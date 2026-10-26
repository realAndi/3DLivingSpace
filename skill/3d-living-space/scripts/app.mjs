// The app as an Artifact's files: the site's own index.html, src/ and textures,
// with nothing rewritten but the page's outer shell. An Artifact is published as
// the inside of <body> (the platform adds the doctype, head and body around it),
// so the page keeps its title, fonts, styles and import map at the top and
// starts with a line that tells src/main.js it is running as an Artifact.
//
// assembleApp(root, outDir) writes the files under outDir and returns their
// published paths. Used by `space.mjs bundle` from a checkout of the repo and by
// skill/package.mjs, which ships the result in the packaged skill.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';

// Modules the page starts from: main.js, and what it loads only as an Artifact.
const ENTRIES = ['src/main.js', 'src/claude-store.js'];
const TEXTURE_SIZES = ['512', '1024'];

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

// index.html, as the inside of an Artifact's <body>.
export function artifactPage(html) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1];
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html)?.[1];
  if (head == null || body == null) throw new Error('index.html has no <head> or <body>.');
  const pick = (re) => [...head.matchAll(re)].map((m) => m[0]);
  const title = '<title>3D Living Space</title>';
  const fonts = pick(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/g);
  const styles = pick(/<style>[\s\S]*?<\/style>/g);
  const importMap = pick(/<script type="importmap">[\s\S]*?<\/script>/g);
  if (!styles.length || !importMap.length) throw new Error('index.html lost its <style> or import map.');
  // What the site's <html lang> and <body data-role> said, plus the switch
  // src/main.js reads; set before the page's styles apply, so nothing meant
  // only for the site flashes up.
  const boot = '<script>window.LIVING_SPACE = \'artifact\'; document.documentElement.lang = \'en\'; document.documentElement.classList.add(\'in-claude\'); document.body.dataset.role = \'loading\';</script>';
  return [title, boot, ...fonts, ...styles, ...importMap, body.trim(), ''].join('\n');
}

export function assembleApp(root, outDir) {
  const files = [];
  const put = (rel, write) => {
    const to = join(outDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    write(to);
    files.push(rel);
  };
  put('index.html', (to) => writeFileSync(to, artifactPage(readFileSync(join(root, 'index.html'), 'utf8'))));
  for (const rel of moduleGraph(root)) put(rel, (to) => copyFileSync(join(root, rel), to));
  for (const size of TEXTURE_SIZES) {
    const dir = join(root, 'assets/tex', size);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.webp')).sort()) put(`assets/tex/${size}/${f}`, (to) => copyFileSync(join(dir, f), to));
  }
  return files;
}
