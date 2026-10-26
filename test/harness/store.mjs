// An in-memory stand-in for an Artifact's `db` capability, as its contract
// (artifact-capabilities 0.2.91, db.d.ts) describes it: the path grammar,
// set/update/delete, queries, per-document versions, the size limits, and the
// access rules, evaluated for one viewer at a time.
//
// Plain JavaScript with no Node imports: test/harness/server.mjs keeps the data
// in one Store, and the page-side mock (client.mjs) imports the grammar, body
// checks and query engine from this same file, so both ends agree.
//
// A viewer is { level, uid }: level is one of LEVELS, uid the id `user.id()`
// would give (null for none).

export const LEVELS = ['none', 'view', 'interact', 'admin', 'owner'];
const RANK = { none: 0, view: 1, interact: 2, admin: 3, owner: 4 };
export const atLeast = (level, min) => (RANK[level] ?? 0) >= RANK[min];

export const LIMITS = {
  bodyBytes: 256 * 1024, depth: 32, docs: 25000,
  segmentBytes: 200, pathBytes: 1000, segments: 16,
  filters: 10, inValues: 30, limit: 1000, rules: 64, subscriptions: 64,
};

// What every rejection carries. The page sees plain { code, message }.
export class DbError extends Error {
  constructor(code, message) { super(message); this.code = code; }
  toJSON() { return { code: this.code, message: this.message }; }
}
const invalid = (message) => new DbError('invalid_argument', message);

const encoder = new TextEncoder();
const utf8 = (s) => encoder.encode(s).length;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Paths. Builders throw TypeError for a path that breaks the grammar; kind is
// 'doc' (even segments), 'collection' (odd) or undefined (either).
const SEGMENT = /^[A-Za-z0-9_\-.~:@+]+$/;
export function splitPath(path, kind) {
  const what = kind === 'doc' ? 'A document path' : kind === 'collection' ? 'A collection path' : 'A path';
  if (typeof path !== 'string') throw new TypeError(`${what} must be a string, not ${path === null ? 'null' : typeof path}.`);
  if (path === '') throw new TypeError(`${what} cannot be empty.`);
  if (utf8(path) > LIMITS.pathBytes) throw new TypeError(`${what} is at most ${LIMITS.pathBytes} bytes.`);
  const segs = path.split('/');
  if (segs.length > LIMITS.segments) throw new TypeError(`"${path}" has ${segs.length} segments; a path has at most ${LIMITS.segments}.`);
  for (const s of segs) {
    if (s === '') throw new TypeError(`"${path}" has an empty segment (a leading, trailing or doubled slash).`);
    if (s === '.' || s === '..') throw new TypeError(`"${path}" has a "${s}" segment.`);
    if (!SEGMENT.test(s)) throw new TypeError(`Segment "${s}" of "${path}" uses a character other than letters, digits and _ - . ~ : @ +.`);
    if (s.length > LIMITS.segmentBytes) throw new TypeError(`A segment of "${path}" is over ${LIMITS.segmentBytes} bytes.`);
  }
  if (kind === 'doc' && segs.length % 2) throw new TypeError(`"${path}" has ${segs.length} segments; a document path has an even number (collection/doc).`);
  if (kind === 'collection' && !(segs.length % 2)) throw new TypeError(`"${path}" has ${segs.length} segments; a collection path has an odd number.`);
  return segs;
}

// ---------------------------------------------------------------------------
// Bodies: plain JSON objects, at most 256 KiB serialized and 32 levels deep
// (the body itself is level 1). Returns a JSON copy.
export function checkBody(data, what = 'A document body') {
  if (!isObj(data)) throw invalid(`${what} must be a JSON object, not ${Array.isArray(data) ? 'an array' : data === null ? 'null' : typeof data}.`);
  if (depthOf(data, 1) > LIMITS.depth) throw invalid(`${what} is more than ${LIMITS.depth} levels deep.`);
  let json;
  try { json = JSON.stringify(data); } catch { throw invalid(`${what} must be plain JSON.`); }
  const size = utf8(json);
  if (size > LIMITS.bodyBytes) throw invalid(`${what} is ${Math.ceil(size / 1024)} KiB; a document is at most ${LIMITS.bodyBytes / 1024} KiB.`);
  return JSON.parse(json);
}
// Stops counting past the limit, so a cycle ends here too.
function depthOf(v, d) {
  if (d > LIMITS.depth) return d;
  let max = d;
  for (const x of Object.values(v)) {
    if (x !== null && typeof x === 'object') max = Math.max(max, depthOf(x, d + 1));
    if (max > LIMITS.depth) break;
  }
  return max;
}

// update(): nested objects merge recursively; anything else, arrays included,
// replaces the field.
export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

export function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

export function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

// ---------------------------------------------------------------------------
// Queries, as the page's builders record them:
//   { where: [[field, op, value], ...], orderBy: [[field, dir], ...], limit }
// Filters and orderBy read top-level fields. A document missing a filtered
// field never matches (as in Firestore, != and not-in included); range
// operators only match values of the filter value's type.
const OPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains'];
export function checkQuery(q = {}) {
  const where = q.where ?? [];
  const orderBy = q.orderBy ?? [];
  if (where.length > LIMITS.filters) throw invalid(`A query has at most ${LIMITS.filters} filters.`);
  for (const [field, op, value] of where) {
    if (typeof field !== 'string' || !field) throw invalid('where() needs a field name.');
    if (!OPS.includes(op)) throw invalid(`Unknown operator "${op}"; use ${OPS.join(' ')}.`);
    if (value === undefined) throw invalid(`where("${field}", "${op}") needs a value.`);
    if ((op === 'in' || op === 'not-in') && (!Array.isArray(value) || value.length > LIMITS.inValues)) throw invalid(`"${op}" takes an array of at most ${LIMITS.inValues} values.`);
  }
  if (orderBy.length > 1) throw invalid('A query has at most one orderBy.');
  const [ob] = orderBy;
  if (ob && (typeof ob[0] !== 'string' || !ob[0])) throw invalid('orderBy() needs a field name.');
  if (ob && ob[1] !== undefined && ob[1] !== 'asc' && ob[1] !== 'desc') throw invalid('orderBy() direction is "asc" or "desc".');
  const limit = q.limit ?? null;
  if (limit !== null && !(Number.isInteger(limit) && limit >= 1 && limit <= LIMITS.limit)) throw invalid(`limit() takes a whole number from 1 to ${LIMITS.limit}.`);
  return { where: where.map(([f, o, v]) => [f, o, v]), orderBy: ob ? [[ob[0], ob[1] ?? 'asc']] : [], limit };
}

const typeRank = (v) => (v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : typeof v === 'string' ? 3 : Array.isArray(v) ? 4 : 5);
function compare(a, b) {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 4) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compare(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  if (ra === 5) { a = JSON.stringify(a); b = JSON.stringify(b); }
  return a < b ? -1 : a > b ? 1 : 0;
}

function matches(data, [field, op, value]) {
  if (!Object.hasOwn(data, field)) return false;
  const x = data[field];
  switch (op) {
    case '==': return equal(x, value);
    case '!=': return !equal(x, value);
    case 'in': return value.some((v) => equal(x, v));
    case 'not-in': return !value.some((v) => equal(x, v));
    case 'array-contains': return Array.isArray(x) && x.some((v) => equal(v, value));
    default: {
      if (typeRank(x) !== typeRank(value)) return false;
      const c = compare(x, value);
      return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
    }
  }
}

// docs: [{ id, data, ... }] of one collection; q from checkQuery. Without an
// orderBy, by document id; documents missing the ordered field sort last.
export const filterOnly = (data, q) => q.where.every((w) => matches(data, w));
export function runQuery(docs, q) {
  const [ob] = q.orderBy;
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const out = docs.filter((d) => filterOnly(d.data, q)).sort((a, b) => {
    if (ob) {
      const ha = Object.hasOwn(a.data, ob[0]), hb = Object.hasOwn(b.data, ob[0]);
      if (ha !== hb) return ha ? -1 : 1;
      if (ha) { const c = compare(a.data[ob[0]], b.data[ob[0]]); if (c) return ob[1] === 'desc' ? -c : c; }
    }
    return byId(a, b);
  });
  return q.limit ? out.slice(0, q.limit) : out;
}

// ---------------------------------------------------------------------------
// Rules, as declared in capabilities.db.rules, checked the way publish would.
export function checkRules(rules = []) {
  if (!Array.isArray(rules)) throw new TypeError('db rules are an array.');
  if (rules.length > LIMITS.rules) throw new TypeError(`At most ${LIMITS.rules} db rules.`);
  const out = [];
  for (const r of rules) {
    if (!isObj(r) || typeof r.path !== 'string') throw new TypeError('Each db rule has a path ("" for the root).');
    for (const k of ['read', 'write']) {
      if (r[k] !== undefined && !(r[k] !== 'none' && Object.hasOwn(RANK, r[k]))) throw new TypeError(`Rule "${r.path}": ${k} is view, interact, admin or owner.`);
    }
    if (r.read && r.write && RANK[r.write] < RANK[r.read]) throw new TypeError(`Rule "${r.path}": write is never below read.`);
    const segs = r.path === '' ? [] : r.path.split('/');
    const self = segs.at(-1) === '{self}';
    if (segs.slice(0, -1).includes('{self}')) throw new TypeError(`Rule "${r.path}": {self} must be the last segment.`);
    if (segs.length) splitPath(self ? [...segs.slice(0, -1), 'self'].join('/') : r.path);
    if (out.some((o) => o.path === r.path)) throw new TypeError(`Two rules at "${r.path}".`);
    out.push({ path: r.path, segs, self, read: r.read, write: r.write });
  }
  for (const r of out.filter((o) => o.self)) {
    const prefix = r.segs.slice(0, -1).join('/');
    const at = out.find((o) => o.path === prefix);
    if (at && !(at.read && at.write)) throw new TypeError(`Rule "${prefix}" is the prefix of "${r.path}", so it must set both read and write.`);
  }
  return out;
}

const startsWith = (segs, prefix) => prefix.every((s, i) => segs[i] === s);
const covers = (rule, segs, uid) => rule.segs.length <= segs.length
  && rule.segs.every((s, i) => (s === '{self}' ? uid != null && segs[i] === uid : s === segs[i]));

// ---------------------------------------------------------------------------
export class Store {
  #docs = new Map(); // path -> { data (deep-frozen), version, seq }
  #leases = new Map(); // path -> { holder, until }
  #listeners = new Set();
  #seq = 0;
  #declared = [];
  #rules = []; // deepest first
  #private = []; // prefixes whose children are per-viewer subtrees
  #open = new Set(); // those of them a declared rule opens to siblings

  constructor({ rules = [], now = Date.now } = {}) {
    this.now = now;
    this.setRules(rules);
  }

  setRules(rules) {
    const checked = checkRules(rules);
    this.#declared = checked.map(({ path, read, write }) => ({ path, ...(read && { read }), ...(write && { write }) }));
    // Deeper rules override; at one depth a literal segment beats {self}.
    this.#rules = [...checked].sort((a, b) => b.segs.length - a.segs.length || a.self - b.self);
    const prefixes = new Map([['data/users', ['data', 'users']]]);
    for (const r of checked.filter((o) => o.self)) prefixes.set(r.segs.slice(0, -1).join('/'), r.segs.slice(0, -1));
    this.#private = [...prefixes.values()];
    this.#open = new Set(checked.filter((o) => !o.self && prefixes.has(o.path)).map((o) => o.path));
  }
  get rules() { return this.#declared; }
  get seq() { return this.#seq; }
  get size() { return this.#docs.size; }

  // The minimum levels at a path for this viewer, or null inside someone
  // else's {self} subtree that no rule at its prefix opens (the owner too).
  #levels(segs, uid) {
    for (const prefix of this.#private) {
      if (segs.length > prefix.length && startsWith(segs, prefix) && segs[prefix.length] !== uid && !this.#open.has(prefix.join('/'))) return null;
    }
    let read, write;
    for (const r of this.#rules) {
      if (!covers(r, segs, uid)) continue;
      read ??= r.read;
      write ??= r.write;
      if (read && write) break;
    }
    read ??= 'view';
    write ??= 'interact';
    // Writing implies reading.
    if (RANK[write] < RANK[read]) write = read;
    return { read, write };
  }

  #allowed(action, segs, viewer) {
    if (!viewer || !atLeast(viewer.level, 'view')) return false;
    const lv = this.#levels(segs, viewer.uid ?? null);
    if (!lv) return false;
    // The owner meets every level; only {self} privacy limits them.
    if (viewer.level === 'owner') return true;
    // view only ever widens reads.
    if (action === 'write' && viewer.level === 'view') return false;
    return atLeast(viewer.level, lv[action]);
  }

  canRead(path, viewer) { return this.#allowed('read', splitPath(path, 'doc'), viewer); }
  canWrite(path, viewer) { return this.#allowed('write', splitPath(path, 'doc'), viewer); }
  // user.can("data.write"): may write shared documents under the root rule.
  canWriteShared(viewer) { return this.#allowed('write', [], viewer); }

  #mayWrite(segs, viewer, path) {
    // The same refusal as a sibling's {self} subtree, whatever the reason.
    if (!this.#allowed('write', segs, viewer)) throw invalid(`This viewer cannot write ${path}.`);
  }

  get(path, viewer) {
    const segs = splitPath(path, 'doc');
    const d = this.#allowed('read', segs, viewer) ? this.#docs.get(path) : undefined;
    return { id: segs.at(-1), path, exists: !!d, data: d?.data, version: d?.version ?? 0, seq: d?.seq ?? 0 };
  }

  set(path, data, viewer) {
    const segs = splitPath(path, 'doc');
    const body = checkBody(data);
    this.#mayWrite(segs, viewer, path);
    return this.#put(path, body);
  }

  update(path, data, viewer) {
    const segs = splitPath(path, 'doc');
    const patch = checkBody(data, 'An update');
    this.#mayWrite(segs, viewer, path);
    const prev = this.#docs.get(path);
    if (!prev) throw invalid(`update() needs an existing document; ${path} does not exist.`);
    return this.#put(path, checkBody(deepMerge(prev.data, patch)));
  }

  // Idempotent; documents nested below survive.
  delete(path, viewer) {
    const segs = splitPath(path, 'doc');
    this.#mayWrite(segs, viewer, path);
    if (!this.#docs.has(path)) return { version: 0, seq: this.#seq };
    this.#docs.delete(path);
    const seq = ++this.#seq;
    this.#emit({ path, seq, exists: false, data: undefined, version: 0 });
    return { version: 0, seq };
  }

  // Direct children of a collection this viewer can read, in query order.
  query(path, q, viewer) {
    const segs = splitPath(path, 'collection');
    const spec = checkQuery(q);
    const docs = [];
    for (const [p, d] of this.#docs) {
      if (!p.startsWith(`${path}/`)) continue;
      const ds = p.split('/');
      if (ds.length !== segs.length + 1 || !this.#allowed('read', ds, viewer)) continue;
      docs.push({ id: ds.at(-1), path: p, exists: true, data: d.data, version: d.version, seq: d.seq });
    }
    return runQuery(docs, spec);
  }

  // A cooperative lease; data merges into the body (creating it) when granted.
  acquire(path, { holder, ttlMs, data } = {}, viewer) {
    const segs = splitPath(path, 'doc');
    if (typeof holder !== 'string' || !holder) throw invalid('acquire() needs a holder string.');
    const extra = data === undefined ? null : checkBody(data, 'acquire() data');
    this.#mayWrite(segs, viewer, path);
    const now = this.now();
    const lease = this.#leases.get(path);
    if (lease && lease.until > now && lease.holder !== holder) return { acquired: false, expiresAt: new Date(lease.until).toISOString() };
    const until = now + Math.min(600000, Math.max(1000, Number(ttlMs) || 30000));
    this.#leases.set(path, { holder, until });
    const prev = this.#docs.get(path);
    const version = extra ? this.#put(path, checkBody(deepMerge(prev?.data ?? {}, extra))).version : prev?.version ?? 0;
    return { acquired: true, version, expiresAt: new Date(until).toISOString(), holder };
  }

  #put(path, body) {
    const prev = this.#docs.get(path);
    if (!prev && this.#docs.size >= LIMITS.docs) throw new DbError('quota_exceeded', `This artifact's database holds at most ${LIMITS.docs} documents.`);
    const seq = ++this.#seq;
    const doc = { data: deepFreeze(body), version: (prev?.version ?? 0) + 1, seq };
    this.#docs.set(path, doc);
    this.#emit({ path, seq, exists: true, data: doc.data, version: doc.version });
    return { version: doc.version, seq, data: doc.data };
  }

  // Every committed change, in order: { path, seq, exists, data, version }.
  // Listeners decide who may see it.
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  #emit(change) {
    for (const fn of this.#listeners) {
      try { fn(change); } catch (e) { console.error(e); }
    }
  }

  // Empties the store, telling listeners each document went away; seq keeps
  // counting so pages holding older state still order what they hear.
  reset() {
    for (const path of [...this.#docs.keys()]) {
      this.#docs.delete(path);
      this.#emit({ path, seq: ++this.#seq, exists: false, data: undefined, version: 0 });
    }
    this.#leases.clear();
  }

  dump() {
    const docs = {};
    for (const p of [...this.#docs.keys()].sort()) docs[p] = { version: this.#docs.get(p).version, data: this.#docs.get(p).data };
    return { seq: this.#seq, rules: this.rules, docs };
  }
}
