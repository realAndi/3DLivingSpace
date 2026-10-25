// 3D Living Space server: the app, its designs API, link-preview pictures and
// the MCP server, all under BASE_PATH. Listens on a port, or on a Unix socket
// when LISTEN is a path (the droplet's nginx proxies to that).
import { createServer } from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Designs } from './service.js';
import { createPages } from './pages.js';
import { createApi } from './api.js';
import { createMcp } from './mcp.js';
import { AppError, RateLimiter, clientIp, json, send } from './http.js';

const config = loadConfig();
const store = new Store(config.dataDir);
const designs = new Designs(store, config);
const limiters = {
  create: new RateLimiter(30, 60 * 60 * 1000),   // new designs and copies, per hour
  write: new RateLimiter(1500, 10 * 60 * 1000),  // saves and agent edits, per 10 minutes
  read: new RateLimiter(1200, 60 * 1000),        // views, polling and pictures, per minute
  mcp: new RateLimiter(900, 10 * 60 * 1000),
};
const handlers = [createApi(config, designs, limiters), createMcp(config, designs, limiters), createPages(config, designs)];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const base = config.basePath;
  if (base && url.pathname === base) {
    send(res, 301, '', { Location: `${base}/${url.search}` });
    return;
  }
  if (!url.pathname.startsWith(`${base}/`)) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    return;
  }
  let path;
  try { path = decodeURIComponent(url.pathname.slice(base.length + 1)); } catch { send(res, 400, 'Bad request'); return; }
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  const ctx = {
    req, res, method: req.method,
    path,
    query: url.searchParams,
    ip: clientIp(req),
    origin: config.publicUrl || `${proto}://${host}`,
  };
  try {
    if (ctx.path === 'healthz') { send(res, 200, 'ok', { 'Content-Type': 'text/plain' }); return; }
    for (const handle of handlers) if (await handle(ctx)) return;
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  } catch (error) {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof AppError) {
      json(res, error.status, { error: error.message }, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      return;
    }
    console.error(error);
    json(res, 500, { error: 'Something went wrong on the server.' });
  }
});

const socket = /^\d+$/.test(config.listen) ? null : config.listen;
if (socket) {
  // A socket left by a container that was killed would make listen fail.
  rmSync(socket, { force: true });
  server.listen(socket, () => {
    // nginx runs as another user and must be able to connect.
    chmodSync(socket, 0o666);
    console.log(`3D Living Space on ${socket} at ${config.basePath || '/'} (${store.count()} designs)`);
  });
} else {
  server.listen(Number(config.listen), () => console.log(`3D Living Space at http://localhost:${config.listen}${config.basePath}/`));
}

// One backup a day, seven kept.
const backup = () => { try { store.backup(); } catch (error) { console.error('backup failed', error); } };
setTimeout(backup, 60_000).unref();
setInterval(backup, 6 * 60 * 60 * 1000).unref();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      store.close();
      if (socket) rmSync(socket, { force: true });
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
