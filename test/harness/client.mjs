// The page side of the harness's window.claude: the `db` and `user`
// namespaces, built as db.d.ts and user.d.ts describe them, talking to
// test/harness/server.mjs: fetch for calls, one EventSource for live changes.
// The inline script server.mjs puts at the end of <head> imports this once
// use() is first called, and resolves use("db") / use("user") with
// namespace(name, config).
//
// How it behaves, as the contract asks:
// - refs are pure and frozen; a bad path throws TypeError at once;
// - verbs reject with plain { code, message };
// - your own writes show at once (hasPendingWrites: true), then confirmed;
//   a refused one rolls back and rejects; writes go out one at a time, in order;
// - a subscription delivers soon after it starts: first from what this page
//   already knows (fromCache: true), then the server's answer; while the live
//   stream is down deliveries say fromCache: true, and it catches up on reconnect;
// - a document that didn't change is the same frozen object across deliveries;
// - at most 64 live subscriptions; the 65th gets resource_exhausted.
import { splitPath, checkBody, checkQuery, runQuery, filterOnly, deepMerge, deepFreeze, equal, LIMITS } from './store.mjs';

export function namespace(name, config) {
  if (name === 'db') return config.level === 'none' ? null : dbNamespace(config);
  if (name === 'user') return userNamespace(config);
  if (name === 'room') return roomNamespace(config);
  if (name === 'sample') return sampleNamespace();
  return null;
}

// use("sample"), as sample.d.ts has it, with a scripted Claude in place of a
// real one: json() checks the call as the platform would, runs the page's
// first tool on a recipe, then on a darker one, and answers with that.
// Records each call on window.__mock.samples.
const TRIALS = [
  { name: 'Oak herringbone', base: '#b48a5c', pattern: { type: 'herringbone', size: [3, 18], colors: ['#b48a5c', '#a87e52', '#c09668'], vary: 0.2 }, layers: [{ type: 'grain', color: '#7d5a37', amount: 0.45, scale: 0.18 }] },
  { name: 'Oak herringbone', base: '#a27a4e', pattern: { type: 'herringbone', size: [3, 18], colors: ['#a27a4e', '#97714a', '#ad8458'], vary: 0.15 }, layers: [{ type: 'grain', color: '#73522f', amount: 0.4, scale: 0.18 }] },
];
function sampleNamespace() {
  const log = (window.__mock.samples ??= []);
  const reject = (code, message) => Promise.reject({ code, message });
  async function json(input, opts = {}) {
    if (typeof input !== 'string' && !Array.isArray(input)) return reject('invalid_request', 'input must be a string or turns');
    if (opts.signal?.aborted) return reject('cancelled', 'aborted');
    const images = opts.images ? [].concat(opts.images) : [];
    if (!images.every((b) => b instanceof Blob)) return reject('invalid_request', 'images must be Blobs');
    const entry = { prompt: String(input).slice(0, 200), images: images.map((b) => ({ type: b.type, size: b.size })), tools: (opts.tools ?? []).map((t) => t.name), results: [] };
    log.push(entry);
    const tool = opts.tools?.[0];
    for (const recipe of TRIALS) {
      await new Promise((r) => setTimeout(r, 250));
      if (opts.signal?.aborted) return reject('cancelled', 'aborted');
      if (tool) { try { entry.results.push(await tool.execute({ recipe }, { signal: opts.signal })); } catch (e) { entry.results.push(`Error: ${e.message}`); } }
    }
    return structuredClone(TRIALS[TRIALS.length - 1]);
  }
  const sample = (input, opts) => json(input, opts).then((v) => ({ text: JSON.stringify(v), truncated: false, modelTierApplied: 'default' }));
  sample.json = json;
  sample.limits = () => Promise.resolve({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] }, tools: { maxCount: 8 } });
  return Object.freeze(sample);
}

// The room, as room.d.ts has it, only as far as the app uses it: presence,
// peers and onPeers (from one EventSource), canSendToClaudeSession and
// sendToClaudeSession (recorded by the server at /__room/sent). Moments on
// topics (emit/on) go nowhere.
function roomNamespace(config) {
  const peer = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
  let list = Object.freeze([]), mine = {};
  const handlers = new Set();
  const asPeer = (p) => Object.freeze({ peer: p.peer, by: p.by, isMe: p.by === config.uid && config.uid != null, sameTab: p.peer === peer, kind: 'viewer', guest: p.guest, presence: Object.freeze({ ...p.presence }), updatedAt: p.updatedAt });
  const es = new EventSource(`/__room/live?as=${encodeURIComponent(config.role)}&uid=${encodeURIComponent(config.uid ?? '')}&peer=${peer}`);
  es.addEventListener('peers', (ev) => {
    const before = new Map(list.map((p) => [p.peer, p]));
    list = Object.freeze(JSON.parse(ev.data).map((p) => (before.get(p.peer)?.updatedAt === p.updatedAt ? before.get(p.peer) : asPeer(p))));
    const now = new Set(list.map((p) => p.peer));
    const change = Object.freeze({
      peers: list, joined: list.filter((p) => !before.has(p.peer)), left: [...before.values()].filter((p) => !now.has(p.peer)),
      updated: list.filter((p) => before.has(p.peer) && before.get(p.peer) !== p),
    });
    for (const h of handlers) { try { h(change); } catch (e) { report(e); } }
  });
  const post2 = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  return Object.freeze({
    presence(patch) {
      mine = { ...mine };
      for (const [k, v] of Object.entries(patch ?? {})) { if (v === null) delete mine[k]; else mine[k] = v; }
      return post2('/__room/presence', { peer, presence: mine }).then(() => {});
    },
    peers: () => list,
    onPeers(handler) { handlers.add(handler); queueMicrotask(() => handler(Object.freeze({ peers: list, joined: list, left: [], updated: [] }))); return () => handlers.delete(handler); },
    emit: () => Promise.resolve(),
    on: () => () => {},
    connected: () => es.readyState === 1,
    onConnection: () => () => {},
    canSendToClaudeSession: () => Promise.resolve(config.ask),
    sendToClaudeSession(data, options) {
      if (!['available', 'available_if_summoned', 'available_if_opened'].includes(config.ask)) return Promise.reject(fail('claude_unavailable', 'Nothing beside this view takes it.'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) return Promise.reject(fail('invalid_argument', 'Not a plain, non-empty object.'));
      return post2('/__room/send', { data, options: { deliver: options?.deliver ?? 'stage' } });
    },
  });
}

const fail = (code, message) => ({ code, message });
const report = (e) => (typeof reportError === 'function' ? reportError(e) : console.error(e));
const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));
const idOf = (path) => path.slice(path.lastIndexOf('/') + 1);
const sameMeta = (a, b) => a.fromCache === b.fromCache && a.hasPendingWrites === b.hasPendingWrites;

async function post(url, config, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Harness-As': config.role, 'X-Harness-Uid': config.uid ?? '' };
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' }); } catch { throw fail('unavailable', 'The harness server did not answer.'); }
  let out;
  try { out = await res.json(); } catch { throw fail('unavailable', `The harness server answered ${res.status}.`); }
  if (out.error) throw fail(out.error.code, out.error.message);
  return out.result;
}

// window.__mock.log: every db call this page made, newest last.
function logCall(entry) {
  const log = window.__mock?.log;
  if (!log) return entry;
  log.push(entry);
  if (log.length > 2000) log.splice(0, log.length - 2000);
  return entry;
}
function logged(entry, promise) {
  logCall(entry);
  return promise.then((r) => { entry.result = 'ok'; return r; }, (e) => { entry.result = e?.code ?? 'error'; throw e; });
}

const freshId = () => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => abc[b % abc.length]).join('');
};

function docSnap(id, body, metadata) {
  return Object.freeze({ id, exists: !!body, data: () => body ?? undefined, metadata: Object.freeze(metadata) });
}

// ---------------------------------------------------------------------------
class Client {
  confirmed = new Map(); // path -> { seq, body: frozen | null }, as of the store's seq
  pending = []; // this page's unconfirmed writes, in send order: { op, path, data }
  bodies = new Map(); // path -> the frozen body last shown, kept while equal
  views = new Map(); // path -> { body, pending }, dropped when the path changes
  listed = new Set(); // collections this page has listed whole (kept current live)
  subs = new Set();
  queue = Promise.resolve();
  live = false;
  flushing = false;

  constructor(config) {
    this.config = config;
    this.call = (body) => post('/__db/call', config, body);
  }

  // The live stream. Subscriptions read only once it is open, so no change
  // falls between a read and the stream; a reconnect re-reads them.
  connect() {
    if (this.es) return this.opened;
    this.opened = new Promise((r) => { this.markOpen = r; });
    const q = new URLSearchParams({ as: this.config.role, uid: this.config.uid ?? '' });
    const es = this.es = new EventSource(`/__db/live?${q}`);
    let before = false;
    es.addEventListener('change', (e) => {
      const { path, seq, exists, data } = JSON.parse(e.data);
      this.learn(path, seq, exists ? data : null);
    });
    es.onopen = () => {
      this.live = true;
      this.markOpen();
      // fromCache until each re-read lands.
      if (before) for (const sub of this.subs) { sub.ready = false; this.load(sub); }
      before = true;
      this.schedule();
    };
    es.onerror = () => { this.live = false; this.schedule(); };
    return this.opened;
  }

  learn(path, seq, body) {
    const c = this.confirmed.get(path);
    if (c && c.seq >= seq) return;
    this.confirmed.set(path, { seq, body });
    this.touch(path);
  }
  touch(path) {
    this.views.delete(path);
    this.schedule();
  }

  // What this page shows for a path: the store's state with its own pending
  // writes on top. body: undefined = unknown, null = missing.
  view(path) {
    let v = this.views.get(path);
    if (v) return v;
    let body = this.confirmed.get(path)?.body;
    let pending = false;
    for (const w of this.pending) {
      if (w.path !== path) continue;
      pending = true;
      if (w.op === 'set') body = w.data;
      else if (w.op === 'delete') body = null;
      // An update to a document this page hasn't seen waits for the store.
      else if (w.op === 'update' && body) body = deepMerge(body, w.data);
    }
    if (body) {
      const prev = this.bodies.get(path);
      if (prev && equal(prev, body)) body = prev;
      else this.bodies.set(path, body = deepFreeze(body));
    }
    v = { body, pending };
    this.views.set(path, v);
    return v;
  }

  // -- verbs ----------------------------------------------------------------
  async get(path) {
    const r = await this.call({ op: 'get', path });
    this.learn(path, r.at, r.exists ? r.data : null);
    // The store's answer; the same object as last shown when it is equal.
    const prev = this.bodies.get(path);
    const body = !r.exists ? null : prev && equal(prev, r.data) ? prev : deepFreeze(r.data);
    return docSnap(idOf(path), body, { fromCache: false, hasPendingWrites: false });
  }

  async list(path, q) {
    const r = await this.call({ op: 'list', path, query: q });
    return r.docs.map((d) => docSnap(d.id, deepFreeze(d.data), { fromCache: false, hasPendingWrites: false }));
  }

  write(op, path, data) {
    const w = { op, path, data };
    this.pending.push(w);
    this.touch(path);
    const settle = () => { this.pending.splice(this.pending.indexOf(w), 1); this.touch(path); };
    const run = this.queue.then(() => this.call({ op, path, data }));
    this.queue = run.catch(() => {});
    return run.then((r) => { this.learn(path, r.seq, r.exists ? r.data : null); settle(); }, (e) => { settle(); throw e; });
  }

  // -- subscriptions --------------------------------------------------------
  subscribe(sub) {
    const terminal = (e) => {
      sub.dead = true;
      this.subs.delete(sub);
      if (sub.error) { try { sub.error(e); } catch (x) { report(x); } } else report(Object.assign(new Error(e.message), { code: e.code }));
    };
    if (this.subs.size >= LIMITS.subscriptions) {
      setTimeout(() => terminal(fail('resource_exhausted', `At most ${LIMITS.subscriptions} active subscriptions per view.`)));
      return () => {};
    }
    // A bad query fails on the error callback at subscribe time.
    if (sub.invalid) {
      setTimeout(() => terminal(sub.invalid));
      return () => {};
    }
    sub.terminal = terminal;
    sub.ready = false;
    this.subs.add(sub);
    this.connect();
    this.load(sub);
    this.schedule();
    return () => {
      if (sub.dead) return;
      sub.dead = true;
      this.subs.delete(sub);
      logCall({ op: 'unsubscribe', path: sub.path, at: Math.round(performance.now()) });
    };
  }

  async load(sub) {
    await this.opened;
    while (!sub.dead) {
      try {
        if (sub.kind === 'doc') {
          const r = await this.call({ op: 'get', path: sub.path });
          this.learn(sub.path, r.at, r.exists ? r.data : null);
        } else {
          // The whole collection as this viewer sees it; the query runs here,
          // over that and this page's own pending writes.
          const r = await this.call({ op: 'list', path: sub.path });
          const here = new Set(r.docs.map((d) => d.path));
          for (const d of r.docs) this.learn(d.path, r.at, d.data);
          for (const p of this.confirmed.keys()) if (parentOf(p) === sub.path && !here.has(p)) this.learn(p, r.at, null);
          this.listed.add(sub.path);
        }
        sub.ready = true;
        this.schedule();
        return;
      } catch (e) {
        if (e.code !== 'unavailable') { sub.terminal(e); return; }
        // Transient: subscriptions retry on their own.
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
      }
    }
  }

  schedule() {
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => { this.flushing = false; this.flush(); });
  }

  flush() {
    for (const sub of [...this.subs]) {
      if (sub.dead) continue;
      const snap = sub.kind === 'doc' ? this.docDelivery(sub) : this.queryDelivery(sub);
      if (!snap) continue;
      try { sub.next(snap); } catch (e) { report(e); }
    }
  }

  docDelivery(sub) {
    const v = this.view(sub.path);
    if (v.body === undefined) return null;
    const meta = { fromCache: !(sub.ready && this.live), hasPendingWrites: v.pending };
    const last = sub.last;
    if (last && last.data() === (v.body ?? undefined) && sameMeta(last.metadata, meta)) return null;
    return (sub.last = docSnap(idOf(sub.path), v.body, meta));
  }

  queryDelivery(sub) {
    if (!sub.ready && !this.listed.has(sub.path)) return null;
    const fromCache = !(sub.ready && this.live);
    const paths = new Set([...this.confirmed.keys(), ...this.pending.map((w) => w.path)]);
    const docs = [];
    for (const p of paths) {
      if (parentOf(p) !== sub.path) continue;
      const v = this.view(p);
      if (v.body) docs.push({ id: idOf(p), path: p, data: v.body, pending: v.pending });
    }
    const old = sub.byId ?? new Map();
    const snaps = runQuery(docs, sub.q).map((d) => {
      const meta = { fromCache, hasPendingWrites: d.pending };
      const prev = old.get(d.id);
      return prev && prev.data() === d.data && sameMeta(prev.metadata, meta) ? prev : docSnap(d.id, d.data, meta);
    });
    // Pending if one of this page's writes touches a document the filters see.
    const pendingHere = this.pending.some((w) => parentOf(w.path) === sub.path
      && [this.view(w.path).body, this.confirmed.get(w.path)?.body].some((b) => b && filterOnly(b, sub.q)));
    const meta = Object.freeze({ fromCache, hasPendingWrites: pendingHere });
    const prevDocs = sub.docs;
    if (prevDocs && prevDocs.length === snaps.length && snaps.every((s, i) => s === prevDocs[i]) && sameMeta(sub.meta, meta)) return null;
    const changes = diff(prevDocs ?? [], snaps);
    sub.docs = snaps;
    sub.meta = meta;
    sub.byId = new Map(snaps.map((s) => [s.id, s]));
    const list = Object.freeze(snaps);
    return Object.freeze({ docs: list, size: list.length, empty: !list.length, docChanges: () => changes, metadata: meta });
  }
}

// Removals first, then additions and modifications in the new order; indexes
// are positions in the previous and the new docs.
function diff(prev, next) {
  const was = new Map(prev.map((s, i) => [s.id, i]));
  const now = new Map(next.map((s, i) => [s.id, i]));
  const out = [];
  prev.forEach((s, i) => { if (!now.has(s.id)) out.push({ type: 'removed', doc: s, oldIndex: i, newIndex: -1 }); });
  next.forEach((s, i) => {
    const j = was.get(s.id);
    if (j === undefined) out.push({ type: 'added', doc: s, oldIndex: -1, newIndex: i });
    else if (prev[j].data() !== s.data()) out.push({ type: 'modified', doc: s, oldIndex: j, newIndex: i });
  });
  return Object.freeze(out.map(Object.freeze));
}

// ---------------------------------------------------------------------------
function dbNamespace(config) {
  const client = new Client(config);
  const at = () => Math.round(performance.now());
  window.__mock.state = () => ({ live: client.live, subscriptions: client.subs.size, pending: client.pending.length });
  const rejectWith = (entry, e) => logged(entry, Promise.reject(fail(e.code ?? 'invalid_argument', e.message)));

  // A write's body is checked here first, so a bad one never shows locally.
  const verb = (op, path, data) => {
    const entry = { op, path, at: at() };
    let body;
    try {
      if (op === 'set') body = checkBody(data);
      else if (op === 'update') body = checkBody(data, 'An update');
    } catch (e) { return rejectWith(entry, e); }
    return logged(entry, client.write(op, path, body));
  };
  const subscribe = (sub, next, error) => {
    if (typeof next !== 'function') throw new TypeError('onSnapshot() needs a callback.');
    logCall({ op: 'onSnapshot', path: sub.path, ...(sub.spec && { query: sub.spec }), at: at() });
    return client.subscribe({ ...sub, next, error });
  };

  function docRef(path) {
    const segs = splitPath(path, 'doc');
    return Object.freeze({
      id: segs.at(-1),
      path,
      get: () => logged({ op: 'get', path, at: at() }, client.get(path)),
      set: (data) => verb('set', path, data),
      update: (data) => verb('update', path, data),
      delete: () => verb('delete', path),
      acquire(options) {
        const entry = { op: 'acquire', path, at: at() };
        let opts;
        try { opts = JSON.parse(JSON.stringify(options ?? {})); } catch (e) { return rejectWith(entry, e); }
        return logged(entry, client.call({ op: 'acquire', path, options: opts }));
      },
      onSnapshot: (next, error) => subscribe({ kind: 'doc', path }, next, error),
      collection(sub) {
        splitPath(sub, 'collection');
        return collRef(`${path}/${sub}`);
      },
    });
  }

  // Builders are pure: each returns a new Query; the terminal calls check it
  // (as given, so an undefined value is caught before JSON turns it to null).
  function query(path, spec) {
    const more = (key, value) => query(path, { ...spec, [key]: key === 'limit' ? value : [...(spec[key] ?? []), value] });
    const checked = () => checkQuery(JSON.parse(JSON.stringify(checkQuery(spec))));
    return Object.freeze({
      where: (field, op, value) => more('where', [field, op, value]),
      orderBy: (field, dir) => more('orderBy', dir === undefined ? [field] : [field, dir]),
      limit: (n) => more('limit', n),
      get() {
        const entry = { op: 'query', path, query: spec, at: at() };
        let q;
        try { q = checked(); } catch (e) { return rejectWith(entry, e); }
        return logged(entry, client.list(path, q).then((docs) => Object.freeze({
          docs: Object.freeze(docs), size: docs.length, empty: !docs.length,
          docChanges: () => Object.freeze(docs.map((d, i) => Object.freeze({ type: 'added', doc: d, oldIndex: -1, newIndex: i }))),
          metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }),
        })));
      },
      onSnapshot(next, error) {
        let q, invalid;
        try { q = checked(); } catch (e) { invalid = fail(e.code ?? 'invalid_argument', e.message); }
        return subscribe({ kind: 'query', path, spec, q, invalid }, next, error);
      },
    });
  }

  function collRef(path) {
    splitPath(path, 'collection');
    const all = query(path, {});
    return Object.freeze({
      path,
      where: all.where, orderBy: all.orderBy, limit: all.limit, get: all.get, onSnapshot: all.onSnapshot,
      doc(id) {
        if (id === undefined) id = freshId();
        else splitPath(id);
        return docRef(`${path}/${id}`);
      },
      async add(data) {
        const ref = docRef(`${path}/${freshId()}`);
        await ref.set(data);
        return ref;
      },
    });
  }

  return Object.freeze({ doc: (path) => docRef(path), collection: (path) => collRef(path) });
}

// ---------------------------------------------------------------------------
// user: every read resolves, never rejects. config.me is what the server
// knows of this viewer; config.can is null when the platform says nothing.
function userNamespace(config) {
  const me = Object.freeze({ ...config.me });
  const resolved = new Set();
  const unresolved = (id) => Object.freeze({ id, name: '', avatarUrl: config.genericAvatar, color: config.neutralColor, email: null, isMe: id === me.id, guest: false });
  const entry = (p) => {
    if (p.name) resolved.add(p.id);
    return Object.freeze({ id: p.id, name: p.name, avatarUrl: p.avatarUrl, color: p.color, email: null, isMe: p.id === me.id, guest: !!p.guest });
  };

  async function profiles(ids) {
    const list = [...new Set(typeof ids === 'string' ? [ids] : Array.from(ids ?? [], String))];
    let found = {};
    if (list.length) { try { found = await post('/__user/profiles', config, { ids: list }); } catch { /* all unresolved */ } }
    return Object.fromEntries(list.map((id) => [id, found[id] ? entry(found[id]) : unresolved(id)]));
  }

  // A newer search() supersedes an older one: both resolve with its result.
  let latest = null;
  async function lookup(q) {
    if (!config.searchable) return [];
    if (!q) {
      const ids = [...new Set([me.id, ...resolved].filter(Boolean))];
      return Object.values(await profiles(ids)).filter((p) => p.name).slice(0, 8);
    }
    try { return (await post('/__user/search', config, { q })).map(entry); } catch { return []; }
  }
  async function search(text) {
    let cur = latest = lookup(String(text ?? ''));
    let out = await cur;
    while (cur !== latest) { cur = latest; out = await cur; }
    return out;
  }

  return Object.freeze({
    isOwner: async () => me.isOwner,
    canEdit: async () => me.canEdit,
    can: async (name) => (config.can === null ? null : Object.hasOwn(config.can, name) ? config.can[name] : false),
    me: async () => me,
    id: async () => me.id,
    name: async () => me.name,
    avatarUrl: async () => (me.id ? me.avatarUrl : null),
    email: async () => null,
    profiles,
    search,
  });
}
