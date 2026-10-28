// A local stand-in for claude.ai's Artifact viewer, so the app can run as an
// Artifact in any browser (headless Chrome can't sign in to claude.ai):
//
//   node test/harness/server.mjs [--root <repo dir>] [--port 8791]
//     [--host 127.0.0.1|0.0.0.0] [--snapshot <unit.json>|none] [--rules <json file or inline JSON>|none]
//
// / serves the page the way the platform would: its fixed skeleton around
// artifactPage(index.html), index.html read fresh from --root on every load.
// A script at the end of the skeleton's <head> defines window.claude before
// any page script, with `db` and `user` backed by this server's in-memory
// store (store.mjs), so reloads keep data and tabs share it.
//
// Who is viewing comes from the page's query: ?as=owner|editor|contributor|
// viewer|outside|signedout, &uid=u_... (default: one per role), &delay=<ms>
// before use() resolves (300), &nocap=1 for no window.claude at all.
//
// Test hooks: POST /__db/write (as the owner, the way Claude writes through
// ArtifactData), GET /__db/dump, POST /__db/reset, GET|POST /__db/rules.
// See test/harness/README.md.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store, DbError, splitPath, atLeast } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

// The rules the app publishes with (see the plan): everyone reads shared
// data, editors write it; each viewer keeps their own version under
// data/users/<id>; suggestions/<id> is the suggester's, and editors read all.
export const APP_RULES = [
  { path: '', read: 'view', write: 'admin' },
  { path: 'data/users/{self}', write: 'interact' },
  { path: 'suggestions', read: 'admin', write: 'admin' },
  { path: 'suggestions/{self}', read: 'interact', write: 'interact' },
];

// Share-menu roles and the db level each holds. Owner is the artifact's own
// owner; an Editor holds admin; outside is a signed-in visitor from another
// organization (view, and can() says nothing).
export const ROLES = {
  owner: { level: 'owner', uid: 'u_owner' },
  editor: { level: 'admin', uid: 'u_editor' },
  contributor: { level: 'interact', uid: 'u_contrib' },
  viewer: { level: 'view', uid: 'u_viewer' },
  outside: { level: 'view', uid: 'u_outside', outside: true },
  signedout: { level: 'none', uid: null },
};
const NAMES = { u_owner: 'Sam', u_editor: 'Riley', u_contrib: 'Jo', u_viewer: 'Alex', u_outside: 'Casey' };
const MORE_NAMES = ['Morgan', 'Taylor', 'Jamie', 'Drew', 'Quinn', 'Avery', 'Rowan', 'Kai', 'Noor', 'Mika', 'Robin', 'Ari'];
const COLORS = ['#c2410c', '#0f766e', '#7c3aed', '#be185d', '#1d4ed8', '#4d7c0f', '#b45309', '#0e7490'];
const NEUTRAL = '#8a857d';

// The platform's page skeleton, verbatim; the mock goes at the end of <head>.
export const SKELETON_HEAD = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>';
export const SKELETON_BODY = '</head><body>';
export const SKELETON_END = '</body></html>';

// A page of the harness's own, for checking the mock without the app.
const BLANK = '<h1>Harness</h1><p id="out"></p><script>window.__early = { claude: typeof window.claude, use: typeof window.claude?.use };</script>';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8',
};
// Textures the Artifact ships (mirrors TEXTURE_SIZES in skill/3d-living-space/scripts/app.mjs).
const PUBLISHED_TEXTURES = /^assets\/tex\/(512|1024)\/[^/]+\.webp$/;

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const nameOf = (uid) => NAMES[uid] ?? MORE_NAMES[hash(uid) % MORE_NAMES.length];
const colorOf = (uid) => COLORS[hash(uid) % COLORS.length];
const svgUrl = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const avatarOf = (name, color) => svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${color}"/><text x="20" y="26" font-family="sans-serif" font-size="17" text-anchor="middle" fill="#fff">${name[0]}</text></svg>`);
const GENERIC_AVATAR = svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${NEUTRAL}"/><circle cx="20" cy="16" r="7" fill="#fff"/><path d="M8 34c2-7 7-10 12-10s10 3 12 10" fill="#fff"/></svg>`);

// Who is asking, from a page's query or a call's headers. Throws a message
// for anything else, which the routes turn into a 400.
export function identify(as, uid) {
  const role = as || 'owner';
  if (!Object.hasOwn(ROLES, role)) throw new Error(`Unknown role "${role}"; use ${Object.keys(ROLES).join(', ')}.`);
  const base = ROLES[role];
  let id = base.uid;
  if (uid && role !== 'signedout') {
    try { splitPath(uid); } catch { throw new Error(`uid "${uid}" is not a valid path segment.`); }
    if (uid.includes('/')) throw new Error('uid is one path segment.');
    id = uid;
  }
  return { role, level: base.level, uid: id, outside: !!base.outside };
}

export async function startHarness({ root = REPO, port = 8791, host = '127.0.0.1', snapshot, rules = APP_RULES, quiet = false } = {}) {
  root = resolve(root);
  if (snapshot && snapshot !== 'none') snapshot = resolve(snapshot);
  const say = quiet ? () => {} : (...a) => console.log(...a);
  const store = new Store({ rules });
  const seen = new Map(Object.entries(ROLES).filter(([, r]) => r.uid).map(([role, r]) => [r.uid, role])); // uid -> role, for profiles
  const streams = new Set();
  const unpublished = new Set();

  // The app's own helpers, from --root, re-imported when they change.
  const fresh = async (rel) => {
    const file = existsSync(join(root, rel)) ? join(root, rel) : join(REPO, rel);
    return import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
  };
  let published = new Set();
  async function renderApp() {
    const app = await fresh('skill/3d-living-space/scripts/app.mjs');
    published = new Set(app.moduleGraph(root));
    return app.artifactPage(readFileSync(join(root, 'index.html'), 'utf8'));
  }

  // unit.json: the bundle's snapshot, first paint for everyone.
  let defaultSnapshot = null;
  if (snapshot === undefined) {
    const { EXAMPLE_TITLE, EXAMPLE_UNIT } = await fresh('src/example.js');
    const { cleanUnit } = await fresh('src/unit.js');
    defaultSnapshot = JSON.stringify({ title: EXAMPLE_TITLE, author: '', unit: cleanUnit(EXAMPLE_UNIT).unit, unitRev: 1, items: [], assets: [], savedAt: new Date().toISOString() });
  }

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const json = (res, status, data) => send(res, status, JSON.stringify(data));
  const readJson = async (req) => {
    let s = '';
    for await (const c of req) s += c;
    return s ? JSON.parse(s) : {};
  };
  const asError = (e) => (e instanceof DbError ? e.toJSON() : { code: 'invalid_argument', message: e.message });

  function pageConfig(url) {
    const p = url.searchParams;
    const who = identify(p.get('as'), p.get('uid'));
    if (who.uid) seen.set(who.uid, who.role);
    const delay = Math.max(0, Math.min(60000, Number(p.get('delay') ?? 300) || 0));
    const signedIn = who.level !== 'none';
    const name = who.uid ? nameOf(who.uid) : '';
    const color = who.uid ? colorOf(who.uid) : NEUTRAL;
    return {
      ...who, delay, nocap: p.get('nocap') === '1',
      // Fixed for the life of a view; null when the platform says nothing.
      can: !signedIn || who.outside ? null : {
        'data.write': store.canWriteShared(who),
        'files.write': atLeast(who.level, 'admin'),
        'assets.write': atLeast(who.level, 'admin'),
        'people.add': atLeast(who.level, 'admin'),
      },
      me: {
        id: who.uid, name, avatarUrl: who.uid ? avatarOf(name, color) : GENERIC_AVATAR, color, email: null,
        isOwner: who.level === 'owner', canEdit: atLeast(who.level, 'admin'),
      },
      // search() is [] for anyone who can neither edit nor comment, or from outside.
      searchable: atLeast(who.level, 'interact') && !who.outside,
      // room.canSendToClaudeSession(): &ask=available|no_session|off (default available).
      ask: p.get('ask') ?? 'available',
      // use("sample"): &sample=on (default: a scripted Claude, see client.mjs) | off.
      sample: p.get('sample') !== 'off' && signedIn,
      genericAvatar: GENERIC_AVATAR, neutralColor: NEUTRAL,
    };
  }

  // The script at the end of the skeleton's <head>: window.claude before any
  // page script; each use() resolves after the delay, never synchronously.
  function mockScript(config) {
    const data = JSON.stringify(config).replace(/</g, '\\u003c');
    return `<script>(() => {
const config = ${data};
window.__mock = { role: config.role, level: config.level, uid: config.uid, log: [] };
if (config.nocap) return;
const served = { db: config.level !== 'none', user: true, room: config.level !== 'none' && !config.outside, sample: !!config.sample };
const memo = {};
let mod;
const after = (ms) => new Promise((r) => setTimeout(r, ms));
function use(name) {
  const key = String(name);
  if (!Object.hasOwn(served, key) || !served[key]) return after(config.delay).then(() => null);
  mod ??= import('/__harness/client.mjs');
  return memo[key] ??= Promise.all([mod, after(config.delay)]).then(([m]) => m.namespace(key, config), (e) => { console.error('harness: the mock capability failed to load', e); return null; });
}
window.claude = Object.freeze({ use });
})();</script>`;
  }

  function page(res, url, body) {
    let config;
    try { config = pageConfig(url); } catch (e) { return send(res, 400, e.message, 'text/plain; charset=utf-8'); }
    // &premodule=1: a module loaded before the page's own scripts, as a viewer's
    // runtime might, after which browsers may ignore the page's import map.
    const pre = url.searchParams.get('premodule') === '1' ? '<script type="module">import(\'data:text/javascript,export default 1\');</script>' : '';
    send(res, 200, SKELETON_HEAD + pre + mockScript(config) + SKELETON_BODY + body + SKELETON_END, TYPES['.html']);
  }

  function serveFile(res, base, rel) {
    const file = resolve(base, rel);
    if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
  }

  // A call from a page's db namespace.
  function dbCall(who, { op, path, data, query, options }) {
    switch (op) {
      case 'get': { const d = store.get(path, who); return { exists: d.exists, data: d.data ?? null, at: store.seq }; }
      case 'list': return { docs: store.query(path, query ?? {}, who).map((d) => ({ id: d.id, path: d.path, data: d.data })), at: store.seq };
      case 'set': case 'update': { const r = store[op](path, data, who); return { seq: r.seq, exists: true, data: r.data }; }
      case 'delete': return { seq: store.delete(path, who).seq, exists: false, data: null };
      case 'acquire': return store.acquire(path, options ?? {}, who);
      default: throw new DbError('invalid_argument', `Unknown call "${op}".`);
    }
  }

  // One hook write: { op, path, data, as?, uid?, ifVersion? }, as the owner by default.
  function hookWrite({ op, path, data, as, uid, ifVersion }) {
    const who = as ? identify(as, uid) : identify('owner');
    if (ifVersion !== undefined) {
      const now = store.get(path, who).version;
      if (now !== ifVersion) throw new DbError('version_mismatch', `${path} is at version ${now}, not ${ifVersion}.`);
    }
    if (!['set', 'update', 'delete'].includes(op)) throw new DbError('invalid_argument', 'op is set, update or delete.');
    const r = op === 'delete' ? store.delete(path, who) : store[op](path, data, who);
    return { path, version: r.version, seq: r.seq };
  }

  function profileOut(uid) {
    const name = nameOf(uid), color = colorOf(uid);
    return { id: uid, name, color, avatarUrl: avatarOf(name, color), guest: seen.get(uid) === 'outside' };
  }

  // The room: who has a page open now, with their presence, kept only while
  // their stream is open; and what pages handed to Claude (sendToClaudeSession).
  const peers = new Map();   // peer → { peer, by, guest, presence, updatedAt, res }
  const sentToClaude = [];
  const peersOut = () => [...peers.values()].map(({ res: _, ...p }) => p);
  const roomBroadcast = () => { const data = JSON.stringify(peersOut()); for (const p of peers.values()) p.res.write(`event: peers\ndata: ${data}\n\n`); };
  function roomLive(req, res, url) {
    let who;
    try { who = identify(url.searchParams.get('as'), url.searchParams.get('uid')); } catch (e) { return send(res, 400, e.message, 'text/plain'); }
    const peer = String(url.searchParams.get('peer') ?? '');
    if (who.level === 'none' || !/^[a-z0-9]{8,32}$/.test(peer)) return send(res, 403, 'No room for this viewer.', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    peers.set(peer, { peer, by: who.uid, guest: !!who.outside, presence: peers.get(peer)?.presence ?? {}, updatedAt: Date.now(), res });
    roomBroadcast();
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); if (peers.get(peer)?.res === res) { peers.delete(peer); roomBroadcast(); } });
  }

  // Changes reach a page only if its viewer may read them.
  function live(req, res, url) {
    let who;
    try { who = identify(url.searchParams.get('as'), url.searchParams.get('uid')); } catch (e) { return send(res, 400, e.message, 'text/plain'); }
    if (who.level === 'none') return send(res, 403, 'No db for a signed-out visitor.', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`retry: 1000\n: at ${store.seq}\n\n`);
    const off = store.subscribe((c) => {
      if (!store.canRead(c.path, who)) return;
      res.write(`event: change\ndata: ${JSON.stringify({ path: c.path, seq: c.seq, exists: c.exists, data: c.data ?? null })}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    const stream = { res, end: () => { off(); clearInterval(ping); streams.delete(stream); } };
    streams.add(stream);
    req.on('close', stream.end);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://harness');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad path', 'text/plain'); }
    const get = req.method === 'GET' || req.method === 'HEAD';
    const post = req.method === 'POST';

    if (get && (p === '/' || p === '/index.html')) {
      let body;
      try { body = await renderApp(); } catch (e) { return send(res, 500, `Could not build the page: ${e.stack}`, 'text/plain; charset=utf-8'); }
      return page(res, url, body);
    }
    if (get && p === '/__harness/blank') return page(res, url, BLANK);
    // The viewer around a real Artifact has its own icon; don't log a 404 for it.
    if (get && p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (get && (p === '/__harness/client.mjs' || p === '/__harness/store.mjs')) return serveFile(res, HERE, p.slice('/__harness/'.length));
    if (get && p === '/__harness/unpublished') return json(res, 200, [...unpublished].sort());
    if (get && p === '/unit.json') {
      if (snapshot === 'none') return send(res, 404, 'No snapshot', 'text/plain');
      if (!snapshot) return send(res, 200, defaultSnapshot);
      if (!existsSync(snapshot)) return send(res, 404, `No file at ${snapshot}`, 'text/plain');
      return send(res, 200, readFileSync(snapshot));
    }
    if (get && (p.startsWith('/src/') || p.startsWith('/assets/'))) {
      // Served whatever it is, so edits are live; but a file the Artifact
      // wouldn't ship gets named, since it would 404 there.
      const rel = p.slice(1);
      if (!published.has(rel) && !PUBLISHED_TEXTURES.test(rel) && !unpublished.has(rel) && existsSync(join(root, rel))) {
        unpublished.add(rel);
        say(`! ${rel} is not one of the Artifact's files (it would 404 there)`);
      }
      // A module goes out as the Artifact ships it: three.js by absolute URL.
      if (rel.startsWith('src/') && rel.endsWith('.js') && existsSync(join(root, rel))) {
        const app = await fresh('skill/3d-living-space/scripts/app.mjs');
        return send(res, 200, app.absoluteThree(readFileSync(join(root, rel), 'utf8'), app.threeBase(readFileSync(join(root, 'index.html'), 'utf8'))), TYPES['.js']);
      }
      return serveFile(res, root, rel);
    }

    if (p === '/__db/live' && get) return live(req, res, url);
    if (p === '/__room/live' && get) return roomLive(req, res, url);
    if (p === '/__room/presence' && post) {
      const { peer, presence } = await readJson(req);
      const p0 = peers.get(peer);
      if (p0 && presence && typeof presence === 'object') { p0.presence = presence; p0.updatedAt = Date.now(); roomBroadcast(); }
      return json(res, 200, { ok: !!p0 });
    }
    if (p === '/__room/send' && post) { const body = await readJson(req); sentToClaude.push(body); say(`  handed to Claude: ${JSON.stringify(body.data).slice(0, 160)}`); return json(res, 200, { to: 'pane' }); }
    if (p === '/__room/sent' && get) return json(res, 200, sentToClaude);
    if (p === '/__db/call' && post) {
      let who, body;
      try { who = identify(req.headers['x-harness-as'], req.headers['x-harness-uid']); body = await readJson(req); } catch (e) { return json(res, 400, { error: { code: 'invalid_argument', message: e.message } }); }
      if (who.level === 'none') return json(res, 200, { error: { code: 'not_granted', message: 'No db for a signed-out visitor.' } });
      if (who.uid) seen.set(who.uid, who.role);
      try {
        const result = dbCall(who, body);
        if (['set', 'update', 'delete'].includes(body.op)) say(`  ${who.role} (${who.uid}) ${body.op} ${body.path}`);
        return json(res, 200, { result });
      } catch (e) {
        if (['set', 'update', 'delete'].includes(body.op)) say(`  ${who.role} (${who.uid}) ${body.op} ${body.path}: ${e.code ?? 'error'}`);
        return json(res, 200, { error: asError(e) });
      }
    }
    if (p === '/__db/write' && post) {
      try {
        const body = await readJson(req);
        const out = Array.isArray(body) ? body.map(hookWrite) : hookWrite(body);
        return json(res, 200, Array.isArray(out) ? out : { ok: true, ...out });
      } catch (e) { return json(res, e.code === 'version_mismatch' ? 409 : 400, { error: asError(e) }); }
    }
    if (p === '/__db/dump' && get) return json(res, 200, store.dump());
    if (p === '/__db/reset' && post) { store.reset(); return json(res, 200, { ok: true }); }
    // A connectivity gap: every page's live stream ends; they reconnect in a second.
    if (p === '/__db/drop' && post) {
      const n = streams.size;
      for (const s of [...streams]) { s.end(); s.res.end(); }
      return json(res, 200, { ok: true, dropped: n });
    }
    if (p === '/__db/rules') {
      if (get) return json(res, 200, store.rules);
      if (post) {
        try { store.setRules(await readJson(req)); return json(res, 200, store.rules); } catch (e) { return json(res, 400, { error: asError(e) }); }
      }
    }
    if (p === '/__user/profiles' && post) {
      let who, ids;
      try { who = identify(req.headers['x-harness-as'], req.headers['x-harness-uid']); ({ ids } = await readJson(req)); } catch (e) { return json(res, 400, { error: { code: 'invalid_argument', message: e.message } }); }
      // Signed out: nobody resolves. Otherwise anyone the harness has met.
      const result = {};
      if (who.level !== 'none') for (const id of Array.isArray(ids) ? ids : []) if (seen.has(id)) result[id] = profileOut(id);
      return json(res, 200, { result });
    }
    if (p === '/__user/search' && post) {
      let q;
      try { ({ q } = await readJson(req)); } catch { q = ''; }
      const needle = String(q ?? '').toLowerCase();
      const hits = [...seen.keys()].map(profileOut).filter((x) => x.name.toLowerCase().includes(needle))
        .sort((a, b) => a.name.toLowerCase().indexOf(needle) - b.name.toLowerCase().indexOf(needle) || a.name.localeCompare(b.name)).slice(0, 8);
      return json(res, 200, { result: hits });
    }
    send(res, 404, 'Not found', 'text/plain');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, String(e.stack ?? e), 'text/plain'); else res.end(); });
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  const actual = server.address().port;
  const local = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${actual}`;
  return {
    server, store, port: actual, url: local,
    urls: host === '0.0.0.0' || host === '::' ? [local, ...reachable(actual)] : [local],
    unpublished: () => [...unpublished].sort(),
    async close() {
      for (const s of [...streams]) { s.end(); s.res.end(); }
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

// Other addresses this machine answers on: its Tailscale name, then IPv4s.
function reachable(port) {
  const out = [];
  try {
    const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const dns = status?.Self?.DNSName?.replace(/\.$/, '');
    if (dns) out.push(`http://${dns}:${port}`);
  } catch { /* no Tailscale CLI */ }
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    const take = () => { i++; if (value === undefined) throw new Error(`${flag} needs a value`); return value; };
    if (flag === '--root') opts.root = take();
    else if (flag === '--port') opts.port = Number(take());
    else if (flag === '--host') opts.host = take();
    else if (flag === '--snapshot') opts.snapshot = take();
    else if (flag === '--rules') {
      const v = take();
      opts.rules = v === 'none' ? [] : JSON.parse(v.trim().startsWith('[') ? v : readFileSync(v, 'utf8'));
    } else if (flag === '--quiet') opts.quiet = true;
    else if (flag === '-h' || flag === '--help') {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
      console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    }
    else throw new Error(`Unknown flag ${flag}`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let h;
  try { h = await startHarness(parseArgs(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(1); }
  console.log('3D Living Space, as an Artifact (local harness)');
  for (const base of h.urls) console.log(`  ${base}/`);
  console.log(`\nAs whom (append to the URL): ${Object.keys(ROLES).map((r) => `?as=${r}`).join('  ')}`);
  console.log('  &uid=u_... another person in that role   &delay=<ms> before use() resolves   &nocap=1 no window.claude');
  console.log(`Rules: ${JSON.stringify(h.store.rules)}`);
  console.log(`Hooks: POST ${h.url}/__db/write  GET ${h.url}/__db/dump  POST ${h.url}/__db/reset\n`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => h.close().then(() => process.exit(0)));
}
