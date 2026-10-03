#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FigmaLink, VERSION, type ProgressInfo } from './link.js';
import { BridgeError, type CallEnvelope, type RoutedTo, type Target } from './protocol.js';

const PORT = Number(process.env.FIGMA_MCP_PORT ?? 3055);
const PACE_MS = Number(process.env.FIGMA_MCP_PACE_MS ?? 500);
/** A client with no calls for this long disconnects from the hub until its next call. */
const PEER_IDLE_MS = Number(process.env.FIGMA_MCP_PEER_IDLE_MS ?? 10 * 60_000);
const DEFAULT_TIMEOUT_MS = 30_000;
/** Text results above this many characters are written to a temp file and returned as a path + preview. */
const MAX_TEXT_CHARS = 100_000;
const PREVIEW_CHARS = 4_000;
/** Images above this base64 size are saved to disk instead of being inlined. */
const MAX_INLINE_IMAGE_BASE64 = 4_500_000;
const RESULT_DIR = join(tmpdir(), 'figma-local-mcp');

// stdout carries the MCP protocol; every diagnostic goes to stderr.
const log = (...args: unknown[]) => console.error('[figma-local-mcp]', ...args);

const link = new FigmaLink({ port: PORT, paceMs: PACE_MS, connectTimeoutMs: 30_000, peerIdleMs: PEER_IDLE_MS, log });

/**
 * Sticky target for this MCP client (set_default_target). It names the file (fileKey when Figma provides one,
 * otherwise fileName), not a connection, so it survives the plugin being reloaded or reconnecting.
 */
let defaultTarget: { fileKey: string | null; fileName: string; editorType: string } | null = null;

const defaultSelector = (): Target | undefined =>
  defaultTarget ? (defaultTarget.fileKey ? { fileKey: defaultTarget.fileKey } : { fileName: defaultTarget.fileName }) : undefined;

type Content = CallToolResult['content'][number];
type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>;
};

const textBlock = (value: unknown): Content => ({
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
});

async function saveFile(path: string, data: string | Buffer): Promise<string> {
  const full = resolve(path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  return full;
}

/** Keeps text results under the client's size limit; the full text goes to a temp file. */
async function capText(text: string, name: string, summary: Record<string, unknown>): Promise<Content> {
  if (text.length <= MAX_TEXT_CHARS) return { type: 'text', text };
  const path = await saveFile(join(RESULT_DIR, `${name}.json`), text);
  return textBlock({
    ...summary,
    truncated: true,
    chars: text.length,
    fullResultPath: path,
    preview: text.slice(0, PREVIEW_CHARS),
  });
}

interface ImageMarker {
  __image: { base64: string; mimeType: string };
}
const isImageMarker = (value: unknown): value is ImageMarker =>
  !!value && typeof value === 'object' && typeof (value as ImageMarker).__image?.base64 === 'string';

/**
 * Replaces { __image: { base64, mimeType } } markers anywhere in a result with placeholders and
 * returns the images as MCP image blocks (or files, when saveTo is given or the image is huge).
 */
async function extractImages(value: unknown, images: Content[], name: string, saveTo?: string): Promise<unknown> {
  if (isImageMarker(value)) {
    const { __image: image, ...rest } = value;
    const bytes = Math.round((image.base64.length * 3) / 4);
    if (saveTo || image.base64.length > MAX_INLINE_IMAGE_BASE64) {
      const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const path = saveTo && images.length === 0 ? saveTo : join(RESULT_DIR, `${name}-${images.length}.${ext}`);
      const savedTo = await saveFile(path, Buffer.from(image.base64, 'base64'));
      images.push(textBlock(`[image saved to ${savedTo}]`));
      return { ...rest, image: { savedTo, mimeType: image.mimeType, bytes } };
    }
    images.push({ type: 'image', data: image.base64, mimeType: image.mimeType });
    return { ...rest, image: { attached: images.length, mimeType: image.mimeType, bytes } };
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => extractImages(item, images, name, saveTo)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await extractImages(item, images, name, saveTo);
    return out;
  }
  return value;
}

/** Pretty JSON when it fits; indentation roughly doubles big payloads, so drop it before spilling to a file. */
function toJson(value: unknown): string {
  const pretty = JSON.stringify(value, null, 2);
  return pretty.length <= MAX_TEXT_CHARS ? pretty : JSON.stringify(value);
}

async function present(envelope: CallEnvelope, saveTo?: string): Promise<CallToolResult> {
  const images: Content[] = [];
  const result = await extractImages(envelope.result, images, envelope.callId, saveTo);
  const body = { ...envelope, result };
  // Kept inline even when the full result goes to a temp file (change lists are already capped by the hub).
  const summary = {
    callId: envelope.callId,
    routedTo: envelope.routedTo,
    ...(envelope.changes ? { changes: envelope.changes } : {}),
    ...(envelope.changesNote ? { changesNote: envelope.changesNote } : {}),
    ...(envelope.lateChanges ? { lateChanges: envelope.lateChanges } : {}),
    ...(envelope.unattributedChanges ? { unattributedChanges: envelope.unattributedChanges } : {}),
    ...(envelope.warnings ? { warnings: envelope.warnings } : {}),
  };
  const text = await capText(toJson(body), envelope.callId, summary);
  return { content: [text, ...images.filter((block) => block.type === 'image')] };
}

const MAX_ERROR_LOG_LINES = 80;
const MAX_ERROR_LOG_LINE_CHARS = 500;

/** Bounds an error's logs and stack so the error itself always stays inline. */
function trimError(details: Record<string, unknown>): Record<string, unknown> {
  const out = { ...details };
  if (Array.isArray(out.logs)) {
    const logs = out.logs.map((entry) => {
      const line = String(entry);
      return line.length > MAX_ERROR_LOG_LINE_CHARS ? `${line.slice(0, MAX_ERROR_LOG_LINE_CHARS)}...` : line;
    });
    out.logs =
      logs.length > MAX_ERROR_LOG_LINES
        ? [...logs.slice(0, 10), `... ${logs.length - MAX_ERROR_LOG_LINES} lines omitted ...`, ...logs.slice(-(MAX_ERROR_LOG_LINES - 10))]
        : logs;
  }
  if (typeof out.stack === 'string') out.stack = out.stack.split('\n').slice(0, 15).join('\n');
  return out;
}

async function failure(command: string, err: unknown): Promise<CallToolResult> {
  const details = trimError(BridgeError.from(err).toJSON());
  const text = toJson({ error: { command, ...details } });
  const name = `error-${(details.callId as string | undefined) ?? Date.now()}`;
  // If even the trimmed error is too big (huge change lists), keep its essentials inline.
  const essentials = {
    error: {
      command,
      message: details.message,
      name: details.name,
      code: details.code,
      line: details.line,
      column: details.column,
      callId: details.callId,
      routedTo: details.routedTo,
      ...(Array.isArray(details.logs) ? { logsTail: details.logs.slice(-20) } : {}),
      ...(details.changes ? { changes: details.changes } : {}),
      ...(details.changesNote ? { changesNote: details.changesNote } : {}),
      ...(details.warnings ? { warnings: details.warnings } : {}),
    },
  };
  return { isError: true, content: [await capText(text, name, essentials)] };
}

function progressForwarder(command: string, extra?: Extra): ((progress: ProgressInfo) => void) | undefined {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return undefined;
  let count = 0;
  return (progress) => {
    void extra!
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: ++count, message: progress.message ?? `${command} still running` },
      })
      .catch(() => undefined);
  };
}

interface RunOptions {
  timeoutMs?: number;
  saveTo?: string;
}

/** figma.createImage accepts PNG, JPEG and GIF; anything bigger than this is refused before it reaches Figma. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface DownloadedImage {
  base64: string;
  mimeType: string;
  bytes: number;
}

/** Recognises the formats figma.createImage accepts by their first bytes. */
function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

/**
 * Downloads an image on this machine, so the plugin itself needs no internet access, and checks that Figma
 * can use it. Also accepts data: URLs.
 */
async function downloadImage(url: string): Promise<DownloadedImage> {
  let bytes: Buffer;
  if (url.startsWith('data:')) {
    const match = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
    if (!match) throw new Error('Malformed data: URL');
    bytes = match[1] ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]), 'latin1');
  } else {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported URL scheme "${parsed.protocol}": use http, https or data:`);
    }
    const res = await fetch(parsed, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Downloading ${url} failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error(`The image is ${declared} bytes; the limit is ${MAX_IMAGE_BYTES}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`The image is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  const mimeType = imageType(bytes);
  if (!mimeType) throw new Error(`${url.slice(0, 100)} is not a PNG, JPEG or GIF image (the formats Figma accepts)`);
  return { base64: bytes.toString('base64'), mimeType, bytes: bytes.length };
}

/** Sends a command to the targeted plugin and converts the outcome into an MCP tool result. */
async function run(command: string, args: Record<string, unknown>, extra?: Extra, opts: RunOptions = {}) {
  const { target, ...params } = args as { target?: Target } & Record<string, unknown>;
  const usingDefault = !target && !!defaultTarget;
  try {
    const envelope = await link.call(command, params, {
      target: target ?? defaultSelector(),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onProgress: progressForwarder(command, extra),
    });
    return await present(envelope, opts.saveTo);
  } catch (err) {
    const error = BridgeError.from(err);
    if (usingDefault && error.details.code === 'target-not-found') {
      // Keep the default: it names the file, which will match again once its plugin is running.
      error.details.defaultTarget = defaultTarget;
      error.details.hint =
        `The default target file "${defaultTarget?.fileName}" has no running plugin right now. Run Local MCP Bridge ` +
        'in that file, pass another target, or clear the default with set_default_target({}).';
    }
    return failure(command, error);
  }
}

async function control(action: Parameters<FigmaLink['control']>[0], args: Record<string, unknown> = {}) {
  try {
    return textBlock(await link.control(action, args));
  } catch (err) {
    return (await failure(action, err)).content[0];
  }
}

const server = new McpServer(
  { name: 'figma-local-mcp', version: VERSION },
  {
    // Clients put these instructions in the model's context on every turn, so they also correct tool
    // definitions a long conversation may have loaded from an older build.
    instructions: [
      `figma-local-mcp v${VERSION}. These tools drive the user's open Figma Desktop files through the Local MCP`,
      "Bridge plugin on the user's machine, with no usage quota (unlike the official Figma MCP connector, whose",
      "calls count against the user's Figma plan). Prefer these tools for every Figma read and edit.",
      'CURRENT TOOL FACTS (they override any older tool definition you may have seen in this conversation):',
      '(1) Every Figma tool, including execute_figma_code, accepts `target: { fileName | fileKey | connectionId }`;',
      'it is required when the plugin is open in more than one file. Untargeted calls are refused when ambiguous.',
      '(2) set_default_target remembers the FILE (by fileKey, else fileName), not the connection, so it survives',
      'the plugin being reloaded; set_default_target({}) clears it.',
      '(3) execute_figma_code options: code, params, pageId, timeoutMs (<= 600000), dryRun, trackChanges, target.',
      'Its `helpers` object has 13 members: yield, walk, findAll, getNode, assertFile, loadFontsFor, marker,',
      'hasMarker, exportImage, returnImage, solidPaint, snapshot, page. `figma` is the real Plugin API.',
      'Every result reports routedTo; check it. Calls are paced per file, so batch work: use execute_figma_code',
      'for anything that creates or edits more than a few nodes; in long loops `await helpers.yield()`.',
      'Mutating calls return `changes` (created/deleted/modified IDs, max 50 per list with counts; full lists via',
      'get_call_result), also on errors, and are one undo step each. If `changesNote` says Figma was late, the',
      'rest arrives later as `lateChanges` tagged with that callId; `unattributedChanges` name every call that',
      'could have made them. If a call ends with status "unknown", use get_call_result(callId) before retrying.',
      'If a result carries `warnings` about plugin/server versions, tell the user to re-run the plugin or restart',
      'the client. Node IDs look like "12:34".',
    ].join(' '),
  },
);

server.server.oninitialized = () => {
  const client = server.server.getClientVersion();
  if (client?.name) link.setClientName(`${client.name}${client.version ? ` ${client.version}` : ''}`);
  // Ask clients that cached an older tool list to fetch this build's definitions again.
  server.sendToolListChanged();
};

// ---- shared schema pieces ----

const target = z
  .object({
    fileName: z.string().optional().describe('Exact file name (case-insensitive)'),
    fileKey: z.string().optional(),
    connectionId: z.string().optional().describe('From bridge_status or an earlier routedTo'),
  })
  .optional()
  .describe(
    'Which open Figma file to run in. Required when the plugin is open in more than one file (unless set_default_target was used).',
  );
const nodeId = z.string().min(1).describe('Figma node ID, e.g. "12:34"');
const pageId = z.string().optional().describe('Page to work on instead of the current page');
const hex = z
  .string()
  .regex(/^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, 'Expected #RGB, #RRGGBB or #RRGGBBAA')
  .describe('Hex color, e.g. "#FF5733" or "#FF573380"');
const properties = z
  .record(z.string(), z.unknown())
  .describe(
    'Plugin API properties to assign, e.g. {"x":10,"opacity":0.5,"layoutMode":"VERTICAL","itemSpacing":8,' +
      '"paddingLeft":16,"cornerRadius":8,"fills":[...]}. Shortcuts: width/height (resize), fillHex, strokeHex.',
  );
const placement = {
  parentId: z.string().optional().describe('Parent frame, group, section or page ID (default: pageId or the current page)'),
  pageId,
  x: z.number().optional().describe('X relative to the parent (default: viewport center on a page)'),
  y: z.number().optional(),
  name: z.string().optional().describe('Layer name'),
  properties: properties.optional(),
};

/** Registers a tool that runs a plugin command; every such tool accepts `target`. */
function figmaTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  opts: { timeoutMs?: number | ((args: Record<string, unknown>) => number) } = {},
): void {
  server.registerTool(name, { description, inputSchema: { ...shape, target } }, ((args: Record<string, unknown>, extra: Extra) =>
    run(name, args, extra, {
      timeoutMs: typeof opts.timeoutMs === 'function' ? opts.timeoutMs(args) : opts.timeoutMs,
    })) as never);
}

// ---- read ----

figmaTool(
  'get_document_info',
  'File name, connectionId, pages, current page, current user and the top-level layers of the current (or given) page.',
  { pageId },
);

figmaTool('get_selection', 'Properties of every node selected on the current (or given) page.', { pageId });

figmaTool(
  'read_node',
  'Detailed properties of a node plus descendants. Walks only that subtree (never loads the whole page) and yields ' +
    'while walking. Use textOnly for a flat list of text content.',
  {
    nodeId,
    depth: z.number().int().min(0).max(20).optional().describe('Levels of children to include (default 2)'),
    maxNodes: z.number().int().min(1).max(20000).optional().describe('Stop after this many nodes (default 1000)'),
    textOnly: z.boolean().optional().describe('Return only text layers (incl. FigJam sticky/shape/connector text)'),
  },
  { timeoutMs: 60_000 },
);

figmaTool(
  'search_nodes',
  'Find layers by name, text and type within a node, a page or the current page. Walks with yields and paginates ' +
    '(pass nextCursor back as cursor). Searching a non-current page loads it first, which is slow on huge pages: ' +
    'prefer withinNodeId.',
  {
    query: z.string().optional().describe('Case-insensitive match against name OR text content'),
    nameContains: z.string().optional(),
    textContains: z.string().optional(),
    types: z.array(z.string()).optional().describe('Node types, e.g. ["FRAME","TEXT","INSTANCE","SECTION","STICKY"]'),
    withinNodeId: z.string().optional().describe('Search only inside this node'),
    withinId: z.string().optional().describe('Alias of withinNodeId'),
    pageId,
    maxDepth: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional().describe('Max results per page (default 50)'),
    cursor: z.string().optional().describe('nextCursor from a previous call'),
  },
  { timeoutMs: 60_000 },
);

figmaTool('get_design_tokens', 'Local paint, text, effect and grid styles plus local variable collections and variables.', {});

figmaTool(
  'get_components',
  'Local components and component sets (with variants). Current page by default; allPages loads every page (slow on large files).',
  { allPages: z.boolean().optional() },
  { timeoutMs: 120_000 },
);

const exportShape = {
  nodeId,
  format: z.enum(['PNG', 'JPG', 'SVG']).optional().describe('Default PNG'),
  scale: z.number().min(0.1).max(4).optional().describe('Raster scale (default 1)'),
  maxDimension: z.number().int().min(16).max(8000).optional().describe('Cap on the longer edge in px (default 1600)'),
  quality: z.number().min(0.1).max(1).optional().describe('JPG quality 0.1-1 (re-encoded in the plugin UI)'),
  saveTo: z.string().optional().describe('Write the image to this path on this machine and return only the path'),
};
server.registerTool(
  'export_node',
  {
    description:
      'Render a node as an image block you can see (PNG/JPG; capped by maxDimension and ~1.5 MB) or as SVG markup. ' +
      'With saveTo, writes the file on this machine instead.',
    inputSchema: { ...exportShape, target },
  },
  (async (args: Record<string, unknown>, extra: Extra) => {
    const { saveTo, ...rest } = args as { saveTo?: string } & Record<string, unknown>;
    return run('export_node', rest, extra, { timeoutMs: 90_000, saveTo });
  }) as never,
);

// ---- create ----

figmaTool(
  'create_rectangle',
  'Create a solid-filled rectangle. Returns the new node ID.',
  {
    width: z.number().positive().describe('Width in px'),
    height: z.number().positive().describe('Height in px'),
    colorHex: hex,
    cornerRadius: z.number().min(0).optional(),
    ...placement,
  },
);

figmaTool('create_ellipse', 'Create an ellipse. Returns the new node ID.', {
  width: z.number().positive(),
  height: z.number().positive(),
  colorHex: hex.optional(),
  ...placement,
});

figmaTool(
  'create_frame',
  'Create a frame. Pass auto layout via properties, e.g. {"layoutMode":"VERTICAL","itemSpacing":12,"paddingTop":16}.',
  {
    width: z.number().positive(),
    height: z.number().positive(),
    fillHex: hex.optional().describe('Background color (default white)'),
    ...placement,
  },
);

figmaTool('create_text', 'Create a text layer. The font is loaded automatically (default Inter Regular).', {
  text: z.string(),
  fontFamily: z.string().optional(),
  fontStyle: z.string().optional().describe('e.g. "Regular", "Bold", "Semi Bold"'),
  fontSize: z.number().positive().optional(),
  colorHex: hex.optional(),
  ...placement,
});

figmaTool(
  'create_instance',
  'Place an instance of a local component (componentId) or a published library component (componentKey).',
  {
    componentId: z.string().optional().describe('Local COMPONENT or COMPONENT_SET node ID'),
    componentKey: z.string().optional().describe('Library component key'),
    ...placement,
  },
);

figmaTool('create_page', "Add a page to the file. Figma's plan limits on page count still apply.", {
  name: z.string().min(1),
});

// ---- edit ----

figmaTool(
  'update_text',
  'Replace the text of a TEXT node, or of a FigJam sticky, shape-with-text or connector. Fonts are loaded first.',
  { nodeId: nodeId.describe('ID of a node with text'), newText: z.string() },
);

figmaTool(
  'set_node_properties',
  'Assign any writable Plugin API properties on a node. Reports which keys applied and which failed.',
  { nodeId, properties },
);

server.registerTool(
  'set_image_fill',
  {
    description:
      "Use an image (http, https or data: URL) as the node's fill. This server downloads it on the user's machine - " +
      'the plugin has no internet access. PNG, JPEG or GIF, up to 10 MB and 4096 px.',
    inputSchema: {
      nodeId,
      url: z.string().url(),
      scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE']).optional(),
      target,
    },
  },
  (async (args: Record<string, unknown>, extra: Extra) => {
    let image: DownloadedImage;
    try {
      image = await downloadImage(String(args.url));
    } catch (err) {
      return failure('set_image_fill', err);
    }
    return run('set_image_fill', { ...args, imageBase64: image.base64 }, extra, { timeoutMs: 60_000 });
  }) as never,
);

figmaTool('clone_node', 'Duplicate a node, optionally into another parent and/or at a new position.', {
  nodeId,
  parentId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  name: z.string().optional(),
});

figmaTool('delete_nodes', 'Delete layers by ID.', { nodeIds: z.array(z.string()).min(1) });

figmaTool(
  'set_selection',
  'Select nodes (switching to their page if needed) and zoom the viewport to them. Empty list clears.',
  { nodeIds: z.array(z.string()), zoom: z.boolean().optional().describe('Default true') },
);

figmaTool('set_current_page', 'Switch the editor to another page.', { pageId: z.string().min(1) });

// ---- full access ----

figmaTool(
  'execute_figma_code',
  [
    'Run JavaScript with the full Figma Plugin API inside the plugin, in the file chosen by `target`',
    '({ fileName | fileKey | connectionId }; required when more than one file has the plugin open, unless',
    'set_default_target was used). The code is the body of an async function: use `await`, and `return` a',
    'JSON-serializable value (nodes are summarized automatically).',
    'In scope: `figma` (the real Plugin API; nodes created through it are listed in `changes`), `console`',
    '(output is returned as `logs`, on errors too), `params` (your values; `params.page` is the current or',
    '`pageId` page) and `helpers` (13):',
    'yield() - pause inside long loops; reports progress and stops the script after a timeout.',
    'walk(node, fn, {yieldEvery, maxDepth}) - depth-first walk that yields; fn returns false to skip children, "stop" to end.',
    'findAll(node, predicate, {limit, maxDepth}) - yielding search under any node with children (incl. FigJam sections).',
    'getNode(id) - getNodeByIdAsync that throws "not found in <file>/<page>".',
    'assertFile(name) - throws unless the call runs in that file.',
    'loadFontsFor(node) - loads the fonts of a TEXT node or FigJam sticky/shape/connector text.',
    'marker(name, node?) and hasMarker(name, node?) - idempotency markers for safe retries.',
    'exportImage(nodeOrId, {format, scale, maxDimension, quality}) and returnImage(bytes, mimeType) - return images as image blocks.',
    'solidPaint(hex), snapshot(node, depth), page.',
    'Options: pageId; timeoutMs (default 30000, max 600000); dryRun (report changes, then undo them);',
    'trackChanges (default: automatic - scripts that look like they edit wait for Figma to confirm their changes;',
    'true forces that wait, false skips change tracking for read-only scripts).',
    'Success returns { result, logs } plus `changes` (up to 50 IDs per list with counts; get_call_result has them',
    'all); errors return message, line/column in your script, stack, logs and changes. If `changesNote` says Figma',
    'was late, the rest arrives as `lateChanges` (tagged with this callId) in a later result. Each call is one undo step.',
  ].join(' '),
  {
    code: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional().describe('Values exposed to the code as `params`'),
    pageId,
    timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('Default 30000'),
    dryRun: z.boolean().optional().describe('Run, report changes, then undo them'),
    trackChanges: z
      .boolean()
      .optional()
      .describe(
        'Default automatic. true: always wait for Figma to confirm the changes; false: skip change tracking (read-only scripts)',
      ),
  },
  // The script's own timeout, plus room for waiting on earlier calls (gate) and on its own change events.
  { timeoutMs: (args) => (typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS) + 25_000 },
);

server.registerTool(
  'get_call_result',
  {
    description:
      'Look up what happened to an earlier call by callId (from a result or an error), e.g. after a timeout or a ' +
      'mid-call disconnect: running / completed / failed / unknown, with its outcome (error or result), its full ' +
      'change lists, and lateChanges that Figma delivered after the call replied.',
    inputSchema: { callId: z.string().min(1) },
  },
  async ({ callId }) => ({ content: [await control('get_call_result', { callId })] }),
);

server.registerTool(
  'set_default_target',
  {
    description:
      'Make one open file the default for calls from this client that pass no target. The default follows the file ' +
      '(by fileKey, or fileName when Figma gives no key), so it survives the plugin being reloaded. Call with no ' +
      'target to clear it.',
    inputSchema: { target },
  },
  async ({ target: wanted }) => {
    if (!wanted || !(wanted.fileName || wanted.fileKey || wanted.connectionId)) {
      defaultTarget = null;
      return { content: [textBlock({ defaultTarget: null })] };
    }
    try {
      const routed = (await link.control('resolve_target', { target: wanted })) as RoutedTo;
      defaultTarget = { fileKey: routed.fileKey, fileName: routed.fileName, editorType: routed.editorType };
      return {
        content: [
          textBlock({
            defaultTarget,
            currentConnectionId: routed.connectionId,
            matchesBy: defaultTarget.fileKey ? 'fileKey' : 'fileName',
          }),
        ],
      };
    } catch (err) {
      return failure('set_default_target', err);
    }
  },
);

server.registerTool(
  'bridge_status',
  {
    description:
      'Connected files (connectionId, fileName, editorType, page, in-flight call, reconnects), MCP clients sharing ' +
      'the bridge, pacing, queue depth, the last disconnect and recent calls. Not paced.',
    inputSchema: {},
  },
  async () => {
    try {
      const status = (await link.control('status')) as Record<string, unknown>;
      return { content: [textBlock({ thisProcess: link.role, thisProcessVersion: VERSION, defaultTarget, ...status })] };
    } catch (err) {
      return failure('bridge_status', err);
    }
  },
);

server.registerTool(
  'configure_bridge',
  {
    description: 'Change bridge settings for every client: paceMs (gap between calls to the same file).',
    inputSchema: { paceMs: z.number().int().min(0).max(10_000).optional() },
  },
  async (args) => ({ content: [await control('configure', args)] }),
);

await server.connect(new StdioServerTransport());
log(`MCP server v${VERSION} ready on stdio (pace ${PACE_MS} ms, port ${PORT})`);

// Release the port as soon as the MCP client goes away; a peer then takes over.
function shutdown(): void {
  link.close();
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
