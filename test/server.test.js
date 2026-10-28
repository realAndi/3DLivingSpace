// End-to-end: start the server on a scratch data directory, then use the API
// the way the browser does and a unit's own MCP server the way an agent does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_TITLE } from '../src/example.js';

const port = 18000 + Math.floor(Math.random() * 1000);
const B = `http://localhost:${port}/3DLivingSpace`;
const dataDir = mkdtempSync(join(tmpdir(), '3dls-'));
let server;

// A design saved before units existed: furniture in the one apartment.
const LEGACY = { id: 'legacy0001', key: 'LegacyKey0123456789abcdefgh' };
function oldDesigns() {
  const db = new DatabaseSync(join(dataDir, 'designs.db'));
  db.exec(`CREATE TABLE designs (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
    doc TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, forked_from TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.prepare('INSERT INTO designs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(LEGACY.id, createHash('sha256').update(LEGACY.key).digest('hex'), 'Old one', 'Lee',
    JSON.stringify({ items: [{ uid: 'bed00001', type: 'bed-queen', x: 30, z: 4.3 }], assets: [] }), 4, null, 1, 2);
  db.prepare('INSERT INTO designs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('broken0001', 'x', '', '', 'not json', 1, null, 1, 1);
  db.close();
}

before(async () => {
  oldDesigns();
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), BASE_PATH: '/3DLivingSpace', DATA_DIR: dataDir, PUBLIC_URL: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${B}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { server.kill(); rmSync(dataDir, { recursive: true, force: true }); });

const api = (path, { method = 'GET', body, key } = {}) => fetch(`${B}/${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Edit-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
const create = async (body = {}) => {
  const res = await api('api/units', { method: 'POST', body });
  assert.equal(res.status, 201);
  return res.json();
};
const isPng = (buf) => buf.subarray(1, 4).toString() === 'PNG';
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

// A unit's MCP server, at its own address.
function mcpAt(url) {
  const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  async function rpc(method, params = {}) {
    const res = await post({ jsonrpc: '2.0', id: 1, method, params });
    assert.equal(res.status, 200, await res.clone().text());
    const reply = await res.json();
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  }
  async function call(name, args = {}) {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.content.find((c) => c.type === 'text')?.text;
    let data = null;
    if (!r.isError && text?.startsWith('{')) data = JSON.parse(text);
    return { ...r, data, text };
  }
  return { rpc, call };
}

// A small unit in inches: a living room with a kitchen along its west wall and
// a bath to the east, a door between them, an entry door and a window. The
// kitchen run and the toilet stand a few inches off their walls on purpose.
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

test('units: create empty, change furniture with the key only, poll, copy', async () => {
  const u = await create({ title: 'Mine' });
  assert.equal(u.unit.rooms.length, 0);
  assert.equal(u.version, 1);
  assert.equal(u.unitRev, 1);
  assert.equal(u.url, `${B}/u/${u.id}`);
  assert.equal(u.editUrl, `${B}/u/${u.id}#edit=${u.key}`);
  assert.equal(u.mcpUrl, `${B}/mcp/${u.id}/${u.key}`);
  assert.equal(u.forkedFrom, null);

  const wrong = await api(`api/units/${u.id}`, { method: 'PATCH', key: 'x'.repeat(28), body: { upsert: [{ type: 'sofa', x: 5, z: 5 }] } });
  assert.equal(wrong.status, 403);
  assert.match((await wrong.json()).error, /key/);
  assert.equal((await api(`api/units/${u.id}`, { method: 'PATCH', body: {} })).status, 403, 'no key');

  // The browser changes furniture and the title; a unit sent along is ignored.
  const ok = await api(`api/units/${u.id}`, { method: 'PATCH', key: u.key, body: {
    baseVersion: 1, title: 'Mine, v2', upsert: [{ uid: 'sofa0001', type: 'sofa', x: 6, z: 8 }],
    unit: { rooms: [{ id: 'r', kind: 'living', poly: [[0, 0], [10, 0], [10, 10], [0, 10]] }] },
  } });
  assert.equal(ok.status, 200);
  const saved = await ok.json();
  assert.deepEqual([saved.version, saved.unitRev, saved.design], [2, 1, undefined]);

  assert.equal((await api(`api/units/${u.id}?since=2`)).status, 204);
  const read = await (await api(`api/units/${u.id}?since=1`)).json();
  assert.equal(read.title, 'Mine, v2');
  assert.equal(read.items.length, 1);
  assert.equal(read.unit.rooms.length, 0, 'the browser never changes the unit');
  assert.equal(read.key, undefined, 'the key never comes back from a read');

  // Someone else wrote since version 1: the reply brings the whole unit.
  const behind = await (await api(`api/units/${u.id}`, { method: 'PATCH', key: u.key, body: { baseVersion: 1, remove: ['nothing0'] } })).json();
  assert.equal(behind.version, 3);
  assert.equal(behind.design.items.length, 1);

  const bad = await api(`api/units/${u.id}`, { method: 'PATCH', key: u.key, body: { upsert: [{ type: 'spaceship', x: 1, z: 1 }] } });
  assert.equal(bad.status, 400);
  assert.equal((await api(`api/units/${u.id}`, { method: 'PATCH', key: u.key, body: [] })).status, 400);

  const copy = await (await api(`api/units/${u.id}/fork`, { method: 'POST', body: {} })).json();
  assert.notEqual(copy.id, u.id);
  assert.notEqual(copy.key, u.key);
  assert.equal(copy.items.length, 1);
  assert.equal(copy.forkedFrom, u.id);
  assert.equal(copy.title, 'Mine, v2 (my version)');
  const copy2 = await create({ from: u.id, author: 'Ana' });
  assert.deepEqual([copy2.items.length, copy2.forkedFrom, copy2.author], [1, u.id, 'Ana']);

  assert.equal((await api('api/units/nope12345')).status, 404);
  assert.equal((await api('api/units', { method: 'POST', body: { from: 'nope12345' } })).status, 404);
});

test('the example unit: read-only, copied without furniture', async () => {
  const ex = await (await api('api/units/example')).json();
  assert.deepEqual([ex.id, ex.version, ex.unitRev, ex.title], ['example', 1, 1, EXAMPLE_TITLE]);
  assert.equal(ex.unit.rooms.length, 10);
  assert.equal(ex.items.length, 0);
  assert.equal((await api('api/units/example?since=1')).status, 204);
  assert.equal((await api('api/units/example', { method: 'PATCH', key: 'x'.repeat(28), body: { title: 'Mine now' } })).status, 403);

  const mine = await create({ from: 'example', title: 'My copy' });
  assert.deepEqual([mine.unit.rooms.length, mine.items.length, mine.forkedFrom, mine.title], [10, 0, 'example', 'My copy']);
  assert.deepEqual(mine.unit, ex.unit);
  const fork = await (await api('api/units/example/fork', { method: 'POST', body: {} })).json();
  assert.deepEqual([fork.unit.rooms.length, fork.forkedFrom, fork.title], [10, 'example', '']);
});

test('designs from before units are units of the example, same links and keys', async () => {
  const old = await (await api(`api/units/${LEGACY.id}`)).json();
  assert.deepEqual([old.title, old.author, old.version, old.unitRev, old.items.length, old.unit.rooms.length], ['Old one', 'Lee', 4, 1, 1, 10]);
  const res = await api(`api/units/${LEGACY.id}`, { method: 'PATCH', key: LEGACY.key, body: { title: 'Old one, moved' } });
  assert.equal(res.status, 200);
  assert.equal((await api('api/units/broken0001')).status, 404);
});

test('pages and pictures', async () => {
  const home = await (await fetch(`${B}/`)).text();
  assert.match(home, /<base href="\/3DLivingSpace\/">/);
  assert.match(home, /og:title" content="3D Living Space"/);
  assert.match(home, /og:image" content="http:\/\/localhost:\d+\/3DLivingSpace\/api\/card.png"/);

  const u = await create({ from: 'example', title: 'Cozy <corner>', author: 'Sam' });
  const html = await (await fetch(`${B}/u/${u.id}`)).text();
  assert.match(html, /<base href="\/3DLivingSpace\/">/);
  assert.match(html, /og:title" content="Cozy &lt;corner&gt; · 3D Living Space"/);
  assert.match(html, /og:description" content="Sam&#39;s apartment in 3D \(2 bed, 2 bath, 821 sq ft, 0 pieces\)/);
  assert.match(html, new RegExp(`api/units/${u.id}/card.png\\?v=1`));
  assert.match(await (await fetch(`${B}/u/example`)).text(), new RegExp(`og:title" content="${EXAMPLE_TITLE} · 3D Living Space"`));
  assert.equal((await fetch(`${B}/u/nope12345`)).status, 404);
  const old = await fetch(`${B}/d/${u.id}`, { redirect: 'manual' });
  assert.deepEqual([old.status, old.headers.get('location')], [301, `/3DLivingSpace/u/${u.id}`]);

  assert.equal((await fetch(`${B}/src/unit.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${B}/assets/tex/512/marble-color.webp`)).headers.get('content-type'), 'image/webp');
  assert.equal((await fetch(`${B}/src/../server/index.js`)).status, 404);

  const empty = await create();
  for (const path of ['api/card.png', `api/units/${u.id}/card.png`, `api/units/${u.id}/plan.png`, 'api/units/example/plan.png', `api/units/${empty.id}/card.png`, `api/units/${empty.id}/plan.png`]) {
    const res = await fetch(`${B}/${path}`);
    assert.equal(res.status, 200, path);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(isPng(buf), path);
    if (path.endsWith('card.png')) assert.deepEqual(pngSize(buf), [1200, 630], path);
  }
});

test('MCP: one address per unit', async () => {
  const u = await create();
  const post = (url, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined });
  for (const url of [`${B}/mcp/${u.id}/${'x'.repeat(28)}`, `${B}/mcp/nope12345/${u.key}`, `${B}/mcp`, `${B}/mcp/${u.id}`, `${B}/mcp/example/${u.key}`]) {
    const res = await post(url);
    assert.equal(res.status, 404, url);
    assert.match((await res.json()).error.message, /Share tab/, url);
  }
  assert.equal((await post(u.mcpUrl, 'GET')).status, 405);

  const { rpc } = mcpAt(u.mcpUrl);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.serverInfo.name, '3d-living-space');
  assert.match(init.instructions, /This connection belongs to one unit/);
  const tools = (await rpc('tools/list')).tools;
  for (const t of ['get_unit', 'build_unit', 'edit_unit', 'get_catalog', 'set_info', 'place_items', 'update_items', 'remove_items', 'create_asset', 'create_texture', 'find_spots', 'check_unit', 'render_plan']) {
    const tool = tools.find((x) => x.name === t);
    assert.ok(tool, t);
    assert.equal(tool.inputSchema.properties?.unit, undefined, `${t} takes no unit`);
  }
});

test('MCP: an agent builds a unit from a plan, fixes it and furnishes it', async () => {
  const u = await create();
  const { call } = mcpAt(u.mcpUrl);

  const empty = (await call('get_unit')).data;
  assert.equal(empty.status, 'empty');
  assert.match(empty.next_steps, /floor plan/);

  const catalog = (await call('get_catalog')).data;
  assert.ok(catalog.fixtures.find((f) => f.type === 'kitchen-run').options.includes('segments'));
  assert.ok(catalog.kitchen_segments.find((s) => s.kind === 'sink').width > 0);
  assert.ok(catalog.furniture.find((f) => f.type === 'sofa'));

  // Build it.
  const built = (await call('build_unit', SMALL)).data;
  assert.deepEqual(built.counts, { rooms: 2, walls: 0, doors: 2, windows: 1, doorways: 0, fixtures: 2, labels: 0 });
  assert.deepEqual(built.rooms.map((r) => r.size), [[144, 180], [60, 96]]);
  assert.deepEqual(built.dropped, []);
  assert.deepEqual(built.problems, []);
  // Both stood off their walls: they were slid back flush.
  const moved = Object.fromEntries(built.moved.map((m) => [m.id, m.to]));
  assert.deepEqual(moved, { kitchen: [20.75, 90], toilet: [202.5, 80] });

  // The browser sees a new unitRev and the rooms.
  const view = await (await api(`api/units/${u.id}`)).json();
  assert.deepEqual([view.unitRev, view.unit.rooms.length, view.unit.name], [2, 2, 'Test flat']);

  const got = (await call('get_unit')).data;
  assert.equal(got.status, 'built');
  assert.equal(got.settings.baths, 1);
  const door = got.openings.find((o) => o.id === 'bath-door');
  assert.deepEqual([door.joins, door.opens, door.opens_into, door.hinge, door.wall_thickness], [['living', 'bath'], 'east', 'bath', 'north', 4.5]);
  assert.deepEqual(got.openings.find((o) => o.id === 'entry').joins, ['living', 'outside']);
  const kitchen = got.fixtures.find((f) => f.id === 'kitchen');
  assert.deepEqual(kitchen.segments.map((s) => s.kind), ['fridge', 'sink', 'dishwasher', 'range']);
  assert.equal(kitchen.hood, 'hood');
  assert.ok(kitchen.against_wall.includes('back'));
  assert.equal(got.fixtures.find((f) => f.id === 'toilet').room, 'bath');

  // Move a door, take out a fixture, add one with snap: false.
  const edited = (await call('edit_unit', {
    openings: [{ id: 'bath-door', at: [154.25, 70] }],
    fixtures: [{ id: 'vanity', type: 'vanity', at: [186, 20], rotation: 0, snap: false }],
    remove: ['toilet', 'ghost'],
  })).data;
  assert.deepEqual(edited.removed, ['fixture toilet']);
  assert.equal(edited.not_found.length, 1);
  assert.deepEqual(edited.moved, []);
  const after = (await call('get_unit')).data;
  assert.deepEqual(after.openings.find((o) => o.id === 'bath-door').at, [154.25, 70]);
  assert.deepEqual(after.fixtures.map((f) => [f.id, f.at]), [['kitchen', [20.75, 90]], ['vanity', [186, 20]]]);

  // Problems come back: overlapping rooms, a door in no wall, a room that can't be used.
  const broken = (await call('edit_unit', {
    rooms: [{ id: 'nook', name: 'Nook', kind: 'other', outline: [[100, 8], [180, 8], [180, 60], [100, 60]] }, { id: 'flat', name: 'Flat', kind: 'other', outline: [[0, 0], [10, 0], [20, 0]] }],
    openings: [{ id: 'lost', type: 'door', at: [80, 100], width: 30 }],
    fixtures: [{ id: 'cab', type: 'base-cabinet', at: [170, 80], snap: false }],
  })).data;
  assert.ok(broken.problems.some((p) => /bath-door\) hits cab/.test(p)), broken.problems.join('\n'));
  assert.ok(broken.problems.some((p) => /overlap/.test(p)), broken.problems.join('\n'));
  assert.ok(broken.problems.some((p) => /lost .*isn't in a wall/.test(p)), broken.problems.join('\n'));
  assert.ok(broken.dropped.some((d) => /Flat/.test(d)));
  const fixed = (await call('edit_unit', { remove: ['nook', 'lost', 'cab'] })).data;
  assert.deepEqual(fixed.problems, []);

  // A schema error is an error, not a crash.
  const nonsense = await call('build_unit', { rooms: [{ id: 'x', name: 'X', kind: 'ballroom', outline: [[0, 0], [1, 0], [1, 1]] }] });
  assert.equal(nonsense.isError, true);

  // Furnish it.
  const unitRev = (await (await api(`api/units/${u.id}`)).json()).unitRev;
  const spots = (await call('find_spots', { width: 84, depth: 36, room: 'living' })).data.spots;
  assert.ok(spots.length > 0);
  const placed = (await call('place_items', { items: [
    { type: 'sofa', at: spots[0].at, rotation: spots[0].rotation },
    { type: 'bed-queen', at: [186, 60] },
  ] })).data;
  assert.equal(placed.placed.length, 2);
  assert.equal(placed.placed[0].room, 'living');
  assert.ok(!placed.problems.some((p) => p.startsWith('Sofa')), placed.problems.join('\n'));
  assert.ok(placed.problems.some((p) => p.startsWith('Queen bed')), 'a queen bed in the bath is flagged');
  const bed = placed.placed[1];
  assert.equal((await call('update_items', { items: [{ id: bed.id, at: [80, 100], rotation: 90 }] })).data.updated[0].room, 'living');
  assert.equal((await call('place_items', { items: [{ type: 'spaceship', at: [1, 1] }] })).isError, true);

  const asset = (await call('create_asset', { name: 'Bar stool', parts: [
    { shape: 'cylinder', size: [14, 1.5, 14], at: [0, 29, 0], color: '#8a6a4a', finish: 'wood' },
    { shape: 'cylinder', size: [2, 28, 2], at: [0, 14, 0], color: '#222222', finish: 'metal' },
  ] })).data;
  assert.equal(asset.height, 29.75);
  const stool = (await call('place_items', { items: [{ type: asset.place_as, at: [60, 60] }] })).data.placed[0];
  assert.equal(stool.type, `asset:${asset.asset_id}`);

  const check = (await call('check_unit')).data;
  assert.equal(check.pieces.length, 3);
  assert.deepEqual(check.unit_problems, []);
  assert.ok(check.pieces.find((p) => p.name === 'Sofa').clear_floor);

  const pic = await call('render_plan');
  assert.equal(pic.content[0].type, 'image');
  const buf = Buffer.from(pic.content[0].data, 'base64');
  assert.ok(isPng(buf));
  assert.ok(pngSize(buf)[0] >= 900);
  assert.match(pic.text, new RegExp(`/u/${u.id}`));

  const removed = (await call('remove_items', { ids: [stool.id] })).data;
  assert.equal(removed.remaining, 2);
  assert.equal((await call('set_info', { title: 'Agent made', author: 'Claude' })).data.title, 'Agent made');

  const final = await (await api(`api/units/${u.id}`)).json();
  assert.deepEqual([final.title, final.author, final.items.length, final.assets.length], ['Agent made', 'Claude', 2, 1]);
  assert.equal(final.unitRev, unitRev, 'furniture never bumps unitRev');
  const got2 = (await call('get_unit')).data;
  assert.equal(got2.furniture.length, 2);
  assert.equal(got2.assets[0].place_as, asset.place_as);
});

test('MCP: editing part of a copy of the example keeps the rest', async () => {
  const u = await create({ from: 'example' });
  const { call } = mcpAt(u.mcpUrl);
  const res = (await call('edit_unit', { rooms: [{ id: 'living', name: 'Great Room' }], openings: [{ id: 'win-living', width: 80 }] })).data;
  assert.deepEqual(res.dropped, []);
  const { unit } = await (await api(`api/units/${u.id}`)).json();
  const room = unit.rooms.find((r) => r.id === 'living'), win = unit.openings.find((o) => o.id === 'win-living');
  assert.equal(room.name, 'Great Room');
  assert.ok(room.view, 'the walk-mode view stays');
  assert.deepEqual([Math.round(win.width * 12), win.mullions], [80, [0.577]]);
  assert.equal(unit.fixtures.length, 16);
});

test('MCP: an agent decorates: lamps on tables, art on walls, a pendant, the counter', async () => {
  const u = await create();
  const { call } = mcpAt(u.mcpUrl);
  await call('build_unit', SMALL);
  assert.equal((await call('edit_unit', { north: 90 })).isError, undefined);
  assert.equal((await call('get_unit')).data.settings.north, 90);

  const catalog = (await call('get_catalog')).data;
  const kind = (t) => catalog.furniture.find((f) => f.type === t);
  assert.deepEqual([kind('table-lamp').placement, kind('table-lamp').kind, kind('table-lamp').use], ['surface', 'lighting', 'switches on and off']);
  assert.deepEqual([kind('wall-art').placement, kind('wall-art').elevation], ['wall', 45]);
  assert.equal(kind('pendant').placement, 'ceiling');
  assert.equal(kind('sidetable').holds_items, true);
  assert.equal(kind('sofa').holds_items, undefined);
  assert.ok(catalog.placements.wall);

  const placed = (await call('place_items', { items: [
    { type: 'sidetable', id: 'side-1', at: [120, 150] },
    { type: 'table-lamp', on: 'side-1' },
    { type: 'dresser', id: 'dresser', at: [143, 100], rotation: 90 },
    { type: 'books', at: [143, 110] },
    { type: 'wall-art', at: [148, 130] },
    { type: 'curtains', at: [80, 12], width: 76 },
    { type: 'pendant', at: [80, 100] },
    { type: 'coffee-maker', on: 'kitchen' },
  ] })).data;
  const by = Object.fromEntries(placed.placed.map((p) => [p.type, p]));
  assert.deepEqual([by['table-lamp'].on, by['table-lamp'].elevation, by['table-lamp'].at], ['side-1', 24, [120, 150]]);
  assert.deepEqual([by.books.on, by.books.elevation], ['dresser', 32]);
  assert.deepEqual([by['wall-art'].on, by['wall-art'].elevation, by['wall-art'].rotation, by['wall-art'].at], ['wall', 45, 90, [151.25, 130]]);
  assert.deepEqual([by.curtains.on, by.curtains.rotation, by.curtains.at[1]], ['wall', 0, 11]);
  assert.deepEqual([by.pendant.on, by.pendant.elevation], ['ceiling', 72]);
  assert.deepEqual([by['coffee-maker'].on, by['coffee-maker'].elevation], ['kitchen', 36]);
  assert.deepEqual(placed.problems, []);

  // Moving the side table carries the lamp; the art goes up the wall.
  const moved = (await call('update_items', { items: [{ id: 'side-1', at: [120, 130] }, { id: by['wall-art'].id, elevation: 50 }] })).data;
  assert.deepEqual(moved.carried.map((p) => [p.type, p.at]), [['table-lamp', [120, 130]]]);
  assert.equal(moved.updated.find((p) => p.type === 'wall-art').elevation, 50);
  assert.deepEqual(moved.problems, []);
  // The lamp moved off its table lands on the floor, and says it's on the floor.
  const off = (await call('update_items', { items: [{ id: by['table-lamp'].id, at: [60, 120] }] })).data.updated[0];
  assert.deepEqual([off.on, off.elevation], ['floor', undefined]);
  assert.equal((await call('update_items', { items: [{ id: by['table-lamp'].id, on: 'side-1' }] })).data.updated[0].elevation, 24);

  // What can't be done says why.
  assert.match((await call('place_items', { items: [{ type: 'mirror', at: [80, 100] }] })).text, /no wall within 3 ft/);
  assert.match((await call('place_items', { items: [{ type: 'vase', on: 'nothing1' }] })).text, /isn't a piece or a fixture/);
  assert.match((await call('place_items', { items: [{ type: 'vase', id: 'side-1', at: [1, 1] }] })).text, /already a piece/);
  assert.match((await call('place_items', { items: [{ type: 'vase', on: 'wall' }] })).text, /needs at/);

  const check = (await call('check_unit')).data;
  assert.equal(check.pieces.find((p) => p.id === by.pendant.id).on, 'ceiling');
  assert.equal(check.pieces.find((p) => p.id === by.books.id).clear_floor, null);
  assert.ok(check.pieces.find((p) => p.id === 'dresser').clear_floor);
  const pic = await call('render_plan');
  assert.ok(isPng(Buffer.from(pic.content[0].data, 'base64')));

  // Removing the table takes the lamp with it.
  const removed = (await call('remove_items', { ids: ['side-1'] })).data;
  assert.deepEqual([removed.removed, removed.also_removed.map((p) => p.id)], [2, [by['table-lamp'].id]]);

  // A lamp an agent makes switches on: placement, kind, light and glow are kept.
  const lamp = (await call('create_asset', { name: 'Mushroom lamp', placement: 'surface', kind: 'lighting', light_at: [0, 10, 0], parts: [
    { shape: 'cylinder', size: [6, 1, 6], at: [0, 0.5, 0], color: '#222222', finish: 'metal' },
    { shape: 'sphere', size: [10, 8, 10], at: [0, 10, 0], color: '#f4ead8', finish: 'glow' },
  ] })).data;
  assert.deepEqual([lamp.placement, lamp.kind, lamp.light_at], ['surface', 'lighting', [0, 10, 0]]);
  const onDresser = (await call('place_items', { items: [{ type: lamp.place_as, at: [143, 85] }] })).data.placed[0];
  assert.deepEqual([onDresser.on, onDresser.elevation], ['dresser', 32]);
});

test('edit codes: the owner sets one, another device trades it for the key; guessing is limited', async () => {
  const u = await create({ title: 'Code test' });
  const code = (method, body, key) => api(`api/units/${u.id}/code`, { method, body, key });
  const unlock = (c, id = u.id) => api(`api/units/${id}/unlock`, { method: 'POST', body: { code: c } });

  assert.equal((await code('GET', null, 'x'.repeat(28))).status, 403, 'only the key sees whether a code is set');
  assert.deepEqual(await (await code('GET', null, u.key)).json(), { set: false });
  assert.equal((await unlock('anything1')).status, 403, 'no code set yet');
  assert.equal((await code('PUT', { code: 'ab-1' }, u.key)).status, 400, 'too short');
  assert.equal((await code('PUT', { code: 'Maple River 42' }, 'x'.repeat(28))).status, 403);
  assert.deepEqual(await (await code('PUT', { code: 'Maple River 42' }, u.key)).json(), { set: true });
  assert.deepEqual(await (await code('GET', null, u.key)).json(), { set: true });
  // The code never comes back from a read.
  assert.equal(JSON.stringify(await (await api(`api/units/${u.id}`)).json()).includes('code'), false);

  const wrong = await unlock('maple river 41');
  assert.equal(wrong.status, 403);
  assert.match((await wrong.json()).error, /Share tab/);
  // Case, spaces and dashes don't matter: a phone capitalizes.
  const right = await unlock('maple-river-42');
  assert.equal(right.status, 200);
  const got = await right.json();
  assert.deepEqual([got.id, got.key, got.mcpUrl], [u.id, u.key, u.mcpUrl]);
  assert.equal((await api(`api/units/${u.id}`, { method: 'PATCH', key: got.key, body: { title: 'From my phone' } })).status, 200);
  assert.equal((await unlock('maple-river-42', 'example')).status, 403, 'the example has no code');

  // A new code replaces the old; removing it closes the door.
  await code('PUT', { code: 'k7qm-4x2p' }, u.key);
  assert.equal((await unlock('maple river 42')).status, 403);
  assert.equal((await unlock('K7QM4X2P')).status, 200);
  assert.deepEqual(await (await code('DELETE', null, u.key)).json(), { set: false });
  assert.equal((await unlock('k7qm-4x2p')).status, 403);
  // A copy doesn't carry the code.
  const copy = await (await api(`api/units/${u.id}/fork`, { method: 'POST', body: {} })).json();
  assert.equal((await unlock('k7qm-4x2p', copy.id)).status, 403);

  // Eight tries per address in fifteen minutes; then wait.
  let status = 0;
  for (let i = 0; i < 3 && status !== 429; i++) status = (await unlock(`guess${i}xx`)).status;
  assert.equal(status, 429);
});

test('suggestions: a copy suggests its layout back; the owner applies part of it, undoes, dismisses', async () => {
  const owner = await create({ from: 'example', title: 'Home' });
  const patch = (u, body) => api(`api/units/${u.id}`, { method: 'PATCH', key: u.key, body });
  await patch(owner, { upsert: [
    { uid: 'sofa0001', type: 'sofa', x: 30, z: 22, rot: 180 },
    { uid: 'side0001', type: 'sidetable', x: 35.5, z: 23.5 },
    { uid: 'lamp0001', type: 'table-lamp', x: 35.5, z: 23.5, y: 2, on: 'p:side0001' },
    { uid: 'chair001', type: 'chair', x: 33, z: 15 },
  ] });

  // A visitor makes their own version and rearranges it.
  const copy = await (await api(`api/units/${owner.id}/fork`, { method: 'POST', body: {} })).json();
  const mine = (path, method = 'GET', body) => api(`api/units/${copy.id}/${path}`, { method, key: copy.key, body });
  assert.deepEqual(await (await mine('suggestion')).json(), { to: { id: owner.id, title: 'Home', author: '' }, status: 'none', note: '', sentAt: null, sent: null, changes: 0 });
  assert.match((await (await mine('suggest', 'POST', {})).json()).error, /Nothing to suggest/);
  await patch(copy, { author: 'Sam', upsert: [
    { uid: 'side0001', type: 'sidetable', x: 33.5, z: 22.5 },
    { uid: 'lamp0001', type: 'table-lamp', x: 33.5, z: 22.5, y: 2, on: 'p:side0001' },
    { uid: 'plant001', type: 'plant', x: 25, z: 15 },
    { uid: 'sofa0001', type: 'sofa', x: 30, z: 21, rot: 180 },
  ], remove: ['chair001'] });
  // The owner moves the sofa too, meanwhile.
  await patch(owner, { upsert: [{ uid: 'sofa0001', type: 'sofa', x: 29, z: 22, rot: 180 }] });

  const sent = await (await mine('suggest', 'POST', { note: 'Lamp by the window, a plant' })).json();
  assert.deepEqual([sent.status, sent.sent, sent.changes, sent.note], ['open', 4, 4, 'Lamp by the window, a plant']);
  // Sending again updates the one suggestion.
  await mine('suggest', 'POST', { note: 'Lamp by the window, and a plant' });

  const list = (key = owner.key) => api(`api/units/${owner.id}/suggestions`, { key });
  assert.equal((await list('x'.repeat(28))).status, 403);
  const { suggestions } = await (await list()).json();
  assert.equal(suggestions.length, 1);
  const s = suggestions[0];
  assert.deepEqual([s.author, s.title, s.note, s.changes, s.from], ['Sam', 'Home (my version)', 'Lamp by the window, and a plant', 4, copy.id]);
  assert.ok(Array.isArray(s.base) && Array.isArray(s.items));

  // Take the side table (its lamp comes with it) and the plant; not the sofa, nor the chair's removal.
  const act = (what, body) => api(`api/units/${owner.id}/suggestions/${s.id}/${what}`, { method: 'POST', key: owner.key, body });
  const applied = await (await act('apply', { groups: ['side0001', 'plant001'] })).json();
  assert.equal(applied.applied, 2);
  const at = (doc, uid) => doc.items.find((i) => i.uid === uid);
  assert.deepEqual([at(applied.design, 'side0001').x, at(applied.design, 'lamp0001').x, at(applied.design, 'sofa0001').x], [33.5, 33.5, 29]);
  assert.ok(at(applied.design, 'plant001') && at(applied.design, 'chair001'));
  assert.equal((await (await list()).json()).suggestions.length, 0);
  assert.equal((await (await mine('suggestion')).json()).status, 'applied');
  assert.equal((await act('apply', { groups: ['side0001'] })).status, 409, 'not twice');

  // Undo puts the layout back and the suggestion back in the list.
  const undone = await (await act('undo')).json();
  assert.equal(at(undone.design, 'side0001').x, 35.5);
  assert.equal(at(undone.design, 'plant001'), undefined);
  assert.equal((await (await list()).json()).suggestions.length, 1);

  // Dismissed, it's gone; the copy sees that.
  assert.equal((await act('dismiss')).status, 200);
  assert.equal((await (await list()).json()).suggestions.length, 0);
  assert.equal((await (await mine('suggestion')).json()).status, 'dismissed');

  // A copy of the example has no one to suggest to.
  const fromExample = await create({ from: 'example' });
  assert.equal((await (await api(`api/units/${fromExample.id}/suggestion`, { key: fromExample.key })).json()).to, null);
  assert.equal((await api(`api/units/${fromExample.id}/suggest`, { method: 'POST', key: fromExample.key, body: {} })).status, 400);
});
