// Textures from recipes (src/recipes.js): what an agent's recipe is cleaned
// to, that every pattern and layer tiles without a seam, measuring a picture
// against a photo, and the unit naming its textures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTexture, cleanTextures, startRender, renderTexture, repeatOf, patch, imageStats, compareStats,
  PATTERNS, LAYERS, PRESETS, preset, TEXTURE_LIMITS,
} from '../src/recipes.js';
import { cleanUnit, buildUnit, hardFloor } from '../src/unit.js';
import { cleanItem } from '../src/design.js';

const ROOM = { id: 'living', name: 'Living', kind: 'living', poly: [[0, 0], [12, 0], [12, 10], [0, 10]] };

test('recipes: cleaned to what draws, with what was changed said', () => {
  const why = [];
  const t = cleanTexture({ name: 'Oak herringbone', for: 'floor', base: '#B48A5C', pattern: { type: 'herringbone', size: [3, 17], angle: 50, colors: ['#b48a5c', 'nope'] }, layers: [{ type: 'grain', color: '#7d5a37' }, { type: 'sparkles' }] }, new Set(), why);
  assert.equal(t.id, 'oak-herringbone');
  assert.equal(t.base, '#b48a5c');
  assert.deepEqual(t.pattern.size, [3, 18], 'a herringbone plank is a whole number of widths long');
  assert.equal(t.pattern.angle, 45, 'angles snap to the turns that still tile');
  assert.deepEqual(t.pattern.colors, ['#b48a5c']);
  assert.deepEqual(t.layers.map((l) => l.type), ['grain']);
  assert.match(why.join(' '), /layer 2: layer type "sparkles" isn't one of/);
  assert.equal(t.finish.roughness, 0.6, 'a floor\'s default finish');
  assert.equal(cleanTexture({ pattern: { type: 'planks', angle: 30 } }).pattern.angle, 0, 'planks turn by quarters');
  assert.equal(cleanTexture({ pattern: { type: 'planks' } }).pattern.bond, 'random');
  // Ids stay unique; the list stops at its limit.
  const used = new Set(['oak']);
  assert.equal(cleanTexture({ id: 'oak', name: 'Oak' }, used).id, 'oak-2');
  const many = [];
  assert.equal(cleanTextures(Array.from({ length: TEXTURE_LIMITS.textures + 3 }, (_, i) => ({ name: `T${i}` })), many).length, TEXTURE_LIMITS.textures);
  assert.match(many[0], /Only 24 textures fit/);
  for (const [key, raw] of Object.entries(PRESETS)) {
    const w = [];
    assert.ok(cleanTexture({ id: key, ...raw }, new Set(), w), key);
    assert.deepEqual(w, [], `${key} cleans as written`);
  }
});

test('recipes: every pattern and layer tiles without a seam, turned or not', () => {
  const layers = LAYERS.map((type) => ({ type, color: '#553322', colors: ['#112233', '#ddccbb'], amount: 0.6 }));
  const cases = [];
  for (const type of PATTERNS) for (const angle of [0, 45, 90]) cases.push({ name: `${type} ${angle}`, base: '#c0a080', pattern: { type, angle, colors: ['#c0a080', '#a08060', '#806040'] }, layers });
  cases.push({ name: 'tiles in running bond', pattern: { type: 'tiles', size: [12, 6], bond: 0.5 }, layers });
  cases.push({ name: 'tiles a third', pattern: { type: 'tiles', size: [9, 3], bond: 1 / 3 }, layers });
  for (const raw of cases) {
    const t = cleanTexture(raw);
    const job = startRender(t, { maxPx: 64 });
    const [ru, rv] = job.repeat;
    assert.deepEqual(repeatOf(t), job.repeat.map((x) => Math.round(x * 1000) / 1000));
    for (let i = 0; i < 60; i++) {
      // Points clear of joints and edges, where one step can land either side.
      const u = ((i * 7.31) % ru) + 0.013, v = ((i * 3.77) % rv) + 0.029;
      const a = job.at(u, v), b = job.at(u + ru, v), c = job.at(u, v + rv);
      for (const [x, y] of [[a, b], [a, c]]) {
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(x[0][k] - y[0][k]) < 2e-3, `${raw.name}: color at (${u}, ${v}) is the same a repeat over`);
        assert.ok(Math.abs(x[1] - y[1]) < 2e-3, `${raw.name}: height`);
      }
    }
  }
});

test('recipes: a picture measured against a photo says what to change', () => {
  const t = preset('chevron');
  const p = patch(t, { px: 96 });
  const self = compareStats(imageStats(p.rgba, p.w, p.h), imageStats(p.rgba, p.w, p.h));
  assert.equal(self.match, 100);
  assert.match(self.hints[0], /match the photo closely/);
  const dark = p.rgba.map((v, i) => (i % 4 === 3 ? v : v * 0.6));
  const vs = compareStats(imageStats(dark, p.w, p.h), imageStats(p.rgba, p.w, p.h));
  assert.ok(vs.match < self.match);
  assert.ok(vs.difference.lightness > 10);
  assert.match(vs.hints.join(' '), /lighter than the photo/);
  // Drawn at the size asked, rows top to bottom, opaque.
  const r = renderTexture(t, { maxPx: 128 });
  assert.equal(Math.max(r.w, r.h), 128);
  assert.equal(r.color.length, r.w * r.h * 4);
  assert.ok(r.color.every((v, i) => i % 4 !== 3 || v === 255));
});

test('recipes: the unit keeps its textures; what names one it lacks goes back to its default', () => {
  const tex = { id: 'oak', name: 'Oak', for: 'floor', pattern: { type: 'herringbone' } };
  const { unit, dropped } = cleanUnit({
    rooms: [{ ...ROOM, floor: 'tex:oak' }, { ...ROOM, id: 'bath', kind: 'bath', poly: [[12.5, 0], [18, 0], [18, 6], [12.5, 6]], floor: 'tex:ghost' }],
    finishes: { counters: 'tex:oak', backsplash: 'zellige', tile: 'tex:ghost', floor: 'herringbone' },
    fixtures: [{ id: 'k', type: 'kitchen-run', at: [6, 1], w: 8, color: 'tex:oak', opts: { backsplash: 'tex:ghost' } }],
    textures: [tex],
  });
  assert.deepEqual(unit.textures.map((t) => t.id), ['oak']);
  assert.equal(unit.rooms[0].floor, 'tex:oak');
  assert.equal(unit.rooms[1].floor, null);
  assert.equal(unit.finishes.counters, 'tex:oak');
  assert.equal(unit.finishes.backsplash, 'zellige');
  assert.equal(unit.finishes.floor, 'herringbone');
  assert.equal(unit.finishes.tile, 'warm-gray');
  assert.equal(unit.fixtures[0].color, 'tex:oak');
  assert.equal(unit.fixtures[0].opts?.backsplash, undefined);
  assert.equal(dropped.filter((d) => /no texture "ghost"/.test(d)).length, 3);
  const U = buildUnit(unit, { checks: false });
  assert.equal(U.textureById.oak.name, 'Oak');
  // Tile and stone floors go without baseboards, and so do textures laid like them.
  assert.ok(hardFloor('travertine') && hardFloor('hex-tile') && !hardFloor('herringbone') && !hardFloor('carpet'));
  assert.ok(hardFloor('tex:t', [{ id: 't', for: 'floor', pattern: { type: 'tiles' } }]));
  assert.ok(!hardFloor('tex:oak', unit.textures));
  // A piece is made of a material, or of one of the unit's textures.
  const sofa = cleanItem({ uid: 'sofa1', type: 'sofa', material: 'velvet', color: '#33aa55' });
  assert.deepEqual([sofa.material, sofa.color], ['velvet', '#33aa55']);
  assert.equal(cleanItem({ uid: 'rug1', type: 'rug-8x10', material: 'tex:oak' }).material, 'tex:oak');
  assert.equal(cleanItem({ uid: 'rug2', type: 'rug-8x10', material: 'plutonium' }).material, undefined);
});
