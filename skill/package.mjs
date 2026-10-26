// npm run skill: the skill as claude.ai and Claude Code take it, in
// dist/3d-living-space/ and dist/3d-living-space.zip (whose top level is that
// folder, as claude.ai wants). It runs on Node 18 or later with nothing to
// install and no network, and no folder in it is called node_modules (skill
// packagers drop those):
//   SKILL.md, references/   as written, plus references/tools.md (help --markdown)
//   scripts/*.mjs           the scripts, their imports pointed at:
//   scripts/lib/            the src/ modules they use, found by following imports
//   scripts/vendor/zod/     the files zod's ES module entry loads
//   scripts/vendor/resvg/   resvg's WebAssembly build
//   scripts/fonts/          IBM Plex (OFL), as server/render.js draws with
//   app/                    the Artifact's files (scripts/app.mjs), so bundle needs no repo
//
// Then the same skill as a Claude plugin, and the marketplace that lists it (below).
//
//   node skill/package.mjs [--out <dir>] [--no-zip] [--marketplace]
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, cpSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { moduleGraph, assembleApp } from './3d-living-space/scripts/app.mjs';

const NAME = '3d-living-space';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'skill', NAME);
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const outRoot = resolve(flag('--out') ?? join(ROOT, 'dist'));
const DEST = join(outRoot, NAME);

function filesUnder(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, rel) : [rel];
  }).sort();
}
const put = (rel, data) => { mkdirSync(dirname(join(DEST, rel)), { recursive: true }); writeFileSync(join(DEST, rel), data); };
const copy = (from, rel) => { mkdirSync(dirname(join(DEST, rel)), { recursive: true }); copyFileSync(from, join(DEST, rel)); };

// ---------------------------------------------------------------------------
// Imports, pointed at the packaged layout. Specifiers are relative to scripts/.

const PACKAGES = { zod: 'vendor/zod/index.js', '@resvg/resvg-wasm': 'vendor/resvg/index.mjs' };
const SPECIFIER = /(^|[;\s])((?:import|export)\s[^'"`;]*?from\s*|import\s*\(\s*|import\s+)(['"])([^'"\n]+)\3/gm;
function pointImports(code, file, dir) {
  const to = (target) => { const r = posix.relative(dir || '.', target); return r.startsWith('.') ? r : `./${r}`; };
  return code.replace(SPECIFIER, (m, lead, head, q, spec) => {
    const target = PACKAGES[spec] ?? (spec.startsWith('../../../src/') ? `lib/${spec.slice('../../../src/'.length)}` : null);
    if (target) return `${lead}${head}${q}${to(target)}${q}`;
    if (spec.startsWith('node:') || spec.startsWith('./')) return m;
    throw new Error(`${file} imports "${spec}", which the packaged skill doesn't have.`);
  });
}

// ---------------------------------------------------------------------------

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

// SKILL.md, references/ and whatever else is written by hand; scripts/ is built below.
for (const e of readdirSync(SOURCE)) {
  if (e === 'scripts' || e === 'app' || e.startsWith('.') || e === 'node_modules') continue;
  cpSync(join(SOURCE, e), join(DEST, e), { recursive: true });
}

// The scripts and the src/ modules they reach.
const scripts = readdirSync(join(SOURCE, 'scripts')).filter((n) => n.endsWith('.mjs')).sort();
const graph = moduleGraph(ROOT, scripts.map((n) => `skill/${NAME}/scripts/${n}`));
const libs = graph.filter((p) => p.startsWith('src/'));
const strays = graph.filter((p) => !p.startsWith('src/') && !p.startsWith(`skill/${NAME}/scripts/`));
if (strays.length || libs.some((p) => p.split('/').length !== 2)) throw new Error(`The scripts reach modules the package can't hold: ${[...strays, ...libs].join(', ')}`);
for (const n of scripts) put(`scripts/${n}`, pointImports(readFileSync(join(SOURCE, 'scripts', n), 'utf8'), n, ''));
for (const p of libs) put(`scripts/lib/${p.slice(4)}`, pointImports(readFileSync(join(ROOT, p), 'utf8'), p, 'lib'));
// lib/ and vendor/ hold .js files: Node loads them as modules only under "type": "module".
put('scripts/package.json', `${JSON.stringify({ private: true, type: 'module', description: 'The 3D Living Space skill\'s scripts. lib/ and vendor/zod/ are ES modules in .js files.' }, null, 2)}\n`);

// zod: its ES module entry and what that loads, nothing else.
const zodDir = dirname(require.resolve('zod/package.json'));
const zodFiles = moduleGraph(zodDir, ['index.js']);
for (const f of zodFiles) {
  const code = readFileSync(join(zodDir, f), 'utf8');
  for (const m of code.matchAll(SPECIFIER)) if (!m[4].startsWith('.')) throw new Error(`zod's ${f} imports "${m[4]}".`);
  put(`scripts/vendor/zod/${f}`, code);
}
copy(join(zodDir, 'LICENSE'), 'scripts/vendor/zod/LICENSE');
const zodVersion = JSON.parse(readFileSync(join(zodDir, 'package.json'), 'utf8')).version;

// resvg's WebAssembly build: one module, no imports, and its wasm.
const resvgDir = dirname(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
const resvg = JSON.parse(readFileSync(join(resvgDir, 'package.json'), 'utf8'));
for (const f of ['index.mjs', 'index_bg.wasm']) copy(join(resvgDir, f), `scripts/vendor/resvg/${f}`);
put('scripts/vendor/resvg/NOTICE.txt', `${resvg.name} ${resvg.version}, unmodified: index.mjs and index_bg.wasm.\nLicensed under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/).\nSource: https://github.com/yisibl/resvg-js\n`);

// The fonts the plan is drawn in, with their license.
for (const f of readdirSync(join(ROOT, 'server/fonts')).filter((n) => /\.(ttf|txt)$/.test(n))) copy(join(ROOT, 'server/fonts', f), `scripts/fonts/${f}`);

// The Artifact's files, prebuilt.
const app = assembleApp(ROOT, join(DEST, 'app'));

// The tool reference, from the packaged scripts themselves: if they can't
// load on their own, packaging fails here.
const tools = execFileSync(process.execPath, [join(DEST, 'scripts/space.mjs'), 'help', '--markdown'], { cwd: outRoot, encoding: 'utf8', env: { PATH: process.env.PATH } });
put('references/tools.md', tools);

const all = filesUnder(DEST);
if (all.some((f) => f.split('/').includes('node_modules'))) throw new Error('A folder in the skill is called node_modules.');
const bytes = all.reduce((n, f) => n + statSync(join(DEST, f)).size, 0);

// ---------------------------------------------------------------------------
// The zip: stored or deflated, whichever is smaller, with a fixed date so the
// same files make the same zip.

function zip(dir, top) {
  const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1, TIME = 0;
  const locals = [], centrals = [];
  let offset = 0;
  const add = (name, data, isDir) => {
    const packed = isDir ? data : deflateRawSync(data, { level: 9 });
    const deflate = !isDir && packed.length < data.length;
    const body = deflate ? packed : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = isDir ? 0 : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);  // names are UTF-8
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(TIME, 10);
    local.writeUInt16LE(DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);  // made on Unix, so the modes below hold
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt16LE(TIME, 12);
    central.writeUInt16LE(DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((isDir ? 0o40755 : 0o100644) << 16 | (isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  };
  const dirs = new Set([`${top}/`]);
  for (const f of filesUnder(dir)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = `${top}/${parts.slice(0, i).join('/')}/`;
      dirs.add(d);
    }
  }
  for (const d of [...dirs].sort()) add(d, Buffer.alloc(0), true);
  for (const f of filesUnder(dir)) add(`${top}/${f}`, readFileSync(join(dir, f)), false);
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const lines = [
  `${DEST}: ${all.length} files, ${mb(bytes)}`,
  `  scripts/lib: ${libs.length} modules; vendor: zod ${zodVersion} (${zodFiles.length} files), ${resvg.name} ${resvg.version}; app: ${app.length} files`,
  `  SKILL.md: ${existsSync(join(DEST, 'SKILL.md')) ? 'yes' : 'not written yet'}`,
];
// ---------------------------------------------------------------------------
// The plugin: the same skill as a Claude plugin, which claude.ai, the desktop
// app and Claude Code all install (Customize > Plugins > Upload plugin, a
// marketplace, or unzipped into ~/.claude/skills): .claude-plugin/plugin.json
// from skill/plugin.json, the skill under skills/, and skill/README.md.
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'skill', 'plugin.json'), 'utf8'));
const PLUGIN = join(outRoot, `${NAME}-plugin`);
rmSync(PLUGIN, { recursive: true, force: true });
mkdirSync(join(PLUGIN, '.claude-plugin'), { recursive: true });
writeFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
cpSync(DEST, join(PLUGIN, 'skills', NAME), { recursive: true });
copyFileSync(join(ROOT, 'skill', 'README.md'), join(PLUGIN, 'README.md'));
// The site's own mark (index.html's favicon), as the listing icon on claude.ai.
copyFileSync(join(ROOT, 'skill', 'icon.png'), join(PLUGIN, '.claude-plugin', 'icon.png'));
lines.push(`${PLUGIN}: plugin ${MANIFEST.name} ${MANIFEST.version}`);

// The marketplace: one entry, the plugin's zip as the GitHub release asset of
// skill-v<version>, pinned by its sha256. Users add it by the release's
// latest/download URL, or (with --marketplace, written into the repo's own
// .claude-plugin/) by the repository.
const REPO = /github\.com\/([^/]+\/[^/#]+)/.exec(MANIFEST.repository)?.[1];
if (!REPO) throw new Error('skill/plugin.json needs its GitHub "repository".');
const TAG = `skill-v${MANIFEST.version}`;

if (!argv.includes('--no-zip')) {
  const file = join(outRoot, `${NAME}.zip`);
  const data = zip(DEST, NAME);
  writeFileSync(file, data);
  lines.push(`${file}: ${mb(data.length)}`);
  const pluginFile = join(outRoot, `${NAME}-plugin.zip`);
  const pluginZip = zip(PLUGIN, NAME);
  writeFileSync(pluginFile, pluginZip);
  lines.push(`${pluginFile}: ${mb(pluginZip.length)}`);
  const catalog = {
    name: '3dlivingspace',
    description: 'Build, furnish and share a to-scale 3D model of your apartment with Claude.',
    owner: MANIFEST.author,
    plugins: [{
      name: MANIFEST.name,
      description: MANIFEST.description,
      source: { source: 'archive', url: `https://github.com/${REPO}/releases/download/${TAG}/${NAME}-plugin.zip`, sha256: createHash('sha256').update(pluginZip).digest('hex') },
    }],
  };
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  writeFileSync(join(outRoot, 'marketplace.json'), text);
  lines.push(`${join(outRoot, 'marketplace.json')}: for ${TAG}`);
  if (argv.includes('--marketplace')) {
    mkdirSync(join(ROOT, '.claude-plugin'), { recursive: true });
    writeFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), text);
    lines.push(`${join(ROOT, '.claude-plugin', 'marketplace.json')}: updated`);
  }
}
console.log(lines.join('\n'));
