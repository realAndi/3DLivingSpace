// The app and one unit in a single HTML file, for where there is no Artifact to
// publish to (claude.ai chat, the API): the person downloads it and opens it in
// a browser. It is the Artifact's page (app.mjs) with its files folded in: each
// module becomes a data: URL in the import map, under a bare name so the
// modules still find each other; the textures and the snapshot ride along as
// globals that src/textures.js and src/claude-store.js look for. Only three.js
// and the fonts still come from the network.
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { moduleGraph, artifactPage, pageTitle } from './app.mjs';

const NAME = 'living-space/';  // the bare prefix the modules are mapped under
const IMPORT = /((?:^|[;\s])(?:import|export)\s[^'"`;]*?from\s*)(['"])(\.{1,2}\/[^'"]+)\2|((?:^|[;\s])import\s*)(['"])(\.{1,2}\/[^'"]+)\5|(import\(\s*)(['"])(\.{1,2}\/[^'"]+)\8(\s*\))/gm;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// A module's relative imports, as the bare names the import map knows.
function rewrite(code, rel) {
  const to = (spec) => NAME + posix.normalize(posix.join(posix.dirname(rel), spec));
  return code.replace(IMPORT, (_, a, q1, s1, b, q2, s2, c, q3, s3, d) => (s1 ? `${a}${q1}${to(s1)}${q1}`
    : s2 ? `${b}${q2}${to(s2)}${q2}` : `${c}${q3}${to(s3)}${q3}${d}`));
}

// root holds the site's index.html, src/ and assets/ (a checkout), or the
// Artifact's files already assembled (a packaged skill's app/: pass its page).
export function singleFile(root, snapshot, { page, title } = {}) {
  page = page ? page.replace(/<title>[^<]*<\/title>/, () => pageTitle(title)) : artifactPage(readFileSync(join(root, 'index.html'), 'utf8'), { title });
  const base = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(page)[1]);
  const imports = { ...base.imports };
  for (const rel of moduleGraph(root)) {
    imports[NAME + rel] = `data:text/javascript;base64,${b64(rewrite(readFileSync(join(root, rel), 'utf8'), rel))}`;
  }
  const textures = {};
  for (const size of ['512', '1024']) {
    const dir = join(root, 'assets/tex', size);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.webp')).sort()) {
      textures[`${size}/${f.replace(/\.webp$/, '')}`] = `data:image/webp;base64,${b64(readFileSync(join(dir, f)))}`;
    }
  }
  const body = page
    .replace(/<script type="importmap">[\s\S]*?<\/script>/, () => `<script type="importmap">${json({ imports })}</script>`)
    .replace(/<script type="module" src="\.\/src\/main\.js"[^>]*><\/script>/, `<script type="module">import '${NAME}src/main.js';</script>`);
  if (!body.includes(`import '${NAME}src/main.js'`)) throw new Error('index.html no longer loads ./src/main.js the way single.mjs expects.');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n'
    + `<script>window.LIVING_SPACE_SNAPSHOT = ${json(snapshot)}; window.LIVING_SPACE_TEXTURES = ${json(textures)};</script>\n`
    + `${body}</body></html>\n`;
}
