import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { BridgeError, type CallEnvelope, type RoutedTo, type Target } from './protocol.js';
import { PacedQueue } from './queue.js';

/** FIGMA_MCP_VERSION_OVERRIDE exists only so tests can simulate an upgrade (hub handover). */
export const VERSION = process.env.FIGMA_MCP_VERSION_OVERRIDE || '3.4.0';
const APP_ID = 'figma-local-mcp';
const PROTOCOL = 5;
const PEER_PATH = '/peer';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Upper bound for a peer waiting on the hub; the hub enforces the real per-call timeouts. */
const PEER_REPLY_TIMEOUT_MS = 30 * 60_000;
/** A disconnected plugin keeps its queue and in-flight calls this long, waiting to reconnect. */
const RECONNECT_GRACE_MS = 10_000;
/** How long a targeted call waits for a matching plugin while other files are connected. */
const TARGET_WAIT_MS = 8_000;
const REGISTER_TIMEOUT_MS = 3_000;
/** Liveness uses WebSocket ping/pong (answered by the browser, not by plugin JS). */
const PING_INTERVAL_MS = 15_000;
/** The hub disconnects idle peers this long after they should have gone dormant on their own. */
const PEER_IDLE_BACKSTOP_MS = 5 * 60_000;
/** Close code telling a peer it was disconnected for being idle (it reconnects on its next call). */
const IDLE_CLOSE_CODE = 4002;
/** Close code used when the hub hands the port to a newer server ("take over" for the newer one). */
const HANDOVER_CLOSE_CODE = 4003;
/** How long a hub waits for in-flight calls to finish before handing over to a newer server. */
const HANDOVER_DRAIN_MS = 15_000;
/** Change lists in results are capped at this many IDs each; get_call_result has them in full. */
const CHANGE_LIST_CAP = 50;
const CALL_LOG_SIZE = 200;
const RECENT_CALLS_IN_STATUS = 10;
const RESULT_PREVIEW_CHARS = 2_000;
const LATE_RESULT_MAX_CHARS = 1_000_000;

export interface LinkOptions {
  port: number;
  paceMs: number;
  /** How long a call waits for any plugin (or the hub) to become reachable. */
  connectTimeoutMs: number;
  /** A peer with no calls for this long disconnects from the hub until its next call. */
  peerIdleMs: number;
  log: (...args: unknown[]) => void;
}

export interface ProgressInfo {
  callId: string;
  at: string;
  message?: string;
}

export interface CallOptions {
  timeoutMs?: number;
  target?: Target;
  onProgress?: (progress: ProgressInfo) => void;
}

export type Role = 'starting' | 'hub' | 'peer' | 'dormant';
export type ControlAction = 'status' | 'resolve_target' | 'get_call_result' | 'configure';

interface PluginInfo {
  connectionId: string;
  fileKey: string | null;
  fileName: string;
  editorType: string;
  currentPageId: string;
  currentPageName: string;
  pluginVersion: string;
}

interface PluginConn {
  info: PluginInfo;
  socket: WebSocket | null;
  alive: boolean;
  queue: PacedQueue;
  connectedAt: number;
  lastSeenAt: number;
  reconnects: number;
  graceTimer: NodeJS.Timeout | null;
}

interface PluginResult {
  result: unknown;
  changes?: CallEnvelope['changes'];
  changesNote?: string;
  rolledBack?: boolean;
  /** Late-change notices for earlier calls in this file. */
  lateChanges?: Array<Record<string, unknown>>;
  /** Changes that could belong to more than one call (named in each notice). */
  unattributedChanges?: Array<Record<string, unknown>>;
  /** Warnings raised by the plugin (e.g. it noticed an outdated server). */
  warnings?: string[];
}

interface PendingCall {
  callId: string;
  command: string;
  conn: PluginConn;
  /** Serialized message, kept so a call the plugin never received can be re-sent after a reconnect. */
  message: string;
  /** Internal requests (e.g. result lookups) are not logged and not recovered. */
  internal: boolean;
  resolve: (value: PluginResult) => void;
  reject: (error: BridgeError) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
  lastProgressAt: number | null;
  onProgress?: (progress: ProgressInfo) => void;
}

type CallStatus = 'running' | 'completed' | 'failed' | 'unknown' | 'timeout';

interface CallRecord {
  callId: string;
  command: string;
  connectionId: string;
  fileName: string;
  status: CallStatus;
  startedAt: number;
  finishedAt: number | null;
  lastProgressAt: number | null;
  /** What the call returned or why it failed, for get_call_result. Full result only if the caller never got it. */
  outcome?: Record<string, unknown>;
}

interface PeerEntry {
  peerId: string;
  pid: number | null;
  clientName: string;
  version: string | null;
  connectedAt: number;
  lastCallAt: number | null;
  socket: WebSocket | null;
  alive: boolean;
  local: boolean;
}

interface PeerPending {
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: NodeJS.Timeout;
  onProgress?: (progress: ProgressInfo) => void;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

function parseJson(data: RawData): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data.toString());
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function parseInfo(value: unknown): PluginInfo | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.connectionId !== 'string' || typeof v.fileName !== 'string') return null;
  return {
    connectionId: v.connectionId,
    fileKey: typeof v.fileKey === 'string' ? v.fileKey : null,
    fileName: v.fileName,
    editorType: String(v.editorType ?? 'figma'),
    currentPageId: String(v.currentPageId ?? ''),
    currentPageName: String(v.currentPageName ?? ''),
    pluginVersion: String(v.pluginVersion ?? 'unknown'),
  };
}

/** -1, 0 or 1; non-numeric parts compare as 0, so "unknown" sorts before any real version. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number(part) || 0);
  const pb = b.split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

function routeOf(conn: PluginConn): RoutedTo {
  const { connectionId, fileName, fileKey, editorType, currentPageId, currentPageName } = conn.info;
  return { connectionId, fileName, fileKey, editorType, currentPage: { id: currentPageId, name: currentPageName } };
}

function describeConn(conn: PluginConn): string {
  const { fileName, editorType, currentPageName, connectionId, fileKey } = conn.info;
  return (
    `"${fileName}" (${editorType}, page "${currentPageName}") connectionId=${connectionId}` +
    (fileKey ? ` fileKey=${fileKey}` : '') +
    (conn.socket ? '' : ' [reconnecting]')
  );
}

/** Tells the caller when the plugin in a file runs a different build than this server. */
function versionWarnings(conn: PluginConn): string[] {
  const { pluginVersion, fileName } = conn.info;
  const order = compareVersions(pluginVersion, VERSION);
  if (order < 0) {
    return [
      `The Local MCP Bridge plugin in "${fileName}" is v${pluginVersion} but this server is v${VERSION}. ` +
        'Close the plugin in that file and run it again to load the update.',
    ];
  }
  if (order > 0) {
    return [
      `The Local MCP Bridge plugin in "${fileName}" is v${pluginVersion} but this server is only v${VERSION}. ` +
        'Restart the MCP client so it starts the rebuilt server.',
    ];
  }
  return [];
}

/** Same document: by fileKey when both have one, else by name and editor type. */
function sameFile(a: PluginInfo, b: PluginInfo): boolean {
  if (a.fileKey && b.fileKey) return a.fileKey === b.fileKey;
  return a.fileName.toLowerCase() === b.fileName.toLowerCase() && a.editorType === b.editorType;
}

const fileIdentity = (conn: PluginConn) => conn.info.fileKey ?? `${conn.info.editorType}:${conn.info.fileName.toLowerCase()}`;

/**
 * Caps each ID list of a change summary for results (counts stay exact). Accepts the plugin's
 * { created, createdCount, ... } shape and older plain lists.
 */
export function capChanges(changes: unknown, callId?: string): unknown {
  if (!changes || typeof changes !== 'object') return changes;
  const source = changes as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  let capped = false;
  for (const key of ['created', 'deleted', 'modified']) {
    const list = Array.isArray(source[key]) ? (source[key] as unknown[]) : [];
    const count = typeof source[`${key}Count`] === 'number' ? (source[`${key}Count`] as number) : list.length;
    out[key] = list.slice(0, CHANGE_LIST_CAP);
    out[`${key}Count`] = count;
    if (count > CHANGE_LIST_CAP) capped = true;
  }
  if (capped) {
    out.truncated =
      `Each list shows at most ${CHANGE_LIST_CAP} IDs; ` +
      (callId ? `get_call_result("${callId}") returns them in full.` : 'get_call_result returns them in full.');
  }
  return out;
}

function capNotices(notices: unknown): unknown {
  if (!Array.isArray(notices)) return notices;
  return notices.map((notice: Record<string, unknown>) => ({
    ...notice,
    changes: capChanges(notice.changes, typeof notice.callId === 'string' ? notice.callId : undefined),
  }));
}

function matchesTarget(conn: PluginConn, target: Target): boolean {
  const { connectionId, fileKey, fileName } = conn.info;
  if (target.connectionId && target.connectionId !== connectionId) return false;
  if (target.fileKey && target.fileKey !== fileKey) return false;
  if (target.fileName && target.fileName.toLowerCase() !== fileName.toLowerCase()) return false;
  return true;
}

const hasTarget = (target?: Target): target is Target =>
  !!target && !!(target.connectionId || target.fileKey || target.fileName);

/** Compact, size-bounded record of a plugin reply for the call log. */
function outcomeOf(msg: Record<string, unknown>, callerGotIt: boolean): Record<string, unknown> {
  const extras = {
    ...(msg.changes ? { changes: msg.changes } : {}),
    ...(msg.changesNote ? { changesNote: msg.changesNote } : {}),
    ...(msg.rolledBack !== undefined ? { rolledBack: msg.rolledBack } : {}),
  };
  if (!msg.ok) {
    const error = { ...((msg.error ?? {}) as Record<string, unknown>) };
    if (Array.isArray(error.logs) && error.logs.length > 50) {
      error.logs = [`... ${error.logs.length - 50} earlier lines omitted`, ...error.logs.slice(-50)];
    }
    return { ok: false, error, ...extras };
  }
  const json = JSON.stringify(msg.result ?? null);
  const limit = callerGotIt ? RESULT_PREVIEW_CHARS : LATE_RESULT_MAX_CHARS;
  return json.length <= limit
    ? { ok: true, result: msg.result ?? null, ...extras }
    : { ok: true, resultPreview: `${json.slice(0, RESULT_PREVIEW_CHARS)}...`, resultChars: json.length, ...extras };
}

/** Binds the port on loopback. Resolves null when another process already owns it. */
function listen(port: number): Promise<Server | null> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ app: APP_ID, protocol: PROTOCOL, version: VERSION, pid: process.pid }));
    } else {
      res.writeHead(426).end('WebSocket only');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Identifies the process on the port without opening a WebSocket (so a plugin slot is never touched). */
async function probeHub(port: number): Promise<{ app?: string; protocol?: number; version?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as { app?: string; protocol?: number; version?: string; pid?: number }) : null;
  } catch {
    return null;
  }
}

/**
 * Routes tool calls to Figma plugins.
 *
 * The first server process to bind the port becomes the hub. It keeps a registry of plugin
 * connections (one per open file, addressed by connectionId), a paced queue per plugin, and a
 * log of recent calls. Every later process becomes a peer that forwards calls to the hub, so
 * several MCP clients share the plugins safely. Peers that stay idle disconnect (go dormant) and
 * reconnect on their next call. If the hub exits, a connected peer takes over the port and the
 * plugins reconnect to it.
 */
export class FigmaLink {
  private readonly opts: LinkOptions;
  private readonly events = new EventEmitter().setMaxListeners(0);
  private readonly self: PeerEntry;
  private readonly startedAt = Date.now();
  private paceMs: number;
  private mode: Role = 'starting';
  private problem = '';
  private closed = false;

  // hub state
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly plugins = new Map<string, PluginConn>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly calls = new Map<string, CallRecord>();
  private readonly peers = new Map<string, PeerEntry>();
  private lastDisconnect: Record<string, unknown> | null = null;
  private legacyRejectedAt: number | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  // peer state
  private hub: WebSocket | null = null;
  private readonly peerPending = new Map<string, PeerPending>();
  private lastPeerActivity = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private goingDormant = false;
  private handingOver = false;

  constructor(opts: LinkOptions) {
    this.opts = opts;
    this.paceMs = opts.paceMs;
    this.self = {
      peerId: randomUUID(),
      pid: process.pid,
      clientName: 'unknown',
      version: VERSION,
      connectedAt: Date.now(),
      lastCallAt: null,
      socket: null,
      alive: true,
      local: true,
    };
    void this.start();
  }

  get role(): Role {
    return this.mode;
  }

  /** Records the MCP client's name so bridge_status can tell clients apart. */
  setClientName(name: string): void {
    this.self.clientName = name;
    if (this.mode === 'peer') this.sendHello();
  }

  /** Runs a plugin command in the targeted file (paced per file) and resolves with its envelope. */
  async call(command: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<CallEnvelope> {
    await this.ready();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.mode === 'hub') {
      return this.hubCall(this.self, command, params, timeoutMs, opts.target, opts.onProgress);
    }
    return (await this.forward({ type: 'call', command, params, timeoutMs, target: opts.target }, opts.onProgress)) as CallEnvelope;
  }

  /** Hub-level requests that are not paced: status, target resolution, call lookups, settings. */
  async control(action: ControlAction, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ready();
    if (this.mode === 'hub') {
      this.self.lastCallAt = Date.now();
      return this.hubControl(action, args);
    }
    return this.forward({ type: 'control', action, args });
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    this.http?.close();
    this.hub?.terminate();
  }

  private async ready(): Promise<void> {
    if (this.mode === 'hub' || this.hub?.readyState === WebSocket.OPEN) return;
    if (this.mode === 'dormant') {
      // Woken by a call: become hub if the port is free, otherwise reconnect as a peer.
      this.mode = 'starting';
      void this.start();
    }
    try {
      await once(this.events, 'ready', { signal: AbortSignal.timeout(this.opts.connectTimeoutMs) });
    } catch {
      throw new BridgeError(
        `figma-local-mcp is not ready on port ${this.opts.port}: ${this.problem || 'still starting'}`,
        { code: 'hub-unavailable' },
      );
    }
  }

  /** `eager`: we were just handed the hub, so keep trying to bind the port for a moment. */
  private async start(eager = false): Promise<void> {
    if (this.closed || this.mode === 'dormant') return;
    this.mode = 'starting';
    try {
      let http = await listen(this.opts.port);
      for (let i = 0; !http && eager && i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        http = await listen(this.opts.port);
      }
      if (http) return this.becomeHub(http);
      const health = await probeHub(this.opts.port);
      // Same protocol: join as a peer. If this build is newer, that hub hands the port over (see handOver).
      if (health?.app === APP_ID && health.protocol === PROTOCOL) return this.becomePeer();
      if (health?.app === APP_ID) {
        const pid = health.pid ?? '?';
        const stop = process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
        this.problem =
          `port ${this.opts.port} is held by figma-local-mcp ${health.version ?? '(build before 3.0)'} (pid ${pid}), ` +
          `which speaks protocol ${health.protocol ?? '?'} while this server (v${VERSION}) speaks ${PROTOCOL}. ` +
          `Restart the MCP client that started it (or end that process: ${stop}).`;
      } else {
        this.problem = `port ${this.opts.port} is held by another program`;
      }
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
    }
    this.opts.log(`Bridge unavailable (${this.problem}); retrying in 5s`);
    setTimeout(() => void this.start(), 5000);
  }

  // =============================== hub ===============================

  private becomeHub(http: Server): void {
    this.http = http;
    this.wss = new WebSocketServer({ server: http });
    this.wss.on('error', (err) => this.opts.log(`Hub error: ${err.message}`));
    this.wss.on('connection', (ws, req) =>
      req.url?.startsWith(PEER_PATH) ? this.attachPeer(ws) : this.attachPluginSocket(ws),
    );
    this.peers.set(this.self.peerId, this.self);
    this.pingTimer = setInterval(() => this.checkLiveness(), PING_INTERVAL_MS);
    this.pingTimer.unref();
    this.mode = 'hub';
    this.problem = '';
    this.opts.log(`Hub v${VERSION}: listening on ws://localhost:${this.opts.port}`);
    this.events.emit('ready');
  }

  private async hubCall(
    caller: PeerEntry,
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    target: Target | undefined,
    onProgress?: (progress: ProgressInfo) => void,
  ): Promise<CallEnvelope> {
    caller.lastCallAt = Date.now();
    if (this.handingOver) {
      throw new BridgeError('The bridge is switching to a newer figma-local-mcp server; retry in a few seconds.', {
        code: 'hub-moving', retryable: true,
      });
    }
    const conn = await this.resolveTarget(target);
    const position = conn.queue.size;
    const enqueuedAt = Date.now();
    if (position > 0) this.opts.log(`Queued ${command} for "${conn.info.fileName}" behind ${position} task(s)`);
    return conn.queue.run(async () => {
      const waitedMs = Date.now() - enqueuedAt;
      const out = await this.sendToPlugin(conn, command, params, timeoutMs, onProgress);
      const warnings = this.warningsFor(conn, out.warnings);
      return {
        callId: out.callId,
        routedTo: routeOf(conn),
        queue: { position, waitedMs },
        result: out.result,
        ...(out.changes ? { changes: capChanges(out.changes, out.callId) as CallEnvelope['changes'] } : {}),
        ...(out.changesNote ? { changesNote: out.changesNote } : {}),
        ...(out.rolledBack !== undefined ? { rolledBack: out.rolledBack } : {}),
        ...(out.lateChanges?.length ? { lateChanges: capNotices(out.lateChanges) as CallEnvelope['lateChanges'] } : {}),
        ...(out.unattributedChanges?.length
          ? { unattributedChanges: capNotices(out.unattributedChanges) as CallEnvelope['unattributedChanges'] }
          : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    });
  }

  /** Version warnings for a file: the hub's own view, else whatever the plugin reported. */
  private warningsFor(conn: PluginConn, fromPlugin?: unknown): string[] {
    const own = versionWarnings(conn);
    if (own.length) return own;
    return Array.isArray(fromPlugin) ? fromPlugin.filter((w): w is string => typeof w === 'string') : [];
  }

  private async hubControl(action: string, args: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'status':
        return this.status();
      case 'resolve_target':
        return routeOf(await this.resolveTarget(args.target as Target | undefined));
      case 'get_call_result':
        return this.getCallResult(String(args.callId ?? ''));
      case 'configure': {
        if (typeof args.paceMs === 'number' && args.paceMs >= 0) {
          this.paceMs = args.paceMs;
          for (const conn of this.plugins.values()) conn.queue.gapMs = args.paceMs;
          this.opts.log(`Pace set to ${args.paceMs} ms`);
        }
        return { paceMs: this.paceMs };
      }
      default:
        throw new BridgeError(`Unknown control action "${action}"`, { code: 'bad-request' });
    }
  }

  /** Picks the plugin for a call. Never guesses between several files. */
  private async resolveTarget(target?: Target): Promise<PluginConn> {
    const targeted = hasTarget(target);
    const deadline = Date.now() + (this.plugins.size ? TARGET_WAIT_MS : this.opts.connectTimeoutMs);
    for (;;) {
      const all = [...this.plugins.values()];
      const matches = targeted ? all.filter((conn) => matchesTarget(conn, target)) : all;
      const live = matches.filter((conn) => conn.socket);
      // Several open connections, or connections to different files: never guess. (A reconnecting
      // connection to the same file as a live one is a re-run plugin, not a second choice.)
      if (live.length > 1 || new Set(matches.map(fileIdentity)).size > 1) {
        const list = matches.map((conn) => `  - ${describeConn(conn)}`).join('\n');
        throw new BridgeError(
          targeted
            ? `Ambiguous target ${JSON.stringify(target)}: it matches ${matches.length} connections. ` +
                `Narrow it with connectionId or fileKey.\n${list}`
            : `Ambiguous target: ${new Set(matches.map(fileIdentity)).size} Figma files have the plugin open. Pass target ` +
                `{ fileName | fileKey | connectionId } (or call set_default_target).\n${list}`,
          { code: 'ambiguous-target', connected: matches.map(routeOf) },
        );
      }
      if (live.length === 1) return live[0];
      // No match yet, or the only match is reconnecting: wait for the registry to change.
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw this.noPluginError(target, all);
      try {
        await once(this.events, 'registry', { signal: AbortSignal.timeout(remaining) });
      } catch {
        // deadline reached; the loop re-checks and throws
      }
    }
  }

  private noPluginError(target: Target | undefined, all: PluginConn[]): BridgeError {
    const outdated = this.legacyRejectedAt
      ? ' An outdated plugin connection was rejected: close the Local MCP Bridge plugin in Figma and run it again.'
      : '';
    if (!all.length) {
      return new BridgeError(
        'No Figma file has the Local MCP Bridge plugin running. In Figma Desktop run ' +
          `Plugins > Development > Local MCP Bridge in the file you want to edit.${outdated}`,
        { code: 'no-plugin' },
      );
    }
    return new BridgeError(
      `No connected Figma file matches target ${JSON.stringify(target)}.${outdated}\nConnected:\n` +
        all.map((conn) => `  - ${describeConn(conn)}`).join('\n'),
      { code: 'target-not-found', connected: all.map(routeOf) },
    );
  }

  private async sendToPlugin(
    conn: PluginConn,
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    onProgress?: (progress: ProgressInfo) => void,
  ): Promise<PluginResult & { callId: string }> {
    const callId = randomUUID();
    const routedTo = routeOf(conn);
    let socket: WebSocket;
    try {
      socket = await this.liveSocket(conn);
    } catch (err) {
      throw new BridgeError(err instanceof Error ? err.message : String(err), {
        code: 'not-sent', status: 'not-sent', callId, routedTo,
      });
    }
    this.remember({
      callId, command, connectionId: conn.info.connectionId, fileName: conn.info.fileName,
      status: 'running', startedAt: Date.now(), finishedAt: null, lastProgressAt: null,
    });
    try {
      const out = await this.request(conn, socket, callId, command, params, timeoutMs, false, onProgress);
      return { callId, ...out };
    } catch (err) {
      const error = BridgeError.from(err);
      const details: Record<string, unknown> = { ...error.details, callId, routedTo };
      if (details.changes) details.changes = capChanges(details.changes, callId);
      if (details.lateChanges) details.lateChanges = capNotices(details.lateChanges);
      if (details.unattributedChanges) details.unattributedChanges = capNotices(details.unattributedChanges);
      const merged = this.warningsFor(conn, details.warnings);
      if (merged.length) details.warnings = merged;
      else delete details.warnings;
      throw new BridgeError(error.message, details);
    }
  }

  private request(
    conn: PluginConn,
    socket: WebSocket,
    callId: string,
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    internal: boolean,
    onProgress?: (progress: ProgressInfo) => void,
  ): Promise<PluginResult> {
    const message = JSON.stringify({ id: callId, command, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.failCall(
            callId,
            'timeout',
            `No reply from Figma to "${command}" within ${timeoutMs / 1000}s. The plugin may still be running it; ` +
              `check get_call_result("${callId}") before retrying.`,
            'timeout',
          ),
        timeoutMs,
      );
      this.pending.set(callId, {
        callId, command, conn, message, internal, resolve, reject, timer,
        startedAt: Date.now(), lastProgressAt: null, onProgress,
      });
      socket.send(message, (err) => {
        if (err) this.failCall(callId, 'unknown', `Could not send "${command}" to the plugin: ${err.message}`, 'send failed');
      });
    });
  }

  /** Resolves with the plugin's open socket, waiting through a short reconnect if needed. */
  private async liveSocket(conn: PluginConn): Promise<WebSocket> {
    const deadline = Date.now() + RECONNECT_GRACE_MS;
    for (;;) {
      if (conn.socket?.readyState === WebSocket.OPEN) return conn.socket;
      if (this.plugins.get(conn.info.connectionId) !== conn) {
        throw new Error(`The plugin in "${conn.info.fileName}" disconnected before the call was sent; nothing ran.`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`The plugin in "${conn.info.fileName}" is reconnecting and did not come back in time; nothing ran.`);
      }
      try {
        await once(this.events, 'registry', { signal: AbortSignal.timeout(remaining) });
      } catch {
        // re-check
      }
    }
  }

  private failCall(callId: string, status: CallStatus, message: string, reason: string): void {
    const entry = this.pending.get(callId);
    if (!entry) return;
    this.pending.delete(callId);
    clearTimeout(entry.timer);
    const details = {
      code: status === 'timeout' ? 'timeout' : 'plugin-disconnected',
      status: 'unknown',
      reason,
      startedAt: iso(entry.startedAt),
      lastProgressAt: iso(entry.lastProgressAt),
    };
    const record = this.calls.get(callId);
    if (record) {
      record.status = status;
      record.finishedAt = Date.now();
      record.outcome = { ok: false, error: { message, ...details } };
    }
    entry.reject(new BridgeError(message, details));
  }

  private onPluginReply(msg: Record<string, unknown>): void {
    const callId = String(msg.id);
    const entry = this.pending.get(callId);
    const record = this.calls.get(callId);
    if (record && record.status !== 'completed' && record.status !== 'failed') {
      record.status = msg.ok ? 'completed' : 'failed';
      record.finishedAt = Date.now();
      // Keep the full result only when the caller gave up (timeout/disconnect) and never received it.
      record.outcome = outcomeOf(msg, !!entry);
    }
    if (!entry) return;
    this.pending.delete(callId);
    clearTimeout(entry.timer);
    const extras = {
      ...(msg.changes ? { changes: msg.changes } : {}),
      ...(msg.changesNote ? { changesNote: msg.changesNote } : {}),
      ...(Array.isArray(msg.lateChanges) && msg.lateChanges.length ? { lateChanges: msg.lateChanges } : {}),
      ...(Array.isArray(msg.unattributedChanges) && msg.unattributedChanges.length
        ? { unattributedChanges: msg.unattributedChanges }
        : {}),
      ...(Array.isArray(msg.warnings) && msg.warnings.length ? { warnings: msg.warnings } : {}),
    };
    if (msg.ok) {
      entry.resolve({
        result: msg.result,
        ...(extras as Omit<PluginResult, 'result'>),
        rolledBack: msg.rolledBack as boolean | undefined,
      });
    } else {
      const error = (msg.error ?? {}) as Record<string, unknown>;
      const { message, ...details } = error;
      entry.reject(new BridgeError(String(message ?? 'Unknown error from Figma'), { code: 'plugin-error', ...details, ...extras }));
    }
  }

  /** A call's changes that Figma delivered after the call replied; kept for get_call_result. */
  private onLateChanges(msg: Record<string, unknown>): void {
    const record = this.calls.get(String(msg.callId));
    if (!record) return;
    record.outcome = {
      ...(record.outcome ?? {}),
      lateChanges: { changes: msg.changes ?? null, complete: msg.complete !== false },
    };
  }

  /** Changes that could belong to any of several calls: kept on each of them for get_call_result. */
  private onUnattributedChanges(msg: Record<string, unknown>): void {
    const callIds = Array.isArray(msg.possibleCallIds) ? msg.possibleCallIds.map(String) : [];
    const notice = { possibleCallIds: callIds, changes: msg.changes ?? null };
    for (const callId of callIds) {
      const record = this.calls.get(callId);
      if (!record) continue;
      const previous = (record.outcome?.unattributedChanges as unknown[] | undefined) ?? [];
      record.outcome = { ...(record.outcome ?? {}), unattributedChanges: [...previous, notice] };
    }
  }

  private onPluginProgress(msg: Record<string, unknown>): void {
    const entry = this.pending.get(String(msg.callId));
    if (!entry) return;
    entry.lastProgressAt = Date.now();
    const record = this.calls.get(entry.callId);
    if (record) record.lastProgressAt = entry.lastProgressAt;
    entry.onProgress?.({
      callId: entry.callId,
      at: iso(entry.lastProgressAt)!,
      ...(typeof msg.message === 'string' ? { message: msg.message } : {}),
    });
  }

  private attachPluginSocket(ws: WebSocket): void {
    let conn: PluginConn | null = null;
    const registerTimer = setTimeout(() => {
      if (conn) return;
      this.legacyRejectedAt = Date.now();
      this.opts.log('Closing a plugin connection that never registered (outdated plugin; re-run it in Figma)');
      ws.close(4001, 'Outdated Local MCP Bridge plugin: close it and run it again');
    }, REGISTER_TIMEOUT_MS);

    ws.on('pong', () => {
      if (conn) conn.alive = true;
    });
    ws.on('message', (data) => {
      const msg = parseJson(data);
      if (!msg) return;
      if (msg.type === 'register') {
        const info = parseInfo(msg.info);
        if (!info) return;
        clearTimeout(registerTimer);
        conn = this.register(ws, info);
        return;
      }
      if (!conn) return;
      conn.lastSeenAt = Date.now();
      conn.alive = true;
      if (msg.type === 'progress') this.onPluginProgress(msg);
      else if (msg.type === 'late-changes') this.onLateChanges(msg);
      else if (msg.type === 'unattributed-changes') this.onUnattributedChanges(msg);
      else if (msg.type === 'reply' || typeof msg.id === 'string') this.onPluginReply(msg);
    });
    ws.on('error', (err) => this.opts.log(`Plugin socket error: ${err.message}`));
    ws.on('close', (code, reason) => {
      clearTimeout(registerTimer);
      if (conn && conn.socket === ws) this.onPluginClose(conn, `${code}${reason.length ? ` ${reason.toString()}` : ''}`);
    });
  }

  private register(ws: WebSocket, info: PluginInfo): PluginConn {
    const conn = this.registerConn(ws, info);
    // Let the plugin know which server build it talks to (plugins warn about outdated servers).
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hub-hello', version: VERSION, protocol: PROTOCOL }));
    return conn;
  }

  private registerConn(ws: WebSocket, info: PluginInfo): PluginConn {
    const now = Date.now();
    const existing = this.plugins.get(info.connectionId);
    if (existing) {
      const renamed = existing.info.fileName !== info.fileName;
      existing.info = info;
      existing.lastSeenAt = now;
      existing.alive = true;
      if (existing.socket !== ws) {
        // Same plugin instance on a new socket: a reconnect. Retire the old socket first.
        const old = existing.socket;
        existing.socket = ws;
        existing.reconnects++;
        if (existing.graceTimer) clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
        old?.terminate();
        this.opts.log(`Plugin reconnected: ${describeConn(existing)} (reconnect #${existing.reconnects})`);
        void this.recoverInFlight(existing);
      } else if (renamed) {
        this.opts.log(`Plugin file renamed: ${describeConn(existing)}`);
      }
      this.events.emit('registry');
      return existing;
    }
    // A plugin re-run in the same file registers under a new connectionId; the old instance (disconnected,
    // waiting out its grace period) is gone for good, so drop it now instead of making targets ambiguous.
    for (const old of [...this.plugins.values()]) {
      if (old.socket || !sameFile(old.info, info)) continue;
      this.expire(old, `the plugin in "${old.info.fileName}" was run again (new connectionId ${info.connectionId})`);
    }
    const conn: PluginConn = {
      info, socket: ws, alive: true, queue: new PacedQueue(this.paceMs),
      connectedAt: now, lastSeenAt: now, reconnects: 0, graceTimer: null,
    };
    this.plugins.set(info.connectionId, conn);
    this.opts.log(`Plugin connected: ${describeConn(conn)} v${info.pluginVersion}`);
    for (const warning of versionWarnings(conn)) this.opts.log(warning);
    this.events.emit('registry');
    return conn;
  }

  private inFlight(conn: PluginConn): PendingCall[] {
    return [...this.pending.values()].filter((entry) => entry.conn === conn && !entry.internal);
  }

  private onPluginClose(conn: PluginConn, reason: string): void {
    conn.socket = null;
    const inFlight = this.inFlight(conn);
    this.lastDisconnect = {
      connectionId: conn.info.connectionId,
      fileName: conn.info.fileName,
      at: iso(Date.now()),
      reason,
      inFlightCallId: inFlight[0]?.callId ?? null,
    };
    this.opts.log(`Plugin disconnected: ${describeConn(conn)} (${reason}); waiting ${RECONNECT_GRACE_MS / 1000}s for it to return`);
    // Internal lookups can't survive a reconnect; user calls wait out the grace period.
    for (const entry of this.pending.values()) {
      if (entry.conn === conn && entry.internal) this.failCall(entry.callId, 'unknown', 'Plugin disconnected', 'plugin disconnected');
    }
    conn.graceTimer = setTimeout(() => this.expire(conn), RECONNECT_GRACE_MS);
    this.events.emit('registry');
  }

  /** The plugin did not come back (or was superseded): report in-flight calls as unknown and drop it. */
  private expire(conn: PluginConn, superseded?: string): void {
    if (conn.socket) return;
    if (conn.graceTimer) clearTimeout(conn.graceTimer);
    conn.graceTimer = null;
    for (const entry of this.inFlight(conn)) {
      this.failCall(
        entry.callId,
        'unknown',
        superseded
          ? `The call's outcome is unknown: ${superseded} before it replied. Read back the affected nodes before retrying.`
          : `The plugin in "${conn.info.fileName}" disconnected before replying and did not reconnect within ` +
              `${RECONNECT_GRACE_MS / 1000}s. The call may have partially applied. When the plugin is running again, ` +
              `get_call_result("${entry.callId}") reports what happened; otherwise read back the affected nodes before retrying.`,
        superseded ? 'plugin re-run' : 'plugin disconnected',
      );
    }
    if (this.plugins.get(conn.info.connectionId) === conn) this.plugins.delete(conn.info.connectionId);
    this.opts.log(`Plugin removed: ${describeConn(conn)}${superseded ? ` (${superseded})` : ''}`);
    this.events.emit('registry');
  }

  /** After a reconnect, find out what happened to calls that were in flight and re-send any that never arrived. */
  private async recoverInFlight(conn: PluginConn): Promise<void> {
    for (const entry of this.inFlight(conn)) {
      const socket = conn.socket;
      if (!socket) return;
      try {
        const lookup = await this.request(
          conn, socket, randomUUID(), '__get_call_result', { callId: entry.callId }, 5000, true,
        );
        const info = lookup.result as { status?: string; reply?: Record<string, unknown> };
        if (info?.reply && this.pending.has(entry.callId)) {
          this.onPluginReply(info.reply);
        } else if (info?.status === 'unknown-call' && this.pending.has(entry.callId)) {
          this.opts.log(`Re-sending ${entry.command} (${entry.callId}); the plugin never received it`);
          socket.send(entry.message);
        }
      } catch (err) {
        this.opts.log(`Could not recover call ${entry.callId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private remember(record: CallRecord): void {
    this.calls.set(record.callId, record);
    while (this.calls.size > CALL_LOG_SIZE) this.calls.delete(this.calls.keys().next().value!);
  }

  /** Asks one plugin what it knows about a call (plugins keep their own record of recent calls). */
  private async askPlugin(conn: PluginConn, callId: string): Promise<{ status?: string; command?: string; reply?: Record<string, unknown> } | null> {
    if (conn.socket?.readyState !== WebSocket.OPEN) return null;
    try {
      const lookup = await this.request(conn, conn.socket, randomUUID(), '__get_call_result', { callId }, 5000, true);
      return lookup.result as { status?: string; command?: string; reply?: Record<string, unknown> };
    } catch {
      return null;
    }
  }

  private async getCallResult(callId: string): Promise<unknown> {
    let record = this.calls.get(callId);
    if (!record) {
      // Not in this hub's log (e.g. the hub changed since): the plugins may still remember it.
      for (const conn of this.plugins.values()) {
        const info = await this.askPlugin(conn, callId);
        if (!info || info.status === 'unknown-call') continue;
        record = {
          callId, command: info.command ?? 'unknown', connectionId: conn.info.connectionId,
          fileName: conn.info.fileName, status: 'running', startedAt: Date.now(), finishedAt: null, lastProgressAt: null,
        };
        this.remember(record);
        if (info.reply) this.onPluginReply(info.reply);
        break;
      }
    } else if (record.status === 'unknown' || record.status === 'timeout' || record.status === 'running') {
      // Outcome unknown to the hub: ask the plugin that ran it.
      const conn = this.plugins.get(record.connectionId);
      const info = conn ? await this.askPlugin(conn, callId) : null;
      if (info?.reply) this.onPluginReply(info.reply);
      else if (info?.status === 'running' || info?.status === 'queued') record.status = 'running';
    }
    if (!record) {
      throw new BridgeError(
        `Unknown callId "${callId}". The hub keeps the last ${CALL_LOG_SIZE} calls and each plugin its last 50.`,
        { code: 'unknown-call' },
      );
    }
    return {
      callId: record.callId,
      command: record.command,
      fileName: record.fileName,
      connectionId: record.connectionId,
      status: record.status,
      startedAt: iso(record.startedAt),
      finishedAt: iso(record.finishedAt),
      lastProgressAt: iso(record.lastProgressAt),
      ...(record.outcome ? { outcome: record.outcome } : {}),
    };
  }

  private status(): Record<string, unknown> {
    const plugins = [...this.plugins.values()];
    const now = Date.now();
    return {
      hub: {
        version: VERSION,
        pid: process.pid,
        port: this.opts.port,
        paceMs: this.paceMs,
        queueSize: plugins.reduce((sum, conn) => sum + conn.queue.size, 0),
        uptimeSec: Math.round((now - this.startedAt) / 1000),
        idleClientsDisconnectAfterSec: Math.round(this.opts.peerIdleMs / 1000),
      },
      plugins: plugins.map((conn) => {
        const warnings = versionWarnings(conn);
        return {
          connectionId: conn.info.connectionId,
          fileName: conn.info.fileName,
          fileKey: conn.info.fileKey,
          editorType: conn.info.editorType,
          currentPage: { id: conn.info.currentPageId, name: conn.info.currentPageName },
          pluginVersion: conn.info.pluginVersion,
          connected: !!conn.socket,
          connectedAt: iso(conn.connectedAt),
          lastSeenAt: iso(conn.lastSeenAt),
          inFlightCallId: this.inFlight(conn)[0]?.callId ?? null,
          reconnects: conn.reconnects,
          queueSize: conn.queue.size,
          ...(warnings.length ? { warning: warnings[0] } : {}),
        };
      }),
      peers: [...this.peers.values()].map((peer) => ({
        peerId: peer.peerId,
        clientName: peer.clientName,
        role: peer.local ? 'hub' : 'peer',
        pid: peer.pid,
        version: peer.version,
        connectedAt: iso(peer.connectedAt),
        lastCallAt: iso(peer.lastCallAt),
        idleSec: Math.round((now - (peer.lastCallAt ?? peer.connectedAt)) / 1000),
      })),
      lastDisconnect: this.lastDisconnect,
      recentCalls: [...this.calls.values()].slice(-RECENT_CALLS_IN_STATUS).map((record) => ({
        callId: record.callId,
        command: record.command,
        fileName: record.fileName,
        status: record.status,
        startedAt: iso(record.startedAt),
        durationMs: record.finishedAt ? record.finishedAt - record.startedAt : null,
        ...(record.outcome && record.outcome.ok === false
          ? { error: (record.outcome.error as Record<string, unknown> | undefined)?.message }
          : {}),
      })),
    };
  }

  /**
   * Terminates sockets that stopped answering pings (never a plugin that is running a call), and
   * disconnects peers that stayed idle well past the point where they should have gone dormant.
   */
  private checkLiveness(): void {
    for (const conn of this.plugins.values()) {
      const socket = conn.socket;
      if (!socket) continue;
      if (!conn.alive && !this.inFlight(conn).length) {
        this.opts.log(`Plugin stopped answering pings: ${describeConn(conn)}`);
        socket.terminate();
        continue;
      }
      conn.alive = false;
      socket.ping();
    }
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (peer.local || !peer.socket) continue;
      if (!peer.alive) {
        this.opts.log(`Pruning unresponsive client ${peer.clientName} (pid ${peer.pid})`);
        peer.socket.terminate();
        continue;
      }
      if (now - (peer.lastCallAt ?? peer.connectedAt) > this.opts.peerIdleMs + PEER_IDLE_BACKSTOP_MS) {
        this.opts.log(`Disconnecting idle client ${peer.clientName} (pid ${peer.pid})`);
        peer.socket.close(IDLE_CLOSE_CODE, 'idle');
        continue;
      }
      peer.alive = false;
      peer.socket.ping();
    }
  }

  private attachPeer(ws: WebSocket): void {
    const peer: PeerEntry = {
      peerId: randomUUID(), pid: null, clientName: 'unknown', version: null, connectedAt: Date.now(),
      lastCallAt: null, socket: ws, alive: true, local: false,
    };
    let registeredId = peer.peerId;
    this.peers.set(registeredId, peer);
    const reply = (payload: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    ws.on('pong', () => (peer.alive = true));
    ws.on('message', (data) => {
      const msg = parseJson(data);
      if (!msg) return;
      peer.alive = true;
      if (msg.type === 'hello') {
        this.peers.delete(registeredId);
        registeredId = typeof msg.peerId === 'string' ? msg.peerId : registeredId;
        peer.peerId = registeredId;
        peer.pid = typeof msg.pid === 'number' ? msg.pid : null;
        peer.clientName = typeof msg.clientName === 'string' ? msg.clientName : 'unknown';
        peer.version = typeof msg.version === 'string' ? msg.version : null;
        this.peers.set(registeredId, peer);
        // A newer build joined: let it run the hub so every client gets its fixes.
        if (peer.version && compareVersions(peer.version, VERSION) > 0) void this.handOver(peer, ws);
        return;
      }
      if (typeof msg.id !== 'string') return;
      const id = msg.id;
      peer.lastCallAt = Date.now();
      const work =
        msg.type === 'control'
          ? this.hubControl(String(msg.action), (msg.args ?? {}) as Record<string, unknown>)
          : this.hubCall(
              peer,
              String(msg.command),
              (msg.params ?? {}) as Record<string, unknown>,
              typeof msg.timeoutMs === 'number' ? msg.timeoutMs : DEFAULT_TIMEOUT_MS,
              msg.target as Target | undefined,
              (progress) => reply({ type: 'progress', id, progress }),
            );
      work.then(
        (value) => reply({ type: 'result', id, ok: true, value }),
        (err) => reply({ type: 'result', id, ok: false, error: BridgeError.from(err).toJSON() }),
      );
    });
    ws.on('error', (err) => this.opts.log(`Peer socket error: ${err.message}`));
    ws.on('close', () => this.peers.delete(registeredId));
    this.opts.log(`Client connected (${this.peers.size - 1} remote)`);
  }

  /**
   * Gives the port to a newer server: waits (bounded) for queued and in-flight calls, tells the newer
   * process to take over, drops every connection (plugins and peers reconnect to the new hub), and
   * rejoins as a peer.
   */
  private async handOver(newer: PeerEntry, socket: WebSocket): Promise<void> {
    if (this.handingOver || this.mode !== 'hub') return;
    this.handingOver = true;
    this.opts.log(`Handing the hub over to newer build v${newer.version} (pid ${newer.pid}) once calls finish`);
    const deadline = Date.now() + HANDOVER_DRAIN_MS;
    const busy = () => this.pending.size > 0 || [...this.plugins.values()].some((conn) => conn.queue.size > 0);
    while (busy() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    if (socket.readyState !== WebSocket.OPEN || this.closed) {
      this.handingOver = false; // the newer process went away; keep serving
      return;
    }
    socket.close(HANDOVER_CLOSE_CODE, 'take over');
    this.closeHub('hub moving');
    this.handingOver = false;
    this.mode = 'starting';
    // Give the newer process a head start on the port, then rejoin as its peer.
    setTimeout(() => void this.start(), 1500);
  }

  private closeHub(reason: string): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const entry of [...this.pending.values()]) {
      this.failCall(
        entry.callId,
        'unknown',
        `The bridge moved to a newer server before Figma replied; get_call_result("${entry.callId}") reports the outcome.`,
        'hub handover',
      );
    }
    for (const conn of this.plugins.values()) {
      if (conn.graceTimer) clearTimeout(conn.graceTimer);
      conn.socket?.close(HANDOVER_CLOSE_CODE, reason);
    }
    this.plugins.clear();
    for (const peer of this.peers.values()) if (!peer.local) peer.socket?.close(HANDOVER_CLOSE_CODE, reason);
    this.peers.clear();
    this.wss?.close();
    this.wss = null;
    this.http?.close();
    this.http = null;
    this.events.emit('registry');
  }

  // =============================== peer ===============================

  private becomePeer(): void {
    this.mode = 'peer';
    this.lastPeerActivity = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}${PEER_PATH}`);
    ws.on('open', () => {
      this.hub = ws;
      this.problem = '';
      this.sendHello();
      this.startIdleTimer();
      this.opts.log(`Peer: forwarding calls through the hub on port ${this.opts.port}`);
      this.events.emit('ready');
    });
    ws.on('message', (data) => {
      const msg = parseJson(data);
      if (!msg || typeof msg.id !== 'string') return;
      const entry = this.peerPending.get(msg.id);
      if (!entry) return;
      if (msg.type === 'progress') {
        entry.onProgress?.(msg.progress as ProgressInfo);
        return;
      }
      this.peerPending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(BridgeError.from(msg.error));
    });
    ws.on('error', (err) => {
      this.problem = `hub connection failed: ${err.message}`;
    });
    ws.on('close', (code, reason) => {
      if (this.hub === ws) this.hub = null;
      if (this.idleTimer) clearInterval(this.idleTimer);
      this.idleTimer = null;
      for (const [id, entry] of this.peerPending) {
        this.peerPending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(
          new BridgeError(
            'The figma-local-mcp hub process exited before replying. The call may or may not have run; ' +
              'read back the affected nodes before retrying.',
            { code: 'hub-unavailable', status: 'unknown' },
          ),
        );
      }
      if (this.closed) return;
      if (this.goingDormant || code === IDLE_CLOSE_CODE) {
        // Idle: stay disconnected until the next call (see ready()).
        this.goingDormant = false;
        this.mode = 'dormant';
        this.opts.log('Peer: idle, disconnected from the hub until the next call');
        return;
      }
      if (code === HANDOVER_CLOSE_CODE && reason.toString() === 'take over') {
        this.opts.log('Peer: the hub was handed to this newer build; taking over the port');
        void this.start(true);
        return;
      }
      // Jitter so several peers don't race for the freed port in lockstep.
      setTimeout(() => void this.start(), 300 + Math.random() * 700);
    });
  }

  /** Goes dormant after peerIdleMs without calls, so idle clients don't linger in bridge_status. */
  private startIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    const every = Math.max(250, Math.min(30_000, this.opts.peerIdleMs / 4));
    this.idleTimer = setInterval(() => {
      const hub = this.hub;
      if (!hub || this.peerPending.size || Date.now() - this.lastPeerActivity < this.opts.peerIdleMs) return;
      this.goingDormant = true;
      hub.close(IDLE_CLOSE_CODE, 'idle');
    }, every);
    this.idleTimer.unref();
  }

  private sendHello(): void {
    if (this.hub?.readyState !== WebSocket.OPEN) return;
    this.hub.send(
      JSON.stringify({
        type: 'hello', peerId: this.self.peerId, pid: process.pid, clientName: this.self.clientName, version: VERSION,
      }),
    );
  }

  private forward(message: Record<string, unknown>, onProgress?: (progress: ProgressInfo) => void): Promise<unknown> {
    const hub = this.hub;
    if (hub?.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new BridgeError('Lost the connection to the figma-local-mcp hub; retry the call', { code: 'hub-unavailable' }),
      );
    }
    this.lastPeerActivity = Date.now();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.peerPending.delete(id);
        reject(new BridgeError('No reply from the figma-local-mcp hub', { code: 'timeout', status: 'unknown' }));
      }, PEER_REPLY_TIMEOUT_MS);
      this.peerPending.set(id, {
        resolve: (value) => {
          this.lastPeerActivity = Date.now();
          resolve(value);
        },
        reject,
        timer,
        onProgress,
      });
      hub.send(JSON.stringify({ ...message, id }), (err) => {
        if (!err) return;
        const entry = this.peerPending.get(id);
        if (!entry) return;
        this.peerPending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new BridgeError(`Could not reach the hub: ${err.message}`, { code: 'hub-unavailable' }));
      });
    });
  }
}
