// The browser's API under api/:
//   POST  api/designs              a new design → { id, key, ... }
//   GET   api/designs/:id          anyone; ?since=<version> answers 204 when unchanged
//   PATCH api/designs/:id          X-Edit-Key: pieces to add or change, uids to remove;
//                                  with baseVersion, the design comes back if others wrote since
//   POST  api/designs/:id/fork     anyone: a copy of the design that you own
//   GET   api/designs/:id/card.png link-preview picture (1200 × 630)
//   GET   api/designs/:id/plan.png labeled plan, as the MCP server draws it
//   GET   api/card.png             the preview for the empty apartment
import { json, readJson, send, limit, AppError } from './http.js';
import { cardSvg, detailSvg, png } from './render.js';

export function createApi(config, designs, limiters) {
  const pictures = new Map();
  function picture(key, make) {
    if (!pictures.has(key)) {
      if (pictures.size > 80) pictures.delete(pictures.keys().next().value);
      pictures.set(key, make());
    }
    return pictures.get(key);
  }
  const sendPng = (ctx, buf) => send(ctx.res, 200, ctx.method === 'HEAD' ? '' : buf, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
  const owned = (row, key, origin) => ({ ...designs.view(row, origin), key, editUrl: designs.editUrl(row.id, key, origin) });

  return async function handleApi(ctx) {
    if (!ctx.path.startsWith('api/')) return false;
    const { method, origin } = ctx;
    const parts = ctx.path.split('/').slice(1);

    if (parts[0] === 'card.png' && parts.length === 1 && method === 'GET') {
      limit(limiters.read, ctx.ip);
      sendPng(ctx, picture('empty', () => png(cardSvg({ title: 'Make your own version', items: [] }))));
      return true;
    }
    if (parts[0] !== 'designs') return false;

    if (parts.length === 1 && method === 'POST') {
      limit(limiters.create, ctx.ip, 'new designs');
      const body = await readJson(ctx.req, config.bodyBytes);
      const { row, key } = designs.create(body);
      json(ctx.res, 201, owned(row, key, origin));
      return true;
    }

    const id = parts[1];
    if (parts.length === 2 && method === 'GET') {
      limit(limiters.read, ctx.ip);
      const row = designs.get(id);
      if (ctx.query.get('since') === String(row.version)) { send(ctx.res, 204, '', { 'Cache-Control': 'no-store' }); return true; }
      json(ctx.res, 200, designs.view(row, origin));
      return true;
    }
    if (parts.length === 2 && method === 'PATCH') {
      limit(limiters.write, ctx.ip, 'changes');
      const key = ctx.req.headers['x-edit-key'];
      const body = await readJson(ctx.req, config.bodyBytes);
      const row = designs.patch(id, typeof key === 'string' ? key : '', body);
      // If someone else (an agent, another tab) wrote since the sender last
      // looked, send the whole design back so it can catch up.
      const behind = Number.isInteger(body.baseVersion) && row.version !== body.baseVersion + 1;
      json(ctx.res, 200, { version: row.version, updatedAt: row.updated_at, ...(behind ? { design: designs.view(row, origin) } : {}) });
      return true;
    }
    if (parts.length === 3 && parts[2] === 'fork' && method === 'POST') {
      limit(limiters.create, ctx.ip, 'new designs');
      const body = await readJson(ctx.req, config.bodyBytes);
      const { row, key } = designs.fork(id, { title: body.title, author: body.author });
      json(ctx.res, 201, owned(row, key, origin));
      return true;
    }
    if (parts.length === 3 && (parts[2] === 'card.png' || parts[2] === 'plan.png') && (method === 'GET' || method === 'HEAD')) {
      limit(limiters.read, ctx.ip);
      const row = designs.get(id);
      const doc = { title: row.title, author: row.author, items: row.doc.items, assets: row.doc.assets };
      sendPng(ctx, picture(`${parts[2]}:${id}:${row.version}`, () => png(parts[2] === 'card.png' ? cardSvg(doc) : detailSvg(doc))));
      return true;
    }
    throw new AppError(404, 'No such API route.');
  };
}
