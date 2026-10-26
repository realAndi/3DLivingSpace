// The unit as a claude.ai Artifact: the files to publish (the app and a
// snapshot of the unit), and the Artifact's database, which the page reads and
// its editors write. Claude publishes with the Artifact tool and reads and
// writes the database with the ArtifactData tool; a script can't call either,
// so these commands print the calls to make and read back what they saved.
//
// The database, as the page (src/claude-store.js) reads it:
//   unit/spec    { unit, unitRev, savedAt }   the unit (src/unit.js, feet)
//   unit/layout  { items, savedAt }           the furniture (src/design.js)
//   unit/info    { title, author }
//   assets/<id>  one custom piece (src/design.js cleanAsset)
// Once unit/spec exists the page takes the database as the truth, so a push
// writes it last. Suggestions and viewers' own versions live there too; the
// skill leaves them alone. A write to a document that exists needs the version
// last read (if_version), and ArtifactData shows versions only in its text
// result, so pull reads them from that text.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ToolError } from '../../../src/agent.js';
import { cleanDesign } from '../../../src/design.js';
import { assembleApp, pageTitle } from './app.mjs';
import { singleFile } from './single.mjs';
import { writeAtomic, newDoc } from './workdir.mjs';

export const RULES = [
  { path: '', read: 'view', write: 'admin' },
  { path: 'data/users/{self}', write: 'interact' },
  { path: 'suggestions', read: 'admin', write: 'admin' },
  { path: 'suggestions/{self}', read: 'interact', write: 'interact' },
];
export const CAPABILITIES = { db: { rules: RULES }, user: { scopes: ['profile'] } };
const DOC_BYTES = 256 * 1024;
// ArtifactData's batch: 50 writes and 1 MiB, kept a little under.
const BATCH = { writes: 50, bytes: 1000 * 1000 };
const PUBLISH = { files: 255, bytes: 64 * 1024 * 1024 };

const HERE = dirname(fileURLToPath(import.meta.url));
const SPACE = join(HERE, 'space.mjs');
// Packaged, the app is prebuilt beside scripts/; in a checkout it is assembled
// from the repo.
export const PACKAGED_APP = join(HERE, '..', 'app');
export const REPO = resolve(HERE, '../../..');
export const isPackaged = () => existsSync(join(PACKAGED_APP, 'index.html'));

// A command to run, its paths quoted for the shell when they need it.
export const shellQuote = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
const command = (work, rest) => `node ${shellQuote(SPACE)} ${rest} --dir ${shellQuote(work.dir)}`;

export function setUrl(work, url) {
  if (!/^https:\/\/\S+$/.test(url)) throw new ToolError(`"${url}" isn't an Artifact's URL; it looks like https://claude.ai/code/artifact/….`);
  work.url = url;
}

// What the last pull or push recorded, if that was for this Artifact: a work
// dir pointed at another one starts over with it.
const syncFor = (work) => { const s = work.sync; return s && (!s.url || s.url === work.url) ? s : null; };

function needUrl(work) {
  const url = work.url;
  if (!url) throw new ToolError('This work dir isn\'t linked to an Artifact yet: pass --url <the Artifact\'s URL> (the Artifact tool\'s publish returns it; bundle prints what to publish).');
  return url;
}

// ---------------------------------------------------------------------------
// The files

const snapshotOf = (doc) => ({ title: doc.title, author: doc.author, unit: doc.unit, unitRev: doc.unitRev, items: doc.items, assets: doc.assets, savedAt: doc.savedAt });

function filesUnder(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, rel) : [rel];
  }).sort();
}

// The page is named for the unit (the gallery shows its <title>).
function writeApp(out, title) {
  if (!isPackaged()) return assembleApp(REPO, out, { title });
  const files = filesUnder(PACKAGED_APP);
  for (const rel of files) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    copyFileSync(join(PACKAGED_APP, rel), join(out, rel));
  }
  const page = join(out, 'index.html');
  writeFileSync(page, readFileSync(page, 'utf8').replace(/<title>[^<]*<\/title>/, () => pageTitle(title)));
  return files;
}

function describe(unit) {
  const what = unit.beds != null && unit.baths != null ? `${unit.beds ? `${unit.beds} bed` : 'studio'}, ${unit.baths} bath apartment` : 'apartment';
  return `A to-scale 3D model of a ${what}: walk through it, furnish it, and suggest changes.`;
}

// Writes the Artifact's files under out and says what to publish.
export function bundle(work, { out = work.path('artifact'), snapshotOnly = false } = {}) {
  const doc = work.load();
  const url = work.url;
  if (snapshotOnly && !url) throw new ToolError('--snapshot-only replaces the unit.json of an Artifact already published: pass --url <its URL>, or bundle without it to publish the whole app.');
  const files = snapshotOnly ? [] : writeApp(out, doc.title || doc.unit.name).filter((f) => f !== 'index.html');
  writeAtomic(join(out, 'unit.json'), JSON.stringify(snapshotOf(doc)));
  files.push('unit.json');
  const bytes = [...files, ...(snapshotOnly ? [] : ['index.html'])].reduce((n, f) => n + statSync(join(out, f)).size, 0);
  if (files.length + 1 > PUBLISH.files || bytes > PUBLISH.bytes) throw new ToolError(`The Artifact would be ${files.length + 1} files and ${Math.round(bytes / 1e6)} MB; one publish takes at most ${PUBLISH.files} files and 64 MB.`);
  const list = files.map((path) => ({ path }));
  if (snapshotOnly) {
    return {
      publish: { url, root: out, files: list },
      next: 'Call the Artifact tool with publish as it is. It replaces only unit.json, the snapshot that signed-out visitors see and every page shows first; the page and its other files stay.',
    };
  }
  return {
    publish: {
      ...(url ? { url } : {}),
      file_path: join(out, 'index.html'), root: out, files: list,
      capabilities: CAPABILITIES,
      ...(url ? {} : { icon: 'home' }),
      description: describe(doc.unit),
    },
    files: files.length + 1, bytes,
    next: url
      ? `Call the Artifact tool with publish as it is; it updates ${url} in place. Then push, so its database matches.`
      : `Call the Artifact tool with publish as it is. Then link this work dir to the Artifact and fill its database: ${command(work, 'push --url <the URL the publish returns>')}, and make the ArtifactData calls it prints.`,
  };
}

// The page and the unit as one HTML file, for where there's no Artifact tool:
// the person downloads it and opens it in a browser.
export function single(work, { out = work.path('living-space.html') } = {}) {
  const doc = work.load();
  const title = doc.title || doc.unit.name;
  const html = isPackaged()
    ? singleFile(PACKAGED_APP, snapshotOf(doc), { page: readFileSync(join(PACKAGED_APP, 'index.html'), 'utf8'), title })
    : singleFile(REPO, snapshotOf(doc), { title });
  writeAtomic(out, html);
  return {
    file: out, bytes: Buffer.byteLength(html),
    next: 'Give the person this file to download and open in a browser (Chrome, Safari, Edge or Firefox). It needs the internet only for the 3D library and the fonts. Furniture they move is kept in that browser; it has no sharing.',
  };
}

// ---------------------------------------------------------------------------
// The database

// The documents a stored unit makes, in the order a push writes them: custom
// pieces, then info and layout, and the spec last (see above).
export function docsOf(doc, savedAt = doc.savedAt) {
  return new Map([
    ...doc.assets.map((a) => [`assets/${a.id}`, a]),
    ['unit/info', { title: doc.title, author: doc.author }],
    ['unit/layout', { items: doc.items, savedAt }],
    ['unit/spec', { unit: doc.unit, unitRev: doc.unitRev, savedAt }],
  ]);
}

// JSON with sorted keys, so the same content hashes the same however it was stored.
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v ?? null));
// What a document's hash covers: what it holds, not when it was saved or
// anything else a page adds.
const OWN = { 'unit/spec': ['unit', 'unitRev'], 'unit/layout': ['items'], 'unit/info': ['title', 'author'] };
export function hashOf(key, data) {
  const fields = OWN[key];
  const picked = fields ? Object.fromEntries(fields.map((f) => [f, data?.[f] ?? null])) : data;
  return createHash('sha256').update(stable(picked)).digest('hex').slice(0, 20);
}

// The documents an ArtifactData read saved with out_dir: <dir>/<collection>/<doc_id>.json, data only.
function readSaved(dir) {
  if (!existsSync(dir)) throw new ToolError(`${dir} doesn't exist: pass the out_dir the ArtifactData reads saved into. If they found no documents, the Artifact's database is empty, and push fills it.`);
  const read = (file) => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw new ToolError(`${file} isn't valid JSON (${error.message}).`); }
  };
  const docs = new Map();
  for (const id of ['spec', 'layout', 'info']) {
    const file = join(dir, 'unit', `${id}.json`);
    if (existsSync(file)) docs.set(`unit/${id}`, read(file));
  }
  const assets = join(dir, 'assets');
  if (existsSync(assets)) {
    for (const f of readdirSync(assets).filter((n) => n.endsWith('.json')).sort()) {
      const data = read(join(assets, f));
      docs.set(`assets/${f.slice(0, -5)}`, { ...data, id: data.id ?? f.slice(0, -5) });
    }
  }
  return docs;
}

// Each document's version, from the text of ArtifactData results however they
// are pasted: lines like `- "spec"  12345 bytes  version 3  "/…/unit/spec.json"`,
// or JSON with version and doc_id. A doc is found by its saved file's path, its
// collection/doc_id, or its doc_id alone when that names one document.
export function parseVersions(text, keys) {
  const found = new Map();
  const byId = new Map();
  for (const key of keys) { const id = key.slice(key.indexOf('/') + 1); byId.set(id, byId.has(id) ? null : key); }
  const keyOf = (s) => {
    const path = /([^\s"'`\\/]+)[\\/]([^\s"'`\\/]+)\.json\b/.exec(s);
    if (path) return `${path[1]}/${path[2]}`;
    if (keys.includes(s)) return s;
    return byId.get(s) ?? null;
  };
  const add = (key, v) => { if (key && Number.isInteger(v) && v > 0) found.set(key, v); };
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const v = typeof o.version === 'number' ? o.version : Number(o.version);
    const id = o.doc_id ?? o.id ?? o.docId;
    if (Number.isInteger(v)) add(o.collection && id ? keyOf(`${o.collection}/${id}`) ?? `${o.collection}/${id}` : keyOf(String(o.path ?? o.file ?? id ?? '')), v);
    Object.values(o).forEach(walk);
  };
  try { walk(JSON.parse(text)); } catch { /* not JSON: read it line by line */ }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const v = /\bversion\b["']?\s*[:=]?\s*(\d+)/i.exec(line);
    if (!v) continue;
    let key = keyOf(line);
    for (const m of line.matchAll(/["'`]([^"'`\s]+)["'`]|\b([\w.~:@+-]+\/[\w.~:@+-]+)\b/g)) key ??= keyOf(m[1] ?? m[2]);
    // Last, a bare word that is a document's id.
    for (const word of line.split(/[\s,;]+/)) key ??= byId.get(word) ?? null;
    add(key, +v[1]);
  }
  return found;
}

// Prints the reads to make; clears the inbox they save into, so nothing left
// from an earlier pull is taken for a document the database still has.
export function pullReads(work) {
  const url = needUrl(work);
  const inbox = work.path('inbox');
  rmSync(inbox, { recursive: true, force: true });
  return {
    read: ['unit', 'assets'].map((collection) => ({ action: 'list', url, collection, out_dir: inbox })),
    next: `Make both ArtifactData calls, then pass pull what they printed, as it is (it holds each document's version):\n${command(work, `pull --from ${shellQuote(inbox)}`)} <<'EOF'\n…both results…\nEOF`,
  };
}

// Takes what the database holds into unit.json. The database wins: someone may
// have moved furniture in the page since. A document only this side changed
// since the last pull or push is kept, and the next push sends it.
export function pullFrom(work, from, versionsText = '') {
  const db = readSaved(from);
  const versions = parseVersions(versionsText, [...db.keys()]);
  const stored = work.has('unit.json') ? work.load() : newDoc();
  const base = syncFor(work)?.docs ?? {};
  const record = () => {
    work.sync = {
      url: work.url, pulledAt: Date.now(), stale: false,
      docs: Object.fromEntries([...db].map(([key, data]) => [key, { version: versions.get(key) ?? null, hash: hashOf(key, data) }])),
    };
  };
  const missing = [...db.keys()].filter((k) => !versions.has(k));
  const versionNote = missing.length ? { missing_versions: missing, warning: `No version found for ${missing.join(', ')} in what was passed in: push can't change those. Pull again with the ArtifactData results on stdin (or --versions <file>).` } : {};

  if (!db.has('unit/spec')) {
    record();
    return { artifact: 'empty', note: 'The Artifact\'s database has no unit yet, so unit.json stays as it is; push fills it.', versions: Object.fromEntries(versions), ...versionNote };
  }

  const local = docsOf(stored);
  const use = new Map();
  const report = { from_artifact: [], kept_local: [], conflicts: [], removed: [] };
  let unchanged = 0;
  for (const key of new Set([...local.keys(), ...db.keys()])) {
    const l = local.get(key), d = db.get(key), b = base[key]?.hash;
    const lh = l && hashOf(key, l), dh = d && hashOf(key, d);
    if (lh === dh) { unchanged++; use.set(key, 'local'); continue; }
    // The page writes every unit document once it saves; one it hasn't yet keeps ours.
    if ((!d && key.startsWith('unit/')) || (lh !== b && dh === b)) { report.kept_local.push(key); use.set(key, 'local'); continue; }
    if (lh !== b && b !== undefined) report.conflicts.push(key);
    if (d) report.from_artifact.push(key); else report.removed.push(key);
    use.set(key, d ? 'db' : 'drop');
  }
  const pick = (key) => (use.get(key) === 'db' ? db.get(key) : local.get(key));
  const spec = pick('unit/spec'), layout = pick('unit/layout'), info = pick('unit/info');
  const items = Array.isArray(layout?.items) ? layout.items : [];
  const assets = [...use].filter(([key, how]) => key.startsWith('assets/') && how !== 'drop').map(([key]) => pick(key));
  const clean = cleanDesign({ title: info?.title ?? '', author: info?.author ?? '', unit: spec?.unit ?? {}, items, assets });
  const unitRev = use.get('unit/spec') === 'db' && Number.isInteger(spec.unitRev) ? spec.unitRev : stored.unitRev;
  const next = { title: clean.title, author: clean.author, unit: clean.unit, unitRev, items: clean.items, assets: clean.assets };
  const changed = JSON.stringify(next) !== JSON.stringify({ title: stored.title, author: stored.author, unit: stored.unit, unitRev: stored.unitRev, items: stored.items, assets: stored.assets });
  if (changed || !work.has('unit.json')) work.save({ ...next, version: stored.version + 1, savedAt: Date.now() });
  record();

  const list = (k) => (report[k].length ? { [k]: report[k] } : {});
  return {
    ...list('from_artifact'), ...list('kept_local'), ...list('conflicts'), ...list('removed'),
    ...(clean.items.length < items.length ? { dropped_pieces: items.length - clean.items.length } : {}),
    unchanged,
    unit: { rooms: clean.unit.rooms.length, pieces: clean.items.length, custom_pieces: clean.assets.length, unitRev },
    versions: Object.fromEntries(versions),
    ...versionNote,
    ...(report.conflicts.length ? { conflicts_note: 'Both this work dir and the Artifact changed these since the last pull; the Artifact\'s version was taken.' } : {}),
    next: report.kept_local.length ? 'unit.json keeps changes the Artifact doesn\'t have yet: push sends them.' : 'unit.json now matches the Artifact.',
  };
}

// Writes the documents that changed since the last pull (or every one, the
// first time) to <dir>/outbox and says which ArtifactData batch calls save them.
export function push(work) {
  const url = needUrl(work);
  const sync = syncFor(work);
  const doc = work.load();
  const now = Date.now();
  const base = sync?.docs ?? {};
  const local = docsOf(doc, now);
  const writes = [], unchanged = [];
  for (const [key, data] of local) {
    const b = base[key];
    if (b && b.hash === hashOf(key, data)) { unchanged.push(key); continue; }
    const text = JSON.stringify(data);
    const size = Buffer.byteLength(text);
    if (size > DOC_BYTES) throw new ToolError(`${key} would be ${Math.ceil(size / 1024)} KiB; an Artifact's document holds at most 256 KiB.`);
    writes.push({ key, op: 'set', text, size, exists: !!b, if_version: b?.version });
  }
  // Custom pieces gone from here go from the Artifact too, after the layout that used them.
  for (const [key, b] of Object.entries(base)) {
    if (!local.has(key) && key.startsWith('assets/')) writes.push({ key, op: 'delete', size: 0, exists: true, if_version: b.version });
  }
  if (!writes.length) return { url, writes: 0, unchanged, note: 'Nothing to push: the Artifact has all of it.' };
  if (sync?.stale) {
    throw new ToolError(`Pull first: the last push changed the Artifact's documents, so the versions recorded here are out of date. Run ${command(work, 'pull')} and make the reads it prints, then pull --from, then push again.`);
  }
  const blind = writes.find((w) => w.exists && !w.if_version);
  if (blind) throw new ToolError(`The Artifact has ${blind.key} but its version wasn't recorded at the last pull: pull again with the ArtifactData results on stdin, then push.`);

  const outbox = work.path('outbox');
  rmSync(outbox, { recursive: true, force: true });
  const calls = [];
  let batch = null, bytes = 0;
  for (const w of writes) {
    const [collection, doc_id] = [w.key.slice(0, w.key.indexOf('/')), w.key.slice(w.key.indexOf('/') + 1)];
    const entry = { op: w.op, collection, doc_id };
    if (w.op === 'set') {
      entry.file_path = join(outbox, collection, `${doc_id}.json`);
      writeAtomic(entry.file_path, w.text);
    }
    if (w.if_version) entry.if_version = w.if_version;
    if (!batch || batch.writes.length >= BATCH.writes || bytes + w.size + 300 > BATCH.bytes) {
      batch = { action: 'batch', url, writes: [] };
      calls.push(batch);
      bytes = 0;
    }
    batch.writes.push(entry);
    bytes += w.size + 300;
  }
  const docs = { ...base };
  for (const w of writes) {
    if (w.op === 'delete') delete docs[w.key];
    else docs[w.key] = { version: null, hash: hashOf(w.key, local.get(w.key)) };
  }
  work.sync = { url, pulledAt: sync?.pulledAt ?? null, pushedAt: now, stale: true, docs };
  return {
    url,
    writes: writes.length,
    ...(writes.some((w) => w.op === 'set') ? { set: writes.filter((w) => w.op === 'set').map((w) => w.key) } : {}),
    ...(writes.some((w) => w.op === 'delete') ? { delete: writes.filter((w) => w.op === 'delete').map((w) => w.key) } : {}),
    unchanged,
    calls,
    next: `Make ${calls.length > 1 ? `these ${calls.length} ArtifactData calls, in order` : 'this ArtifactData call'}. If one says a document changed or already exists, someone saved in the page meanwhile: pull (${command(work, 'pull')} prints the reads), then push again. Pull before the next push too. Signed-out visitors see the bundled snapshot instead: when you're done, bundle --snapshot-only and publish it.`,
  };
}
