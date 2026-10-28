// The app as an Artifact's files: the site's own index.html, src/ and textures,
// with nothing rewritten but the page's outer shell. An Artifact is published as
// the inside of <body> (the platform adds the doctype, head and body around it),
// so the page keeps its title, fonts and styles at the top and starts with a
// line that tells src/main.js it is running as an Artifact. It has no import
// map (see absoluteThree). Its
// <title> is the Artifact's name in the gallery: the unit's, when it has one.
//
// assembleApp(root, outDir) writes the files under outDir and returns their
// published paths. Used by `space.mjs bundle` from a checkout of the repo and by
// skill/package.mjs, which ships the result in the packaged skill.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';

// Modules the page starts from: main.js, and what it loads only as an Artifact.
const ENTRIES = ['src/main.js', 'src/claude-store.js'];
const TEXTURE_SIZES = ['512', '1024'];
// Pictures a unit can point at (src/unit.js planImage): the example's floor plan.
export const PICTURES = ['assets/floorplan.png'];
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
export const pageTitle = (title) => `<title>${esc(title || '3D Living Space')}</title>`;

// three.js by absolute URL in the Artifact's copies of src/. An Artifact can't
// use an import map: the viewer around it loads a module first, and then
// browsers that take one map only (Firefox, Safari) reject the page's, so
// `import 'three'` has nothing to resolve to. So nothing bare is left: jsDelivr's +esm builds of three and its add-ons, which
// name three by that same URL, so every module shares one copy of it. `base` is
// the package's URL, from the site's import map.
export function absoluteThree(code, base) {
  return code.replace(/((?:^|[;\s])(?:import|export)\s[^'"`;]*?from\s*|import\(\s*)(['"])three(\/addons\/[^'"]+)?\2/gm,
    (_, lead, q, addon) => `${lead}${q}${base}${addon ? `/examples/jsm${addon.slice('/addons'.length)}/+esm` : '/+esm'}${q}`);
}

// The three.js package's URL, from index.html's import map.
export function threeBase(html) {
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}');
  const base = /^(https:\/\/cdn\.jsdelivr\.net\/npm\/three@[\d.]+)\/build\/three\.module\.js$/.exec(map.imports?.three ?? '')?.[1];
  if (!base) throw new Error('index.html\'s import map no longer names three on jsDelivr the way app.mjs expects.');
  return base;
}

// Every relative module reachable from the entries, static or dynamic imports.
const IMPORT = /(?:^|[;\s])(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|(?:^|[;\s])import\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm;
export function moduleGraph(root, entries = ENTRIES) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel) || !existsSync(join(root, rel))) return;
    seen.add(rel);
    const code = readFileSync(join(root, rel), 'utf8');
    for (const m of code.matchAll(IMPORT)) walk(posix.normalize(posix.join(posix.dirname(rel), m[1] ?? m[2] ?? m[3])));
  };
  for (const e of entries) walk(e);
  return [...seen].sort();
}

// Starts the app. If it can't, the loading screen says why instead of loading
// forever. Each stage (this script ran, the modules loaded, the app is up, or
// what went wrong) is kept, privately for whoever is looking, in the page's
// database at data/users/<id>/boot, where Claude can read it with ArtifactData.
const START = `<script>
(function () {
  var t0 = Date.now(), errors = [], stage = 'started', done = false, chain = Promise.resolve();
  function note(e) { errors.push(String((e && (e.stack || e.message)) || e).slice(0, 400)); }
  addEventListener('error', function (e) { if (!done) note(e.message || ('Could not load ' + ((e.target && (e.target.src || e.target.href)) || 'a file'))); }, true);
  addEventListener('unhandledrejection', function (e) { if (!done) note(e.reason); });
  // One write at a time to the one document.
  function keep() {
    var use = window.claude && window.claude.use, body = {
      stage: stage, ms: Date.now() - t0, errors: errors.slice(0, 20), at: new Date().toISOString(),
      browser: navigator.userAgent, page: location.origin + location.pathname,
      importMaps: !!(HTMLScriptElement.supports && HTMLScriptElement.supports('importmap')),
    };
    if (!use) return;
    chain = chain.then(function () {
      return Promise.all([use('db'), use('user')]).then(function (c) {
        return c[0] && c[1] && c[1].id().then(function (id) { return id && c[0].doc('data/users/' + id + '/boot').set(body); });
      });
    }).catch(function () {});
  }
  function fail(e) {
    if (done) return;
    done = true;
    if (e) note(e);
    stage = 'failed: ' + stage;
    var el = document.getElementById('loading');
    if (el) {
      el.textContent = '';
      var d = document.createElement('div');
      d.className = 'error';
      d.textContent = '3D Living Space couldn\u2019t start. ' + errors.join(' \u00b7 ');
      el.append(d);
    }
    keep();
  }
  keep();
  import('./src/main.js').then(function () { stage = 'modules loaded'; }, fail);
  var wait = setInterval(function () {
    if (window.app && window.app.ready) { clearInterval(wait); if (!done) { done = true; stage = 'ready'; keep(); } }
    else if (Date.now() - t0 > 20000) { clearInterval(wait); fail('Still starting after 20 seconds.'); }
  }, 250);
})();
</script>`;

// index.html, as the inside of an Artifact's <body>.
export function artifactPage(html, { title } = {}) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1];
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html)?.[1];
  if (head == null || body == null) throw new Error('index.html has no <head> or <body>.');
  const pick = (re) => [...head.matchAll(re)].map((m) => m[0]);
  const fonts = pick(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/g);
  const styles = pick(/<style>[\s\S]*?<\/style>/g);
  if (!styles.length) throw new Error('index.html lost its <style>.');
  // What the site's <html lang> and <body data-role> said, plus the switch
  // src/main.js reads; set before the page's styles apply, so nothing meant
  // only for the site flashes up.
  const boot = '<script>window.LIVING_SPACE = \'artifact\'; document.documentElement.lang = \'en\'; document.documentElement.classList.add(\'in-claude\'); document.body.dataset.role = \'loading\';</script>';
  // The site's module tag and its generic "didn't load" note give way to START.
  const app = body.trim()
    .replace(/<script>\s*function appFailed\(\)[\s\S]*?<\/script>\s*/, '')
    .replace(/<script type="module" src="\.\/src\/main\.js"[^>]*><\/script>/, START);
  if (!app.includes('import(\'./src/main.js\')')) throw new Error('index.html no longer loads ./src/main.js the way app.mjs expects.');
  return [pageTitle(title), boot, ...fonts, ...styles, app, ''].join('\n');
}

export function assembleApp(root, outDir, { title } = {}) {
  const files = [];
  const put = (rel, write) => {
    const to = join(outDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    write(to);
    files.push(rel);
  };
  const html = readFileSync(join(root, 'index.html'), 'utf8'), base = threeBase(html);
  put('index.html', (to) => writeFileSync(to, artifactPage(html, { title })));
  for (const rel of moduleGraph(root)) put(rel, (to) => writeFileSync(to, absoluteThree(readFileSync(join(root, rel), 'utf8'), base)));
  for (const size of TEXTURE_SIZES) {
    const dir = join(root, 'assets/tex', size);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.webp')).sort()) put(`assets/tex/${size}/${f}`, (to) => copyFileSync(join(dir, f), to));
  }
  for (const rel of PICTURES) if (existsSync(join(root, rel))) put(rel, (to) => copyFileSync(join(root, rel), to));
  return files;
}
