// End-to-end: start the server on a scratch database, then use the API and the
// MCP tools the way the browser and an agent do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 18000 + Math.floor(Math.random() * 1000);
const B = `http://localhost:${port}/3DLivingSpace`;
const dataDir = mkdtempSync(join(tmpdir(), '3dls-'));
let server;

before(async () => {
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

async function mcp(method, params = {}) {
  const res = await fetch(`${B}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).result;
}
const call = async (name, args = {}) => {
  const r = await mcp('tools/call', { name, arguments: args });
  return { ...r, data: r.content[0].type === 'text' ? JSON.parse(r.content[0].text.startsWith('{') ? r.content[0].text : 'null') : null, text: r.content.find((c) => c.type === 'text')?.text };
};

test('designs: create, read, change with the key only, poll, copy', async () => {
  const res = await api('api/designs', { method: 'POST', body: { title: 'Mine', items: [{ type: 'sofa', x: 30, z: 14 }] } });
  assert.equal(res.status, 201);
  const d = await res.json();
  assert.match(d.editUrl, /\/d\/\w+#edit=\w+$/);
  assert.equal(d.items.length, 1);

  const wrong = await api(`api/designs/${d.id}`, { method: 'PATCH', key: 'x'.repeat(28), body: { remove: [d.items[0].uid] } });
  assert.equal(wrong.status, 403);

  const ok = await api(`api/designs/${d.id}`, { method: 'PATCH', key: d.key, body: { title: 'Mine, v2', upsert: [{ uid: 'bed00001', type: 'bed-queen', x: 30.13, z: 4.32 }] } });
  assert.equal(ok.status, 200);
  const { version } = await ok.json();
  assert.equal(version, 2);

  assert.equal((await api(`api/designs/${d.id}?since=2`)).status, 204);
  const read = await (await api(`api/designs/${d.id}?since=1`)).json();
  assert.equal(read.title, 'Mine, v2');
  assert.equal(read.items.length, 2);
  assert.equal(read.key, undefined, 'the key never comes back from a read');

  const bad = await api(`api/designs/${d.id}`, { method: 'PATCH', key: d.key, body: { upsert: [{ type: 'spaceship', x: 1, z: 1 }] } });
  assert.equal(bad.status, 400);

  const copy = await (await api(`api/designs/${d.id}/fork`, { method: 'POST', body: {} })).json();
  assert.notEqual(copy.id, d.id);
  assert.equal(copy.items.length, 2);
  assert.equal(copy.forkedFrom, d.id);
});

test('pages and pictures', async () => {
  const d = await (await api('api/designs', { method: 'POST', body: { title: 'Cozy <corner>', author: 'Sam' } })).json();
  const html = await (await fetch(`${B}/d/${d.id}`)).text();
  assert.match(html, /<base href="\/3DLivingSpace\/">/);
  assert.match(html, /og:title" content="Cozy &lt;corner&gt; · 3D Living Space"/);
  assert.match(html, new RegExp(`api/designs/${d.id}/card.png\\?v=1`));
  assert.equal((await fetch(`${B}/d/nope12345`)).status, 404);
  const png = Buffer.from(await (await fetch(`${B}/api/designs/${d.id}/card.png`)).arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal((await fetch(`${B}/src/main.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${B}/src/../server/index.js`)).status, 404);
});

test('MCP: an agent furnishes a design', async () => {
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.serverInfo.name, '3d-living-space');
  const tools = (await mcp('tools/list')).tools.map((t) => t.name);
  for (const t of ['get_apartment', 'get_catalog', 'create_design', 'get_design', 'place_items', 'update_items', 'remove_items', 'create_asset', 'find_spots', 'check_design', 'render_plan', 'set_design_info']) assert.ok(tools.includes(t), t);

  const apt = (await call('get_apartment')).data;
  assert.equal(apt.units, 'inches');
  assert.ok(apt.rooms.find((r) => r.id === 'primary'));

  const made = (await call('create_design', { title: 'Agent made', author: 'Claude' })).data;
  const ref = made.edit_url;

  const denied = await call('place_items', { design: made.view_url, items: [{ type: 'sofa', x: 372, z: 168 }] });
  assert.equal(denied.isError, true);

  const spots = (await call('find_spots', { design: ref, width: 64, depth: 86, room: 'primary' })).data.spots;
  assert.ok(spots.length > 0);
  const placed = (await call('place_items', { design: ref, items: [{ type: 'bed-queen', x: spots[0].x, z: spots[0].z, rotation: spots[0].rotation }, { type: 'sofa', x: 10, z: 10 }] })).data;
  assert.equal(placed.placed.length, 2);
  assert.ok(placed.problems.some((p) => p.name === 'Sofa'), 'a sofa dropped into the corner walls is flagged');

  const asset = (await call('create_asset', { design: ref, name: 'Bar stool', parts: [
    { shape: 'cylinder', size: [14, 1.5, 14], at: [0, 29, 0], color: '#8a6a4a', finish: 'wood' },
    { shape: 'cylinder', size: [2, 28, 2], at: [0, 14, 0], color: '#222222', finish: 'metal' },
  ] })).data;
  assert.equal(asset.height, 29.75);
  const stool = (await call('place_items', { design: ref, items: [{ type: asset.place_as, x: 300, z: 220 }] })).data.placed[0];
  assert.equal(stool.type, `asset:${asset.asset_id}`);

  await call('update_items', { design: ref, items: [{ id: stool.id, x: 310, rotation: 45 }] });
  const check = (await call('check_design', { design: ref })).data;
  assert.equal(check.pieces.length, 3);

  const pic = await call('render_plan', { design: ref });
  assert.equal(pic.content[0].type, 'image');

  const removed = (await call('remove_items', { design: ref, ids: [stool.id] })).data;
  assert.equal(removed.remaining, 2);
  const got = (await call('get_design', { design: made.view_url })).data;
  assert.equal(got.items.length, 2);
  assert.equal(got.assets.length, 1);
});
