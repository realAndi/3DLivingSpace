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
import { createHash, timingSafeEqual, randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { cleanAsset, cleanDesign, cleanItem, randomId, LIMITS } from '../src/design.js';
import { cleanUnit, emptyUnit, buildUnit } from '../src/unit.js';
import { EXAMPLE_UNIT, EXAMPLE_TITLE } from '../src/example.js';
import { AppError } from './http.js';

const hash = (key) => createHash('sha256').update(key).digest('hex');
const derive = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

// Edit codes are typed on phones: case, spaces, dashes and dots don't matter.
export const normalizeCode = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s._-]+/g, '');
const WRONG_CODE = 'That code doesn\'t open this unit. Its owner sets the edit code in the Share tab.';
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
    let doc = { unit: emptyUnit(), items: [], assets: [] }, forkedFrom = null, defaultTitle = '';
    if (from) {
      const src = this.get(from);
      doc = structuredClone(src.doc);
      forkedFrom = src.id;
      if (src.id !== EXAMPLE_ID && src.title) defaultTitle = `${src.title} (my version)`;
    }
    const clean = cleanDesign({ title: title ?? defaultTitle, author: author ?? '', unit: doc.unit, items: doc.items, assets: doc.assets });
    const id = randomId(10);
    const key = randomId(28);
    this.store.insert({
      id, keyHash: hash(key), title: clean.title, author: clean.author, forkedFrom,
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
