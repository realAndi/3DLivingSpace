// Design operations shared by the browser API and the MCP tools.
//
// A design has a public id (in its view link) and a secret edit key (in its
// edit link, after #edit= so it never reaches a server log). Only a hash of the
// key is stored. Anyone may view a design or make their own copy of it; only
// the key changes it.
import { createHash, timingSafeEqual } from 'node:crypto';
import { cleanAsset, cleanDesign, cleanItem, randomId, LIMITS } from '../src/design.js';
import { AppError } from './http.js';

const hash = (key) => createHash('sha256').update(key).digest('hex');
export const ID_RE = /^[A-Za-z0-9]{8,16}$/;
export const KEY_RE = /^[A-Za-z0-9]{20,48}$/;

export class Designs {
  constructor(store, { basePath }) {
    this.store = store;
    this.basePath = basePath;
  }

  viewUrl(id, origin) { return `${origin}${this.basePath}/d/${id}`; }
  editUrl(id, key, origin) { return `${this.viewUrl(id, origin)}#edit=${key}`; }

  create(input = {}, { forkedFrom = null } = {}) {
    const doc = cleanDesign(input);
    const id = randomId(10);
    const key = randomId(28);
    this.store.insert({ id, keyHash: hash(key), title: doc.title, author: doc.author, doc: { items: doc.items, assets: doc.assets }, forkedFrom });
    return { row: this.get(id), key };
  }

  get(id) {
    const row = ID_RE.test(id ?? '') ? this.store.get(id) : null;
    if (!row) throw new AppError(404, `There is no design "${id}".`);
    return row;
  }

  canEdit(row, key) {
    if (!KEY_RE.test(key ?? '')) return false;
    return timingSafeEqual(Buffer.from(hash(key)), Buffer.from(row.key_hash));
  }

  requireEdit(id, key) {
    const row = this.get(id);
    if (!this.canEdit(row, key)) throw new AppError(403, 'That edit key does not match this design. Changing a design needs its edit link.');
    return row;
  }

  // Apply a change to the stored document. `change(doc)` edits a copy; it is
  // retried if another write landed in between, so two editors (a browser and
  // an agent, say) never overwrite each other's pieces.
  mutate(id, key, change) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = this.requireEdit(id, key);
      const doc = structuredClone({ title: row.title, author: row.author, items: row.doc.items, assets: row.doc.assets });
      const result = change(doc);
      const clean = cleanDesign(doc);
      if (clean.items.length < doc.items.length) {
        throw new AppError(400, doc.items.length > LIMITS.items ? `A design holds at most ${LIMITS.items} pieces.` : 'Some pieces could not be saved: check their type, asset and numbers.');
      }
      if (this.store.update(id, row.version, { title: clean.title, author: clean.author, doc: { items: clean.items, assets: clean.assets } })) {
        return { row: this.get(id), result };
      }
    }
    throw new AppError(409, 'The design kept changing while saving. Try again.');
  }

  // Browser autosave: whole pieces in, pieces out.
  patch(id, key, { title, author, upsert = [], remove = [], assets = [], removeAssets = [] }) {
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
      if (doc.assets.length > LIMITS.assets) throw new AppError(400, `A design holds at most ${LIMITS.assets} custom pieces.`);
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

  fork(id, { title, author } = {}) {
    const src = this.get(id);
    const base = src.title ? `${src.title} (my version)` : '';
    return this.create({ title: title ?? base, author: author ?? '', items: src.doc.items, assets: src.doc.assets }, { forkedFrom: id });
  }

  // What anyone may see.
  view(row, origin) {
    return {
      id: row.id, title: row.title, author: row.author, version: row.version,
      updatedAt: row.updated_at, createdAt: row.created_at, forkedFrom: row.forked_from,
      url: this.viewUrl(row.id, origin),
      items: row.doc.items, assets: row.doc.assets,
    };
  }
}
