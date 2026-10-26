// The browser's API under api/:
//   POST  api/units               { from?: 'example' | '<id>', title?, author? } → a new unit you own:
//                                 empty, a copy of the example's unit, or a copy of a unit with its furniture
//   GET   api/units/:id           anyone (also 'example'); ?since=<version> answers 204 when unchanged
//   PATCH api/units/:id           X-Edit-Key: furniture, custom pieces, title, author (never the unit);
//                                 with baseVersion, the unit comes back if others wrote since
//   POST  api/units/:id/fork      anyone: a copy that you own
//   GET / PUT / DELETE api/units/:id/code   X-Edit-Key: whether an edit code is set; set { code }; remove it
//   POST  api/units/:id/unlock    { code } → the unit with its key, as if you owned it (rate-limited)
//   GET   api/units/:id/card.png  link-preview picture (1200 × 630)
//   GET   api/units/:id/plan.png  labeled plan, as the MCP server draws it
//   GET   api/card.png            the home page's preview: the example unit
import { json, readJson, send, limit, AppError } from './http.js';
import { cardSvg, detailSvg, png } from './render.js';
import { EXAMPLE_ID } from './service.js';

export function createApi(config, units, limiters) {
  const pictures = new Map();
  function picture(key, make) {
    if (!pictures.has(key)) {
      if (pictures.size > 80) pictures.delete(pictures.keys().next().value);
      pictures.set(key, make());
    }
    return pictures.get(key);
  }
  const sendPng = (ctx, buf) => send(ctx.res, 200, ctx.method === 'HEAD' ? '' : buf, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
  const owned = (row, key, origin) => ({ ...units.view(row, origin), key, editUrl: units.editUrl(row.id, key, origin), mcpUrl: units.mcpUrl(row.id, key, origin) });
  const body = async (ctx) => {
    const data = await readJson(ctx.req, config.bodyBytes);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError(400, 'The request body must be a JSON object.');
    return data;
  };
  const docOf = (row) => ({ title: row.title, author: row.author, unit: row.doc.unit, items: row.doc.items, assets: row.doc.assets });

  return async function handleApi(ctx) {
    if (!ctx.path.startsWith('api/')) return false;
    const { method, origin } = ctx;
    const parts = ctx.path.split('/').slice(1);
    const read = method === 'GET' || method === 'HEAD';

    if (parts[0] === 'card.png' && parts.length === 1 && read) {
      limit(limiters.read, ctx.ip);
      const row = units.get(EXAMPLE_ID);
      sendPng(ctx, picture('home', () => png(cardSvg(docOf(row), units.built(row), {
        headline: 'Your apartment, in 3D',
        tagline: 'Build it from your floor plan with Claude.',
      }))));
      return true;
    }
    if (parts[0] !== 'units') throw new AppError(404, 'No such API route.');

    if (parts.length === 1 && method === 'POST') {
      limit(limiters.create, ctx.ip, 'new units');
      const { from, title, author } = await body(ctx);
      const { row, key } = units.create({ from, title, author });
      json(ctx.res, 201, owned(row, key, origin));
      return true;
    }

    const id = parts[1];
    if (parts.length === 2 && method === 'GET') {
      limit(limiters.read, ctx.ip);
      const row = units.get(id);
      if (ctx.query.get('since') === String(row.version)) { send(ctx.res, 204, '', { 'Cache-Control': 'no-store' }); return true; }
      json(ctx.res, 200, units.view(row, origin));
      return true;
    }
    if (parts.length === 2 && method === 'PATCH') {
      limit(limiters.write, ctx.ip, 'changes');
      const key = ctx.req.headers['x-edit-key'];
      const change = await body(ctx);
      const row = units.patch(id, typeof key === 'string' ? key : '', change);
      // If someone else (an agent, another tab) wrote since the sender last
      // looked, send the whole unit back so it can catch up.
      const behind = Number.isInteger(change.baseVersion) && row.version !== change.baseVersion + 1;
      json(ctx.res, 200, { version: row.version, unitRev: row.doc.unitRev, updatedAt: row.updated_at, ...(behind ? { design: units.view(row, origin) } : {}) });
      return true;
    }
    if (parts.length === 3 && parts[2] === 'fork' && method === 'POST') {
      limit(limiters.create, ctx.ip, 'new units');
      const { title, author } = await body(ctx);
      const { row, key } = units.fork(id, { title, author });
      json(ctx.res, 201, owned(row, key, origin));
      return true;
    }
    // The edit code: the owner sets it, another device trades it for the key.
    if (parts.length === 3 && parts[2] === 'code' && ['GET', 'PUT', 'DELETE'].includes(method)) {
      limit(limiters.write, ctx.ip, 'changes');
      const key = typeof ctx.req.headers['x-edit-key'] === 'string' ? ctx.req.headers['x-edit-key'] : '';
      const set = method === 'GET' ? units.hasCode(id, key)
        : await units.setCode(id, key, method === 'DELETE' ? null : (await body(ctx)).code ?? '');
      json(ctx.res, 200, { set });
      return true;
    }
    if (parts.length === 3 && parts[2] === 'unlock' && method === 'POST') {
      // Few guesses per address, and few per unit from everywhere.
      limit(limiters.unlock, ctx.ip, 'code attempts');
      limit(limiters.unlockUnit, id, 'code attempts for this unit');
      const { code } = await body(ctx);
      const { row, key } = await units.unlock(id, typeof code === 'string' ? code : '');
      json(ctx.res, 200, owned(row, key, origin));
      return true;
    }
    if (parts.length === 3 && (parts[2] === 'card.png' || parts[2] === 'plan.png') && read) {
      limit(limiters.read, ctx.ip);
      const row = units.get(id);
      sendPng(ctx, picture(`${parts[2]}:${id}:${row.version}`, () => {
        const U = units.built(row);
        return png(parts[2] === 'card.png' ? cardSvg(docOf(row), U) : detailSvg(docOf(row), U));
      }));
      return true;
    }
    throw new AppError(404, 'No such API route.');
  };
}
