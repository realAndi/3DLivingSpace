// A work dir: the unit the skill builds and furnishes, kept between calls, and
// what links it to a published Artifact.
//   unit.json      the stored document, { title, author, unit, unitRev, items,
//                  assets, version, savedAt }, in feet as the server stores it
//   artifact.json  { url }: the Artifact it was published as
//   sync.json      what the Artifact's database held at the last pull or push
//                  (see artifact.mjs)
// Every file is written to a temp file and renamed over the old one, so a
// crash never leaves half a unit.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ToolError } from '../../../src/agent.js';
import { cleanDesign, LIMITS } from '../../../src/design.js';
import { buildUnit, cleanUnit, emptyUnit } from '../../../src/unit.js';
import { EXAMPLE_UNIT } from '../../../src/example.js';

export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export class WorkDir {
  constructor(dir) { this.dir = dir; }

  path(...parts) { return join(this.dir, ...parts); }

  has(name) { return existsSync(this.path(name)); }

  readJson(name, fallback = null) {
    if (!this.has(name)) return fallback;
    try {
      return JSON.parse(readFileSync(this.path(name), 'utf8'));
    } catch (error) {
      throw new ToolError(`${this.path(name)} isn't valid JSON (${error.message}). Fix or delete it.`);
    }
  }

  writeJson(name, data) { writeAtomic(this.path(name), `${JSON.stringify(data, null, 1)}\n`); }

  load() {
    if (!this.has('unit.json')) throw new ToolError(`There is no unit in ${this.dir}: start one with \`new\` (or \`new --example\`), or pass --dir <the work dir>.`);
    const doc = this.readJson('unit.json');
    if (!doc?.unit || !Array.isArray(doc.items) || !Array.isArray(doc.assets)) throw new ToolError(`${this.path('unit.json')} isn't a unit: it needs unit, items and assets.`);
    return { title: '', author: '', unitRev: 1, version: 1, savedAt: 0, ...doc };
  }

  save(doc) { this.writeJson('unit.json', doc); }

  get url() { return this.readJson('artifact.json')?.url ?? null; }

  set url(url) { this.writeJson('artifact.json', { url }); }

  get sync() { return this.readJson('sync.json'); }

  set sync(data) { this.writeJson('sync.json', data); }
}

// A new unit: empty, or the example's rooms without furniture, cleaned the
// way server/service.js creates one.
export function newDoc({ example = false, title = '' } = {}) {
  const unit = example ? cleanUnit(EXAMPLE_UNIT).unit : emptyUnit();
  const clean = cleanDesign({ title, author: '', unit, items: [], assets: [] });
  return { title: clean.title, author: clean.author, unit: clean.unit, unitRev: 1, items: clean.items, assets: clean.assets, version: 1, savedAt: Date.now() };
}

// The stored document as the server's row, which src/agent.js reads.
const rowOf = (doc) => ({ id: null, title: doc.title, author: doc.author, version: doc.version, doc: { unit: doc.unit, unitRev: doc.unitRev, items: doc.items, assets: doc.assets } });

// A change to the stored document, checked and saved the way server/service.js
// mutate() saves one: the same cleaning and errors; unitRev goes up only when
// the unit itself changed (the page rebuilds the 3D only then), version always.
export function saveChange(work, change) {
  const stored = work.load();
  const doc = structuredClone({ title: stored.title, author: stored.author, unit: stored.unit, items: stored.items, assets: stored.assets });
  const result = change(doc);
  const clean = cleanDesign(doc);
  if (clean.items.length < doc.items.length) {
    throw new ToolError(doc.items.length > LIMITS.items ? `A unit holds at most ${LIMITS.items} pieces.` : 'Some pieces could not be saved: check their type, asset and numbers.');
  }
  const unitRev = stored.unitRev + (JSON.stringify(clean.unit) === JSON.stringify(stored.unit) ? 0 : 1);
  const next = { title: clean.title, author: clean.author, unit: clean.unit, unitRev, items: clean.items, assets: clean.assets, version: stored.version + 1, savedAt: Date.now() };
  work.save(next);
  return { doc: next, result };
}

// What src/agent.js createTools() needs, over a work dir. png comes from
// raster.mjs, loaded only when a picture is wanted.
export function toolContext(work, { png = null } = {}) {
  const cache = new Map();
  const built = (row) => {
    if (!cache.has(row.doc.unitRev)) cache.set(row.doc.unitRev, buildUnit(row.doc.unit));
    return cache.get(row.doc.unitRev);
  };
  return {
    viewUrl: work.url,
    current: () => { const row = rowOf(work.load()); return { row, U: built(row) }; },
    write: (change) => { const { doc, result } = saveChange(work, change); return { row: rowOf(doc), result }; },
    built,
    png: (svg) => {
      if (!png) throw new ToolError('The plan renderer isn\'t loaded.');
      return png(svg);
    },
  };
}
