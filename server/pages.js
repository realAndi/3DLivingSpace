// The app's files, and its one page with link-preview tags filled in: a design's
// own title and plan picture on /d/<id>, so a shared link unfurls as that design.
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { send } from './http.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8',
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createPages(config, designs) {
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
    send(ctx.res, status, html, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
  }

  return async function handlePage(ctx) {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
    const base = `${ctx.origin}${config.basePath}`;
    if (ctx.path === '' || ctx.path === 'index.html') {
      await page(ctx, {
        title: '3D Living Space',
        description: 'Furnish a to-scale 3D model of a 2 bed, 2 bath apartment, then share your version. Works with AI agents through MCP.',
        url: `${base}/`, image: `${base}/api/card.png`,
      });
      return true;
    }
    const d = /^d\/([A-Za-z0-9]{8,16})\/?$/.exec(ctx.path);
    if (d) {
      let row = null;
      try { row = designs.get(d[1]); } catch { row = null; }
      if (!row) {
        await page(ctx, { title: 'Design not found · 3D Living Space', description: 'This design does not exist.', url: `${base}/`, image: `${base}/api/card.png` }, 404);
        return true;
      }
      const n = row.doc.items.length;
      await page(ctx, {
        title: `${row.title || 'An untitled design'} · 3D Living Space`,
        description: `${row.author ? `${row.author}'s` : 'A'} furnished version of a 2 bed, 2 bath apartment, ${n} piece${n === 1 ? '' : 's'}. Open it in 3D, then make your own.`,
        url: designs.viewUrl(row.id, ctx.origin),
        image: `${base}/api/designs/${row.id}/card.png?v=${row.version}`,
      });
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
