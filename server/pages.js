// The app's files, and its one page with link-preview tags filled in: the
// home page, and each unit's own title, summary and card on /u/<id>, so a
// shared link unfurls as that unit.
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { send } from './http.js';
import { facts } from './render.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8',
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createPages(config, units) {
  const indexPath = join(config.root, 'index.html');
  let cached = null;
  async function template() {
    const s = await stat(indexPath);
    if (!cached || cached.mtime !== s.mtimeMs) cached = { mtime: s.mtimeMs, text: await readFile(indexPath, 'utf8') };
    return cached.text;
  }

  function metaTags({ title, description, url, image }) {
    return [
      `<title>${esc(title)}</title>`,
      `<meta name="description" content="${esc(description)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="3D Living Space">`,
      `<meta property="og:title" content="${esc(title)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      `<meta property="og:image" content="${esc(image)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ].join('\n');
  }

  async function page(ctx, meta, status = 200) {
    const html = (await template())
      .replace('<!--base-->', `<base href="${esc(config.basePath)}/">`)
      .replace(/<!--meta-->[\s\S]*?<!--\/meta-->/, metaTags(meta));
    send(ctx.res, status, ctx.method === 'HEAD' ? '' : html, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
  }

  return async function handlePage(ctx) {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
    const base = `${ctx.origin}${config.basePath}`;
    if (ctx.path === '' || ctx.path === 'index.html') {
      await page(ctx, {
        title: '3D Living Space',
        description: 'Turn your floor plan into a to-scale 3D model of your apartment with Claude, furnish it, and share it so anyone can make their own version.',
        url: `${base}/`, image: `${base}/api/card.png`,
      });
      return true;
    }
    const u = /^u\/([A-Za-z0-9]{1,32})\/?$/.exec(ctx.path);
    if (u) {
      let row = null;
      try { row = units.get(u[1]); } catch { row = null; }
      if (!row) {
        await page(ctx, { title: 'Unit not found · 3D Living Space', description: 'This unit does not exist.', url: `${base}/`, image: `${base}/api/card.png` }, 404);
        return true;
      }
      const spec = row.doc.unit;
      const about = spec.rooms.length ? facts(spec, row.doc.items).join(', ') : 'not built yet';
      await page(ctx, {
        title: `${row.title || spec.name || 'An untitled unit'} · 3D Living Space`,
        description: `${row.author ? `${row.author}'s` : 'An'} apartment in 3D (${about}). Walk through it, then make your own version.`,
        url: units.viewUrl(row.id, ctx.origin),
        image: `${base}/api/units/${row.id}/card.png?v=${row.version}`,
      });
      return true;
    }
    // Links to designs from before units: those are units now, with the same ids
    // (the browser keeps the #edit= part across the redirect).
    const d = /^d\/([A-Za-z0-9]{8,16})\/?$/.exec(ctx.path);
    if (d) {
      send(ctx.res, 301, '', { Location: `${config.basePath}/u/${d[1]}` });
      return true;
    }
    if (/^(src\/[\w.-]+\.js|assets\/[\w./-]+)$/.test(ctx.path)) {
      const file = normalize(join(config.root, ctx.path));
      if (!file.startsWith(config.root.replace(/\/?$/, sep)) || file.includes(`${sep}..`)) return false;
      let s;
      try { s = await stat(file); } catch { return false; }
      if (!s.isFile()) return false;
      const etag = `"${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}"`;
      if (ctx.req.headers['if-none-match'] === etag) { send(ctx.res, 304, '', { ETag: etag, 'Cache-Control': 'no-cache' }); return true; }
      send(ctx.res, 200, ctx.method === 'HEAD' ? '' : await readFile(file), {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache',
      });
      return true;
    }
    return false;
  };
}
