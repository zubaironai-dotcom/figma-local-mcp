// Execution layer: runs commands relayed by ui.html against the Figma Plugin API and posts each
// result (or structured error) back with the originating call id.

const PLUGIN_VERSION = '3.4.0';
/** Identifies this plugin run; stable across WebSocket reconnects so the hub can resume in-flight calls. */
const CONNECTION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const SCRIPT_URL = 'figma-local-script.js';
const MARKER_PREFIX = 'mcp-marker:';
/** Raster exports are shrunk until they fit this many bytes. */
const MAX_EXPORT_BYTES = 1_500_000;
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_CHARS = 2_000;
const CALL_RECORDS_KEPT = 50;
/** After a script times out, later commands wait this long for it to settle before running anyway. */
const TIMED_OUT_SCRIPT_GRACE_MS = 60_000;
// Change tracking (see "change ledger" below). Heavy files deliver nodechange events 0.5-1.5 s late, and
// the first deliveries after the plugin starts can take several seconds.
const SENTINEL_KEY = 'mcp-sentinel';
/** The hidden, locked layer (one per page) that carries the sentinels, so no real layer is ever touched. */
const HELPER_ROLE_KEY = 'mcp-role';
const HELPER_ROLE = 'bridge-helper';
const HELPER_NAME = 'Local MCP Bridge helper (hidden; tracks changes, safe to delete)';
/** How long a script waits for its sentinel before replying (later events become lateChanges). */
const SENTINEL_WAIT_MS = 4_000;
/** A mutating call waits this long for earlier calls' sentinels before starting anyway. */
const GATE_MS = 10_000;
/** ...or only this long when an earlier sentinel already looks lost. */
const LOST_GATE_MS = 2_000;
/** A window still waiting for its sentinel after this long is closed as incomplete. */
const LATE_WINDOW_MAX_MS = 30_000;
/** Lost sentinels in a row (with no sentinel coming back in between) before sentinels are given up. */
const MAX_SENTINEL_MISSES = 2;
/** How many directly created node IDs to remember for attributing their creation events. */
const DIRECT_ORIGINS_KEPT = 20_000;
const UNLIKELY_EVENT_WAIT_MS = 120;
const QUIET_FALLBACK_MS = 1_500;
const EVENT_QUIET_MS = 150;
/** Change lists sent to the hub are capped at this many IDs each (with counts). */
const MAX_LISTED_CHANGES = 5_000;
const HUB_HELLO_TIMEOUT_MS = 2_500;
const HELPER_NAMES = [
  'yield', 'walk', 'findAll', 'getNode', 'assertFile', 'loadFontsFor', 'marker', 'hasMarker',
  'exportImage', 'returnImage', 'solidPaint', 'snapshot', 'page',
];

figma.showUI(__html__, { width: 300, height: 150, themeColors: true });

// Params arrive already validated by the MCP server's zod schemas.
type Params = Record<string, any>;
type Json = Record<string, unknown>;
type TextLike = TextNode | TextSublayerNode;

interface CommandMessage {
  id: string;
  command: string;
  params?: Params;
}

/** What a call changed: recorded directly by the plugin's own code, plus nodechange events for scripts. */
interface ChangeSet {
  created: Map<string, BaseNode | null>;
  deleted: Set<string>;
  modified: Map<string, Set<string>>;
}

/**
 * Collects the changes of one mutating call. Events are routed to the oldest open window; a window closes
 * when its sentinel's event comes back (Figma delivers events in order, so everything before it is the call's).
 */
interface ChangeWindow {
  callId: string;
  /** Opening order; a creation event proves every older window's sentinel should already have arrived. */
  seq: number;
  /** A lost sentinel was already counted for this window. */
  missCounted: boolean;
  /** Changes attributed before the call replied. */
  changes: ChangeSet;
  /** Changes attributed after the call replied (it timed out waiting, or is a tool that doesn't wait). */
  late: ChangeSet | null;
  /** The helper layer holding this window's sentinel, and the unique value written there. */
  carrierId: string | null;
  token: string | null;
  carrierAt: number;
  /** Bookkeeping window (startup priming, a dryRun's undo): reports nothing. */
  absorb: boolean;
  /** Node IDs whose events this bookkeeping window swallows (the nodes a dryRun's undo restores). */
  absorbIds: Set<string>;
  events: number;
  lastEventAt: number;
  closed: boolean;
  incomplete: boolean;
  wake: Array<() => void>;
}

/** Where engine-reported line numbers of a user script come from, measured once with a probe. */
interface ScriptCalibration {
  /** File token the engine prints for Function-constructor code ("<input>" in QuickJS, the sourceURL in V8). */
  file: string | null;
  /** Wrapper lines the engine puts above the script body. */
  offset: number;
  /** True when plugin frames carry the same file token, so line ranges must disambiguate. */
  shared: boolean;
}

interface CallContext {
  callId: string;
  logs: string[];
  cancelled: boolean;
  lastProgress: number;
  changes: ChangeSet | null;
  window: ChangeWindow | null;
  /** Page the call worked on (pageId), where its sentinel goes; defaults to the current page. */
  page: PageNode | null;
  script: { cal: ScriptCalibration; lineCount: number } | null;
  needsReencode: boolean;
  /** For execute_figma_code: settles when the user script really finishes (it may outlive a timeout). */
  settled?: Promise<void>;
}

interface CallRecord {
  callId: string;
  command: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  reply?: Json;
  lateChanges?: Json;
  unattributedChanges?: Json[];
}

// ------------------------------------------------------------------ registration

function fileInfo(): Json {
  let fileKey: string | null = null;
  try {
    fileKey = figma.fileKey ?? null;
  } catch {
    // only available to private/development plugins
  }
  return {
    connectionId: CONNECTION_ID,
    fileKey,
    fileName: figma.root.name,
    editorType: figma.editorType,
    currentPageId: figma.currentPage.id,
    currentPageName: figma.currentPage.name,
    pluginVersion: PLUGIN_VERSION,
  };
}

let lastInfo = '';
/** Sends registration info to the UI (and so to the hub) when it changes, or always when forced. */
function publishInfo(force = false): void {
  const info = fileInfo();
  const json = JSON.stringify(info);
  if (!force && json === lastInfo) return;
  lastInfo = json;
  figma.ui.postMessage({ type: 'register', info });
}

figma.on('currentpagechange', () => {
  publishInfo();
  watchPage(figma.currentPage);
  pendingOnlySentinel = false;
});
// Selecting is user activity: don't fold a pending sentinel into whatever the user does next.
figma.on('selectionchange', () => {
  pendingOnlySentinel = false;
});
// There is no rename event; a cheap poll catches file renames.
setInterval(() => publishInfo(), 3000);
publishInfo(true);

// ------------------------------------------------------------------ generic helpers

const SNAPSHOT_PROPS = [
  'visible', 'locked', 'x', 'y', 'width', 'height', 'rotation', 'absoluteBoundingBox',
  'opacity', 'blendMode', 'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'effects',
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'boundVariables',
  'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'constraints', 'clipsContent', 'layoutMode', 'layoutWrap', 'layoutPositioning', 'itemSpacing',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutSizingHorizontal', 'layoutSizingVertical',
  'characters', 'fontName', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textCase', 'textDecoration',
  'componentProperties', 'componentPropertyDefinitions', 'variantProperties', 'description', 'key',
  'shapeType', 'connectorStart', 'connectorEnd', 'sectionContentsHidden',
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/** Message of anything thrown, including non-Error values some host APIs throw. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && typeof (err as Params).message === 'string') return (err as Params).message;
  return String(err);
}

/** Deep-copies an API value into plain JSON, mapping figma.mixed to "mixed". */
function toPlain(value: unknown): unknown {
  const json = JSON.stringify(value, (_key, v) => (v === figma.mixed ? 'mixed' : v));
  return json === undefined ? undefined : JSON.parse(json);
}

function summary(node: BaseNode): Json {
  const out: Json = { id: node.id, name: node.name, type: node.type };
  if ('x' in node) Object.assign(out, { x: node.x, y: node.y, width: node.width, height: node.height });
  return out;
}

/** Properties of one node; children are included down to `depth` levels (synchronous, for small trees). */
function snapshot(node: BaseNode, depth = 0): Json {
  const out: Json = { id: node.id, name: node.name, type: node.type };
  const source = node as unknown as Params;
  for (const key of SNAPSHOT_PROPS) {
    if (!(key in node)) continue;
    try {
      const value = toPlain(source[key]);
      if (value !== undefined) out[key] = value;
    } catch {
      // Some getters throw for particular node states (e.g. broken variants); skip them.
    }
  }
  const text = textTarget(node);
  if (text && node.type !== 'TEXT') out.text = text.characters;
  if ('children' in node) {
    const children = (node.children as readonly BaseNode[]).filter((child) => !helperIds.has(child.id));
    out.childCount = children.length;
    if (depth > 0) out.children = children.map((child) => snapshot(child, depth - 1));
  }
  return out;
}

const isNode = (v: any): v is BaseNode =>
  v !== null && typeof v === 'object' && typeof v.id === 'string' && typeof v.type === 'string' && 'removed' in v;

/** Makes arbitrary values returned by user code safe to postMessage: nodes become summaries. */
function normalize(value: unknown, depth = 0): unknown {
  if (value === figma.mixed) return 'mixed';
  if (value === undefined) return null;
  if (typeof value === 'bigint') return String(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? String(value) : value;
  }
  if (isNode(value)) return value.removed ? { id: value.id, removed: true } : summary(value);
  if (depth > 20) return '[max depth]';
  if (ArrayBuffer.isView(value)) return { byteLength: value.byteLength };
  if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
  const out: Json = {};
  for (const key of Object.keys(value)) out[key] = normalize((value as Params)[key], depth + 1);
  return out;
}

function where(): string {
  return `file "${figma.root.name}" (${figma.editorType}, current page "${figma.currentPage.name}")`;
}

async function getNode(nodeId: string): Promise<BaseNode> {
  const node = await figma.getNodeByIdAsync(String(nodeId));
  if (!node) {
    throw new Error(`Node "${nodeId}" not found in ${where()}. If the ID belongs to another file, pass target.`);
  }
  return node;
}

async function getSceneNode(nodeId: string): Promise<SceneNode> {
  const node = await getNode(nodeId);
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error(`Node "${nodeId}" is a ${node.type}, not a layer`);
  return node;
}

function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  return current as PageNode | null;
}

/** The given page (loaded on demand) or the current page. Loading a huge page is slow; prefer node IDs. */
async function resolvePage(pageId: string | undefined, call: CallContext | null): Promise<PageNode> {
  if (!pageId) return figma.currentPage;
  const page = await getNode(pageId);
  if (page.type !== 'PAGE') throw new Error(`Node "${pageId}" is ${page.type}, not a PAGE`);
  if (page !== figma.currentPage) await page.loadAsync();
  watchPage(page);
  if (call) call.page = page;
  return page;
}

function parseHex(hex: string): { color: RGB; opacity: number } {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error(`Invalid hex color "${hex}"`);
  const channel = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { color: { r: channel(0), g: channel(2), b: channel(4) }, opacity: h.length === 8 ? channel(6) : 1 };
}

function solidPaint(hex: string): SolidPaint {
  const { color, opacity } = parseHex(hex);
  return { type: 'SOLID', color, opacity };
}

// ------------------------------------------------------------------ change records

function newChangeSet(): ChangeSet {
  return { created: new Map(), deleted: new Set(), modified: new Map() };
}

function noteCreated(call: CallContext | null, node: BaseNode): void {
  call?.changes?.created.set(node.id, node);
  if (call?.window) {
    directOrigins.set(node.id, call.window.seq);
    if (directOrigins.size > DIRECT_ORIGINS_KEPT) directOrigins.delete(directOrigins.keys().next().value!);
  }
}

function noteDeleted(call: CallContext | null, id: string): void {
  call?.changes?.deleted.add(id);
}

function noteModified(call: CallContext | null, id: string, properties: string[]): void {
  const changes = call?.changes;
  if (!changes || !properties.length) return;
  const props = changes.modified.get(id) ?? new Set<string>();
  for (const prop of properties) props.add(prop);
  changes.modified.set(id, props);
}

function hasEntries(set: ChangeSet): boolean {
  return set.created.size + set.deleted.size + set.modified.size > 0;
}

/**
 * Net effect of a change set, as capped ID lists plus counts. Nodes created and removed again are left
 * out, and with `exclude` anything already reported there (so late changes list only what is new).
 */
function summarizeChanges(set: ChangeSet, exclude?: ChangeSet): Json {
  const created = [...set.created]
    .filter(([id, node]) => !set.deleted.has(id) && !(node && node.removed) && !exclude?.created.has(id))
    .map(([id]) => id);
  const deleted = [...set.deleted].filter((id) => !set.created.has(id) && !exclude?.deleted.has(id));
  const modified: Array<{ id: string; properties: string[] }> = [];
  for (const [id, props] of set.modified) {
    if (set.created.has(id) || set.deleted.has(id)) continue;
    const known = exclude?.modified.get(id);
    const fresh = [...props].filter((prop) => !known?.has(prop));
    if (fresh.length) modified.push({ id, properties: fresh });
  }
  return {
    created: created.slice(0, MAX_LISTED_CHANGES),
    createdCount: created.length,
    deleted: deleted.slice(0, MAX_LISTED_CHANGES),
    deletedCount: deleted.length,
    modified: modified.slice(0, MAX_LISTED_CHANGES),
    modifiedCount: modified.length,
  };
}

const hasChanges = (changes: Json) =>
  (changes.createdCount as number) + (changes.deletedCount as number) + (changes.modifiedCount as number) > 0;

// ------------------------------------------------------------------ change ledger
//
// Figma reports document changes as page `nodechange` events, delivered asynchronously in batches - in heavy
// files 0.5-1.5 s after the change, and slower right after the plugin starts. Batches arrive in order, but the
// order of events inside a batch is not reliable (a deletion can come before an earlier change). So:
//  - listeners stay registered for the plugin's lifetime;
//  - each mutating call opens a window. When its work is done, the plugin writes a sentinel: a unique
//    plugin-data value on a hidden, locked helper layer it owns (never on a real layer). The window closes when
//    a batch confirming that write arrives; every change the call made is in that batch or an earlier one;
//  - a mutating call doesn't start while an earlier window is still open, so one batch never holds two calls'
//    changes and the order inside it doesn't matter;
//  - the pipeline is primed when the plugin starts, so the first calls don't pay Figma's warm-up;
//  - whatever reaches a window after its call replied is reported as `lateChanges` for that call. If a gate
//    ever times out and two windows are open at once, their events are reported as `unattributedChanges`
//    naming every possible call, never credited to one of them.

const windows: ChangeWindow[] = [];
const watchedPages = new Set<PageNode>();
const watchProblems = new Map<string, string>();
/** Notices not yet included in a reply: late changes (certain) and unattributed changes (uncertain). */
const lateNotices: Json[] = [];
const unattributedNotices: Json[] = [];
/** Node ID -> seq of the window whose call created it directly (tools and figma.create* in scripts). */
const directOrigins = new Map<string, number>();
/** Hidden helper layers carrying the sentinels, by page id. Their own events are never reported. */
const helpersByPage = new Map<string, SceneNode[]>();
const helperIds = new Set<string>();
/** Calls whose sentinels are outstanding at the same time get separate helpers (rare: after a gate timeout). */
const MAX_HELPERS_PER_PAGE = 3;
/** Layers whose 3.2-era sentinel data was just cleared: their plugin-data echo is ignored until the time stored. */
const ignoredPluginData = new Map<string, number>();
const cleanedPages = new Set<string>();
/** Changes seen while more than one call's window was open: they can't be attributed for certain. */
let uncertain: { callIds: string[]; changes: ChangeSet } | null = null;
let windowSeq = 0;
let sentinelMisses = 0;
/** The only uncommitted plugin edits are bridge bookkeeping: the next call folds them into its own undo step. */
let pendingOnlySentinel = false;

function noteMiss(window: ChangeWindow): void {
  if (window.missCounted || !window.carrierId) return;
  window.missCounted = true;
  sentinelMisses++;
}

function watchPage(page: PageNode): void {
  if (watchedPages.has(page)) return;
  try {
    page.on('nodechange', onNodeChange);
    watchedPages.add(page);
    watchProblems.delete(page.id);
    findHelpers(page); // so existing helpers are recognised (and hidden from results) right away
  } catch (err) {
    watchProblems.set(page.id, `could not watch page "${page.name}" for changes (${errorMessage(err)})`);
  }
}

// ---- helper layer

/** The page's helper layers (found by their plugin-data role, so ones from earlier sessions are reused). */
function findHelpers(page: PageNode): SceneNode[] {
  let helpers = (helpersByPage.get(page.id) ?? []).filter((node) => !node.removed);
  if (!helpers.length) {
    helpers = page.children.filter((node) => {
      try {
        return node.getPluginData(HELPER_ROLE_KEY) === HELPER_ROLE;
      } catch {
        return false;
      }
    });
  }
  for (const node of helpers) helperIds.add(node.id);
  helpersByPage.set(page.id, helpers);
  return helpers;
}

/**
 * A helper layer for `window`'s sentinel that no other open window is waiting on (a shared helper would let
 * one window's event confirm the other), created on first use as a 1x1 hidden, locked top-level rectangle.
 */
function ensureHelper(page: PageNode, window: ChangeWindow): SceneNode | null {
  const helpers = findHelpers(page);
  const busy = new Set(windows.filter((w) => !w.closed && w !== window && w.carrierId).map((w) => w.carrierId));
  const free = helpers.find((node) => !busy.has(node.id));
  if (free) return free;
  if (helpers.length >= MAX_HELPERS_PER_PAGE) return helpers[0]; // share; the sentinel's value still tells calls apart
  const node = createHelper(page);
  if (node) helpersByPage.set(page.id, [...helpers, node]);
  return node;
}

function createHelper(page: PageNode): SceneNode | null {
  let node: SceneNode | null = null;
  for (const make of [() => figma.createRectangle(), () => figma.createFrame()]) {
    try {
      node = make();
      break;
    } catch {
      // not available in this editor (or the file is read-only)
    }
  }
  if (!node) return null;
  helperIds.add(node.id); // before any of its events can arrive
  try {
    const anchor = page.children.find((child) => child !== node && !helperIds.has(child.id));
    if (node.parent !== page) page.appendChild(node);
    node.name = HELPER_NAME;
    node.setPluginData(HELPER_ROLE_KEY, HELPER_ROLE);
    if ('resize' in node) node.resize(1, 1);
    node.x = anchor ? anchor.x : 0;
    node.y = anchor ? anchor.y : 0;
    node.visible = false;
    node.locked = true;
  } catch {
    try {
      node.remove();
    } catch {
      // already gone
    }
    helperIds.delete(node.id);
    return null;
  }
  return node;
}

function forgetHelper(id: string): void {
  helperIds.delete(id);
  for (const [pageId, nodes] of helpersByPage) helpersByPage.set(pageId, nodes.filter((node) => node.id !== id));
}

/** 3.2 wrote sentinels on ordinary top-level layers; clear that data once per page. */
function cleanLegacySentinels(page: PageNode): void {
  if (cleanedPages.has(page.id)) return;
  cleanedPages.add(page.id);
  const until = Date.now() + 60_000;
  for (const node of page.children) {
    if (helperIds.has(node.id)) continue;
    try {
      if (!node.getPluginData(SENTINEL_KEY)) continue;
      ignoredPluginData.set(node.id, until);
      node.setPluginData(SENTINEL_KEY, '');
    } catch {
      // read-only or locked instance content: leave it
    }
  }
}

// ---- windows

function openWindow(callId: string, absorb = false): ChangeWindow {
  const window: ChangeWindow = {
    callId, seq: ++windowSeq, missCounted: false, changes: newChangeSet(), late: null, carrierId: null, token: null,
    carrierAt: 0, absorb, absorbIds: new Set(), events: 0, lastEventAt: 0, closed: false, incomplete: false, wake: [],
  };
  windows.push(window);
  return window;
}

function addChange(set: ChangeSet, change: NodeChange): void {
  if (change.type === 'CREATE') {
    if (!set.created.has(change.id)) set.created.set(change.id, null);
  } else if (change.type === 'DELETE') {
    set.deleted.add(change.id);
  } else {
    const props = set.modified.get(change.id) ?? new Set<string>();
    for (const prop of change.properties) props.add(prop);
    set.modified.set(change.id, props);
  }
}

function record(window: ChangeWindow, change: NodeChange): void {
  window.events++;
  window.lastEventAt = Date.now();
  if (!window.absorb) addChange(window.late ?? window.changes, change);
}

/** Changes that arrived while several calls' windows were open: kept apart, naming every possible call. */
function recordUncertain(open: ChangeWindow[], change: NodeChange): void {
  const callIds = open.map((w) => w.callId);
  for (const w of open) {
    w.events++;
    w.lastEventAt = Date.now();
  }
  if (uncertain && uncertain.callIds.join() !== callIds.join()) flushUncertain();
  if (!uncertain) uncertain = { callIds, changes: newChangeSet() };
  addChange(uncertain.changes, change);
}

function flushUncertain(): void {
  if (!uncertain) return;
  const changes = summarizeChanges(uncertain.changes);
  if (hasChanges(changes)) {
    const notice: Json = { possibleCallIds: uncertain.callIds, changes };
    unattributedNotices.push(notice);
    for (const id of uncertain.callIds) {
      const callRecord = records.get(id);
      if (callRecord) callRecord.unattributedChanges = [...(callRecord.unattributedChanges ?? []), notice];
    }
    figma.ui.postMessage({ type: 'unattributed-changes', ...notice });
  }
  uncertain = null;
}

/** Closes a window; if its call already replied, reports what arrived since as late changes. */
function closeWindow(window: ChangeWindow, incomplete: boolean): void {
  if (window.closed) return;
  window.closed = true;
  window.incomplete = incomplete;
  if (incomplete) noteMiss(window); // its sentinel never came back
  for (const wake of window.wake.splice(0)) wake();
  if (uncertain && uncertain.callIds.indexOf(window.callId) >= 0) flushUncertain();
  if (!window.late || window.absorb) return;
  const changes = summarizeChanges(window.late, window.changes);
  if (!hasChanges(changes) && !incomplete) return;
  const notice: Json = { callId: window.callId, changes, complete: !incomplete };
  lateNotices.push(notice);
  const callRecord = records.get(window.callId);
  if (callRecord) callRecord.lateChanges = notice;
  figma.ui.postMessage({ type: 'late-changes', ...notice });
}

function pruneWindows(): void {
  for (let i = windows.length - 1; i >= 0; i--) if (windows[i].closed) windows.splice(i, 1);
}

/**
 * The open window a helper event confirms: the one whose token the helper carries now. If Figma merged
 * several sentinel writes into one event, that is the newest write, and it covers the older ones too.
 */
function confirmedBy(change: NodeChange): ChangeWindow | null {
  const users = windows.filter((w) => !w.closed && w.carrierId === change.id);
  if (change.type === 'DELETE') {
    // The helper was deleted (by the user, or an undo) after every write it carried.
    forgetHelper(change.id);
    return users.length ? users[users.length - 1] : null;
  }
  if (!users.length || change.type !== 'PROPERTY_CHANGE' || change.properties.indexOf('pluginData') < 0) return null;
  let token = '';
  try {
    token = (change.node as BaseNode).getPluginData(SENTINEL_KEY);
  } catch {
    // node gone
  }
  return users.find((w) => w.token === token) ?? null;
}

/** Attributes one (non-helper) change. `confirmed` is the window the same batch confirms, if any. */
function attribute(change: NodeChange, confirmed: ChangeWindow | null): void {
  // The undo of a dryRun restoring its own nodes: bookkeeping.
  if (windows.some((w) => !w.closed && w.absorb && w.absorbIds.has(change.id))) return;
  const open = windows.filter((w) => !w.closed && !w.absorb);
  // A call's own creation is certain. It can only be delivered after every older call's sentinel, so an
  // older window still open (and not confirmed by this very batch) has lost its sentinel.
  const origin = change.type === 'CREATE' ? directOrigins.get(change.id) : undefined;
  if (origin !== undefined) {
    const creator = open.find((w) => w.seq === origin);
    if (creator) record(creator, change);
    for (const w of windows.slice()) {
      if (!w.closed && w.seq < origin && !(confirmed && w.seq <= confirmed.seq)) closeWindow(w, true);
    }
    return;
  }
  if (open.length === 1) record(open[0], change);
  else if (open.length > 1) recordUncertain(open, change);
  else pendingOnlySentinel = false; // none of our calls is running: the user edited the document
}

/** Handles one delivered batch as a whole; the order of events inside it doesn't matter. */
function onNodeChange(event: NodeChangeEvent): void {
  const now = Date.now();
  let confirmed: ChangeWindow | null = null;
  const rest: NodeChange[] = [];
  for (const change of event.nodeChanges) {
    if (change.origin !== 'LOCAL') continue;
    if (helperIds.has(change.id)) {
      const window = confirmedBy(change);
      if (window && (!confirmed || window.seq > confirmed.seq)) confirmed = window;
      continue; // the helper's own events are bookkeeping, never reported
    }
    const pluginDataOnly = change.type === 'PROPERTY_CHANGE' && change.properties.length === 1 && change.properties[0] === 'pluginData';
    if (pluginDataOnly && (ignoredPluginData.get(change.id) ?? 0) > now) continue;
    rest.push(change);
  }
  // Everything in a batch that confirms a window happened before that window's sentinel was written.
  for (const change of rest) attribute(change, confirmed);
  if (confirmed) {
    sentinelMisses = 0;
    for (const w of windows.slice()) if (!w.closed && w.seq <= confirmed.seq) closeWindow(w, false);
  }
  pruneWindows();
}

/** Writes the sentinel on the page's helper layer (creating it if needed). */
function placeSentinel(window: ChangeWindow, page: PageNode): boolean {
  if (sentinelMisses >= MAX_SENTINEL_MISSES || !watchedPages.has(page)) return false;
  cleanLegacySentinels(page);
  const helper = ensureHelper(page, window);
  if (!helper) return false;
  const now = Date.now();
  const token = `${window.callId}@${now}`;
  try {
    window.carrierId = helper.id;
    window.token = token;
    window.carrierAt = now;
    helper.setPluginData(SENTINEL_KEY, token);
    return true;
  } catch {
    window.carrierId = null;
    window.token = null;
    return false;
  }
}

/**
 * Holds a mutating call until earlier windows are confirmed, so no batch can mix two calls' changes.
 * Bounded; returns the IDs of calls still unconfirmed when it gave up (their windows count as lost).
 */
async function gate(): Promise<string[]> {
  const started = Date.now();
  for (;;) {
    const open = windows.filter((w) => !w.closed);
    if (!open.length) return [];
    // Sentinels were given up in this file: open windows can't be confirmed any more, so don't wait on them.
    if (sentinelMisses >= MAX_SENTINEL_MISSES) return open.filter((w) => !w.absorb).map((w) => w.callId);
    const limit = open.some((w) => w.missCounted) ? LOST_GATE_MS : GATE_MS;
    const remaining = limit - (Date.now() - started);
    if (remaining <= 0) {
      // Slow is not lost: only a window whose own events arrived without its sentinel counts as a loss.
      for (const w of open) if (w.events > 0) noteMiss(w);
      return open.filter((w) => !w.absorb).map((w) => w.callId);
    }
    await waitForClose(open[open.length - 1], Math.min(remaining, 250));
  }
}

/** Writes a first sentinel when the plugin starts, so Figma's slow first delivery happens before any call. */
function prime(): void {
  if (figma.editorType === 'dev') return;
  const window = openWindow('startup', true);
  if (placeSentinel(window, figma.currentPage)) pendingOnlySentinel = true; // bookkeeping: fold into the next step
  else closeWindow(window, false);
}

function waitForClose(window: ChangeWindow, ms: number): Promise<boolean> {
  if (window.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    window.wake.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Fallback when no sentinel can be placed: wait until events go quiet (bounded). */
async function quietWait(window: ChangeWindow, firstEventMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    await sleep(25);
    const now = Date.now();
    if (!window.events ? now - started >= firstEventMs : now - window.lastEventAt >= EVENT_QUIET_MS) return;
    if (now - started >= SENTINEL_WAIT_MS) return;
  }
}

/**
 * After a call's work: decides whether it changed anything, places its sentinel and (for scripts, whose
 * changes are only known from events) waits for it. Returns notes for `changesNote`.
 */
async function settleWindow(window: ChangeWindow, page: PageNode, likely: boolean, isScript: boolean): Promise<string[]> {
  const evidence = likely || window.events > 0 || hasEntries(window.changes);
  if (!evidence) {
    await sleep(UNLIKELY_EVENT_WAIT_MS);
    return [];
  }
  if (!placeSentinel(window, page)) {
    const why =
      watchProblems.get(page.id) ??
      (sentinelMisses >= MAX_SENTINEL_MISSES
        ? 'Figma has not been reporting the sentinel changes in this file'
        : `the hidden helper layer could not be created on page "${page.name}" (read-only file?)`);
    if (!isScript) return [];
    await quietWait(window, QUIET_FALLBACK_MS);
    return [`Changes Figma reports late may be missing from this list: no change sentinel could be placed (${why}).`];
  }
  if (!isScript) return []; // tools know their changes; the window keeps absorbing their late events
  const arrived = await waitForClose(window, SENTINEL_WAIT_MS);
  if (arrived) {
    return window.incomplete
      ? ['Change events for this call were incomplete (its sentinel was lost); the list may miss some changes.']
      : [];
  }
  // The call's other events arrived but its sentinel did not: likely lost rather than merely slow.
  if (window.events > 0) noteMiss(window);
  return [
    `Figma had not delivered all change events after ${SENTINEL_WAIT_MS / 1000} s. Changes that arrive later are ` +
      'reported as lateChanges for this call (in the next result for this file, and via get_call_result).',
  ];
}

// Watch the current page from the start and prime the pipeline; windows that never see their sentinel are
// closed eventually.
watchPage(figma.currentPage);
prime();
setInterval(() => {
  const now = Date.now();
  for (const w of windows) if (!w.closed && w.carrierId && now - w.carrierAt > LATE_WINDOW_MAX_MS) closeWindow(w, true);
  pruneWindows();
  for (const [id, until] of ignoredPluginData) if (until <= now) ignoredPluginData.delete(id);
}, 2000);

/** Rough test for scripts that edit the document, used to decide how long to wait for change events. */
const MUTATION_HINT =
  /\.(create\w*|remove\w*|delete\w*|resize\w*|rescale|set\w*|append\w*|insert\w*|clone|detach\w*|swap\w*|flatten|group|ungroup|union|subtract|intersect|exclude|marker|triggerUndo)\s*\(|\.\w+\s*(?:[-+*/%&|^]|\*\*|<<|>>>?)?=(?!=)|\]\s*(?:[-+*/%])?=(?!=)|Object\.assign\s*\(/;

// ------------------------------------------------------------------ the `figma` object for scripts

const CREATING_METHODS = /^(create|group$|union$|subtract$|intersect$|exclude$|flatten$|combineAsVariants$)/;
const BLOCKED_METHODS: Record<string, string> = {
  closePlugin: 'figma.closePlugin() would disconnect the bridge, so it is disabled inside execute_figma_code',
  showUI: 'figma.showUI() would replace the bridge UI, so it is disabled inside execute_figma_code',
};

/**
 * The `figma` object scripts receive: a plain object whose properties forward to the real API, so values
 * and methods are the real ones (called on the real object), except that node-creating methods also record
 * the new node in the call's changes. Not a Proxy: Figma's API properties are read-only and
 * non-configurable, and the Proxy invariants forbid a get trap from returning anything but the original.
 */
function scriptApi(call: CallContext): PluginAPI {
  const source = figma as unknown as Params;
  const names = new Set<string>();
  try {
    for (let o: object | null = figma; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const name of Object.getOwnPropertyNames(o)) if (name !== 'constructor') names.add(name);
    }
  } catch {
    return figma;
  }
  // Unexpected shape: hand over the real object rather than risk a broken one.
  if (!names.has('createRectangle') || !names.has('getNodeByIdAsync')) return figma;

  const record = (out: unknown) => {
    if (isNode(out)) noteCreated(call, out);
    return out;
  };
  const cache = new Map<string, { from: unknown; fn: unknown }>();
  const api: Params = {};
  for (const name of names) {
    Object.defineProperty(api, name, {
      enumerable: true,
      get() {
        const value = source[name];
        if (typeof value !== 'function') return value;
        const hit = cache.get(name);
        if (hit && hit.from === value) return hit.fn;
        let fn: unknown;
        if (hasOwn(BLOCKED_METHODS, name)) {
          fn = () => {
            throw new Error(BLOCKED_METHODS[name]);
          };
        } else if (CREATING_METHODS.test(name)) {
          fn = (...args: unknown[]) => {
            const out = value.apply(figma, args);
            return out && typeof out.then === 'function' ? out.then(record) : record(out);
          };
        } else {
          fn = value.bind(figma);
        }
        cache.set(name, { from: value, fn });
        return fn;
      },
      set(value) {
        source[name] = value;
      },
    });
  }
  return api as unknown as PluginAPI;
}

// ------------------------------------------------------------------ script errors and line numbers

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;
const SCRIPT_PARAMS = ['figma', 'console', 'params', 'helpers'];

interface Frame {
  file: string;
  line: number;
  column: number | null;
}

/** Parses the trailing "file:line[:column]" of each "at ..." stack line (V8 and QuickJS formats). */
function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const text of stack.split('\n')) {
    if (!/^\s*at\s/.test(text)) continue;
    const match = /([^\s()]+?):(\d+)(?::(\d+))?\)?\s*$/.exec(text);
    if (match) frames.push({ file: match[1], line: Number(match[2]), column: match[3] ? Number(match[3]) : null });
  }
  return frames;
}

/**
 * Finds the user-script frames in a stack, rewrites their locations to "script:<line>[:<col>]" with the
 * wrapper's line offset removed, and returns the innermost one as line/column.
 */
function mapStack(stack: string, cal: ScriptCalibration, lineCount: number): { stack: string; line?: number; column?: number | null } {
  const isScriptFrame = (frame: Frame) => {
    const fileMatches = cal.file ? frame.file === cal.file : /^(<input>|<anonymous>|figma-local-script\.js)$/.test(frame.file);
    const line = frame.line - cal.offset;
    return fileMatches && line >= 1 && (!cal.shared || line <= lineCount);
  };
  const innermost: { frame: Frame | null } = { frame: null };
  const lines = stack.split('\n').map((text) => {
    const frame = parseFrames(text)[0];
    if (!frame || !isScriptFrame(frame)) return text;
    if (!innermost.frame) innermost.frame = frame;
    const col = frame.column !== null ? `:${frame.column}` : '';
    return text.replace(`${frame.file}:${frame.line}${col}`, `script:${frame.line - cal.offset}${col}`);
  });
  const first = innermost.frame;
  return { stack: lines.join('\n'), ...(first ? { line: first.line - cal.offset, column: first.column } : {}) };
}

let calibration: ScriptCalibration | null = null;
/** Measures, with a probe that throws on its first line, how this engine reports script locations. */
async function calibrateScripts(): Promise<ScriptCalibration> {
  if (calibration) return calibration;
  let frames: Frame[] = [];
  try {
    await new AsyncFunction(...SCRIPT_PARAMS, `throw new Error('probe')\n//# sourceURL=${SCRIPT_URL}`)();
  } catch (err) {
    const stack = err && typeof err === 'object' ? (err as Params).stack : undefined;
    frames = typeof stack === 'string' ? parseFrames(stack) : [];
  }
  const probe = frames[0];
  calibration = probe
    ? { file: probe.file, offset: probe.line - 1, shared: frames.slice(1).some((f) => f.file === probe.file) }
    : // Both V8 and QuickJS place two wrapper lines above the body of Function-constructor code.
      { file: null, offset: 2, shared: true };
  return calibration;
}

function describeError(err: unknown, script: CallContext['script']): Json {
  const message = errorMessage(err);
  const name = err instanceof Error ? err.name : (err as Params)?.name;
  const out: Json = { name: typeof name === 'string' ? name : 'Error', message };
  const stack = err && typeof err === 'object' ? (err as Params).stack : undefined;
  if (typeof stack === 'string') {
    let text = stack;
    if (script) {
      const mapped = mapStack(stack, script.cal, script.lineCount);
      text = mapped.stack;
      if (mapped.line !== undefined) {
        out.line = mapped.line;
        out.column = mapped.column;
      }
    }
    out.stack = text.split('\n').slice(0, 15).join('\n');
  }
  if (script && /not a function|is undefined|of undefined/i.test(message)) {
    out.hint = `helpers available: ${HELPER_NAMES.join(', ')}`;
  }
  out.file = { name: figma.root.name, editorType: figma.editorType, currentPage: figma.currentPage.name };
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(
        `Script exceeded timeoutMs (${ms} ms). It was asked to stop at its next helpers.yield(); ` +
          'changes made so far are listed in `changes`.',
      );
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (err) => (clearTimeout(timer), reject(err)),
    );
  });
}

/** Formats one console argument; never throws, so logging can't break a script. */
function formatLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    const json = JSON.stringify(normalize(arg));
    return json === undefined ? String(arg) : json;
  } catch {
    try {
      return String(arg);
    } catch {
      return '[unprintable]';
    }
  }
}

// ------------------------------------------------------------------ cooperative yielding and walking

let currentCall: CallContext | null = null;

function postProgress(call: CallContext, message?: string): void {
  call.lastProgress = Date.now();
  figma.ui.postMessage({ type: 'progress', callId: call.callId, at: call.lastProgress, ...(message ? { message } : {}) });
}

/** Lets the event loop breathe (UI messages, heartbeats) and reports progress. Throws once the call timed out. */
async function pause(): Promise<void> {
  const call = currentCall;
  if (call) {
    if (call.cancelled) throw new Error('Stopped: the call exceeded its timeoutMs');
    if (Date.now() - call.lastProgress > 1000) postProgress(call);
  }
  await sleep(0);
}

type Visitor = (node: SceneNode, depth: number) => unknown;

/**
 * Depth-first walk of every descendant of `root` (not root itself), yielding every `yieldEvery` nodes.
 * Return false from the visitor to skip a node's children, or 'stop' to end the walk. Returns nodes visited.
 */
async function walk(root: BaseNode, visit: Visitor, opts: { yieldEvery?: number; maxDepth?: number } = {}): Promise<number> {
  const yieldEvery = Math.max(1, opts.yieldEvery ?? 500);
  const stack: Array<[BaseNode, number]> = [[root, 0]];
  let visited = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (helperIds.has(node.id)) continue; // the bridge's hidden helper layer is not part of the design
    if (node !== root) {
      visited++;
      if (visited % yieldEvery === 0) await pause();
      const verdict = await visit(node as SceneNode, depth);
      if (verdict === 'stop') break;
      if (verdict === false) continue;
    }
    if ('children' in node && (opts.maxDepth === undefined || depth < opts.maxDepth)) {
      const children = node.children as readonly BaseNode[];
      for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], depth + 1]);
    }
  }
  return visited;
}

async function findAll(
  root: BaseNode,
  predicate: (node: SceneNode) => unknown,
  opts: { limit?: number; maxDepth?: number; yieldEvery?: number } = {},
): Promise<SceneNode[]> {
  const found: SceneNode[] = [];
  const limit = opts.limit ?? Infinity;
  await walk(
    root,
    async (node) => {
      if (await predicate(node)) found.push(node);
      return found.length >= limit ? 'stop' : true;
    },
    opts,
  );
  return found;
}

// ------------------------------------------------------------------ text and fonts

/** The editable text of a node: a TEXT node itself, or the text sublayer of a FigJam sticky/shape/connector. */
function textTarget(node: BaseNode): TextLike | null {
  if (node.type === 'TEXT') return node;
  if (node.type === 'STICKY' || node.type === 'SHAPE_WITH_TEXT' || node.type === 'CONNECTOR') return node.text;
  return null;
}

/** Loads every font a text node (or text sublayer) uses so it can be edited. */
async function loadFontsFor(node: BaseNode): Promise<void> {
  const text = textTarget(node);
  if (!text) throw new Error(`Node "${node.id}" is ${node.type} and has no text`);
  if (text.hasMissingFont) throw new Error(`Node "${node.id}" uses a font that is not available on this machine`);
  let fonts: FontName[] = [];
  try {
    fonts = text.fontName === figma.mixed ? text.getRangeAllFontNames(0, text.characters.length) : [text.fontName];
  } catch {
    fonts = [];
  }
  const valid = fonts.filter((font) => font && font.family);
  try {
    if (!valid.length) throw new Error('no font set');
    await Promise.all(valid.map((font) => figma.loadFontAsync(font)));
  } catch (err) {
    // FigJam connector text has an invalid default font until one is set.
    if (node.type === 'TEXT') throw err;
    const fallback: FontName = { family: 'Inter', style: 'Medium' };
    await figma.loadFontAsync(fallback);
    text.fontName = fallback;
  }
}

// ------------------------------------------------------------------ properties and creation

/** Assigns properties one by one so a single bad key doesn't block the rest. */
async function applyProperties(node: SceneNode, props: Params): Promise<{ applied: string[]; failed: Json }> {
  const applied: string[] = [];
  const failed: Json = {};
  const target = node as unknown as Params;
  if (textTarget(node)) {
    await loadFontsFor(node);
    if (props.fontName) await figma.loadFontAsync(props.fontName);
  }
  // layoutMode must precede the padding/spacing/sizing properties that depend on it.
  const keys = Object.keys(props).sort((a, b) => Number(b === 'layoutMode') - Number(a === 'layoutMode'));
  for (const key of keys) {
    const value = props[key];
    try {
      if (key === 'width' || key === 'height') {
        if (!('resize' in node)) throw new Error(`${node.type} cannot be resized`);
        node.resize(key === 'width' ? value : node.width, key === 'height' ? value : node.height);
      } else if (key === 'fillHex') {
        target.fills = [solidPaint(value)];
      } else if (key === 'strokeHex') {
        target.strokes = [solidPaint(value)];
      } else if (key in node) {
        target[key] = value;
      } else {
        throw new Error(`${node.type} has no property "${key}"`);
      }
      applied.push(key);
    } catch (err) {
      failed[key] = errorMessage(err);
    }
  }
  return { applied, failed };
}

async function resolveParent(p: Params, call: CallContext): Promise<BaseNode & ChildrenMixin> {
  if (!p.parentId) return resolvePage(p.pageId, call);
  const parent = await getNode(p.parentId);
  if (parent.type === 'DOCUMENT' || !('appendChild' in parent)) {
    throw new Error(`Node "${p.parentId}" (${parent.type}) cannot contain layers`);
  }
  if (parent.type === 'PAGE' && parent !== figma.currentPage) await parent.loadAsync();
  return parent;
}

/** Shared create flow: parent, configure, name, position, extra properties; removes the node on failure. */
async function createNode<T extends SceneNode>(
  p: Params,
  call: CallContext,
  make: () => T,
  configure: (node: T) => void,
): Promise<Json> {
  const parent = await resolveParent(p, call);
  const node = make();
  noteCreated(call, node);
  try {
    parent.appendChild(node);
    configure(node);
    if (p.name) node.name = p.name;
    if (p.x !== undefined || p.y !== undefined) {
      node.x = p.x ?? node.x;
      node.y = p.y ?? node.y;
    } else if (parent.type === 'PAGE') {
      const center = figma.viewport.center;
      node.x = Math.round(center.x - node.width / 2);
      node.y = Math.round(center.y - node.height / 2);
    }
    const extra = p.properties ? await applyProperties(node, p.properties) : null;
    return extra && Object.keys(extra.failed).length ? { ...summary(node), failedProperties: extra.failed } : summary(node);
  } catch (err) {
    node.remove();
    throw err;
  }
}

// ------------------------------------------------------------------ images

/**
 * Exports a node as { __image: { base64, mimeType } } (raster) or { svg } and keeps rasters under
 * MAX_EXPORT_BYTES by shrinking the output. JPG with `quality` is re-encoded by the UI iframe.
 */
async function exportImage(node: SceneNode, opts: Params, call: CallContext | null): Promise<Json> {
  const format: 'PNG' | 'JPG' | 'SVG' = opts.format ?? 'PNG';
  if (format === 'SVG') return { format, svg: await node.exportAsync({ format: 'SVG_STRING' }) };
  const scale: number = opts.scale ?? 1;
  const maxDimension: number = opts.maxDimension ?? 1600;
  const width = 'width' in node ? node.width : 1;
  const height = 'height' in node ? node.height : 1;
  const natural = Math.max(width, height, 1) * scale;
  const reencode = format === 'JPG' && typeof opts.quality === 'number';
  const exportFormat = reencode ? 'PNG' : format;
  let longest = Math.min(natural, maxDimension);
  for (let attempt = 0; ; attempt++) {
    const constraint: ExportSettingsConstraints =
      attempt === 0 && longest === natural
        ? { type: 'SCALE', value: scale }
        : { type: width >= height ? 'WIDTH' : 'HEIGHT', value: Math.max(1, Math.round(longest)) };
    const bytes = await node.exportAsync({ format: exportFormat, constraint });
    if (bytes.length <= MAX_EXPORT_BYTES || attempt >= 4) {
      const k = longest / Math.max(width, height, 1);
      if (reencode && call) call.needsReencode = true;
      return {
        nodeId: node.id,
        format,
        pixelSize: { width: Math.round(width * k), height: Math.round(height * k) },
        downscaled: longest < natural,
        __image: {
          base64: figma.base64Encode(bytes),
          mimeType: exportFormat === 'PNG' ? 'image/png' : 'image/jpeg',
          ...(reencode ? { reencode: { quality: opts.quality } } : {}),
        },
      };
    }
    longest = longest * Math.sqrt(MAX_EXPORT_BYTES / bytes.length) * 0.9;
  }
}

// ------------------------------------------------------------------ script helpers

function makeHelpers(call: CallContext, page: PageNode) {
  return {
    page,
    solidPaint,
    snapshot,
    yield: pause,
    walk,
    findAll,
    getNode,
    loadFontsFor,
    assertFile(name: string) {
      if (figma.root.name !== name) {
        throw new Error(`WRONG FILE: this call ran in "${figma.root.name}" but the script expects "${name}". Pass target: { fileName: "${name}" }.`);
      }
    },
    marker(name: string, node: BaseNode = figma.root) {
      node.setPluginData(MARKER_PREFIX + name, new Date().toISOString());
      if (node.type !== 'DOCUMENT') noteModified(call, node.id, ['pluginData']);
    },
    hasMarker(name: string, node: BaseNode = figma.root) {
      return node.getPluginData(MARKER_PREFIX + name) !== '';
    },
    async exportImage(node: SceneNode | string, opts: Params = {}) {
      return exportImage(typeof node === 'string' ? await getSceneNode(node) : node, opts, call);
    },
    returnImage(bytes: Uint8Array | string, mimeType = 'image/png') {
      return { __image: { base64: typeof bytes === 'string' ? bytes : figma.base64Encode(bytes), mimeType } };
    },
  };
}

// ------------------------------------------------------------------ commands

const READ_ONLY = new Set([
  'get_document_info', 'get_selection', 'read_node', 'search_nodes', 'get_design_tokens', 'get_components', 'export_node',
]);

const handlers: Record<string, (p: Params, call: CallContext) => Promise<unknown>> = {
  // ---- read ----

  async get_document_info(p, call) {
    const page = await resolvePage(p.pageId, call);
    return {
      ...fileInfo(),
      currentUser: figma.currentUser ? { id: figma.currentUser.id, name: figma.currentUser.name } : null,
      currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
      pages: figma.root.children.map((pg) => ({ id: pg.id, name: pg.name })),
      page: { id: page.id, name: page.name },
      topLevelNodes: page.children.filter((node) => !helperIds.has(node.id)).map(summary),
    };
  },

  async get_selection(p, call) {
    const page = await resolvePage(p.pageId, call);
    return page.selection.map((node) => snapshot(node, 0));
  },

  async read_node(p) {
    const node = await getNode(p.nodeId);
    const maxNodes: number = p.maxNodes ?? 1000;
    // Only an explicitly requested page is loaded; a single node is resolved by ID without loading its page.
    if (node.type === 'PAGE' && node !== figma.currentPage) await node.loadAsync();
    if (node.type === 'DOCUMENT') throw new Error('read_node needs a page or layer ID; use get_document_info for the file');
    const parent = node.parent ? { id: node.parent.id, name: node.parent.name, type: node.parent.type } : null;

    if (p.textOnly) {
      const texts: Json[] = [];
      let truncated = false;
      await walk(node, (child) => {
        const text = textTarget(child);
        if (text) texts.push({ id: child.id, name: child.name, type: child.type, characters: text.characters });
        if (texts.length >= maxNodes) {
          truncated = true;
          return 'stop';
        }
        return true;
      });
      const own = textTarget(node);
      return { ...summary(node), parent, ...(own ? { characters: own.characters } : {}), texts, truncated };
    }

    const depth: number = p.depth ?? 2;
    let count = 0;
    let truncated = false;
    const visit = async (current: BaseNode, level: number): Promise<Json> => {
      count++;
      if (count % 200 === 0) await pause();
      const out = snapshot(current, 0);
      if ('children' in current && level < depth) {
        const children: Json[] = [];
        for (const child of current.children as readonly BaseNode[]) {
          if (helperIds.has(child.id)) continue;
          if (count >= maxNodes) {
            truncated = true;
            break;
          }
          children.push(await visit(child, level + 1));
        }
        out.children = children;
      }
      return out;
    };
    return { ...(await visit(node, 0)), parent, nodeCount: count, ...(truncated ? { truncated: true } : {}) };
  },

  async search_nodes(p, call) {
    const withinId: string | undefined = p.withinNodeId ?? p.withinId;
    const root = withinId ? await getNode(withinId) : await resolvePage(p.pageId, call);
    if (root.type === 'PAGE' && root !== figma.currentPage) await root.loadAsync();
    if (!('children' in root)) throw new Error(`Node "${root.id}" (${root.type}) has no children to search`);
    const query = String(p.query ?? '').toLowerCase();
    const nameQ = String(p.nameContains ?? '').toLowerCase();
    const textQ = String(p.textContains ?? '').toLowerCase();
    const types: Set<string> | null = p.types?.length ? new Set(p.types) : null;
    const limit: number = p.limit ?? 50;
    const cursor = Number(p.cursor ?? 0) || 0;
    const nodes: Json[] = [];
    let index = 0;
    let more = false;
    const scanned = await walk(
      root,
      (node) => {
        if (types && !types.has(node.type)) return true;
        const name = node.name.toLowerCase();
        const text = textTarget(node)?.characters.toLowerCase() ?? '';
        if (nameQ && !name.includes(nameQ)) return true;
        if (textQ && !text.includes(textQ)) return true;
        if (query && !name.includes(query) && !text.includes(query)) return true;
        if (index++ < cursor) return true;
        if (nodes.length === limit) {
          more = true;
          return 'stop';
        }
        const textValue = textTarget(node)?.characters;
        nodes.push({
          ...summary(node),
          parentId: node.parent ? node.parent.id : null,
          ...(textValue !== undefined ? { text: textValue.slice(0, 200) } : {}),
        });
        return true;
      },
      { maxDepth: p.maxDepth },
    );
    return {
      root: { id: root.id, name: root.name, type: root.type },
      nodes,
      nextCursor: more ? String(cursor + limit) : null,
      scanned,
      ...(more ? {} : { total: index }),
    };
  },

  async get_design_tokens() {
    const [paint, text, effect, grid, collections, variables] = await Promise.all([
      figma.getLocalPaintStylesAsync(),
      figma.getLocalTextStylesAsync(),
      figma.getLocalEffectStylesAsync(),
      figma.getLocalGridStylesAsync(),
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);
    return {
      paintStyles: paint.map((s) => ({ id: s.id, key: s.key, name: s.name, paints: toPlain(s.paints) })),
      textStyles: text.map((s) => ({
        id: s.id, key: s.key, name: s.name, fontName: s.fontName, fontSize: s.fontSize,
        lineHeight: toPlain(s.lineHeight), letterSpacing: toPlain(s.letterSpacing),
      })),
      effectStyles: effect.map((s) => ({ id: s.id, key: s.key, name: s.name, effects: toPlain(s.effects) })),
      gridStyles: grid.map((s) => ({ id: s.id, key: s.key, name: s.name, layoutGrids: toPlain(s.layoutGrids) })),
      variableCollections: collections.map((c) => ({
        id: c.id, name: c.name, modes: toPlain(c.modes), defaultModeId: c.defaultModeId,
      })),
      variables: variables.map((v) => ({
        id: v.id, name: v.name, resolvedType: v.resolvedType, collectionId: v.variableCollectionId,
        valuesByMode: toPlain(v.valuesByMode),
      })),
    };
  },

  async get_components(p) {
    let found: Array<ComponentNode | ComponentSetNode>;
    if (p.allPages) {
      await figma.loadAllPagesAsync();
      found = figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    } else {
      found = figma.currentPage.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    }
    return found
      .filter((node) => !node.parent || node.parent.type !== 'COMPONENT_SET')
      .map((node) => ({
        ...summary(node),
        key: node.key,
        description: node.description,
        page: pageOf(node)?.name,
        ...(node.type === 'COMPONENT_SET' ? { variants: node.children.map((v) => ({ id: v.id, name: v.name })) } : {}),
      }));
  },

  async export_node(p, call) {
    return exportImage(await getSceneNode(p.nodeId), p, call);
  },

  // ---- create ----

  async create_rectangle(p, call) {
    return createNode(p, call, () => figma.createRectangle(), (rect) => {
      rect.resize(p.width, p.height);
      rect.fills = [solidPaint(p.colorHex)];
      if (p.cornerRadius !== undefined) rect.cornerRadius = p.cornerRadius;
    });
  },

  async create_ellipse(p, call) {
    return createNode(p, call, () => figma.createEllipse(), (ellipse) => {
      ellipse.resize(p.width, p.height);
      ellipse.fills = [solidPaint(p.colorHex ?? '#D9D9D9')];
    });
  },

  async create_frame(p, call) {
    return createNode(p, call, () => figma.createFrame(), (frame) => {
      frame.resize(p.width, p.height);
      if (p.fillHex) frame.fills = [solidPaint(p.fillHex)];
    });
  },

  async create_text(p, call) {
    const fontName: FontName = { family: p.fontFamily ?? 'Inter', style: p.fontStyle ?? 'Regular' };
    await figma.loadFontAsync(fontName);
    return createNode(p, call, () => figma.createText(), (text) => {
      text.fontName = fontName;
      text.characters = String(p.text);
      if (p.fontSize) text.fontSize = p.fontSize;
      if (p.colorHex) text.fills = [solidPaint(p.colorHex)];
    });
  },

  async create_instance(p, call) {
    if (!p.componentKey && !p.componentId) throw new Error('Provide componentId or componentKey');
    let component: BaseNode = p.componentKey
      ? await figma.importComponentByKeyAsync(p.componentKey)
      : await getNode(p.componentId);
    if (component.type === 'COMPONENT_SET') component = component.defaultVariant;
    if (component.type !== 'COMPONENT') throw new Error(`Node "${component.id}" is ${component.type}, not a COMPONENT`);
    const main = component;
    return createNode(p, call, () => main.createInstance(), () => undefined);
  },

  async create_page(p, call) {
    const page = figma.createPage();
    noteCreated(call, page);
    page.name = String(p.name);
    return { id: page.id, name: page.name };
  },

  // ---- edit ----

  async update_text(p, call) {
    const node = await getNode(p.nodeId);
    const text = textTarget(node);
    if (!text) throw new Error(`Node "${node.id}" is ${node.type} and has no editable text`);
    await loadFontsFor(node);
    text.characters = String(p.newText);
    noteModified(call, node.id, ['characters']);
    return { id: node.id, name: node.name, type: node.type, characters: text.characters };
  },

  async set_node_properties(p, call) {
    const node = await getSceneNode(p.nodeId);
    const outcome = await applyProperties(node, p.properties ?? {});
    noteModified(call, node.id, outcome.applied);
    return { ...summary(node), ...outcome };
  },

  async set_image_fill(p, call) {
    const node = await getSceneNode(p.nodeId);
    if (!('fills' in node)) throw new Error(`${node.type} has no fills`);
    let image: Image;
    if (typeof p.imageBase64 === 'string') {
      // The server downloaded the image; the plugin itself has no internet access.
      image = figma.createImage(figma.base64Decode(p.imageBase64));
    } else {
      try {
        image = await figma.createImageAsync(p.url);
      } catch (err) {
        throw new Error(
          `Figma could not load ${p.url} (${errorMessage(err)}). This plugin has no internet access; update and ` +
            'restart the figma-local-mcp server, which downloads images itself.',
        );
      }
    }
    node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: p.scaleMode ?? 'FILL' }];
    noteModified(call, node.id, ['fills']);
    return { ...summary(node), imageHash: image.hash };
  },

  async clone_node(p, call) {
    const copy = (await getSceneNode(p.nodeId)).clone();
    noteCreated(call, copy);
    if (p.parentId) (await resolveParent({ parentId: p.parentId }, call)).appendChild(copy);
    if (p.x !== undefined) copy.x = p.x;
    if (p.y !== undefined) copy.y = p.y;
    if (p.name) copy.name = p.name;
    return summary(copy);
  },

  async delete_nodes(p, call) {
    const deleted: string[] = [];
    const failed: Json = {};
    for (const id of p.nodeIds as string[]) {
      try {
        (await getSceneNode(id)).remove();
        noteDeleted(call, id);
        deleted.push(id);
      } catch (err) {
        failed[id] = errorMessage(err);
      }
    }
    return { deleted, failed };
  },

  async set_selection(p) {
    const nodes = await Promise.all((p.nodeIds as string[]).map(getSceneNode));
    const page = nodes.length ? pageOf(nodes[0]) : null;
    if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = nodes;
    if (nodes.length && p.zoom !== false) figma.viewport.scrollAndZoomIntoView(nodes);
    return nodes.map(summary);
  },

  async set_current_page(p) {
    const page = await getNode(p.pageId);
    if (page.type !== 'PAGE') throw new Error(`Node "${page.id}" is ${page.type}, not a PAGE`);
    await figma.setCurrentPageAsync(page);
    return { id: page.id, name: page.name };
  },

  // ---- full access ----

  async execute_figma_code(p, call) {
    const code = String(p.code);
    call.script = { cal: await calibrateScripts(), lineCount: code.split('\n').length };
    const capture = (...args: unknown[]) => {
      if (call.logs.length >= MAX_LOG_ENTRIES) return;
      const line = args.map(formatLogArg).join(' ');
      call.logs.push(line.length > MAX_LOG_CHARS ? `${line.slice(0, MAX_LOG_CHARS)}...` : line);
    };
    const sandboxConsole = { log: capture, info: capture, warn: capture, error: capture, debug: capture };
    let run: (...args: unknown[]) => Promise<unknown>;
    try {
      run = new AsyncFunction(...SCRIPT_PARAMS, `${code}\n//# sourceURL=${SCRIPT_URL}`);
    } catch (err) {
      if (err instanceof Error) err.message = `Code failed to compile: ${err.message}`;
      throw err;
    }
    const page = await resolvePage(p.pageId, call);
    const params: Params = { ...(p.params ?? {}) };
    if (!('page' in params)) params.page = page;
    const running = run(scriptApi(call), sandboxConsole, params, makeHelpers(call, page));
    call.settled = running.then(
      () => undefined,
      () => undefined,
    );
    try {
      const value = await withTimeout(running, Number(p.timeoutMs ?? 30000));
      return { result: normalize(value), logs: call.logs };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') call.cancelled = true;
      throw err;
    }
  },
};

// ------------------------------------------------------------------ dispatch

const records = new Map<string, CallRecord>();
function remember(record: CallRecord): void {
  records.set(record.callId, record);
  while (records.size > CALL_RECORDS_KEPT) records.delete(records.keys().next().value!);
}

/** What this plugin knows about a call; used by the hub after reconnects and by get_call_result. */
function callResult(callId: string): Json {
  const record = records.get(callId);
  if (!record) return { status: 'unknown-call' };
  return {
    status: record.status,
    command: record.command,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    ...(record.reply ? { reply: record.reply } : {}),
    ...(record.lateChanges ? { lateChanges: record.lateChanges } : {}),
    ...(record.unattributedChanges ? { unattributedChanges: record.unattributedChanges } : {}),
  };
}

// ---- server version (the hub announces itself with hub-hello; builds before 3.2 stay silent)

let hubVersion: string | null = null;
let hubSilent = false;
let hubTimer: ReturnType<typeof setTimeout> | null = null;

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number(part) || 0);
  const pb = b.split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

function bridgeWarning(): string | null {
  if (hubSilent) {
    return (
      `The figma-local-mcp server this plugin (v${PLUGIN_VERSION}) is connected to is an older build (before 3.2), ` +
      'so some fixes are not live. Restart every MCP client that uses figma-local.'
    );
  }
  if (!hubVersion) return null;
  const order = compareVersions(hubVersion, PLUGIN_VERSION);
  if (order < 0) {
    return `The figma-local-mcp server is v${hubVersion} but this plugin is v${PLUGIN_VERSION}. Restart every MCP client that uses figma-local.`;
  }
  if (order > 0) {
    return `This plugin is v${PLUGIN_VERSION} but the figma-local-mcp server is v${hubVersion}. Close the plugin and run it again.`;
  }
  return null;
}

function showBridgeWarning(): void {
  figma.ui.postMessage({ type: 'bridge-warning', text: bridgeWarning() });
}

async function execute(msg: CommandMessage): Promise<void> {
  const record: CallRecord = { callId: msg.id, command: msg.command, status: 'running', startedAt: Date.now() };
  remember(record);
  const params = msg.params ?? {};
  const isScript = msg.command === 'execute_figma_code';
  const undoable = !READ_ONLY.has(msg.command);
  const tracked = undoable && !(isScript && params.trackChanges === false && !params.dryRun);
  const call: CallContext = {
    callId: msg.id,
    logs: [],
    cancelled: false,
    lastProgress: Date.now(),
    changes: null,
    window: null,
    page: null,
    script: null,
    needsReencode: false,
  };
  currentCall = call;
  // Heartbeat for the hub whenever the event loop gets a chance (scripts make room with helpers.yield()).
  const ticker = setInterval(() => postProgress(call), 2000);
  // An edit call waits until earlier calls' changes are confirmed, so no batch of events mixes two calls.
  const unconfirmed = tracked ? await gate() : [];
  const window = tracked ? openWindow(msg.id) : null;
  call.window = window;
  call.changes = window ? window.changes : null;
  // Close the user's open undo step so this call becomes exactly one step of its own (pending bridge
  // bookkeeping - a sentinel or the helper layer - is simply folded into this call's step instead).
  if (undoable && !pendingOnlySentinel) figma.commitUndo();
  pendingOnlySentinel = false;

  let reply: Json;
  try {
    if (!hasOwn(handlers, msg.command)) throw new Error(`Unknown command "${msg.command}"`);
    const result = await handlers[msg.command](params, call);
    reply = { type: 'reply', id: msg.id, ok: true, result };
  } catch (err) {
    const error = describeError(err, call.script);
    if (call.logs.length) error.logs = call.logs;
    if (call.cancelled) error.stillRunning = true;
    reply = { type: 'reply', id: msg.id, ok: false, error };
  }
  clearInterval(ticker);

  if (window) {
    const likely = isScript && (params.trackChanges === true || MUTATION_HINT.test(String(params.code ?? '')));
    const page = call.page ?? figma.currentPage;
    const problems = await settleWindow(window, page, likely, isScript);
    if (unconfirmed.length) {
      problems.unshift(
        `This call started while earlier call(s) ${unconfirmed.join(', ')} were still unconfirmed by Figma. Changes ` +
          'that could belong to either are reported as unattributedChanges instead of being credited to one call.',
      );
    }
    const changes = summarizeChanges(window.changes);
    if (hasChanges(changes)) reply.changes = changes;
    if (problems.length) reply.changesNote = problems.join(' ');
    // From here on, anything this window receives is late (reported later, attributed to this call).
    window.late = newChangeSet();
    if (!window.carrierId) closeWindow(window, false);

    if (isScript && params.dryRun) {
      reply.rolledBack = hasChanges(changes);
      if (hasChanges(changes) || window.carrierId) {
        figma.commitUndo();
        figma.triggerUndo();
        // Swallow the undo's own events (it restores exactly the nodes the script touched) so they don't show
        // up in a later call; a fresh sentinel tells when they have all arrived.
        const echo = openWindow(`${msg.id}:undo`, true);
        for (const id of window.changes.created.keys()) echo.absorbIds.add(id);
        for (const id of window.changes.deleted) echo.absorbIds.add(id);
        for (const id of window.changes.modified.keys()) echo.absorbIds.add(id);
        if (placeSentinel(echo, page)) pendingOnlySentinel = true;
        else closeWindow(echo, false);
      }
    } else if (hasChanges(changes) || !window.carrierId) {
      figma.commitUndo();
    } else {
      // Nothing changed but the sentinel: leave it uncommitted rather than create an invisible undo step.
      pendingOnlySentinel = true;
    }
  } else if (undoable) {
    figma.commitUndo();
  }
  if (lateNotices.length) reply.lateChanges = lateNotices.splice(0);
  if (unattributedNotices.length) reply.unattributedChanges = unattributedNotices.splice(0);
  const warning = bridgeWarning();
  if (warning) {
    reply.warnings = [warning];
    // Servers before 3.2 drop unknown reply fields, so also put the warning inside object results.
    const result = reply.result as Json | undefined;
    if (hubSilent && reply.ok && result && typeof result === 'object' && !Array.isArray(result)) {
      reply.result = { ...result, bridgeWarning: warning };
    }
  }
  if (call.needsReencode) reply.reencode = true;
  currentCall = null;

  record.status = reply.ok ? 'completed' : 'failed';
  record.finishedAt = Date.now();
  record.reply = reply;
  figma.ui.postMessage(reply);

  // A timed-out script may still be mutating the file: hold later commands until it settles (bounded).
  if (call.cancelled && call.settled) await Promise.race([call.settled, sleep(TIMED_OUT_SCRIPT_GRACE_MS)]);
}

// Commands run strictly one at a time, even if the hub re-sends or several arrive together.
let chain: Promise<void> = Promise.resolve();

figma.ui.onmessage = (msg: CommandMessage & { type?: string; version?: unknown }) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ui-ready') {
    publishInfo(true);
    return;
  }
  if (msg.type === 'ws-open') {
    // A (re)connection: expect the server to identify itself, or treat it as an older build.
    hubVersion = null;
    hubSilent = false;
    if (hubTimer) clearTimeout(hubTimer);
    hubTimer = setTimeout(() => {
      if (!hubVersion) {
        hubSilent = true;
        showBridgeWarning();
      }
    }, HUB_HELLO_TIMEOUT_MS);
    return;
  }
  if (msg.type === 'hub-hello') {
    hubVersion = String(msg.version ?? '');
    hubSilent = false;
    if (hubTimer) clearTimeout(hubTimer);
    showBridgeWarning();
    return;
  }
  if (typeof msg.id !== 'string' || typeof msg.command !== 'string') return;
  if (msg.command === '__get_call_result') {
    figma.ui.postMessage({ type: 'reply', id: msg.id, ok: true, result: callResult(String(msg.params?.callId)) });
    return;
  }
  const known = records.get(msg.id);
  if (known) {
    // Duplicate delivery (re-sent after a reconnect): answer from the record instead of running twice.
    if (known.reply) figma.ui.postMessage(known.reply);
    return;
  }
  remember({ callId: msg.id, command: msg.command, status: 'queued', startedAt: Date.now() });
  chain = chain.then(() => execute(msg)).catch(() => undefined);
};
