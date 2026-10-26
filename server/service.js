// Unit operations shared by the browser API, the pages and the MCP tools.
//
// A unit has a public id (in its view link) and a secret edit key (in its edit
// link after #edit=, so it never reaches a server log, and in its MCP address).
// Only a hash of the key is stored. Anyone may view a unit or make their own
// copy of it; only the key changes it. The example unit is not stored: it is
// built from src/example.js and can be viewed and copied but never changed.
//
// An owner may also set an edit code, a password for their other devices: on
// one, with only the unit's link, the code unlocks the edit key. The key is
// kept encrypted with the code (scrypt, then AES-256-GCM); the code itself is
// never stored, and a code that decrypts the key is the right one.
//
// A copy can suggest its layout back to the unit it was copied from: a copy
// remembers the layout it started from (base), so the owner sees just what it
// changed, and what clashes with their own changes since (src/changes.js). One
// suggestion per copy is open at a time; sending again updates it. The owner
// previews one at a time, applies what they choose, and can undo that.
import { createHash, timingSafeEqual, randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { cleanAsset, cleanDesign, cleanItem, randomId, LIMITS } from '../src/design.js';
import { cleanUnit, emptyUnit, buildUnit } from '../src/unit.js';
import { layoutChanges, applyChanges } from '../src/changes.js';
import { EXAMPLE_UNIT, EXAMPLE_TITLE } from '../src/example.js';
import { AppError } from './http.js';

const hash = (key) => createHash('sha256').update(key).digest('hex');
const derive = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

// Edit codes are typed on phones: case, spaces, dashes and dots don't matter.
export const normalizeCode = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s._-]+/g, '');
const WRONG_CODE = 'That code doesn\'t open this unit. Its owner sets the edit code in the Share tab.';
export const SUGGESTIONS = { open: 10, note: 200 };
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
export const ID_RE = /^[A-Za-z0-9]{8,16}$/;
export const KEY_RE = /^[A-Za-z0-9]{20,48}$/;
export const EXAMPLE_ID = 'example';

const EXAMPLE = cleanUnit(EXAMPLE_UNIT).unit;
const STARTED = Date.now();

export class Units {
  constructor(store, { basePath }) {
    this.store = store;
    this.basePath = basePath;
    // Built units by id and unitRev: building one takes 100-200 ms and every
    // picture and agent call needs one.
    this.cache = new Map();
  }

  viewUrl(id, origin) { return `${origin}${this.basePath}/u/${id}`; }
  editUrl(id, key, origin) { return `${this.viewUrl(id, origin)}#edit=${key}`; }
  mcpUrl(id, key, origin) { return `${origin}${this.basePath}/mcp/${id}/${key}`; }

  // { from: undefined } an empty unit; 'example' a copy of the example's unit
  // without furniture; '<id>' a copy of that unit with its furniture.
  create({ from, title, author } = {}) {
    if (from !== undefined && from !== null && typeof from !== 'string') throw new AppError(400, 'from must be "example" or a unit id.');
    let doc = { unit: emptyUnit(), items: [], assets: [] }, forkedFrom = null, defaultTitle = '', base = null;
    if (from) {
      const src = this.get(from);
      doc = structuredClone(src.doc);
      forkedFrom = src.id;
      if (src.id !== EXAMPLE_ID && src.title) defaultTitle = `${src.title} (my version)`;
      // What it starts from, so a suggestion back shows only what changed.
      if (src.id !== EXAMPLE_ID) base = { items: src.doc.items, assets: src.doc.assets };
    }
    const clean = cleanDesign({ title: title ?? defaultTitle, author: author ?? '', unit: doc.unit, items: doc.items, assets: doc.assets });
    const id = randomId(10);
    const key = randomId(28);
    this.store.insert({
      id, keyHash: hash(key), title: clean.title, author: clean.author, forkedFrom, base,
      doc: { unit: clean.unit, unitRev: 1, items: clean.items, assets: clean.assets },
    });
    return { row: this.get(id), key };
  }

  fork(id, { title, author } = {}) {
    return this.create({ from: id, title, author });
  }

  get(id) {
    if (id === EXAMPLE_ID) {
      return {
        id: EXAMPLE_ID, key_hash: null, title: EXAMPLE_TITLE, author: '', version: 1, forked_from: null,
        created_at: STARTED, updated_at: STARTED, doc: { unit: EXAMPLE, unitRev: 1, items: [], assets: [] },
      };
    }
    const row = ID_RE.test(id ?? '') ? this.store.get(id) : null;
    if (!row) throw new AppError(404, `There is no unit "${id}".`);
    return row;
  }

  canEdit(row, key) {
    if (!row.key_hash || !KEY_RE.test(key ?? '')) return false;
    return timingSafeEqual(Buffer.from(hash(key)), Buffer.from(row.key_hash));
  }

  // Lock the edit key with a new edit code, or (code null) remove the code.
  async setCode(id, key, code) {
    const row = this.requireEdit(id, key);
    if (code === null) { this.store.setCode(row.id, null); return false; }
    const c = normalizeCode(code);
    if (c.length < 6) throw new AppError(400, 'An edit code needs at least 6 letters or digits.');
    if (c.length > 64) throw new AppError(400, 'An edit code can be at most 64 letters or digits.');
    const salt = randomBytes(16), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await derive(c, salt, 32, SCRYPT), iv);
    const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    const b64 = (b) => b.toString('base64');
    this.store.setCode(row.id, JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), data: b64(data), tag: b64(cipher.getAuthTag()) }));
    return true;
  }

  hasCode(id, key) { return !!this.requireEdit(id, key).code; }

  // The edit key, for the right code: { row, key }. A wrong code, a unit
  // without one and the example all answer the same.
  async unlock(id, code) {
    const row = this.get(id);
    const c = normalizeCode(code);
    if (!row.code || !c || c.length > 64) throw new AppError(403, WRONG_CODE);
    let key;
    try {
      const lock = JSON.parse(row.code), b = (s) => Buffer.from(s, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', await derive(c, b(lock.salt), 32, SCRYPT), b(lock.iv));
      decipher.setAuthTag(b(lock.tag));
      key = Buffer.concat([decipher.update(b(lock.data)), decipher.final()]).toString('utf8');
    } catch {
      throw new AppError(403, WRONG_CODE);
    }
    if (!this.canEdit(row, key)) throw new AppError(403, WRONG_CODE);
    return { row, key };
  }

  // ---- suggestions

  // The unit a copy suggests to, or why it can't.
  #parentOf(copy) {
    if (!copy.forked_from || copy.forked_from === EXAMPLE_ID) throw new AppError(400, 'Only a copy of someone\'s unit can suggest changes to it. This one wasn\'t copied from one.');
    try { return this.get(copy.forked_from); } catch { throw new AppError(400, 'The unit this was copied from is gone.'); }
  }

  #changesOf(copy, parent) {
    const base = copy.base ? JSON.parse(copy.base) : null;
    return layoutChanges({ base: base?.items ?? null, theirs: copy.doc.items, ours: parent.doc.items });
  }

  // Send a copy's layout to the unit it was copied from (or update the one
  // already waiting). Returns the copy's suggestion, as mySuggestion.
  suggest(copyId, key, { note } = {}) {
    const copy = this.requireEdit(copyId, key);
    const parent = this.#parentOf(copy);
    const sent = this.#changesOf(copy, parent).length;
    if (!sent) throw new AppError(400, 'Nothing to suggest yet: your version\'s furniture is the same as theirs.');
    const base = copy.base ? JSON.parse(copy.base) : null;
    const fields = {
      author: copy.author, title: copy.title, note: text(note, SUGGESTIONS.note),
      doc: { base: base?.items ?? null, items: copy.doc.items, assets: copy.doc.assets, sent },
    };
    const open = this.store.latestSuggestionFrom(copy.id);
    if (!(open?.status === 'open' && open.unit_id === parent.id && this.store.resendSuggestion(open.id, fields))) {
      if (this.store.openSuggestions(parent.id).length >= SUGGESTIONS.open) {
        throw new AppError(429, `${parent.title || 'That unit'} already has ${SUGGESTIONS.open} suggestions waiting. Try again once its owner has looked at them.`);
      }
      this.store.addSuggestion({ id: randomId(10), unitId: parent.id, fromId: copy.id, ...fields });
    }
    return this.mySuggestion(copyId, key);
  }

  // What a copy has suggested, for its owner: { to: { id, title, author },
  // status: 'none' | 'open' | 'applied' | 'dismissed', note, sent (how many
  // changes went), changes (how many it would offer now), sentAt }. `to` is
  // null when it can't suggest.
  mySuggestion(copyId, key) {
    const copy = this.requireEdit(copyId, key);
    let parent;
    try { parent = this.#parentOf(copy); } catch { return { to: null, status: 'none', changes: 0 }; }
    const s = this.store.latestSuggestionFrom(copy.id);
    return {
      to: { id: parent.id, title: parent.title, author: parent.author },
      status: s?.unit_id === parent.id ? s.status : 'none',
      note: s?.note ?? '', sentAt: s?.updated_at ?? null, sent: s?.unit_id === parent.id ? s.doc.sent ?? null : null,
      changes: this.#changesOf(copy, parent).length,
    };
  }

  withdraw(copyId, key) {
    const copy = this.requireEdit(copyId, key);
    const s = this.store.latestSuggestionFrom(copy.id);
    if (s?.status === 'open') this.store.dropSuggestion(s.id);
    return this.mySuggestion(copyId, key);
  }

  // The suggestions waiting for a unit, for its owner to preview: each with
  // its layout and base, so the browser shows the same changes the server applies.
  suggestions(id, key) {
    const row = this.requireEdit(id, key);
    return this.store.openSuggestions(row.id).map((s) => ({
      id: s.id, from: s.from_id, author: s.author, title: s.title, note: s.note, createdAt: s.created_at, updatedAt: s.updated_at,
      base: s.doc.base, items: s.doc.items, assets: s.doc.assets,
      changes: layoutChanges({ base: s.doc.base, theirs: s.doc.items, ours: row.doc.items }).length,
    }));
  }

  #open(row, sid) {
    const s = this.store.suggestion(sid);
    if (!s || s.unit_id !== row.id) throw new AppError(404, 'There is no such suggestion for this unit.');
    return s;
  }

  // Take the chosen changes (group ids, or 'all') into the unit. Returns { row, applied }.
  applySuggestion(id, key, sid, select = 'all') {
    if (select !== 'all' && (!Array.isArray(select) || !select.length || !select.every((g) => typeof g === 'string'))) throw new AppError(400, 'Choose at least one change to apply.');
    const s = this.#open(this.requireEdit(id, key), sid);
    if (s.status !== 'open') throw new AppError(409, 'That suggestion was already applied or dismissed.');
    let before, applied;
    const { row } = this.mutate(id, key, (doc) => {
      before = { items: doc.items, assets: doc.assets };
      const out = applyChanges({ base: s.doc.base, theirs: s.doc.items, ours: doc.items, theirAssets: s.doc.assets, ourAssets: doc.assets, select });
      if (!out.applied) throw new AppError(409, 'Those changes are already in your layout, or no longer apply.');
      if (out.assets.length > LIMITS.assets) throw new AppError(400, `A unit holds at most ${LIMITS.assets} custom pieces.`);
      ({ applied } = out);
      doc.items = out.items;
      doc.assets = out.assets;
    });
    this.store.closeSuggestion(s.id, 'applied', { before, version: row.version });
    return { row, applied };
  }

  dismissSuggestion(id, key, sid) {
    const s = this.#open(this.requireEdit(id, key), sid);
    if (s.status === 'open') this.store.closeSuggestion(s.id, 'dismissed');
  }

  // Put the layout back as it was before a suggestion was applied, and the
  // suggestion back in the list, if nothing has changed since.
  undoSuggestion(id, key, sid) {
    const row0 = this.requireEdit(id, key);
    const s = this.#open(row0, sid);
    if (s.status !== 'applied' || !s.before) throw new AppError(409, 'There is nothing to undo.');
    if (row0.version !== s.applied_version) throw new AppError(409, 'The layout has changed since, so this can\'t be undone in one go.');
    const { row } = this.mutate(id, key, (doc) => { doc.items = s.before.items; doc.assets = s.before.assets; });
    this.store.closeSuggestion(s.id, 'open');
    return { row };
  }

  requireEdit(id, key) {
    const row = this.get(id);
    if (row.id === EXAMPLE_ID) throw new AppError(403, 'The example unit can\'t be changed. Make your own copy of it to change.');
    if (!this.canEdit(row, key)) throw new AppError(403, 'That edit key does not match this unit. Changing a unit needs its edit link.');
    return row;
  }

  // The unit as built (src/unit.js buildUnit), cached per unit and unitRev.
  built(row) {
    const key = `${row.id}:${row.doc.unitRev}`;
    let U = this.cache.get(key);
    if (U) this.cache.delete(key);
    else U = buildUnit(row.doc.unit);
    this.cache.set(key, U);
    // Bounded by grid size too: a big unit's grid is tens of megabytes, and the
    // container has 192 MB.
    const cells = () => [...this.cache.values()].reduce((n, b) => n + b.grid.nx * b.grid.nz, 0);
    while (this.cache.size > 1 && (this.cache.size > 12 || cells() > 8e6)) this.cache.delete(this.cache.keys().next().value);
    return U;
  }

  // Apply a change to the stored document. `change(doc)` edits a copy of
  // { title, author, unit, items, assets }; it is retried if another write
  // landed in between, so two editors (a browser and an agent, say) never
  // overwrite each other. unitRev goes up only when the unit itself changed,
  // so browsers rebuild the 3D only then.
  mutate(id, key, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = this.requireEdit(id, key);
      const doc = structuredClone({ title: row.title, author: row.author, unit: row.doc.unit, items: row.doc.items, assets: row.doc.assets });
      const result = change(doc);
      const clean = cleanDesign(doc);
      if (clean.items.length < doc.items.length) {
        throw new AppError(400, doc.items.length > LIMITS.items ? `A unit holds at most ${LIMITS.items} pieces.` : 'Some pieces could not be saved: check their type, asset and numbers.');
      }
      const unitRev = row.doc.unitRev + (JSON.stringify(clean.unit) === JSON.stringify(row.doc.unit) ? 0 : 1);
      if (this.store.update(id, row.version, { title: clean.title, author: clean.author, doc: { unit: clean.unit, unitRev, items: clean.items, assets: clean.assets } })) {
        return { row: this.get(id), result };
      }
    }
    throw new AppError(409, 'The unit kept changing while saving. Try again.');
  }

  // Browser autosave: furniture, custom pieces, title and author. Never the unit.
  patch(id, key, { title, author, upsert = [], remove = [], assets = [], removeAssets = [] } = {}) {
    if (![upsert, remove, assets, removeAssets].every(Array.isArray)) throw new AppError(400, 'upsert, remove, assets and removeAssets must be lists.');
    return this.mutate(id, key, (doc) => {
      if (typeof title === 'string') doc.title = title;
      if (typeof author === 'string') doc.author = author;
      const assetById = Object.fromEntries(doc.assets.map((a) => [a.id, a]));
      for (const raw of assets) {
        const a = cleanAsset(raw);
        if (a) assetById[a.id] = a;
      }
      for (const aid of removeAssets) delete assetById[aid];
      doc.assets = Object.values(assetById);
      if (doc.assets.length > LIMITS.assets) throw new AppError(400, `A unit holds at most ${LIMITS.assets} custom pieces.`);
      const gone = new Set(remove);
      const byUid = new Map(doc.items.filter((i) => !gone.has(i.uid) && (i.type !== 'asset' || assetById[i.asset])).map((i) => [i.uid, i]));
      for (const raw of upsert) {
        const item = cleanItem(raw, assetById);
        if (!item) throw new AppError(400, `A piece of type "${raw?.type}" is not in the catalog or its custom asset is missing.`);
        byUid.set(item.uid, item);
      }
      doc.items = [...byUid.values()];
    }).row;
  }

  // What anyone may see.
  view(row, origin) {
    return {
      id: row.id, title: row.title, author: row.author, version: row.version, unitRev: row.doc.unitRev,
      unit: row.doc.unit, items: row.doc.items, assets: row.doc.assets,
      url: this.viewUrl(row.id, origin),
      createdAt: row.created_at, updatedAt: row.updated_at, forkedFrom: row.forked_from,
    };
  }

  // Designs from before units: their furniture, in the example unit.
  importDesigns() {
    return this.store.importDesigns((doc) => {
      const clean = cleanDesign({ unit: EXAMPLE, items: doc.items, assets: doc.assets });
      return { unit: clean.unit, unitRev: 1, items: clean.items, assets: clean.assets };
    });
  }
}
