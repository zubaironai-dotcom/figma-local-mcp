// End-to-end test of the Local MCP Bridge without Figma.
//
// Simulated files run the real compiled plugin (figma-plugin/code.js) against a mocked `figma` object whose API
// properties are read-only and non-configurable, like Figma's. "Tagh Work UI - Complete" is a heavy design file
// whose change events arrive 0.9-1.15 s late in batches; "TAGH Manufacturing Workflow" is a FigJam board whose
// events arrive at once. A harness that behaves like ui.html connects them to the real server, and real MCP
// clients spawn the server (one becomes the hub, the others peers) and drive it over stdio.
//
// Usage: npm run build && node test/bridge.test.mjs [--quick]   (--quick skips the 32 s long-script check)

import { readFileSync, existsSync, mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createFigmaMock } from './mock-figma.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3999;
const QUICK = process.argv.includes('--quick');
const DESIGN = 'Tagh Work UI - Complete';
const BOARD = 'TAGH Manufacturing Workflow';
const PEER_IDLE_MS = 3000;
// Tests run the plugin compiled to figma-plugin/.build/ (npm test compiles it there) and never write
// figma-plugin/code.js: Figma reloads live plugins whenever that file changes. BRIDGE_PLUGIN_CODE lets a check
// run against another build (e.g. to prove a test catches a bug).
const TEST_BUILD = join(ROOT, 'figma-plugin', '.build', 'code.js');
const LIVE_CODE = join(ROOT, 'figma-plugin', 'code.js');
const LIVE_CODE_MTIME = existsSync(LIVE_CODE) ? statSync(LIVE_CODE).mtimeMs : null;
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const GIF_1PX_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PLUGIN_CODE = readFileSync(
  process.env.BRIDGE_PLUGIN_CODE ?? (existsSync(TEST_BUILD) ? TEST_BUILD : join(ROOT, 'figma-plugin', 'code.js')),
  'utf8',
);
const HELPERS = ['yield', 'walk', 'findAll', 'getNode', 'assertFile', 'loadFontsFor', 'marker', 'hasMarker',
  'exportImage', 'returnImage', 'solidPaint', 'snapshot', 'page'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}
const section = (title) => console.log(`\n-- ${title}`);
const same = (a = [], b = []) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** One open Figma file: mocked API + the real plugin code + a ui.html-like WebSocket relay. */
class SimulatedFile {
  /** `setup(mock)` runs before the plugin starts (e.g. to add layers the file already has). */
  constructor({ versionOverride, setup, ...options }) {
    this.mock = createFigmaMock(options);
    setup?.(this.mock);
    this.versionOverride = versionOverride;
    this.socket = null;
    this.info = null;
    this.outbox = [];
    this.autoReconnect = true;
    this.warning = null;
    this.port = PORT;
    this.mock.onUiMessage((msg) => this.fromMain(msg));
    this.context = vm.createContext({
      figma: this.mock.figma, __html__: '', console, setTimeout, clearTimeout, setInterval, clearInterval,
      Error, Promise, Object, Array, JSON, Proxy, Map, Set, Symbol, ArrayBuffer, Uint8Array, RegExp, Date,
      Math, Number, String, Boolean,
    });
    vm.runInContext(PLUGIN_CODE, this.context, { filename: 'code.js' });
  }

  get figma() {
    return this.mock.figma;
  }

  fromMain(msg) {
    if (msg.type === 'register') {
      this.info = this.versionOverride ? { ...msg.info, pluginVersion: this.versionOverride } : msg.info;
      this.register();
    } else if (msg.type === 'bridge-warning') {
      this.warning = msg.text;
    } else if (msg.type === 'progress' || msg.type === 'late-changes' || msg.type === 'unattributed-changes') {
      this.send(msg);
    } else if (msg.type === 'reply' && !this.send(msg)) {
      this.outbox.push(msg);
    }
  }

  send(msg) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  register() {
    if (!this.info || !this.send({ type: 'register', info: this.info })) return;
    while (this.outbox.length && this.send(this.outbox[0])) this.outbox.shift();
  }

  connect(port = this.port) {
    this.port = port;
    const ws = new WebSocket(`ws://localhost:${port}`);
    this.socket = ws;
    ws.on('open', () => {
      this.figma.ui.onmessage({ type: 'ws-open' });
      if (this.info) this.register();
      else this.figma.ui.onmessage({ type: 'ui-ready' });
    });
    ws.on('message', (data) => this.figma.ui.onmessage(JSON.parse(data.toString())));
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.autoReconnect && this.socket === ws) setTimeout(() => this.connect(), 300);
    });
  }

  /** Simulates a dropped connection; reconnects after `afterMs` (or not at all). */
  drop(afterMs) {
    this.autoReconnect = false;
    const ws = this.socket;
    this.socket = null;
    ws?.terminate();
    if (afterMs !== undefined) {
      setTimeout(() => {
        this.autoReconnect = true;
        this.connect();
      }, afterMs);
    }
  }
}

async function startClient(name, env = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(ROOT, 'mcp-server', 'dist', 'index.js')],
    stderr: 'pipe',
    env: { ...process.env, FIGMA_MCP_PORT: String(PORT), FIGMA_MCP_PEER_IDLE_MS: String(PEER_IDLE_MS), ...env },
  });
  const logs = [];
  transport.stderr.on('data', (d) => logs.push(...d.toString().trim().split('\n')));
  const client = new Client({ name, version: '1.0.0' });
  const state = { client, logs, toolListChanged: 0 };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    state.toolListChanged++;
  });
  await client.connect(transport);
  return state;
}

const parse = (res) => JSON.parse(res.content[0].text);
const call = (client, name, args = {}, options) => client.callTool({ name, arguments: args }, undefined, options);
const exec = (client, code, extra = {}, options) => call(client, 'execute_figma_code', { code, ...extra }, options);
const errorOf = (res) => (res.isError ? parse(res).error : {});

async function main() {
  const A = await startClient('client-A');
  await sleep(300);
  const B = await startClient('client-B');

  // The design file is heavy: change events arrive 0.9-1.15 s late, in batches (FigJam's at once). Its poster
  // still carries sentinel data written by 3.2 on a real layer.
  let huge;
  let poster;
  const design = new SimulatedFile({
    fileName: DESIGN, fileKey: 'DESIGNKEY', eventDelayMs: 900, batchIntervalMs: 250,
    setup: (m) => {
      huge = m.buildLargeTree({ groups: 100, perGroup: 1000 });
      poster = m.addFrame({ name: 'Poster', width: 3000, height: 2000 });
      poster.pluginData['mcp-sentinel'] = 'left over by 3.2';
    },
  });
  let board = new SimulatedFile({ fileName: BOARD, editorType: 'figjam', fileKey: 'BOARDKEY', setup: (m) => m.addFrame({ name: 'Board frame' }) });
  design.connect();
  board.connect();
  await sleep(1000);
  const D = { target: { fileName: DESIGN } };
  const F = { target: { fileName: BOARD } };

  section('Status and routing');
  const status = parse(await call(A.client, 'bridge_status'));
  const files = status.plugins.map((p) => p.fileName).sort();
  check('bridge_status lists both plugins', files.length === 2 && files.includes(DESIGN) && files.includes(BOARD), files.join(' | '));
  check('bridge_status lists both MCP clients with names, roles and versions', status.peers.length === 2 &&
    status.peers.every((p) => /client-[AB]/.test(p.clientName) && p.version === status.hub.version),
    status.peers.map((p) => `${p.clientName}/${p.role}/v${p.version}`).join(', '));
  const ambiguousError = errorOf(await call(A.client, 'get_document_info'));
  check('untargeted call refused when two files are open', ambiguousError.code === 'ambiguous-target');
  let routedOk = 0;
  for (let i = 0; i < 20; i++) {
    const wanted = i % 2 ? BOARD : DESIGN;
    const res = parse(await exec(i % 4 < 2 ? A.client : B.client, 'return figma.root.name', { target: { fileName: wanted }, trackChanges: false }));
    if (res.result.result === wanted && res.routedTo.fileName === wanted) routedOk++;
  }
  check('20 alternating targeted calls all land in the requested file', routedOk === 20, `${routedOk}/20`);

  section('The figma object in scripts (read-only API, like Figma)');
  const apiRes = await exec(A.client, [
    "const types = [typeof figma.loadFontAsync, typeof figma.createText, typeof figma.getNodeByIdAsync].join(',');",
    "const t = figma.createText(); t.characters = 'hello';",
    "const n = await figma.getNodeByIdAsync(t.id);",
    "return { types, hasChildren: 'children' in figma.currentPage, inNode: 'characters' in n };",
  ].join('\n'), D);
  const api = apiRes.isError ? {} : parse(apiRes).result.result;
  check('figma.* methods and `in` work in scripts', api.types === 'function,function,function' && api.hasChildren && api.inNode,
    apiRes.isError ? errorOf(apiRes).message : JSON.stringify(api));
  check('figma.closePlugin() is blocked', /disabled inside execute_figma_code/.test(errorOf(await exec(A.client, 'figma.closePlugin()', D)).message ?? ''));

  section('Your sequence in the heavy design file: each call gets exactly its own changes');
  const frameCode = [
    "const f = figma.createFrame(); f.name = 'Test frame';",
    'for (let i = 0; i < 400; i++) { const r = figma.createRectangle(); f.appendChild(r); }',
    "throw new Error('on purpose');",
  ].join('\n');
  const x = errorOf(await exec(A.client, frameCode, D));
  const frameId = x.changes?.created?.[0];
  check('X: 401 creations reported, capped at 50 IDs with a count', x.changes?.createdCount === 401 &&
    x.changes.created.length === 50 && /get_call_result/.test(x.changes.truncated ?? ''), `count=${x.changes?.createdCount} listed=${x.changes?.created?.length}`);
  const xFull = parse(await call(A.client, 'get_call_result', { callId: x.callId }));
  check('X: get_call_result returns all 401 IDs', xFull.outcome?.changes?.created?.length === 401, `${xFull.outcome?.changes?.created?.length}`);

  const a = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).remove();', { ...D, params: { id: frameId } }));
  check('A: deleting the 401-node frame reports exactly that delete', same(a.changes?.deleted, [frameId]) &&
    a.changes.createdCount === 0 && a.changes.modifiedCount === 0 && !a.changesNote && !a.lateChanges, JSON.stringify(a.changes));

  const b = parse(await exec(A.client, 'const r1 = figma.createRectangle(); const r2 = figma.createRectangle(); return [r1.id, r2.id];', D));
  const [r1, r2] = b.result.result;
  check('B: two probe rectangles reported, nothing else', same(b.changes?.created, [r1, r2]) && b.changes.deletedCount === 0 &&
    b.changes.modifiedCount === 0, JSON.stringify(b.changes));

  const c = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).remove();', { ...D, params: { id: r1 } }));
  check('C: deleting one probe (no wait) reports only that delete', same(c.changes?.deleted, [r1]) && c.changes.createdCount === 0 &&
    c.changes.modifiedCount === 0 && !c.lateChanges, JSON.stringify(c.changes));

  const d = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).remove(); await new Promise((r) => setTimeout(r, 1500));',
    { ...D, params: { id: r2 } }));
  check('D: deleting the other probe (then waiting) reports only that delete', same(d.changes?.deleted, [r2]) &&
    d.changes.createdCount === 0 && d.changes.modifiedCount === 0, JSON.stringify(d.changes));

  const tool = parse(await call(A.client, 'create_rectangle', { ...D, width: 40, height: 40, colorHex: '#00ff00' }));
  const afterTool = parse(await exec(A.client, 'const n = await figma.getNodeByIdAsync(params.id); n.resize(320, 240);', { ...D, params: { id: poster.id } }));
  check("a tool's late events don't leak into the next script", same(tool.changes?.created, [tool.result.id]) &&
    afterTool.changes?.createdCount === 0 && same(afterTool.changes?.modified?.map((m) => m.id), [poster.id]), JSON.stringify(afterTool.changes));

  const viaRaw = parse(await exec(A.client, 'return globalThis.figma.createEllipse().id;', D));
  check('creation through the raw global API is listed', same(viaRaw.changes?.created, [viaRaw.result.result]));
  const t0 = Date.now();
  const readRes = parse(await exec(A.client, 'return figma.root.name', D));
  const readMs = Date.now() - t0 - readRes.queue.waitedMs;
  check('read-only script places no sentinel and stays fast', readMs < 400 && !readRes.changes, `${readMs} ms`);
  const probe = errorOf(await exec(A.client, "console.log('before');\nconst r = figma.createRectangle(); r.name = 'probe';\nthrow new Error('after create');", D));
  check('error: creations, logs and line number are all reported', probe.changes?.createdCount === 1 && probe.logs?.[0] === 'before' && probe.line === 3,
    `created=${probe.changes?.createdCount} line=${probe.line}`);
  const lineOne = errorOf(await exec(A.client, "throw new Error('first line')", D));
  check('error on line 1 is reported as line 1 (stack rewritten)', lineOne.line === 1 && /script:1/.test(lineOne.stack ?? ''));
  const before = design.mock.page.children.length;
  const fontFail = await call(A.client, 'create_text', { ...D, text: 'x', properties: { fontName: { family: 'Missing Font', style: 'Regular' } } });
  check('failed create_text leaves no stray layer', fontFail.isError && design.mock.page.children.length === before);
  const mapped = design.context.mapStack('    at anonymous (<input>:5)\n    at execute (<input>:812)', { file: '<input>', offset: 2, shared: true }, 4);
  check('QuickJS-style stack frames are mapped to script lines', mapped.line === 3 && mapped.stack.includes('(script:3)') && mapped.stack.includes('(<input>:812)'));

  section('Issue 3: sentinels live on a hidden helper layer, never on deliverables');
  const helperLayers = design.mock.page.children.filter((n) => n.pluginData['mcp-role'] === 'bridge-helper');
  check('one hidden, locked helper layer carries the sentinels', helperLayers.length === 1 && helperLayers[0].visible === false &&
    helperLayers[0].locked === true && !!helperLayers[0].pluginData['mcp-sentinel'], `${helperLayers.length} helper(s)`);
  const tainted = design.mock.page.children.filter((n) => n.pluginData['mcp-role'] !== 'bridge-helper' && n.pluginData['mcp-sentinel']);
  check('no real layer carries sentinel data (the 3.2 leftover on Poster was cleared)', tainted.length === 0 && poster.pluginData['mcp-sentinel'] === '',
    tainted.map((n) => n.name).join(', '));
  const listed = parse(await call(A.client, 'get_document_info', D)).result.topLevelNodes;
  const searched = parse(await call(A.client, 'search_nodes', { ...D, nameContains: 'Local MCP Bridge helper' })).result.nodes;
  check('the helper layer is left out of results and searches', !listed.some((n) => n.id === helperLayers[0]?.id) && searched.length === 0);

  section('Issue 1: FigJam right after the plugin starts (slow first deliveries, deletions listed first)');
  const fresh = new SimulatedFile({
    fileName: 'Fresh board', editorType: 'figjam', fileKey: 'FRESHKEY', warmupMs: 7000,
    setup: (m) => m.addFrame({ name: '02 Manufacturing Lifecycle' }),
  });
  fresh.connect();
  await sleep(700);
  const FB = { target: { fileName: 'Fresh board' } };
  const c1Start = Date.now();
  const c1 = parse(await exec(A.client, 'return figma.createRectangle().id;', FB));
  const c1Ms = Date.now() - c1Start;
  const c2 = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).remove();', { ...FB, params: { id: c1.result.result } }));
  const c3 = parse(await exec(A.client, 'return figma.createRectangle().id;', FB));
  const c4 = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).remove();', { ...FB, params: { id: c3.result.result } }));
  const c5 = parse(await exec(A.client, 'return 1', { ...FB, trackChanges: false }));
  check('call 1 waits for the primed pipeline, then reports its creation (no timeout)', same(c1.changes?.created, [c1.result.result]) &&
    !c1.changesNote, `${c1Ms} ms; ${c1.changesNote ?? 'no note'}`);
  check('call 2 reports its own delete (no timeout)', same(c2.changes?.deleted, [c1.result.result]) && !c2.changesNote, JSON.stringify(c2.changes));
  check('calls 3 and 4 are correct, and nothing is credited to another call', same(c3.changes?.created, [c3.result.result]) &&
    same(c4.changes?.deleted, [c3.result.result]) && ![c2, c3, c4, c5].some((r) => r.lateChanges || r.unattributedChanges));
  const c2Lookup = parse(await call(A.client, 'get_call_result', { callId: c2.callId }));
  check("get_call_result for call 2 shows its delete", same(c2Lookup.outcome?.changes?.deleted, [c1.result.result]));
  fresh.drop();

  section('Issue 4: each call is one undo step');
  const undone = parse(await exec(A.client, 'return [figma.createRectangle().id, figma.createEllipse().id, figma.createRectangle().id];', D));
  const undoIds = undone.result.result;
  const undoer = parse(await exec(A.client,
    'figma.triggerUndo(); return (await Promise.all(params.ids.map((id) => figma.getNodeByIdAsync(id)))).map((n) => n === null);',
    { ...D, params: { ids: undoIds } }));
  check('one figma.triggerUndo() (what Ctrl+Z does) reverts exactly the previous call', undoer.result.result.every(Boolean) &&
    same(undoer.changes?.deleted, undoIds) && undoer.changes.createdCount === 0, JSON.stringify(undoer.changes));

  section('Least privilege: the plugin reaches only the local bridge');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'figma-plugin', 'manifest.json'), 'utf8'));
  check('manifest: network access only to ws://localhost:3055 (no wildcard)',
    JSON.stringify(manifest.networkAccess.allowedDomains) === '["ws://localhost:3055"]', JSON.stringify(manifest.networkAccess.allowedDomains));
  check('manifest: no unused permissions (activeusers, fileusers)', !manifest.permissions.includes('activeusers') &&
    !manifest.permissions.includes('fileusers'), manifest.permissions.join(', '));
  const imageServer = createServer((req, res) => {
    if (req.url === '/pixel.png') res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_1PX);
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<html>not an image</html>');
  });
  await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  const imageBase = `http://127.0.0.1:${imageServer.address().port}`;
  const filled = parse(await call(A.client, 'set_image_fill', { ...D, nodeId: poster.id, url: `${imageBase}/pixel.png` }));
  check('set_image_fill still works: the server downloads the image, the plugin makes no request', poster.fills[0]?.type === 'IMAGE' &&
    !!filled.result?.imageHash && design.mock.state.networkRequests.length === 0 && filled.changes?.modified?.some((m) => m.id === poster.id),
    `requests from the plugin: ${design.mock.state.networkRequests.length}`);
  const fromDataUrl = await call(A.client, 'set_image_fill', { ...D, nodeId: poster.id, url: GIF_1PX_DATA_URL });
  check('data: URLs work too', !fromDataUrl.isError && !!parse(fromDataUrl).result?.imageHash);
  const notImage = await call(A.client, 'set_image_fill', { ...D, nodeId: poster.id, url: `${imageBase}/page.html` });
  check('a non-image is refused with a clear message before it reaches Figma', notImage.isError &&
    /not a PNG, JPEG or GIF/.test(errorOf(notImage).message ?? ''), errorOf(notImage).message);
  imageServer.close();

  section('Builds and tests never reload the live plugin needlessly');
  const { publish } = await import(pathToFileURL(join(ROOT, 'figma-plugin', 'publish.mjs')).href);
  const scratch = mkdtempSync(join(tmpdir(), 'figma-local-publish-'));
  const builtCode = join(scratch, 'built.js');
  const publishedCode = join(scratch, 'code.js');
  writeFileSync(builtCode, 'same build');
  writeFileSync(publishedCode, 'same build');
  const stamp = statSync(publishedCode).mtimeMs;
  await sleep(30);
  check('a build with nothing new leaves code.js and its timestamp alone', publish(builtCode, publishedCode) === false &&
    statSync(publishedCode).mtimeMs === stamp);
  writeFileSync(builtCode, 'changed build');
  check('a real change is published', publish(builtCode, publishedCode) === true && readFileSync(publishedCode, 'utf8') === 'changed build');

  section('Late changes: reported against the call that made them');
  const slow = new SimulatedFile({ fileName: 'Slow file', fileKey: 'SLOWKEY', eventDelayMs: 6000, batchIntervalMs: 250 });
  const doomed = slow.mock.addFrame({ name: 'Doomed' });
  slow.mock.addFrame({ name: 'Keeper' });
  slow.connect();
  await sleep(800);
  const S = { target: { fileName: 'Slow file' } };
  const l1 = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).remove();', { ...S, params: { id: doomed.id } }));
  check('when Figma is too slow, changesNote says the rest will follow as lateChanges', /lateChanges/.test(l1.changesNote ?? '') && !l1.changes,
    l1.changesNote);
  await sleep(3500); // the delete and the sentinel arrive ~6 s after the call
  const l2 = parse(await exec(A.client, 'return 1', { ...S, trackChanges: false }));
  const notice = l2.lateChanges?.find((n) => n.callId === l1.callId);
  check('the next result carries them as lateChanges tagged with the earlier callId', same(notice?.changes?.deleted, [doomed.id]) &&
    notice?.complete === true, JSON.stringify(l2.lateChanges));
  check('...and they are not folded into the next call', !l2.changes);
  const l1Later = parse(await call(A.client, 'get_call_result', { callId: l1.callId }));
  check('get_call_result shows the late changes too', same(l1Later.outcome?.lateChanges?.changes?.deleted, [doomed.id]), JSON.stringify(l1Later.outcome?.lateChanges));

  section('Safety net: a Figma that never reports plugin-data changes (every sentinel lost)');
  const deaf = new SimulatedFile({ fileName: 'Deaf file', fileKey: 'DEAFKEY', eventDelayMs: 300, batchIntervalMs: 50, dropPluginDataEvents: true });
  const victim = deaf.mock.addFrame({ name: 'Victim' });
  deaf.mock.addFrame({ name: 'Keeper' });
  deaf.connect();
  await sleep(800);
  const DF = { target: { fileName: 'Deaf file' } };
  const s1 = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).remove();', { ...DF, params: { id: victim.id } }));
  check('lost sentinel: the call still lists what arrived and says it could not confirm', same(s1.changes?.deleted, [victim.id]) &&
    /lateChanges/.test(s1.changesNote ?? ''), s1.changesNote);
  const tTool = parse(await call(A.client, 'create_rectangle', { ...DF, width: 10, height: 10, colorHex: '#123456' }));
  const s2 = parse(await exec(A.client, 'return figma.createEllipse().id;', DF));
  check('a newer call\'s own events close the stuck window instead of being misattributed', same(s2.changes?.created, [s2.result.result]) &&
    s2.changes.deletedCount === 0, JSON.stringify(s2.changes));
  const s1Notice = [...(tTool.lateChanges ?? []), ...(s2.lateChanges ?? [])].find((n) => n.callId === s1.callId);
  check('the stuck call is reported as incomplete (complete: false)', s1Notice?.complete === false, JSON.stringify(s1Notice));
  const t3 = Date.now();
  const s3 = parse(await exec(A.client, 'return figma.createRectangle().id;', DF));
  const s3Ms = Date.now() - t3 - s3.queue.waitedMs;
  check('after repeated losses sentinels are given up: no 4 s waits, and the result says why',
    /not been reporting the sentinel/.test(s3.changesNote ?? '') && s3Ms < 3500 && same(s3.changes?.created, [s3.result.result]),
    `${s3Ms} ms; ${s3.changesNote}`);
  check("the stuck call's notice holds no other call's changes", s1Notice?.changes?.createdCount === 0, JSON.stringify(s1Notice?.changes));
  deaf.drop();

  section('Earlier guarantees still hold');
  const walkRes = await exec(A.client,
    "let n = 0; const frame = await helpers.getNode(params.frameId); await helpers.walk(frame, (node) => { if (node.type === 'RECTANGLE') n++; }); return n;",
    { ...D, params: { frameId: huge.id }, timeoutMs: 120000 });
  check('100,000-node walk with helpers.walk completes', !walkRes.isError && parse(walkRes).result.result === 100000);
  const undoBefore = design.mock.undo.history.length;
  const thrown = errorOf(await exec(A.client,
    "for (let i = 0; i < 5; i++) { const r = figma.createRectangle(); r.name = 'Temp ' + i; console.log('made', r.id); }\nthrow new Error('boom after 5');", D));
  const createdIds = thrown.changes?.created ?? [];
  check('throwing script returns its 5 created IDs, line 2 and 5 log lines', createdIds.length === 5 && thrown.line === 2 && thrown.logs?.length === 5);
  design.figma.triggerUndo(); // one Ctrl+Z
  check('one undo removes all 5 nodes', createdIds.every((id) => !design.mock.registry.has(id)) && design.mock.undo.history.length === undoBefore);
  const failedLookup = parse(await call(A.client, 'get_call_result', { callId: thrown.callId }));
  check('get_call_result on a failed call includes the error message', failedLookup.status === 'failed' && failedLookup.outcome?.error?.message === 'boom after 5');
  const dry = parse(await exec(A.client, 'const a = figma.createRectangle(); const b = figma.createEllipse(); return [a.id, b.id];', { ...D, dryRun: true }));
  check('dryRun reports changes then rolls them back', dry.rolledBack === true && dry.changes.createdCount === 2 &&
    dry.result.result.every((id) => !design.mock.registry.has(id)));
  await sleep(1500);
  const afterDry = parse(await exec(A.client, 'const n = await figma.getNodeByIdAsync(params.id); n.resize(300, 200);', { ...D, params: { id: poster.id } }));
  check("the dryRun's undo doesn't leak into the next call", afterDry.changes?.deletedCount === 0 && afterDry.changes?.createdCount === 0 &&
    same(afterDry.changes?.modified?.map((m) => m.id), [poster.id]), JSON.stringify(afterDry.changes));
  const exported = await call(A.client, 'export_node', { ...D, nodeId: poster.id, maxDimension: 6000, scale: 2 });
  const image = exported.content.find((cnt) => cnt.type === 'image');
  check('export_node returns an image block under the byte cap', !!image && Buffer.from(image.data, 'base64').length <= 1_500_000);
  const bigText = parse(await exec(A.client, "return 'x'.repeat(200000)", { ...D, trackChanges: false }));
  check('text results over 100 KB go to a temp file', bigText.truncated === true && existsSync(bigText.fullResultPath));
  const longish = exec(A.client, 'const end = Date.now() + 3000; while (Date.now() < end) await helpers.yield(); return "done";', F);
  await sleep(1000);
  board.drop(800);
  const survived = await longish;
  check('call survives a brief plugin disconnect', !survived.isError && parse(survived).result.result === 'done');
  check('no version warnings while plugin and server match', !parse(survived).warnings);

  section('Default target follows the file');
  await call(A.client, 'set_default_target', F);
  const first = parse(await call(A.client, 'get_document_info'));
  board.drop(); // the plugin is closed...
  board = new SimulatedFile({ fileName: BOARD, editorType: 'figjam', fileKey: 'BOARDKEY' }); // ...and run again
  board.mock.addFrame({ name: 'Board frame' });
  board.connect();
  await sleep(700);
  const second = await call(A.client, 'get_document_info');
  const secondBody = second.isError ? errorOf(second) : parse(second);
  check('after the plugin is re-run, untargeted calls re-attach to the same file', !second.isError &&
    secondBody.routedTo.fileName === BOARD && secondBody.routedTo.connectionId !== first.routedTo.connectionId,
    second.isError ? secondBody.message : `${first.routedTo.connectionId} -> ${secondBody.routedTo.connectionId}`);
  const statusDefault = parse(await call(A.client, 'bridge_status'));
  check('bridge_status shows the default target by file', statusDefault.defaultTarget?.fileKey === 'BOARDKEY' &&
    statusDefault.plugins.filter((p) => p.fileName === BOARD).length === 1);
  await call(A.client, 'set_default_target', {});

  section('Issue 2: tool descriptions');
  const tools = await A.client.listTools();
  const execTool = tools.tools.find((t) => t.name === 'execute_figma_code');
  const defaultTool = tools.tools.find((t) => t.name === 'set_default_target');
  const missing = HELPERS.filter((h) => !execTool.description.includes(h));
  check('execute_figma_code: description lists all 13 helpers and target is in its schema', execTool.description.includes('target') &&
    'target' in execTool.inputSchema.properties && !missing.length, missing.join(', '));
  check('set_default_target says it follows the file', /follows the file/.test(defaultTool.description) &&
    !/until that plugin disconnects/.test(defaultTool.description));
  const instructions = A.client.getInstructions() ?? '';
  check('server instructions (refreshed every turn) carry the current tool facts', /v\d+\.\d+\.\d+/.test(instructions) &&
    /accepts `target/.test(instructions) && /13 members/.test(instructions) && /remembers the FILE/.test(instructions) &&
    HELPERS.every((h) => instructions.includes(h)));
  check('the server tells clients to refetch the tool list', A.toolListChanged >= 1 && B.toolListChanged >= 1,
    `A=${A.toolListChanged} B=${B.toolListChanged}`);

  section('Idle clients');
  await sleep(PEER_IDLE_MS + 1500); // B makes no calls
  const quiet = parse(await call(A.client, 'bridge_status'));
  check('an idle client disconnects from the hub on its own', quiet.peers.length === 1, quiet.peers.map((p) => p.clientName).join(', '));
  const woke = await exec(B.client, 'return figma.root.name', { ...F, trackChanges: false });
  check('a dormant client reconnects on its next call', !woke.isError && parse(woke).result.result === BOARD);

  section('Version mismatch');
  const old = new SimulatedFile({ fileName: 'Old plugin file', versionOverride: '3.0.0' });
  old.connect();
  await sleep(700);
  const warned = parse(await exec(A.client, 'return 1', { target: { fileName: 'Old plugin file' }, trackChanges: false }));
  check('results warn when the plugin in a file is an older build', /run it again/.test(warned.warnings?.[0] ?? ''), warned.warnings?.[0]);
  old.drop();

  const fakeReplies = [];
  const fake = new WebSocketServer({ port: 3998 });
  fake.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'reply') fakeReplies.push(msg);
    });
    // A pre-3.2 server: never sends hub-hello.
    setTimeout(() => ws.send(JSON.stringify({ id: 'probe-1', command: 'execute_figma_code', params: { code: 'return { ok: true }', trackChanges: false } })), 3000);
  });
  const lonely = new SimulatedFile({ fileName: 'Lonely file' });
  lonely.connect(3998);
  await sleep(3800);
  const fakeReply = fakeReplies.find((r) => r.id === 'probe-1');
  check('the plugin warns when its server is a pre-3.2 build (in warnings and inside the result)',
    /older build/.test(fakeReply?.warnings?.[0] ?? '') && /older build/.test(fakeReply?.result?.bridgeWarning ?? ''), fakeReply?.warnings?.[0]);
  check('the plugin window shows that warning', /older build/.test(lonely.warning ?? ''));
  lonely.drop();
  fake.close();

  if (!QUICK) {
    section('Long-running script');
    let progressEvents = 0;
    const long = await exec(A.client,
      'const end = Date.now() + 32000; let i = 0; while (Date.now() < end) { i++; await helpers.yield(); } return i > 0;',
      { ...D, timeoutMs: 60000, trackChanges: false },
      { timeout: 15000, resetTimeoutOnProgress: true, onprogress: () => progressEvents++ });
    check('32 s script completes (client timeout 15 s, kept alive by progress)', !long.isError && parse(long).result.result === true,
      `progress notifications=${progressEvents}`);

    section('If calls ever overlap (gate timed out), uncertain changes are reported as such');
    let nodeX;
    let nodeY;
    const glacial = new SimulatedFile({
      fileName: 'Glacial file', fileKey: 'GLACIALKEY', eventDelayMs: 16000, batchIntervalMs: 250,
      setup: (m) => {
        nodeX = m.addFrame({ name: 'X' });
        nodeY = m.addFrame({ name: 'Y' });
      },
    });
    glacial.connect();
    await sleep(700);
    const G = { target: { fileName: 'Glacial file' } };
    const u1 = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).resize(50, 50);', { ...G, params: { id: nodeX.id } }));
    const u2 = parse(await exec(A.client, '(await figma.getNodeByIdAsync(params.id)).resize(60, 60);', { ...G, params: { id: nodeY.id } }));
    check('the overlapping call says so in changesNote', /still unconfirmed/.test(u2.changesNote ?? ''), u2.changesNote?.slice(0, 90));
    await sleep(17000); // every delayed batch arrives
    const u3 = parse(await exec(A.client, 'return 1', { ...G, trackChanges: false }));
    // The notice rides on the first reply after it is known (here u2's, which was still waiting for its sentinel).
    const notices = [...(u2.unattributedChanges ?? []), ...(u3.unattributedChanges ?? [])];
    const unsure = notices.find((n) => n.possibleCallIds.includes(u1.callId) && n.possibleCallIds.includes(u2.callId));
    check("X's change, made while both calls were unconfirmed, is reported as possibly either call", unsure?.changes?.modified?.some((m) => m.id === nodeX.id),
      JSON.stringify(notices));
    const u1Lookup = parse(await call(A.client, 'get_call_result', { callId: u1.callId }));
    check('get_call_result for either call shows the unattributed change', u1Lookup.outcome?.unattributedChanges?.some((n) =>
      n.changes?.modified?.some((m) => m.id === nodeX.id)), JSON.stringify(u1Lookup.outcome?.unattributedChanges));
    const u2Late = u3.lateChanges?.find((n) => n.callId === u2.callId);
    check("Y's change, which only the later call could have made, is credited to it", u2Late?.changes?.modified?.some((m) => m.id === nodeY.id),
      JSON.stringify(u3.lateChanges));
    check('...and no change is credited to the wrong call', !u3.lateChanges?.some((n) => n.callId === u1.callId && n.changes.modified.some((m) => m.id === nodeY.id)));
    glacial.drop();
  } else {
    console.log('\nSKIP  long-script and overlapping-call checks (--quick)');
  }

  section('Upgrade: a newer server takes over the hub');
  const C = await startClient('client-C', { FIGMA_MCP_VERSION_OVERRIDE: '9.9.9' });
  await sleep(5000); // C joins as a peer, the hub hands over, plugins and clients reconnect
  const afterHandover = parse(await call(A.client, 'bridge_status'));
  check('the newer build now runs the hub; the old hub became a peer', afterHandover.hub.version === '9.9.9' &&
    afterHandover.thisProcess === 'peer' && afterHandover.plugins.some((p) => p.fileName === DESIGN),
    `hub v${afterHandover.hub.version}, A is ${afterHandover.thisProcess}, plugins ${afterHandover.plugins.length}`);
  const viaNewHub = await exec(A.client, 'return figma.root.name', { ...D, trackChanges: false });
  check('calls keep working after the handover', !viaNewHub.isError && parse(viaNewHub).result.result === DESIGN);

  section('Issue 4: the hub process exits (e.g. the MCP Inspector is closed)');
  await C.client.close(); // C runs the hub now
  await sleep(3000);
  const afterExit = await exec(A.client, 'return figma.root.name', { ...D, trackChanges: false });
  const exitStatus = parse(await call(A.client, 'bridge_status'));
  check('another client takes over the hub, the plugins reconnect, and calls keep working', !afterExit.isError &&
    parse(afterExit).result.result === DESIGN && exitStatus.thisProcess === 'hub' && exitStatus.plugins.some((p) => p.fileName === DESIGN),
    `A is ${exitStatus.thisProcess}`);

  await Promise.all([A.client.close(), B.client.close()]);
  check('this test run never touched figma-plugin/code.js (so live plugins were not reloaded)',
    LIVE_CODE_MTIME === null || statSync(LIVE_CODE).mtimeMs === LIVE_CODE_MTIME);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
