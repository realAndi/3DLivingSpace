// Suggestions (src/changes.js): what a copy changed, how it lands on the
// original now, clashes, stacks moving together, and applying a choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutChanges, applyChanges, whatChanged } from '../src/changes.js';

const piece = (uid, type, x, z, extra = {}) => ({ uid, type, name: extra.name ?? type, w: 2, d: 2, h: 2.5, x, z, rot: 0, color: null, ...extra });
// The original when it was copied: a sofa, a table with a lamp on it, a rug, a chair.
const BASE = [
  piece('sofa1', 'sofa', 5, 5, { name: 'Sofa', w: 7, d: 3 }),
  piece('table1', 'sidetable', 10, 5, { name: 'Side table' }),
  piece('lamp1', 'table-lamp', 10, 5, { name: 'Table lamp', y: 2, on: 'p:table1' }),
  piece('rug1', 'rug-5x8', 6, 9, { name: 'Rug', h: 0.04 }),
  piece('chair1', 'chair', 2, 2, { name: 'Chair' }),
];
const moved = (p, dx, dz, extra = {}) => ({ ...p, x: p.x + dx, z: p.z + dz, ...extra });

test('nothing changed, nothing to suggest', () => {
  assert.deepEqual(layoutChanges({ base: BASE, theirs: BASE, ours: BASE }), []);
});

test('a table moved with its lamp is one change; an added piece and a removed one are their own', () => {
  const theirs = [BASE[0], moved(BASE[1], 3, 1), moved(BASE[2], 3, 1), BASE[3], piece('plant1', 'plant', 1, 8, { name: 'Plant' })];
  const groups = layoutChanges({ base: BASE, theirs, ours: BASE });
  assert.deepEqual(groups.map((g) => [g.id, g.kind, g.pieces.map((p) => p.uid), g.conflict]), [
    ['table1', 'changed', ['table1', 'lamp1'], null],
    ['plant1', 'added', ['plant1'], null],
    ['chair1', 'removed', ['chair1'], null],
  ]);
  assert.ok(Math.abs(groups[0].pieces[0].what.moved - Math.hypot(3, 1)) < 1e-9);
});

test('what the owner changed since clashes; what they already have is left out', () => {
  const theirs = [moved(BASE[0], 0, -1), BASE[1], BASE[2], moved(BASE[3], 1, 0), BASE[4]];
  // The owner moved the sofa too, and already moved the rug the same way.
  const ours = [moved(BASE[0], 2, 0), BASE[1], BASE[2], moved(BASE[3], 1, 0), BASE[4]];
  const groups = layoutChanges({ base: BASE, theirs, ours });
  assert.deepEqual(groups.map((g) => [g.id, g.conflict]), [['sofa1', 'changed']]);
  // Removed by the owner, changed by them.
  const gone = layoutChanges({ base: BASE, theirs, ours: BASE.filter((p) => p.uid !== 'sofa1') });
  assert.equal(gone.find((g) => g.id === 'sofa1').conflict, 'removed');
});

test('a lamp moved onto a table the owner removed clashes', () => {
  const theirs = [...BASE.slice(0, 2), moved(BASE[2], 0, 0, { on: 'p:chair1', y: 1.5, x: 2, z: 2 }), BASE[3], BASE[4]];
  const ours = BASE.filter((p) => p.uid !== 'chair1');
  const [g] = layoutChanges({ base: BASE, theirs, ours });
  assert.deepEqual([g.id, g.conflict], ['lamp1', 'support']);
  assert.equal(whatChanged(BASE[2], theirs[2]).onto, 'p:chair1');
  // Applied anyway, it lands on the floor.
  const { items } = applyChanges({ base: BASE, theirs, ours, select: ['lamp1'] });
  const lamp = items.find((i) => i.uid === 'lamp1');
  assert.deepEqual([lamp.on, lamp.y, lamp.x], [undefined, undefined, 2]);
});

test('applying a choice takes only those groups, and brings the custom pieces they need', () => {
  const stool = { id: 'stool1', name: 'Stool', parts: [] };
  const theirs = [moved(BASE[0], 0, -1), BASE[1], BASE[2], BASE[3], BASE[4], piece('mine1', 'asset', 3, 3, { asset: 'stool1', name: 'Stool' })];
  const ours = [...BASE, piece('own1', 'ottoman', 12, 12, { name: 'Ottoman' })];
  const one = applyChanges({ base: BASE, theirs, ours, theirAssets: [stool], select: ['mine1'] });
  assert.equal(one.applied, 1);
  assert.deepEqual(one.items.map((i) => i.uid), ['sofa1', 'table1', 'lamp1', 'rug1', 'chair1', 'own1', 'mine1']);
  assert.equal(one.items[0].z, 5, 'the sofa stays where the owner has it');
  assert.deepEqual(one.assets.map((a) => a.id), ['stool1']);
  const all = applyChanges({ base: BASE, theirs, ours, theirAssets: [stool] });
  assert.equal(all.applied, 2);
  assert.equal(all.items.find((i) => i.uid === 'sofa1').z, 4);
  assert.ok(all.items.some((i) => i.uid === 'own1'), 'what the owner added since stays');
});

test('a copy from before suggestions: no clashes, no removals', () => {
  const theirs = [moved(BASE[0], 1, 0), BASE[1]];
  const groups = layoutChanges({ base: null, theirs, ours: BASE });
  assert.deepEqual(groups.map((g) => [g.id, g.kind, g.conflict]), [['sofa1', 'changed', null]]);
});
