// A small in-memory stand-in for the Figma Plugin API: enough for the bridge's tests to run the real
// compiled plugin (figma-plugin/code.js) without Figma. Models nodes, pages, `nodechange` events delivered
// late and in batches (as in heavy files; property changes of one node merged within a batch; order inside a
// batch not preserved; an optional warm-up before the first delivery), an undo stack (including plugin data),
// exports whose byte size grows with pixel area, and Figma's read-only, non-configurable API properties.

let nextId = 1;

export function createFigmaMock({
  fileName,
  editorType = 'figma',
  fileKey = null,
  bytesPerPixel = 0.5,
  eventDelayMs = 5,
  batchIntervalMs = 20,
  // Simulates a Figma that never reports plugin-data changes (so every sentinel is lost).
  dropPluginDataEvents = false,
  // Nothing is delivered until this long after startup (the slow first deliveries seen after the plugin starts).
  warmupMs = 0,
  // Figma doesn't keep event order inside a batch: 'byType' lists deletions first, then creations, then
  // property changes (which reproduces the misattribution seen in FigJam); 'fifo' keeps the order.
  batchOrder = 'byType',
}) {
  const startedAt = Date.now();
  const registry = new Map();
  const listeners = { currentpagechange: new Set(), selectionchange: new Set() };
  const undo = { current: [], history: [], triggered: 0 };
  const state = { closed: false, delivered: 0, networkRequests: [] };
  const pages = new Set();
  let uiHandler = () => {};

  const prefix = `${nextId++}`;
  let counter = 0;
  const newId = () => `${prefix}:${++counter}`;

  function emit(page, change) {
    if (!page || !page.listeners.size) return;
    if (dropPluginDataEvents && change.properties?.length === 1 && change.properties[0] === 'pluginData') return;
    page.queue.push({ origin: 'LOCAL', ...change, at: Date.now() });
  }

  // Figma batches nodechange events and delivers them asynchronously, much later in heavy files. Within a
  // batch, property changes to the same node are merged into the entry of its first change.
  const typeRank = { DELETE: 0, CREATE: 1, PROPERTY_CHANGE: 2 };
  const pump = setInterval(() => {
    const now = Date.now();
    if (now - startedAt < warmupMs) return;
    for (const page of pages) {
      const due = [];
      while (page.queue.length && now - page.queue[0].at >= eventDelayMs) due.push(page.queue.shift());
      if (!due.length) continue;
      const batch = [];
      const byId = new Map();
      for (const { at, ...change } of due) {
        if (change.type === 'PROPERTY_CHANGE' && byId.has(change.id)) {
          const merged = byId.get(change.id);
          for (const prop of change.properties) if (!merged.properties.includes(prop)) merged.properties.push(prop);
          continue;
        }
        const entry = change.properties ? { ...change, properties: [...change.properties] } : { ...change };
        if (entry.type === 'PROPERTY_CHANGE') byId.set(entry.id, entry);
        batch.push(entry);
      }
      if (batchOrder === 'byType') batch.sort((a, b) => typeRank[a.type] - typeRank[b.type]);
      state.delivered += batch.length;
      for (const fn of [...page.listeners]) fn({ nodeChanges: batch });
    }
  }, batchIntervalMs);
  pump.unref?.();

  function pageOf(node) {
    let n = node;
    while (n && n.type !== 'PAGE') n = n.parent;
    return n;
  }

  function makeNode(type, props = {}, { register = true, container = false } = {}) {
    const node = {
      id: newId(),
      type,
      name: props.name ?? type.charAt(0) + type.slice(1).toLowerCase(),
      removed: false,
      parent: null,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      opacity: 1,
      visible: true,
      fills: [],
      pluginData: {},
      resize(w, h) {
        if (!(w >= 0.01 && h >= 0.01)) throw new Error('Size must be >= 0.01');
        this.width = w;
        this.height = h;
        emit(pageOf(this), { type: 'PROPERTY_CHANGE', id: this.id, node: this, properties: ['width', 'height'] });
      },
      remove() {
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        const page = pageOf(this);
        this.parent = null;
        this.removed = true;
        registry.delete(this.id);
        emit(page, { type: 'DELETE', id: this.id, node: { removed: true, id: this.id, type: this.type } });
      },
      setPluginData(key, value) {
        const previous = this.pluginData[key];
        this.pluginData[key] = value;
        const page = pageOf(this);
        if (this.type === 'PAGE' || !page) return;
        emit(page, { type: 'PROPERTY_CHANGE', id: this.id, node: this, properties: ['pluginData'] });
        undo.current.push(() => {
          this.pluginData[key] = previous;
          emit(pageOf(this), { type: 'PROPERTY_CHANGE', id: this.id, node: this, properties: ['pluginData'] });
        });
      },
      getPluginData(key) {
        return this.pluginData[key] ?? '';
      },
      async exportAsync(settings) {
        if (settings.format === 'SVG_STRING') return `<svg width="${this.width}" height="${this.height}"/>`;
        const c = settings.constraint ?? { type: 'SCALE', value: 1 };
        const k =
          c.type === 'SCALE' ? c.value : c.type === 'WIDTH' ? c.value / this.width : c.value / this.height;
        const bytes = Math.max(16, Math.round(this.width * k * this.height * k * bytesPerPixel));
        return new Uint8Array(bytes);
      },
      clone() {
        const copy = makeNode(this.type, { name: this.name });
        copy.width = this.width;
        copy.height = this.height;
        this.parent?.appendChild(copy);
        return copy;
      },
      ...props,
    };
    if (container) {
      node.children = [];
      node.appendChild = function appendChild(child) {
        if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = this;
        this.children.push(child);
      };
      node.findAll = function findAll(fn = () => true) {
        const out = [];
        const visit = (n) => n.children?.forEach((c) => (fn(c) && out.push(c), visit(c)));
        visit(this);
        return out;
      };
    }
    if (register) registry.set(node.id, node);
    return node;
  }

  function makePage(name) {
    const page = makeNode('PAGE', { name }, { container: true });
    delete page.x;
    delete page.y;
    delete page.width;
    delete page.height;
    delete page.resize;
    page.selection = [];
    page.listeners = new Set();
    page.queue = [];
    page.on = (type, fn) => type === 'nodechange' && page.listeners.add(fn);
    page.off = (type, fn) => type === 'nodechange' && page.listeners.delete(fn);
    page.loadAsync = async () => {};
    pages.add(page);
    return page;
  }

  const page = makePage('Page 1');
  let currentPage = page;
  const root = {
    id: '0:0',
    type: 'DOCUMENT',
    name: fileName,
    children: [page],
    parent: null,
    removed: false,
    pluginData: {},
    setPluginData(key, value) {
      this.pluginData[key] = value;
    },
    getPluginData(key) {
      return this.pluginData[key] ?? '';
    },
  };
  page.parent = root;
  registry.set(root.id, root);

  /** New nodes land on the current page, as in Figma, and become one undoable operation. */
  function created(node) {
    currentPage.appendChild(node);
    undo.current.push(() => node.removed || node.remove());
    emit(currentPage, { type: 'CREATE', id: node.id, node });
    return node;
  }

  const members = {
    mixed: Symbol('mixed'),
    editorType,
    fileKey,
    root,
    currentUser: { id: 'user-1', name: 'Test User' },
    viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
    ui: {
      onmessage: null,
      postMessage: (msg) => uiHandler(msg),
    },
    showUI() {},
    closePlugin() {
      state.closed = true;
    },
    on(type, fn) {
      listeners[type]?.add(fn);
    },
    off(type, fn) {
      listeners[type]?.delete(fn);
    },
    commitUndo() {
      if (undo.current.length) undo.history.push(undo.current.splice(0));
    },
    triggerUndo() {
      undo.triggered++;
      const step = undo.current.length ? undo.current.splice(0) : undo.history.pop() ?? [];
      for (const revert of step.reverse()) revert();
    },
    async getNodeByIdAsync(id) {
      return registry.get(id) ?? null;
    },
    async loadFontAsync(font) {
      if (font?.family === 'Missing Font') throw new Error(`The font "${font.family} ${font.style}" could not be loaded`);
    },
    async loadAllPagesAsync() {},
    async setCurrentPageAsync(p) {
      currentPage = p;
      for (const fn of listeners.currentpagechange) fn();
    },
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
    base64Decode: (text) => new Uint8Array(Buffer.from(text, 'base64')),
    createImage(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw new Error('Image is not a valid PNG, JPEG or GIF');
      return { hash: `img-${bytes.length}` };
    },
    // The manifest allows no internet domains, so Figma would block any request the plugin makes itself.
    async createImageAsync(src) {
      state.networkRequests.push(src);
      throw new Error(`Network request to ${src} was blocked (not in networkAccess.allowedDomains)`);
    },
    createRectangle: () => created(makeNode('RECTANGLE', { cornerRadius: 0 })),
    createEllipse: () => created(makeNode('ELLIPSE')),
    createFrame: () => created(makeNode('FRAME', { layoutMode: 'NONE', itemSpacing: 0 }, { container: true })),
    createText: () =>
      created(
        makeNode('TEXT', {
          characters: '',
          fontName: { family: 'Inter', style: 'Regular' },
          hasMissingFont: false,
          getRangeAllFontNames: () => [],
        }),
      ),
    createPage: () => {
      const p = makePage('Page');
      p.parent = root;
      root.children.push(p);
      return p;
    },
  };

  // Like Figma's API object: every member is a read-only, non-configurable own property (so Proxy
  // invariants apply to it), currentPage is a getter, and the object is frozen.
  const figma = {};
  for (const [key, value] of Object.entries(members)) {
    Object.defineProperty(figma, key, { value, writable: false, configurable: false, enumerable: true });
  }
  Object.defineProperty(figma, 'currentPage', {
    get: () => currentPage,
    set: () => {
      throw new Error('Setting figma.currentPage is not supported with documentAccess: dynamic-page');
    },
    enumerable: true,
    configurable: false,
  });
  Object.freeze(figma);

  /** Builds `groups` frames of `perGroup` rectangles under one frame without emitting events. */
  function buildLargeTree({ groups, perGroup, width = 1440, height = 1024 }) {
    const frame = makeNode('FRAME', { name: 'Huge frame', width, height }, { container: true });
    page.appendChild(frame);
    for (let g = 0; g < groups; g++) {
      const group = makeNode('FRAME', { name: `Group ${g}` }, { container: true });
      frame.appendChild(group);
      for (let i = 0; i < perGroup; i++) group.appendChild(makeNode('RECTANGLE', { name: `Cell ${i}` }, { register: false }));
    }
    return frame;
  }

  function addFrame(props) {
    const frame = makeNode('FRAME', props, { container: true });
    page.appendChild(frame);
    return frame;
  }

  return {
    figma,
    registry,
    undo,
    state,
    page,
    buildLargeTree,
    addFrame,
    onUiMessage(fn) {
      uiHandler = fn;
    },
  };
}
