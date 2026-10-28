// Every module the page and the scripts load parses: a slip in one stops the
// whole page, and only the browser would notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ...readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => join('src', f)),
  ...readdirSync(join(ROOT, 'skill/3d-living-space/scripts')).filter((f) => f.endsWith('.mjs')).map((f) => join('skill/3d-living-space/scripts', f)),
];

test('modules: every one parses', () => {
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
