// Hitboxes and the collision engine (src/hitbox.js, src/fit.js): pieces meet
// part by part, so chairs tuck under tables, stools under an island's
// overhang and lamp shades over a sofa's arm, while real overlaps are caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnit, cleanUnit } from '../src/unit.js';
import { cleanAsset } from '../src/design.js';
import { catalogByType } from '../src/catalog.js';
import { blockersFor, slideTo, problems, collides, clearances, settleOffWalls, collisionShapes } from '../src/fit.js';
import { localParts, pieceParts } from '../src/hitbox.js';

// A 24' × 16' room: an island with its overhang facing south, a wall cabinet
// on the north wall, and a kitchen run (fridge, then a base cabinet) on the east wall.
const U = buildUnit(cleanUnit({
  name: 'Test', ceiling: 9,
  rooms: [{ id: 'living', name: 'Living', kind: 'living', poly: [[0, 0], [24, 0], [24, 16], [0, 16]] }],
  openings: [{ id: 'entry', type: 'entry', at: [20, 16.3], width: 3 }],
  fixtures: [
    { id: 'island', type: 'island', x: 6, z: 5, w: 6, d: 3, h: 3, rot: 0 },
    { id: 'uppers', type: 'upper-cabinet', x: 18, z: 0.5, w: 3, d: 1, h: 2.5, rot: 0, opts: { bottom: 4.5 } },
    { id: 'kitchen', type: 'kitchen-run', x: 24 - 2.125 / 2, z: 9, w: 6, d: 2.125, h: 3, rot: 90, opts: { segments: [{ kind: 'fridge', w: 3 }, { kind: 'base', w: 3 }], uppers: true } },
  ],
}).unit);

let n = 0;
const piece = (type, x, z, rot = 0, extra = {}) => {
  const d = catalogByType[type];
  return { uid: `p${type}${++n}`, type, name: d.name, w: d.w / 12, d: d.d / 12, h: d.h / 12, x, z, rot, ...extra };
};
// Drag a piece toward (tx, tz) the way the editor does, among `items`.
const drag = (item, tx, tz, items, assets = null) => Object.assign(item, slideTo(item, tx, tz, blockersFor(item, U, items, assets), assets));
const inch = (ft) => Math.round(ft * 1200) / 100;
const near = (a, b, tol = 0.002) => Math.abs(a - b) < tol;

test('the test unit builds cleanly', () => {
  assert.deepEqual(U.problems, []);
});

test('a dining chair tucks under a table until its back meets the edge', () => {
  const table = piece('table', 12, 10);
  const chair = piece('chair', 12, 7.5);  // north of the table, facing it
  const items = [table, chair];
  drag(chair, 12, 10, items);
  const edge = table.z - table.d / 2, back = chair.z - chair.d / 2;
  assert.ok(near(back + 0.08, edge), `the back stops at the edge (${inch(back + 0.08 - edge)}")`);
  assert.ok(near(chair.z + chair.d / 2 - edge, chair.d - 0.08), 'the seat goes 19" under');
  assert.deepEqual(problems(chair, items, U), []);
  assert.deepEqual(problems(table, items, U), []);
  // Pushed further, the back would be in the top.
  assert.match(problems({ ...chair, z: chair.z + 0.1 }, items, U).join(), /overlaps Dining table/);
});

test('a chair stops at a table leg; an armchair\'s arms go under the top but not its back', () => {
  const table = piece('table', 12, 10);
  const corner = piece('chair', 12 - 2.5 + 0.2, 8.6);  // over the north-west leg
  assert.match(problems(corner, [table, corner], U).join(), /overlaps Dining table/);
  const arm = piece('armchair', 12, 6);
  drag(arm, 12, 10, [table, arm]);
  assert.ok(near(arm.z - arm.d / 2 + 0.6, table.z - table.d / 2), 'its back meets the edge');
  // A bench as high as the top's underside would not go under.
  const tall = piece('bench', 12, 6, 0, { h: 2.45 });
  drag(tall, 12, 10, [table, tall]);
  assert.ok(near(tall.z + tall.d / 2, table.z - table.d / 2), 'flush with the table edge');
});

test('an office chair rolls under a desk until its back meets the edge', () => {
  const desk = piece('desk', 12, 12);
  const chair = piece('officechair', 12, 14.6, 180);  // south of the desk, facing it
  const items = [desk, chair];
  drag(chair, 12, 11, items);
  const front = desk.z + desk.d / 2, backFace = chair.z + chair.d / 2 - chair.d * 0.2;
  assert.ok(near(backFace, front), 'the back is flush with the desk');
  assert.ok(chair.z - chair.d / 2 < front - 1.5, `the seat is well under (${inch(front - (chair.z - chair.d / 2))}")`);
  assert.deepEqual(problems(chair, items, U), []);
});

// A counter stool: a round seat on a round base, as an agent would make it.
const STOOL = cleanAsset({ id: 'stool1', name: 'Counter stool', parts: [
  { shape: 'cylinder', size: [15, 2, 15], at: [0, 25, 0] },
  { shape: 'cylinder', size: [12, 24, 12], at: [0, 12, 0] },
] });
const stool = (x, z) => ({ uid: `stool${++n}`, type: 'asset', asset: STOOL.id, name: 'Counter stool', w: STOOL.w / 12, d: STOOL.d / 12, h: STOOL.h / 12, x, z, rot: 0 });

test('a counter stool tucks under the island overhang', () => {
  const island = collisionShapes(U).filter((s) => s.id === 'island');
  assert.deepEqual(island.map((s) => [s.y0, +s.y1.toFixed(3)]), [[0, 2.896], [2.896, 3]], 'cabinets, then the counter slab');
  const s = stool(6, 9);
  drag(s, 6, 5, [s], [STOOL]);
  // The overhang is 12"; the stool goes in up to the back panel, 11¼".
  assert.ok(near(6.5 - (s.z - s.d / 2), 1 - 0.06), `${inch(6.5 - (s.z - s.d / 2))}"`);
  assert.deepEqual(problems(s, [s], U, [STOOL]), []);
  // A dining chair's back is lower than the counter: it slides under too.
  const chair = piece('chair', 2, 9, 180);
  drag(chair, 2, 5, [chair]);
  assert.ok(chair.z - chair.d / 2 < 6.5 - 0.9);
  // A bookcase is not.
  const shelf = piece('bookshelf', 8, 9, 180);
  drag(shelf, 8, 5, [shelf]);
  assert.ok(near(shelf.z - shelf.d / 2, 6.5), 'flush with the counter edge');
});

test('a side table fits in the empty corner of a sectional, not on its chaise', () => {
  const sec = piece('sectional', 12, 11);  // the chaise is on the east end, toward the front
  const corner = piece('sidetable', 7.5, 14.4);
  assert.equal(collides(corner, blockersFor(corner, U, [sec, corner])), false);
  assert.deepEqual(problems(corner, [sec, corner], U), []);
  // Slid in from the front, its legs stop at the seat's front (its top, higher
  // than the seat, reaches a little over it), not at the bounding box.
  const t = piece('sidetable', 9, 15.1);
  drag(t, 9, 10, [sec, t]);
  assert.ok(near(t.z - t.d / 2 + 0.07, 11 - sec.d / 2 + 3), `stops at the seat front (${inch(t.z - t.d / 2)})`);
  const chaise = piece('sidetable', 15, 14);
  assert.match(problems(chaise, [sec, chaise], U).join(), /overlaps Sectional/);
});

test("a floor lamp's shade reaches over a sofa's arm", () => {
  const sofa = piece('sofa', 12, 3);
  const lamp = piece('lamp', 17.5, 3);
  drag(lamp, 15, 3, [sofa, lamp]);
  const arm = sofa.x + sofa.w / 2;
  assert.ok(near(lamp.x - 0.03, arm), 'the pole stops at the sofa');
  assert.ok(arm - (lamp.x - lamp.w / 2) > 0.5, `the shade is over the arm (${inch(arm - (lamp.x - lamp.w / 2))}")`);
  assert.deepEqual(problems(lamp, [sofa, lamp], U), []);
  // Its pole in the arm is an overlap.
  assert.match(problems({ ...lamp, x: arm - 0.2 }, [sofa, lamp], U).join(), /overlaps Sofa/);
});

test('wall cabinets stop a tall bookcase, and a low dresser fits under them', () => {
  const shelf = piece('bookshelf', 18, 4);
  drag(shelf, 18, 0, [shelf]);
  assert.ok(near(shelf.z - shelf.d / 2, 1.17), 'stops at the pulls on the cabinet doors, 14" out');
  const dresser = piece('dresser', 18, 4);
  drag(dresser, 18, 0, [dresser]);
  assert.ok(near(dresser.z - dresser.d / 2, 0.045), 'goes back to the baseboard');
  assert.deepEqual(problems(dresser, [dresser], U), []);
  assert.match(problems({ ...shelf, z: 0.6 }, [shelf], U).join(), /overlaps the wall cabinet/);
});

test("a kitchen run's fridge stands proud of the counter, with cabinets over the counter", () => {
  const kitchen = U.fixtures.find((f) => f.id === 'kitchen');
  const counter = 24 - kitchen.d;
  // In front of the base cabinet a piece meets the counter's edge; in front of the fridge, its handles.
  const box = piece('box', 18, 10.5, 90);
  drag(box, 23, 10.5, [box]);
  assert.ok(near(box.x + box.d / 2, counter));
  const box2 = piece('box', 18, 7.5, 90);
  drag(box2, 23, 7.5, [box2]);
  assert.ok(counter - (box2.x + box2.d / 2) > 0.85, `stops at the fridge handles (${inch(counter - (box2.x + box2.d / 2))}" short of the counter)`);
  const uppers = collisionShapes(U).filter((s) => s.id === 'kitchen' && s.y0 === 4.5);
  assert.equal(uppers.length, 1);
});

test("a custom asset's turned and tipped parts", () => {
  // A box turned 45° about y: a diamond, not its bounding square.
  const diamond = cleanAsset({ id: 'diamond', name: 'Diamond', parts: [{ shape: 'box', size: [24, 30, 24], at: [0, 15, 0], rot: [0, 45, 0] }] });
  const item = { uid: 'diamond1', type: 'asset', asset: 'diamond', w: diamond.w / 12, d: diamond.d / 12, h: diamond.h / 12, x: 12, z: 8, rot: 0 };
  const [part] = localParts(item, [diamond]);
  const r = Math.SQRT2;  // feet from the center to each corner
  assert.equal(part.poly.length, 4);
  for (const [x, z] of part.poly) assert.ok(Math.abs(Math.hypot(x, z) - r) < 1e-6 && (Math.abs(x) < 1e-6 || Math.abs(z) < 1e-6));
  assert.deepEqual([part.y0, part.y1], [0, 2.5]);
  // A cube slid at its corner gets inside the bounding square, up to the diamond's side.
  const cube = { uid: 'cube1', type: 'box', name: 'Cube', w: 1, d: 1, h: 1, x: 15, z: 5, rot: 0 };
  drag(cube, 12, 8, [item, cube], [diamond]);
  assert.ok(cube.x - 0.5 < 12 + r - 0.3, `inside the footprint (${inch(12 + r - (cube.x - 0.5))}")`);
  assert.deepEqual(problems(cube, [item, cube], U, [diamond]), []);

  // A back tipped 20° about x, and an upright cylinder, on a piece scaled to twice the width.
  const lounge = cleanAsset({ id: 'lounge', name: 'Lounger', parts: [
    { shape: 'box', size: [20, 4, 20], at: [0, 14, 0] },
    { shape: 'box', size: [20, 24, 2], at: [0, 26, -9], rot: [-20, 0, 0] },
    { shape: 'cylinder', size: [4, 12, 4], at: [0, 6, 0] },
  ] });
  const big = { type: 'asset', asset: 'lounge', w: (lounge.w * 2) / 12, d: lounge.d / 12, h: lounge.h / 12, x: 0, z: 0, rot: 0 };
  const [seat, back, post] = localParts(big, { lounge });
  assert.deepEqual(seat.poly.map(([x]) => +Math.abs(x).toFixed(4)), [20 / 12, 20 / 12, 20 / 12, 20 / 12].map((v) => +v.toFixed(4)));
  // The tipped back leans toward -z as it rises: its outline is deeper than the 2" board.
  const zs = back.poly.map(([, z]) => z), depth = (Math.max(...zs) - Math.min(...zs)) * 12;
  const a = (20 * Math.PI) / 180;
  assert.ok(Math.abs(depth - (24 * Math.sin(a) + 2 * Math.cos(a))) < 1e-6, `tipped back is ${depth.toFixed(2)}" deep`);
  assert.ok(Math.abs(back.y1 - back.y0 - (24 * Math.cos(a) + 2 * Math.sin(a)) / 12) < 1e-6);
  assert.equal(post.poly.length, 12, 'an upright cylinder is its circle');
  const xs = post.poly.map(([x]) => x);
  assert.ok(Math.abs(Math.max(...xs) - 4 / 12) < 1e-9, 'scaled with the piece: 2" radius, twice as wide');
});

test('real overlaps are still caught', () => {
  const a = piece('sofa', 12, 10), b = piece('sofa', 13, 10.5);
  assert.match(problems(a, [a, b], U).join(), /overlaps Sofa/);
  assert.equal(collides(a, blockersFor(a, U, [a, b])), true);
  const inIsland = piece('ottoman', 6, 4.5);
  assert.match(problems(inIsland, [inIsland], U).join(), /overlaps the island/);
  const inWall = piece('dresser', 12, 0.5);
  assert.match(problems(inWall, [inWall], U).join(), /runs into a wall|sticks out/);
  const ottoman = piece('ottoman', 12, 10), bench = piece('bench', 12, 10);
  assert.match(problems(ottoman, [ottoman, bench], U).join(), /overlaps Bench/, 'an ottoman is taller than a bench underside');
  const low = { ...ottoman, h: 1.2 };
  assert.deepEqual(problems(low, [low, bench], U), [], 'a lower one fits under');
});

test('slideTo stops flush and never overlaps', () => {
  // Against the east wall's baseboard (½" proud of the wall).
  const dresser = piece('dresser', 12, 3, 270);
  drag(dresser, 30, 3, [dresser]);
  const gap = 24 - (dresser.x + dresser.d / 2);
  assert.ok(near(gap, 0.045), `flush on the baseboard (${inch(gap)}")`);
  // Against another piece, sliding along it when dragged at an angle.
  const sofa = piece('sofa', 12, 12), chair = piece('armchair', 12, 8);
  drag(chair, 12.5, 12, [sofa, chair]);
  assert.ok(near(chair.z + chair.d / 2, sofa.z - sofa.d / 2), 'flush with the sofa');
  assert.ok(Math.abs(chair.x - 12.5) < 1e-6, 'slid along it');
  assert.equal(collides(chair, blockersFor(chair, U, [sofa, chair])), false);
});

test('an agent\'s piece set into the baseboard is eased off the wall', () => {
  const sofa = piece('sofa', 12, 1.5);  // back on the wall's face, in the baseboard
  const p = settleOffWalls(sofa, U);
  assert.ok(p && near(p.z, 1.5 + 0.045));
});

test('clearances run from the outline of a turned piece', () => {
  // A 2' square turned 45° beside another piece: the gap is to its slanted side, not its bounding box.
  const a = { uid: 'a', type: 'box', w: 2, d: 2, h: 2, x: 10, z: 10, rot: 45 };
  const b = { uid: 'b', type: 'box', w: 2, d: 2, h: 2, x: 12.5, z: 11.2, rot: 0 };
  const east = clearances(a, [a, b]).find((c) => c.side === 'east');
  assert.ok(Math.abs(east.dist - (11.5 - (10 + Math.SQRT2 - 0.2))) < 1e-6, `${east.dist}`);
  assert.ok(Math.abs(east.at - 10.2) < 1e-6);
  // Square to the walls, nothing changes: the middle of the overlap.
  const c = { ...a, rot: 0 };
  const e2 = clearances(c, [c, b]).find((s) => s.side === 'east');
  assert.deepEqual([e2.dist, e2.edge, e2.at], [0.5, 11, 10.6]);
});

test('every catalog piece stays inside its footprint and height (a TV may rise above its stand)', () => {
  for (const type of Object.keys(catalogByType)) {
    const it = piece(type, 0, 0);
    let top = 0;
    for (const p of pieceParts(it)) {
      top = Math.max(top, p.y1);
      assert.ok(p.y0 >= -1e-9, type);
      for (const [x, z] of p.poly) assert.ok(Math.abs(x) <= it.w / 2 + 1e-9 && Math.abs(z) <= it.d / 2 + 1e-9, `${type} part outside its footprint`);
    }
    if (type !== 'tvstand-tv') assert.ok(Math.abs(top - it.h) < 1e-9, `${type} top ${top} vs ${it.h}`);
  }
});
