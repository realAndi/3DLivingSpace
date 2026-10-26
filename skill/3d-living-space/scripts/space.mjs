#!/usr/bin/env node
// 3D Living Space for Claude, without a server: build, check and furnish a
// to-scale model of an apartment in a work dir, then publish it as a claude.ai
// Artifact and keep its database in step.
//
//   node scripts/space.mjs <command> [arguments] [--dir <work dir>]
//
// The twelve tools are the unit's MCP tools, by the same names, taking the same
// JSON (checked by the same zod schemas, src/tools.js) and answering the same
// (src/agent.js); here they read and save <work dir>/unit.json. Results go to
// stdout; an error is one clear message on stderr and exit code 1.
// Node 18 or later, nothing to install: packaged, zod, resvg and the shared
// modules sit beside this file (skill/package.mjs).
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TOOLS } from '../../../src/tools.js';
import { createTools, pretty, ToolError } from '../../../src/agent.js';
import { WorkDir, newDoc, toolContext } from './workdir.mjs';
import { bundle, single, pullReads, pullFrom, push, setUrl, isPackaged, PACKAGED_APP, REPO } from './artifact.mjs';

// Node 18 has Web Crypto only as a module; src/design.js randomId wants it global.
globalThis.crypto ??= webcrypto;

const SPACE = fileURLToPath(import.meta.url);
const MIN_NODE = 18;

const COMMANDS = {
  new: { usage: 'new [--example] [--title <title>] [--force]', about: 'Start a work dir: an empty unit, or with --example the example apartment\'s rooms without furniture. Won\'t replace a unit already there without --force.', flags: ['example', 'title', 'force'] },
  help: { usage: 'help [<tool or command>] [--markdown]', about: 'The tools and commands; one tool\'s description and input as JSON Schema; with --markdown, every tool as a reference document.', flags: ['markdown'] },
  bundle: { usage: 'bundle [--out <dir>] [--snapshot-only] [--url <artifact url>]  |  bundle --single [--out <file>]', about: 'Write the Artifact\'s files (the app, and unit.json: a snapshot of the unit) to <dir> (default <work dir>/artifact) and print what to pass to the Artifact tool\'s publish. --snapshot-only: just unit.json, for an Artifact already published. --single: the page with the unit inside, as one HTML file to download (default <work dir>/living-space.html), for where there is no Artifact tool.', flags: ['out', 'snapshot-only', 'url', 'single'] },
  pull: { usage: 'pull [--url <artifact url>]  |  pull --from <dir> [--versions <file>] < ArtifactData results', about: 'Without --from, print the ArtifactData reads to make. With --from, take the documents they saved into unit.json (the Artifact\'s version wins where both changed), and each one\'s version from the ArtifactData results on stdin (or --versions).', flags: ['from', 'versions', 'url'] },
  push: { usage: 'push [--url <artifact url>]', about: 'Write the documents that changed since the last pull (all of them the first time) to <work dir>/outbox and print the ArtifactData batch calls that save them. Remembers the Artifact\'s URL.', flags: ['url'] },
  doctor: { usage: 'doctor', about: 'Check Node, where the scripts run from, and that the plan renderer and its fonts load.', flags: [] },
};
const BOOLEAN = new Set(['example', 'force', 'markdown', 'snapshot-only', 'single']);
const TOOL_FLAGS = { render_plan: ['out'] };

class Usage extends ToolError {}

function parseArgs(argv) {
  const positional = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { positional.push(a); continue; }
    const [, name, inline] = m;
    if (BOOLEAN.has(name)) { flags[name] = inline === undefined ? true : inline !== 'false'; continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Usage(`--${name} needs a value.`);
    flags[name] = value;
  }
  return { positional, flags };
}

function readText(file) {
  if (!existsSync(file)) throw new Usage(`There is no file ${file}.`);
  return readFileSync(file, 'utf8');
}

// A tool's arguments: inline JSON, a file, or - for stdin; nothing is {}.
async function readArgs(arg, io) {
  if (arg === undefined) return {};
  let text, from;
  if (arg === '-') { text = await io.stdin(); from = 'stdin'; }
  else if (/^\s*[[{]/.test(arg)) { text = arg; from = 'the arguments'; }
  else {
    from = resolve(io.cwd, arg);
    if (!existsSync(from)) throw new Usage(`There is no file ${from}. Pass the arguments as JSON ('{…}'), a file of JSON, or - to read them from stdin.`);
    text = readFileSync(from, 'utf8');
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Usage(`${from === 'the arguments' ? 'The arguments aren\'t' : `${from} isn't`} valid JSON: ${error.message}.`);
  }
}

// zod's complaints, a line each, as `path: message` (the MCP SDK says the same, the other way round).
const dotPath = (path) => path.reduce((s, seg, i) => (typeof seg === 'number' ? `${s}[${seg}]` : i ? `${s}.${String(seg)}` : String(seg)), '');
const issuesOf = (name, error) => `Invalid arguments for ${name}:\n${error.issues.map((i) => (i.path.length ? `${dotPath(i.path)}: ${i.message}` : i.message)).join('\n')}`;

const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

async function runTool(tool, positional, flags, work, io) {
  const parsed = z.object(tool.inputSchema).safeParse(await readArgs(positional[1], io));
  if (!parsed.success) throw new Usage(issuesOf(tool.name, parsed.error));
  let png = null;
  if (tool.name === 'render_plan') { const r = await raster(); await r.ready(); png = r.png; }
  const out = createTools(toolContext(work, { png }))[tool.name](parsed.data);
  if (!out?.image) return pretty(out);
  const file = resolve(io.cwd, flags.out ?? work.path('plan.png'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out.image);
  const buf = Buffer.from(out.image);
  const [w, h] = pngSize(buf);
  return `${out.text}\nPlan: ${file} (${w} × ${h} px, PNG). Open it and compare it with the floor plan.`;
}

const raster = () => import('./raster.mjs');

function cmdNew(flags, work) {
  if (work.has('unit.json') && !flags.force) throw new Usage(`There is already a unit in ${work.dir}. Pass --force to start over, or --dir <another folder>.`);
  const doc = newDoc({ example: !!flags.example, title: flags.title ?? '' });
  if (flags.force) for (const f of ['sync.json', 'artifact.json', 'outbox', 'inbox']) rmSync(work.path(f), { recursive: true, force: true });
  work.save(doc);
  return pretty({
    dir: work.dir, unit: flags.example ? 'example' : 'empty', title: doc.title, rooms: doc.unit.rooms.length, version: doc.version,
    next: flags.example
      ? 'The example apartment\'s rooms, doors, windows and kitchen and baths, with no furniture. Look at it with render_plan, then furnish it with get_catalog and place_items.'
      : 'Nothing is built yet. Ask for the floor plan (with the room sizes) and a few photos of each room, call get_catalog, then build_unit.',
  });
}

// ---------------------------------------------------------------------------
// help

function schemaOf(tool) {
  const schema = z.toJSONSchema(z.object(tool.inputSchema), { io: 'input', unrepresentable: 'any' });
  delete schema.$schema;
  return schema;
}
const hasInput = (tool) => Object.keys(tool.inputSchema).length > 0;
const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));

function helpList() {
  return [
    `3D Living Space: node ${SPACE} <command> [arguments] [--dir <work dir>]`,
    'The work dir (default ./living-space) holds unit.json, the unit between calls.',
    '',
    'Tools. Arguments are one JSON object: inline (\'{…}\'), a file, or - for stdin. Inches.',
    ...TOOLS.map((t) => `  ${pad(t.name, 16)}${t.title}`),
    '  render_plan writes the picture to <work dir>/plan.png (or --out <file>).',
    '',
    'Commands:',
    ...Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.about}`),
    '',
    'help <tool> shows its description and input.',
  ].join('\n');
}

function helpOne(name) {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool) {
    return [
      `${tool.name}: ${tool.title}`, '', tool.description, '',
      hasInput(tool) ? `Input (JSON Schema):\n${pretty(schemaOf(tool))}` : 'No input.', '',
      `Run: node ${SPACE} ${tool.name}${hasInput(tool) ? ' \'{…}\'' : ''} [--dir <work dir>]${tool.name === 'render_plan' ? ' [--out <file.png>]' : ''}`,
    ].join('\n');
  }
  const c = COMMANDS[name];
  if (c) return `${c.usage}\n\n${c.about}`;
  throw new Usage(`There is no tool or command "${name}". ${helpList()}`);
}

export function toolsMarkdown() {
  return [
    '# 3D Living Space: the tools',
    '',
    'Generated by `node scripts/space.mjs help --markdown` from the same schemas the MCP server uses; don\'t edit it by hand.',
    '',
    'Run a tool as `node scripts/space.mjs <tool> \'<JSON arguments>\' --dir <work dir>`, or pass a file of JSON, or `-` and the JSON on stdin. Each prints its result as JSON; an error prints one message and exits with 1. `render_plan` writes the picture to `<work dir>/plan.png` (or `--out <file>`) and prints its path: open it and look.',
    '',
    'Inches throughout. x runs east (left to right on the floor plan), z south (top to bottom), y up; put the origin at the plan\'s top-left (north-west) outside corner. Rotations are degrees clockwise on the plan: 0 means a fixture\'s or piece\'s front faces south, 90 west, 180 north, 270 east.',
    '',
    ...TOOLS.map((t) => `- [\`${t.name}\`](#${t.name}): ${t.title}`),
    '',
    ...TOOLS.flatMap((t) => [
      `## ${t.name}`, '', `**${t.title}.** ${t.description}`, '',
      ...(hasInput(t) ? ['Input:', '', '```json', pretty(schemaOf(t)), '```'] : ['No input.']),
      '',
    ]),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// doctor

async function doctor(work) {
  const major = Number(process.versions.node.split('.')[0]);
  const out = {
    node: process.version, node_ok: major >= MIN_NODE,
    runs_from: isPackaged() ? `the packaged skill (${dirname(dirname(SPACE))})` : `a checkout of the repo (${REPO})`,
    app: isPackaged() ? `prebuilt in ${PACKAGED_APP}` : 'assembled from the repo by bundle',
  };
  try {
    const r = await raster();
    const t = await r.selfTest();
    out.renderer = t.ink > 0 ? `resvg (WebAssembly) loaded and drew a test in ${t.ms} ms` : 'resvg loaded but drew no text: the fonts didn\'t load';
    out.fonts = { dir: r.FONT_DIR, files: r.FONT_FILES, ok: t.ink > 0 };
  } catch (error) {
    out.renderer = `failed: ${error.message}`;
  }
  out.work_dir = { dir: work.dir, unit: work.has('unit.json'), artifact: work.url };
  out.ok = out.node_ok && !!out.fonts?.ok;
  if (!out.node_ok) out.fix = `Node ${MIN_NODE} or later is needed.`;
  return out;
}

// ---------------------------------------------------------------------------

// Reads stdin to its end. With wait, gives up if nothing comes in that long:
// a stdin left open with nothing on it mustn't hang a pull.
function processStdin({ wait = Infinity } = {}) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((done, fail) => {
    const chunks = [];
    const timer = Number.isFinite(wait) ? setTimeout(() => { if (!chunks.length) { process.stdin.destroy(); done(''); } }, wait) : null;
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); done(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', (e) => { clearTimeout(timer); fail(e); });
  });
}

// The whole CLI, callable in-process: returns { code, out, err }.
export async function run(argv, io = {}) {
  io = { cwd: process.cwd(), stdin: processStdin, ...io };
  try {
    const { positional, flags } = parseArgs(argv);
    const name = positional[0] ?? 'help';
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool && !COMMANDS[name]) throw new Usage(`There is no tool or command "${name}".\n\n${helpList()}`);
    const allowed = new Set(['dir', ...(tool ? TOOL_FLAGS[name] ?? [] : COMMANDS[name].flags)]);
    for (const f of Object.keys(flags)) if (!allowed.has(f)) throw new Usage(`${name} takes no --${f}. ${tool ? `Run help ${name}.` : `Usage: ${COMMANDS[name].usage}`}`);
    const work = new WorkDir(resolve(io.cwd, flags.dir ?? 'living-space'));
    if (flags.url) setUrl(work, flags.url);
    const out = tool ? await runTool(tool, positional, flags, work, io)
      : name === 'new' ? cmdNew(flags, work)
      : name === 'help' ? (flags.markdown ? toolsMarkdown() : positional[1] ? helpOne(positional[1]) : helpList())
      : name === 'bundle' ? pretty(flags.single ? single(work, { out: flags.out && resolve(io.cwd, flags.out) })
        : bundle(work, { out: flags.out && resolve(io.cwd, flags.out), snapshotOnly: !!flags['snapshot-only'] }))
      : name === 'pull' ? pretty(flags.from
        ? pullFrom(work, resolve(io.cwd, flags.from), flags.versions ? readText(resolve(io.cwd, flags.versions)) : await io.stdin({ wait: 1500 }))
        : pullReads(work))
      : name === 'push' ? pretty(push(work))
      : await doctor(work);
    // doctor reports either way; what's wrong makes it fail.
    if (name === 'doctor') return { code: out.ok ? 0 : 1, out: pretty(out), err: '' };
    return { code: 0, out, err: '' };
  } catch (error) {
    if (error instanceof ToolError) return { code: 1, out: '', err: error.message };
    return { code: 1, out: '', err: `Unexpected error: ${error.message}${process.env.SPACE_DEBUG ? `\n${error.stack}` : ' (SPACE_DEBUG=1 shows where)'}` };
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SPACE); } catch { return false; }
})();
if (isMain) {
  const { code, out, err } = await run(process.argv.slice(2));
  if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  if (err) process.stderr.write(err.endsWith('\n') ? err : `${err}\n`);
  process.exitCode = code;
}
