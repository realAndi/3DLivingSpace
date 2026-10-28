// The app and one unit in a single HTML file, for where there is no Artifact to
// publish to (claude.ai chat, the API): the person downloads it and opens it in
// a browser. It is the Artifact's page (app.mjs) with its files folded in: each
// module becomes a data: URL in the import map, under a bare name so the
// modules still find each other; the textures and the snapshot ride along as
// globals that src/textures.js, src/claude-store.js and src/main.js look for
// (with the example's floor plan when the unit shows it). Only three.js and the
// fonts still come from the network.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { moduleGraph, artifactPage, pageTitle, absoluteThree, threeBase } from './app.mjs';

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
// Its modules: a checkout's own (three.js made absolute, as app.mjs does for
// an Artifact), or the packaged app's, which already are.
export function singleFile(root, snapshot, { page, title } = {}) {
  const site = !page;
  page = site ? artifactPage(readFileSync(join(root, 'index.html'), 'utf8'), { title }) : page.replace(/<title>[^<]*<\/title>/, () => pageTitle(title));
  const base = site ? threeBase(readFileSync(join(root, 'index.html'), 'utf8')) : null;
  const imports = {};
  for (const rel of moduleGraph(root)) {
    const code = readFileSync(join(root, rel), 'utf8');
    imports[NAME + rel] = `data:text/javascript;base64,${b64(rewrite(site ? absoluteThree(code, base) : code, rel))}`;
  }
  const textures = {};
  for (const size of ['512', '1024']) {
    const dir = join(root, 'assets/tex', size);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.webp')).sort()) {
      textures[`${size}/${f.replace(/\.webp$/, '')}`] = `data:image/webp;base64,${b64(readFileSync(join(dir, f)))}`;
    }
  }
  // The picture a unit lays under its plan (only the example has one), keyed by its src.
  const plans = {};
  const src = snapshot.unit?.planImage?.src;
  if (typeof src === 'string' && /^assets\/[\w.-]+\.(png|jpg)$/.test(src) && existsSync(join(root, src))) {
    plans[src] = `data:image/${src.endsWith('.png') ? 'png' : 'jpeg'};base64,${b64(readFileSync(join(root, src)))}`;
  }
  // Nothing loads a module before this page, so the modules' own names can go in a map.
  const body = page
    .replace(/<\/style>\n(?![\s\S]*<\/style>)/, () => `</style>\n<script type="importmap">${json({ imports })}</script>\n`)
    // The page starts the app with import('./src/main.js') (app.mjs START): here it's a bare name.
    .replace("import('./src/main.js')", () => `import('${NAME}src/main.js')`);
  if (!body.includes('<script type="importmap">') || !body.includes(`import('${NAME}src/main.js')`)) throw new Error('The page no longer starts ./src/main.js the way single.mjs expects.');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n'
    + `<script>document.documentElement.classList.add('in-file'); window.LIVING_SPACE_SNAPSHOT = ${json(snapshot)}; window.LIVING_SPACE_TEXTURES = ${json(textures)}; window.LIVING_SPACE_PLANS = ${json(plans)};</script>\n`
    + `${body}</body></html>\n`;
}
