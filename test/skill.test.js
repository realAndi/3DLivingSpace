// The skill's scripts (skill/3d-living-space/scripts): the MCP tools from the
// command line over a work dir, answering as the server does; the Artifact's
// files; keeping its database in step; and the packaged skill on its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../skill/3d-living-space/scripts/space.mjs';
import { parseVersions } from '../skill/3d-living-space/scripts/artifact.mjs';
import { moduleGraph } from '../skill/3d-living-space/scripts/app.mjs';
import { patch, preset } from '../src/recipes.js';
import { encodePng } from '../src/png.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), '3dls-skill-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The same small unit as test/server.test.js: a living room with a kitchen
// along its west wall, a bath to the east, a door between them.
const SMALL = {
  name: 'Test flat', beds: 0, baths: 1, ceiling_height: 108, door_height: 80,
  rooms: [
    { id: 'living', name: 'Living', kind: 'living', outline: [[8, 8], [152, 8], [152, 188], [8, 188]] },
    { id: 'bath', name: 'Bath', kind: 'bath', outline: [[156.5, 8], [216.5, 8], [216.5, 104], [156.5, 104]] },
  ],
  openings: [
    { id: 'entry', type: 'entry', at: [80, 192], width: 36 },
    { id: 'bath-door', type: 'door', at: [154.25, 40], width: 28, hinge: 'north', opens: 'east' },
    { id: 'win-living', type: 'window', at: [80, 4], width: 60 },
  ],
  fixtures: [
    { id: 'kitchen', type: 'kitchen-run', at: [23.75, 90], width: 132, rotation: 270, segments: ['fridge', 'sink', { kind: 'dishwasher' }, { kind: 'range', width: 30 }], hood: 'hood' },
    { id: 'toilet', type: 'toilet', at: [200, 80], rotation: 90 },
  ],
};
const STOOL = { asset_id: 'stool1', name: 'Bar stool', parts: [
  { shape: 'cylinder', size: [14, 1.5, 14], at: [0, 29, 0], color: '#8a6a4a', finish: 'wood' },
  { shape: 'cylinder', size: [2, 28, 2], at: [0, 14, 0], color: '#222222', finish: 'metal' },
] };
const isPng = (buf) => buf.subarray(1, 4).toString() === 'PNG';
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

// A work dir and the CLI over it, in this process.
function workDir(name) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const cli = async (args, stdin = '') => run([...args, '--dir', join(dir, 'ws')], { cwd: dir, stdin: async () => stdin });
  const ok = async (args, stdin) => {
    const r = await cli(args, stdin);
    assert.equal(r.code, 0, `${args[0]}: ${r.err}`);
    return r.out.startsWith('{') ? JSON.parse(r.out) : r.out;
  };
  const tool = (name, args = {}) => ok([name, JSON.stringify(args)]);
  const stored = () => JSON.parse(readFileSync(join(dir, 'ws', 'unit.json'), 'utf8'));
  return { dir, ws: join(dir, 'ws'), cli, ok, tool, stored };
}

// ---------------------------------------------------------------------------
// The server, for the same calls over MCP.

const port = 19000 + Math.floor(Math.random() * 1000);
const B = `http://localhost:${port}/3DLivingSpace`;
let server;
before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), BASE_PATH: '/3DLivingSpace', DATA_DIR: join(scratch, 'data'), PUBLIC_URL: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${B}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => server?.kill());

async function mcpUnit() {
  const u = await (await fetch(`${B}/api/units`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  return async function call(name, args = {}) {
    const res = await fetch(u.mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const { result } = await res.json();
    const text = result.content.find((c) => c.type === 'text')?.text;
    const image = result.content.find((c) => c.type === 'image');
    return { isError: !!result.isError, text, data: !result.isError && text?.startsWith('{') ? JSON.parse(text) : null, image: image && Buffer.from(image.data, 'base64') };
  };
}
// What may differ between the two: the unit's id, its link, its version.
const same = (o) => JSON.parse(JSON.stringify(o, (k, v) => (['unit_id', 'view_url', 'version'].includes(k) ? undefined : v)));

// ---------------------------------------------------------------------------

test('skill: the tools from the command line answer as the MCP server does', async () => {
  const mcp = await mcpUnit();
  const w = workDir('tools');
  assert.equal((await w.ok(['new'])).unit, 'empty');
  assert.match((await w.cli(['new'])).err, /already a unit.*--force/);
  const both = async (name, args = {}) => {
    const [cli, server] = [await w.tool(name, args), await mcp(name, args)];
    assert.equal(server.isError, false, server.text);
    assert.deepEqual(same(cli), same(server.data), name);
    return cli;
  };

  assert.equal((await both('get_unit')).status, 'empty');
  await both('get_catalog');
  const built = await both('build_unit', SMALL);
  assert.deepEqual(built.rooms.map((r) => r.size), [[144, 180], [60, 96]]);
  assert.deepEqual([w.stored().unitRev, w.stored().version], [2, 2]);
  await both('get_unit');
  await both('check_unit');
  await both('edit_unit', { openings: [{ id: 'bath-door', at: [154.25, 70] }], fixtures: [{ id: 'vanity', type: 'vanity', at: [186, 20], snap: false }], remove: ['ghost'] });
  await both('find_spots', { width: 84, depth: 36, room: 'living' });
  await both('place_items', { items: [
    { type: 'sidetable', id: 'side-1', at: [120, 150] }, { type: 'table-lamp', id: 'lamp', on: 'side-1' },
    { type: 'sofa', id: 'sofa', at: [80, 160], rotation: 180 }, { type: 'wall-art', id: 'art', at: [148, 130] },
  ] });
  await both('update_items', { items: [{ id: 'side-1', at: [120, 130] }, { id: 'art', elevation: 50 }] });
  await both('create_asset', STOOL);
  await both('place_items', { items: [{ type: 'asset:stool1', id: 'stool', at: [60, 60] }] });
  await both('remove_items', { ids: ['lamp'] });
  await both('set_info', { title: 'Agent made', author: 'Claude' });
  const unitRev = w.stored().unitRev;
  await both('get_unit');
  const check = await both('check_unit');
  assert.equal(check.pieces.length, 4);
  assert.equal(w.stored().unitRev, unitRev, 'furniture never bumps unitRev');
  assert.deepEqual(Object.keys(w.stored()).sort(), ['assets', 'author', 'items', 'savedAt', 'title', 'unit', 'unitRev', 'version']);

  // The same picture, to the byte, written where Claude can open it.
  const plan = await w.ok(['render_plan']);
  const file = /Plan: (\S+\.png)/.exec(plan)[1];
  assert.equal(file, join(w.ws, 'plan.png'));
  const png = readFileSync(file);
  assert.ok(isPng(png));
  assert.ok(pngSize(png)[0] >= 900 && pngSize(png)[1] >= 560);
  assert.deepEqual(png, (await mcp('render_plan')).image);
  assert.match(await w.ok(['render_plan', '--out', 'pics/p.png']), /pics\/p\.png/);
  assert.ok(existsSync(join(w.dir, 'pics/p.png')));

  // A texture to match a photo: made, used, the same reply and picture from
  // both; with --sample, measured against the photo and shown beside it.
  const tex = { name: 'Oak herringbone', for: 'floor', base: '#b48a5c', pattern: { type: 'herringbone', size: [3, 18], colors: ['#b48a5c', '#a87e52'] },
    layers: [{ type: 'grain', color: '#7d5a37', amount: 0.45, scale: 0.2 }], apply_to: { rooms: ['living'], pieces: ['sofa'], finishes: ['counters'] } };
  const viaCli = await w.cli(['create_texture', JSON.stringify(tex)]);
  assert.equal(viaCli.code, 0, viaCli.err);
  const viaMcp = await mcp('create_texture', tex);
  assert.equal(viaMcp.isError, false, viaMcp.text);
  const [made, preview] = viaCli.out.split('\nPreview: ');
  assert.deepEqual(same(JSON.parse(made)), same(viaMcp.data));
  assert.deepEqual(JSON.parse(made).applied_to, ['finishes.counters', 'room living', 'piece sofa']);
  const texFile = /^(\S+\.png)/.exec(preview)[1];
  assert.equal(texFile, join(w.ws, 'texture-oak-herringbone.png'));
  assert.deepEqual(readFileSync(texFile), viaMcp.image);
  const spec = w.stored().unit;
  assert.equal(spec.rooms.find((r) => r.id === 'living').floor, 'tex:oak-herringbone');
  assert.equal(spec.finishes.counters, 'tex:oak-herringbone');
  assert.equal(w.stored().items.find((i) => i.uid === 'sofa').material, 'tex:oak-herringbone');
  const listed = (await both('get_unit')).textures;
  assert.deepEqual(listed.map((t) => [t.texture_id, t.used_by]), [['oak-herringbone', ['finishes.counters', 'room living', 'piece sofa']]]);
  // Changed in place by its id; a photo to measure against.
  writeFileSync(join(w.dir, 'photo.png'), encodePng(patch(preset('chevron'), { px: 64 }).rgba, 64, 64));
  const again = await w.cli(['create_texture', JSON.stringify({ ...tex, texture_id: 'oak-herringbone', base: '#a07a50', apply_to: undefined }), '--sample', 'photo.png', '--crop', '0,0,1,1']);
  assert.equal(again.code, 0, again.err);
  const vs = JSON.parse(again.out.split('\nPreview: ')[0]);
  assert.equal(vs.texture_id, 'oak-herringbone');
  assert.ok(vs.against_the_photo.match >= 0 && vs.against_the_photo.hints.length, JSON.stringify(vs));
  assert.match(again.out, /with the photo beside it/);
  assert.equal(w.stored().unit.textures.length, 1);
  await mcp('create_texture', { ...tex, texture_id: 'oak-herringbone', base: '#a07a50', apply_to: undefined });
  assert.match((await w.cli(['create_texture', JSON.stringify({ ...tex, texture_id: 'nope' })])).err, /no texture "nope"/);
  // A piece's material; a texture removed leaves what used it as it was.
  await both('update_items', { items: [{ id: 'side-1', material: 'travertine' }] });
  const removed = await both('edit_unit', { remove: ['oak-herringbone'] });
  assert.deepEqual(removed.removed, ['texture oak-herringbone']);
  assert.equal(w.stored().unit.finishes.counters, 'quartz');
  assert.equal(w.stored().unit.rooms.find((r) => r.id === 'living').floor, null);
  assert.equal(w.stored().items.find((i) => i.uid === 'sofa').material, undefined);
  assert.equal(w.stored().items.find((i) => i.uid === 'side-1').material, 'travertine');

  // What can't be done says why, as the server does.
  const err = async (name, args) => {
    const r = await w.cli([name, JSON.stringify(args)]);
    assert.equal(r.code, 1);
    return r.err;
  };
  const spaceship = { items: [{ type: 'spaceship', at: [1, 1] }] };
  assert.equal(await err('place_items', spaceship), (await mcp('place_items', spaceship)).text);
  const nowhere = { items: [{ type: 'vase', id: 'vase', on: 'nothing1' }] };
  assert.equal(await err('place_items', nowhere), (await mcp('place_items', nowhere)).text);
  assert.equal(await err('build_unit', { ceiling_height: 20, rooms: [{ id: 'x', name: 'X', kind: 'ballroom', outline: [[0, 0], [1, 0]] }] }), [
    'Invalid arguments for build_unit:',
    'ceiling_height: Too small: expected number to be >=78',
    'rooms[0].kind: Invalid option: expected one of "living"|"kitchen"|"dining"|"bedroom"|"bath"|"closet"|"hall"|"entry"|"laundry"|"office"|"storage"|"pantry"|"utility"|"balcony"|"other"',
    'rooms[0].outline: Too small: expected array to have >=3 items',
  ].join('\n'));
  assert.match(await err('update_items', { items: [] }), /^Invalid arguments for update_items:\nitems: Too small/);
  assert.match((await w.cli(['place_items', '{"items": ['])).err, /^The arguments aren't valid JSON/);
  assert.match((await w.cli(['place_items', 'nope.json'])).err, /There is no file .*nope\.json/);
  assert.match((await w.cli(['frobnicate'])).err, /There is no tool or command "frobnicate"/);
  assert.match((await w.cli(['get_unit', '--out', 'x'])).err, /get_unit takes no --out/);
  assert.match((await run(['get_unit', '--dir', join(w.dir, 'nowhere')], { cwd: w.dir })).err, /There is no unit in .*nowhere.*`new`/);

  // Arguments from a file, or from stdin.
  writeFileSync(join(w.dir, 'info.json'), JSON.stringify({ title: 'From a file' }));
  assert.equal((await w.ok(['set_info', 'info.json'])).title, 'From a file');
  assert.equal((await w.ok(['set_info', '-'], '{"author": "Piped"}')).author, 'Piped');

  // help: the list, one tool with its schema, every tool as markdown.
  assert.match(await w.ok(['help']), /build_unit\s+Build the unit[\s\S]*push \[--url/);
  const one = await w.ok(['help', 'place_items']);
  assert.match(one, /^place_items: Place furniture\n\nAdd pieces\./);
  const schema = JSON.parse(/Input \(JSON Schema\):\n([\s\S]*?)\n\nRun:/.exec(one)[1]);
  assert.deepEqual(schema.required, ['items']);
  assert.equal(schema.properties.items.items.properties.type.type, 'string');
  const md = await w.ok(['help', '--markdown']);
  for (const name of ['get_unit', 'build_unit', 'render_plan']) assert.match(md, new RegExp(`\n## ${name}\n`));
});

test('skill: new --example, and a new unit starts over only with --force', async () => {
  const w = workDir('example');
  const made = await w.ok(['new', '--example', '--title', 'My copy']);
  assert.deepEqual([made.unit, made.title, made.rooms], ['example', 'My copy', 10]);
  const example = await (await fetch(`${B}/api/units/example`)).json();
  assert.deepEqual(w.stored().unit, example.unit, 'the same rooms as the server\'s example');
  assert.deepEqual([w.stored().items, w.stored().assets, w.stored().unitRev], [[], [], 1]);
  writeFileSync(join(w.ws, 'sync.json'), '{}');
  assert.equal((await w.ok(['new', '--force'])).rooms, 0);
  assert.equal(existsSync(join(w.ws, 'sync.json')), false, 'starting over forgets the Artifact');
});

test('skill: bundle, push and pull keep the Artifact\'s files and database in step', async () => {
  const w = workDir('artifact');
  const URL = 'https://claude.ai/code/artifact/test-0001';
  await w.ok(['new', '--title', 'Flat']);
  await w.tool('build_unit', SMALL);
  await w.tool('create_asset', STOOL);
  await w.tool('place_items', { items: [{ type: 'sofa', id: 'sofa', at: [80, 160], rotation: 180 }, { type: 'asset:stool1', id: 'stool', at: [60, 60] }, { type: 'chair', id: 'chair', at: [100, 60] }] });

  // The files: the page as an Artifact's body, the app, and a snapshot of the unit.
  const b = await w.ok(['bundle']);
  const root = join(w.ws, 'artifact');
  assert.deepEqual([b.publish.root, b.publish.file_path, b.publish.icon, b.publish.url], [root, join(root, 'index.html'), 'home', undefined]);
  assert.deepEqual(b.publish.capabilities, { db: { rules: [
    { path: '', read: 'view', write: 'admin' }, { path: 'data/users/{self}', write: 'interact' },
    { path: 'suggestions', read: 'admin', write: 'admin' }, { path: 'suggestions/{self}', read: 'interact', write: 'interact' },
  ] }, user: { scopes: ['profile'] }, room: {}, sample: { images: true } });
  assert.match(b.publish.description, /^A to-scale 3D model of a studio, 1 bath apartment/);
  const page = readFileSync(b.publish.file_path, 'utf8');
  assert.doesNotMatch(page, /<!doctype|<html[\s>]|<head>|<body[\s>]/i, 'body only');
  // No import map: three.js by absolute URL in the modules (a viewer's runtime makes browsers ignore a page's map).
  assert.doesNotMatch(page, /<script type="importmap">/);
  assert.match(readFileSync(join(root, 'src/main.js'), 'utf8'), /from 'https:\/\/cdn\.jsdelivr\.net\/npm\/three@[\d.]+\/\+esm'/);
  assert.match(page, /window\.LIVING_SPACE = 'artifact'/);
  const paths = b.publish.files.map((f) => f.path);
  for (const p of ['src/main.js', 'src/unit.js', 'assets/tex/512/marble-color.webp', 'unit.json']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.includes('index.html'));
  for (const p of paths) assert.ok(existsSync(join(root, p)), p);
  assert.equal(b.files, paths.length + 1);
  const snapshot = JSON.parse(readFileSync(join(root, 'unit.json'), 'utf8'));
  assert.deepEqual(Object.keys(snapshot), ['title', 'author', 'unit', 'unitRev', 'items', 'assets', 'savedAt']);
  assert.deepEqual([snapshot.title, snapshot.items.length, snapshot.assets[0].id, snapshot.unitRev], ['Flat', 3, 'stool1', 2]);
  assert.match((await w.cli(['bundle', '--snapshot-only'])).err, /--snapshot-only .*--url/);

  // The first push seeds the database: every document, no versions, the spec last.
  assert.match((await w.cli(['push'])).err, /isn't linked to an Artifact/);
  assert.match((await w.cli(['push', '--url', 'nope'])).err, /isn't an Artifact's URL/);
  const seed = await w.ok(['push', '--url', URL]);
  assert.equal(seed.calls.length, 1);
  const writes = seed.calls[0].writes;
  assert.deepEqual(seed.calls[0].action, 'batch');
  assert.equal(seed.calls[0].url, URL);
  assert.deepEqual(writes.map((x) => `${x.collection}/${x.doc_id}`), ['assets/stool1', 'unit/info', 'unit/layout', 'unit/spec']);
  assert.ok(writes.every((x) => x.op === 'set' && x.if_version === undefined && x.file_path.startsWith(join(w.ws, 'outbox'))));
  const sent = (key) => JSON.parse(readFileSync(join(w.ws, 'outbox', `${key}.json`), 'utf8'));
  assert.deepEqual(sent('unit/info'), { title: 'Flat', author: '' });
  assert.deepEqual(Object.keys(sent('unit/spec')), ['unit', 'unitRev', 'savedAt']);
  assert.deepEqual(sent('unit/layout').items, w.stored().items);
  assert.equal(sent('assets/stool1').name, 'Bar stool');
  // Pushing again needs the versions that push made: pull first.
  assert.equal((await w.ok(['push'])).note, 'Nothing to push: the Artifact has all of it.');
  await w.tool('set_info', { author: 'Sam' });
  assert.match((await w.cli(['push'])).err, /^Pull first/);
  // The URL is remembered: tools link to it, a redeploy updates it.
  assert.equal((await w.tool('get_unit')).view_url, URL);
  const again = await w.ok(['bundle']);
  assert.deepEqual([again.publish.url, again.publish.icon], [URL, undefined]);
  const snap = await w.ok(['bundle', '--snapshot-only']);
  // The Artifact tool takes a page with every publish: the same one goes along.
  assert.deepEqual(snap.publish, { url: URL, file_path: join(root, 'index.html'), root, files: [{ path: 'unit.json' }] });
  assert.match(readFileSync(join(root, 'index.html'), 'utf8'), /^<title>Flat<\/title>/);

  // pull, step one: the reads to make.
  const reads = await w.ok(['pull']);
  const inbox = join(w.ws, 'inbox');
  assert.deepEqual(reads.read, [{ action: 'list', url: URL, collection: 'unit', out_dir: inbox }, { action: 'list', url: URL, collection: 'assets', out_dir: inbox }]);
  assert.match(reads.next, /pull --from .*inbox/);

  // What they saved: what was pushed, but someone moved the sofa in the page.
  const save = (dir, key, data) => { mkdirSync(join(dir, dirname(key)), { recursive: true }); writeFileSync(join(dir, `${key}.json`), JSON.stringify(data, null, 2)); };
  const layout = sent('unit/layout');
  layout.items.find((i) => i.uid === 'sofa').x = 5;
  for (const key of ['unit/spec', 'unit/info', 'assets/stool1']) save(inbox, key, sent(key));
  save(inbox, 'unit/layout', { ...layout, savedAt: Date.now() });
  const listing = (versions) => Object.entries(versions).map(([key, v]) => `- "${key.split('/')[1]}"  1234 bytes  version ${v}  "${join(inbox, `${key}.json`)}"`).join('\n');
  const pulled = await w.ok(['pull', '--from', inbox], `Read 3 documents from unit:\n${listing({ 'unit/spec': 1, 'unit/info': 1, 'unit/layout': 2 })}\n\nRead 1 document from assets:\n${listing({ 'assets/stool1': 1 })}`);
  assert.deepEqual(pulled.from_artifact, ['unit/layout']);
  assert.deepEqual(pulled.versions, { 'unit/spec': 1, 'unit/info': 1, 'unit/layout': 2, 'assets/stool1': 1 });
  assert.equal(pulled.missing_versions, undefined);
  assert.equal(w.stored().items.find((i) => i.uid === 'sofa').x, 5, 'the page\'s move came in');
  const sync = JSON.parse(readFileSync(join(w.ws, 'sync.json'), 'utf8'));
  assert.deepEqual([sync.stale, sync.url, sync.docs['unit/layout'].version], [false, URL, 2]);

  // Change a piece and the title here: only those two documents go, pinned to their versions.
  await w.tool('update_items', { items: [{ id: 'chair', at: [100, 70] }] });
  await w.tool('set_info', { title: 'Flat, furnished' });
  const pushed = await w.ok(['push']);
  assert.deepEqual(pushed.calls[0].writes.map((x) => [`${x.collection}/${x.doc_id}`, x.if_version]), [['unit/info', 1], ['unit/layout', 2]]);
  assert.deepEqual(pushed.unchanged, ['assets/stool1', 'unit/spec']);
  assert.equal(Math.round(sent('unit/layout').items.find((i) => i.uid === 'chair').z * 12), 70);

  // Next round: the database took that push (new versions). Meanwhile a new
  // piece was made here, and someone renamed the unit in the page.
  for (const key of ['unit/info', 'unit/layout']) save(inbox, key, sent(key));
  save(inbox, 'unit/info', { title: 'Renamed in the page', author: '' });
  await w.tool('create_asset', { ...STOOL, asset_id: 'stool2', name: 'Tall stool' });
  const round2 = await w.ok(['pull', '--from', inbox], listing({ 'unit/spec': 1, 'unit/info': 3, 'unit/layout': 3, 'assets/stool1': 1 }));
  assert.deepEqual([round2.from_artifact, round2.kept_local, round2.conflicts], [['unit/info'], ['assets/stool2'], undefined]);
  assert.equal(w.stored().title, 'Renamed in the page');
  const round2push = await w.ok(['push']);
  assert.deepEqual(round2push.calls[0].writes.map((x) => [`${x.collection}/${x.doc_id}`, x.if_version]), [['assets/stool2', undefined]]);

  // Both sides moved the same piece since: the Artifact's move wins.
  save(inbox, 'assets/stool2', sent('assets/stool2'));
  const theirs = JSON.parse(readFileSync(join(inbox, 'unit/layout.json'), 'utf8'));
  theirs.items.find((i) => i.uid === 'chair').x = 3;
  save(inbox, 'unit/layout', theirs);
  await w.tool('update_items', { items: [{ id: 'chair', at: [110, 70] }] });
  const round3 = await w.ok(['pull', '--from', inbox], listing({ 'unit/spec': 1, 'unit/info': 4, 'unit/layout': 5, 'assets/stool1': 1, 'assets/stool2': 1 }));
  assert.deepEqual([round3.from_artifact, round3.conflicts], [['unit/layout'], ['unit/layout']]);
  assert.equal(w.stored().items.find((i) => i.uid === 'chair').x, 3);
  assert.equal((await w.ok(['push'])).note, 'Nothing to push: the Artifact has all of it.');

  // A custom piece gone from here goes from the database, after everything else.
  const doc = w.stored();
  writeFileSync(join(w.ws, 'unit.json'), JSON.stringify({ ...doc, assets: doc.assets.filter((a) => a.id !== 'stool2') }));
  const gone = await w.ok(['push']);
  assert.deepEqual(gone.calls[0].writes, [{ op: 'delete', collection: 'assets', doc_id: 'stool2', if_version: 1 }]);

  // Without the versions, pull still takes the documents, but push can't write them.
  writeFileSync(join(w.ws, 'unit.json'), JSON.stringify(doc));
  const blind = await w.ok(['pull', '--from', inbox]);
  assert.equal(blind.missing_versions.length, 5);
  await w.tool('set_info', { title: 'Again' });
  assert.match((await w.cli(['push'])).err, /unit\/info but its version wasn't recorded/);

  // An empty database leaves the unit as it is; the next push seeds it.
  const empty = join(w.dir, 'empty-db');
  mkdirSync(empty);
  assert.equal((await w.ok(['pull', '--from', empty])).artifact, 'empty');
  assert.equal(w.stored().title, 'Again');
  assert.ok((await w.ok(['push'])).calls[0].writes.every((x) => x.if_version === undefined));
  assert.match((await w.cli(['pull', '--from', join(w.dir, 'missing')])).err, /doesn't exist/);
});

test('skill: the example ships its floor plan, nobody else\'s; a plan with the floor plan over it; the page in one file', async () => {
  const ex = workDir('pictures-example');
  await ex.ok(['new', '--example']);
  const exBundle = await ex.ok(['bundle']);
  assert.ok(exBundle.publish.files.some((f) => f.path === 'assets/floorplan.png'));
  // A unit of anyone's own never carries the example's picture, even into a dir that had it.
  const own = workDir('pictures-own');
  await own.ok(['new']);
  await own.tool('build_unit', SMALL);
  const out = join(own.dir, 'out');
  cpSync(join(ex.ws, 'artifact'), out, { recursive: true });
  const ownBundle = await own.ok(['bundle', '--out', out]);
  assert.ok(!ownBundle.publish.files.some((f) => f.path.startsWith('assets/') && !f.path.startsWith('assets/tex/')));
  assert.ok(!existsSync(join(out, 'assets/floorplan.png')));
  assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /^<title>Test flat<\/title>/);

  // The leasing plan laid over the example's drawing, at its scale and origin.
  await ex.ok(['render_plan', '--out', join(ex.dir, 'plain.png')]);
  const said = await ex.ok(['render_plan', '--out', join(ex.dir, 'over.png'), '--overlay', join(ROOT, 'assets/floorplan.png'), '--overlay-scale', '2.155', '--overlay-origin', '91,60']);
  assert.match(said, /with the floor plan laid over it/);
  const [a, b] = [readFileSync(join(ex.dir, 'plain.png')), readFileSync(join(ex.dir, 'over.png'))];
  assert.deepEqual(pngSize(a), pngSize(b));
  assert.ok(!a.equals(b));
  const half = await ex.cli(['render_plan', '--overlay', join(ROOT, 'assets/floorplan.png')]);
  assert.equal(half.code, 1);
  assert.match(half.err, /--overlay-scale/);

  // One file: every module in the import map under a bare name, the unit inside.
  const single = await own.ok(['bundle', '--single']);
  const html = readFileSync(single.file, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /window\.LIVING_SPACE_SNAPSHOT = \{"title":"","author":"","unit":\{"name":"Test flat"/);
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
  for (const rel of moduleGraph(ROOT)) {
    const code = Buffer.from(map[`living-space/${rel}`].split(',')[1], 'base64').toString();
    assert.doesNotMatch(code, /from\s*['"]\.{1,2}\/|import\(\s*['"]\.{1,2}\//, rel);
  }
  assert.ok(html.includes("import('living-space/src/main.js')"));
});

test('skill: as a command: results on stdout, an error on stderr with exit 1, JSON and results on stdin', () => {
  const dir = join(scratch, 'process');
  mkdirSync(dir);
  const space = (args, input) => spawnSync(process.execPath, [join(ROOT, 'skill/3d-living-space/scripts/space.mjs'), ...args], { cwd: dir, encoding: 'utf8', input });
  assert.deepEqual([space(['new']).status, space(['new']).status], [0, 1]);
  let r = space(['build_unit', '-'], JSON.stringify(SMALL));
  assert.deepEqual([r.status, r.stderr, JSON.parse(r.stdout).counts.rooms], [0, '', 2]);
  r = space(['place_items', '{"items": [{"type": "spaceship", "at": [1, 1]}]}']);
  assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', '"spaceship" is not in the catalog. Call get_catalog, or build it with create_asset.\n']);

  // Seed, then pull what was seeded with its versions on stdin.
  const first = 'https://claude.ai/code/artifact/first';
  assert.equal(space(['push', '--url', first]).status, 0);
  const ws = join(dir, 'living-space');
  cpSync(join(ws, 'outbox'), join(dir, 'db'), { recursive: true });
  r = space(['pull', '--from', 'db'], ['spec', 'layout', 'info'].map((id) => `- "${id}"  10 bytes  version 1  "${join(dir, 'db/unit', `${id}.json`)}"`).join('\n'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).versions, { 'unit/spec': 1, 'unit/layout': 1, 'unit/info': 1 });
  space(['set_info', '{"title": "Changed"}']);
  assert.deepEqual(JSON.parse(space(['push']).stdout).calls[0].writes.map((x) => x.if_version), [1]);
  // A work dir pointed at another Artifact seeds that one from scratch.
  r = space(['push', '--url', 'https://claude.ai/code/artifact/second']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).calls[0].writes.map((x) => x.if_version), [undefined, undefined, undefined]);
});

test('skill: versions are read from ArtifactData results however they are pasted', () => {
  const keys = ['unit/spec', 'unit/layout', 'unit/info', 'assets/stool1'];
  const v = (text) => Object.fromEntries(parseVersions(text, keys));
  assert.deepEqual(v('- "spec"  12345 bytes  version 3  "/abs/path/unit/spec.json"'), { 'unit/spec': 3 });
  assert.deepEqual(v('saved C:\\work\\inbox\\assets\\stool1.json (version: 7)'), { 'assets/stool1': 7 });
  assert.deepEqual(v('* layout, version 4\n* `info` (version=2)\n* stool1 version 9'), { 'unit/layout': 4, 'unit/info': 2, 'assets/stool1': 9 });
  assert.deepEqual(v(JSON.stringify({ documents: [{ collection: 'unit', doc_id: 'spec', version: 5 }, { id: 'stool1', version: 2, data: {} }] })), { 'unit/spec': 5, 'assets/stool1': 2 });
  assert.deepEqual(v('nothing useful here\nversion 3'), {});
});

test('skill: the packaged skill runs on its own, with no node_modules and nothing from the repo', () => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), '3dls-pkg-')));
  const work = realpathSync(mkdtempSync(join(tmpdir(), '3dls-use-')));
  after(() => { rmSync(out, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  for (let d = out; d !== dirname(d); d = dirname(d)) assert.ok(!existsSync(join(d, 'node_modules')), `${d} has node_modules: the test would prove nothing`);

  const pkg = spawnSync(process.execPath, ['skill/package.mjs', '--out', out], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(pkg.status, 0, pkg.stderr);
  const skill = join(out, '3d-living-space');
  const files = (dir, pre = '') => readdirSync(join(dir, pre), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(dir, `${pre}${e.name}/`) : [`${pre}${e.name}`]));
  const all = files(skill);
  assert.ok(!all.some((f) => f.split('/').includes('node_modules')));
  for (const f of ['scripts/space.mjs', 'scripts/raster.mjs', 'scripts/app.mjs', 'scripts/lib/agent.js', 'scripts/lib/tools.js', 'scripts/vendor/zod/index.js', 'scripts/vendor/zod/LICENSE',
    'scripts/vendor/resvg/index_bg.wasm', 'scripts/fonts/IBMPlexSans-Regular.ttf', 'scripts/fonts/OFL.txt', 'app/index.html', 'app/src/main.js', 'references/tools.md']) assert.ok(all.includes(f), f);
  assert.ok(!all.some((f) => f.startsWith('scripts/vendor/zod/') && /\.d\.c?ts$|\.cjs$|\/src\//.test(f)), 'only zod\'s ES modules');
  // Exactly the shared modules the scripts reach, none of the browser's.
  const libs = moduleGraph(ROOT, ['skill/3d-living-space/scripts/space.mjs']).filter((p) => p.startsWith('src/')).map((p) => `scripts/lib/${p.slice(4)}`);
  assert.deepEqual(all.filter((f) => f.startsWith('scripts/lib/')).sort(), libs.sort());
  assert.match(readFileSync(join(skill, 'references/tools.md'), 'utf8'), /\n## build_unit\n/);
  // Ours, that is: resvg's initWasm can fetch a URL, but it is handed the wasm's bytes.
  for (const f of all.filter((f) => /^scripts\/(lib\/)?[^/]+\.m?js$/.test(f))) assert.doesNotMatch(readFileSync(join(skill, f), 'utf8'), /\bfetch\(|['"]node:(https?|net|dns)['"]/, `${f} reaches for the network`);

  // The zip holds the folder at its top level.
  const zip = readFileSync(join(out, '3d-living-space.zip'));
  const end = zip.length - 22, names = [];
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  for (let i = zip.readUInt32LE(end + 16), n = 0; n < zip.readUInt16LE(end + 10); n++) {
    assert.equal(zip.readUInt32LE(i), 0x02014b50);
    const len = zip.readUInt16LE(i + 28);
    names.push(zip.toString('utf8', i + 46, i + 46 + len));
    i += 46 + len + zip.readUInt16LE(i + 30) + zip.readUInt16LE(i + 32);
  }
  assert.ok(names.length > all.length && names.every((n) => n.startsWith('3d-living-space/')));
  assert.ok(all.every((f) => names.includes(`3d-living-space/${f}`)));
  if (spawnSync('unzip', ['-v']).status === 0) assert.equal(spawnSync('unzip', ['-tq', join(out, '3d-living-space.zip')]).status, 0);

  // The same skill as a plugin, and the marketplace entry that pins its zip.
  const plugin = join(out, '3d-living-space-plugin');
  const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  assert.deepEqual([manifest.name, manifest.version], ['3d-living-space', JSON.parse(readFileSync(join(ROOT, 'skill/plugin.json'), 'utf8')).version]);
  for (const f of ['README.md', '.claude-plugin/icon.png', 'skills/3d-living-space/SKILL.md', 'skills/3d-living-space/scripts/space.mjs']) assert.ok(existsSync(join(plugin, f)), f);
  const catalog = JSON.parse(readFileSync(join(out, 'marketplace.json'), 'utf8'));
  const entry = catalog.plugins[0];
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.source.url, `https://github.com/realAndi/3DLivingSpace/releases/download/skill-v${manifest.version}/3d-living-space-plugin.zip`);
  assert.equal(entry.source.sha256, createHash('sha256').update(readFileSync(join(out, '3d-living-space-plugin.zip'))).digest('hex'));

  // Run it from elsewhere, allowed to read only itself and the work dir.
  const space = (...args) => {
    const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${skill}`, `--allow-fs-read=${work}`, `--allow-fs-write=${work}`, join(skill, 'scripts/space.mjs'), ...args], { cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`);
    return r.stdout.startsWith('{') ? JSON.parse(r.stdout) : r.stdout;
  };
  const doctor = space('doctor');
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.match(doctor.runs_from, /packaged skill/);
  assert.equal(space('new', '--title', 'Packed').unit, 'empty');
  writeFileSync(join(work, 'small.json'), JSON.stringify(SMALL));
  assert.deepEqual(space('build_unit', 'small.json').problems, []);
  assert.match(space('render_plan'), /2 rooms, 3 doors and windows/);
  const png = readFileSync(join(work, 'living-space/plan.png'));
  assert.ok(isPng(png) && pngSize(png)[0] >= 900);
  const b = space('bundle');
  assert.ok(existsSync(join(work, 'living-space/artifact/src/main.js')));
  // The app's files and the snapshot; not the example's floor plan, which this unit doesn't show.
  assert.equal(b.files, all.filter((f) => f.startsWith('app/') && f !== 'app/assets/floorplan.png').length + 1);
});
