// Pieces off the floor (src/stacking.js with src/fit.js): lamps on tables,
// books on shelves, a coffee maker on the counter, art and curtains on the
// walls, a pendant from the ceiling; moving a table carries what's on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnit, cleanUnit } from '../src/unit.js';
import { cleanDesign } from '../src/design.js';
import { catalogByType } from '../src/catalog.js';
import { problems, blockersFor, slideOnWall, collides } from '../src/fit.js';
import { placeByType, restOn, hangOnWall, carry, descendants, supportOf, surfacesAt } from '../src/stacking.js';

// A 20' × 14' living room with a window centered on its north wall, a bedroom
// door on its west wall, and a kitchen run (base cabinets under wall cabinets)
// along its east wall.
const unit = cleanUnit({
  name: 'Test', ceiling: 9,
  rooms: [
    { id: 'living', name: 'Living', kind: 'living', poly: [[0, 0], [20, 0], [20, 14], [0, 14]] },
    { id: 'bed', name: 'Bedroom', kind: 'bedroom', poly: [[-12.375, 0], [-0.375, 0], [-0.375, 14], [-12.375, 14]] },
  ],
  openings: [
    { id: 'entry', type: 'entry', at: [10, 14.3], width: 3 },
    { id: 'win', type: 'window', at: [10, -0.3], width: 6, sill: 2, head: 6.67 },
    { id: 'bed-door', type: 'door', at: [-0.19, 7], width: 2.67, hinge: 'north', opens: 'west' },
  ],
  fixtures: [
    { id: 'kitchen', type: 'kitchen-run', x: 20 - 2.125 / 2, z: 7, w: 8, d: 2.125, h: 3, rot: 90, opts: { segments: [{ kind: 'base', w: 4 }, { kind: 'sink', w: 2.75 }], uppers: true } },
  ],
}).unit;
const U = buildUnit(unit);

let n = 0;
const piece = (type, x, z, extra = {}) => {
  const d = catalogByType[type];
  return { uid: `p${type.replace(/-/g, '')}${++n}`.padEnd(6, '0'), type, name: d.name, w: d.w / 12, d: d.d / 12, h: d.h / 12, x, z, rot: 0, ...extra };
};
const near = (a, b, tol = 0.002) => Math.abs(a - b) < tol;

test('the test unit builds cleanly', () => {
  assert.deepEqual(U.problems, []);
});

test('a table lamp rests on a side table, and a second one can\'t overlap it', () => {
  const table = piece('sidetable', 4, 10);
  const lamp = piece('table-lamp', 4.1, 10);
  const items = [table, lamp];
  Object.assign(lamp, placeByType(lamp, { items, U }));
  assert.equal(lamp.on, `p:${table.uid}`);
  assert.ok(near(lamp.y, table.h), 'on the top');
  assert.deepEqual(problems(lamp, items, U), []);
  assert.deepEqual(problems(table, items, U), []);
  // The table never blocks the lamp, nor the lamp the table.
  assert.ok(!collides(lamp, blockersFor(lamp, U, items), null));
  assert.ok(!collides(table, blockersFor(table, U, items), null));
  // Pulled in to fit when set down near the edge.
  const edge = piece('table-lamp', 4 + table.w / 2 - 0.1, 10);
  Object.assign(edge, placeByType(edge, { items, U }));
  assert.ok(edge.x + edge.w / 2 <= table.x + table.w / 2 + 1e-3, 'kept on the top');
  const other = { ...edge, uid: 'second1', x: lamp.x, z: lamp.z };
  assert.match(problems(other, [...items, other], U).join(), /overlaps Table lamp/);
  // A lamp floating above the table, or sunk into it, is caught.
  assert.match(problems({ ...lamp, y: lamp.y + 0.3 }, items, U).join(), /floats above the side table/);
  assert.match(problems({ ...lamp, x: 9, z: 7 }, items, U).join(), /floats above the side table/);
});

test('moving a table carries what is on it, turning with it', () => {
  const table = piece('table', 10, 8);
  const plates = piece('plates', 10.8, 8, { y: table.h, on: `p:${table.uid}` });
  const vase = piece('vase', 10.8, 8, { y: table.h + plates.h, on: `p:${plates.uid}` });
  const items = [table, plates, vase];
  assert.deepEqual(descendants(table.uid, items).map((i) => i.uid), [plates.uid, vase.uid]);
  const moved = carry(table, { ...table, x: 12, z: 9, rot: 90 }, items);
  const byUid = Object.fromEntries(moved.map((m) => [m.uid, m]));
  // 0.8 east of the table's middle, turned 90° clockwise: 0.8 south of it.
  assert.ok(near(byUid[plates.uid].x, 12) && near(byUid[plates.uid].z, 9.8), JSON.stringify(byUid[plates.uid]));
  assert.equal(byUid[plates.uid].rot, 90);
  assert.ok(near(byUid[vase.uid].x, 12) && near(byUid[vase.uid].z, 9.8));
  // A lower table lowers them.
  const lower = carry(table, { ...table, h: 2.25 }, items);
  assert.ok(near(lower.find((m) => m.uid === plates.uid).y, 2.25));
});

test('books go on a bookshelf\'s shelves; too tall a piece doesn\'t fit a shelf', () => {
  const shelf = piece('bookshelf', 6, 0.5 + 0.04);
  const books = piece('books', 6, 0.55);
  const items = [shelf, books];
  const support = supportOf({ on: `p:${shelf.uid}` }, items, U);
  const low = restOn(books, support, { y: 1.3 });
  assert.equal(typeof low, 'object', String(low));
  assert.ok(low.y > 1 && low.y < 1.5, `a middle shelf (${low.y})`);
  Object.assign(books, low);
  assert.deepEqual(problems(books, items, U), []);
  // The shelf's one solid box doesn't block the books inside it.
  assert.ok(!collides(books, blockersFor(books, U, items), null));
  const vase = piece('vase', 6, 0.55, { h: 1.5 });
  Object.assign(vase, restOn(vase, support, { y: 1.3 }));
  assert.match(problems(vase, [...items, vase], U).join(), /too tall for the shelf/);
  // The top has room for anything.
  const top = restOn(vase, support, {});
  assert.ok(near(top.y, shelf.h));
});

test('a coffee maker goes on the counter; a tall one hits the wall cabinets', () => {
  const at = [20 - 1, 5];
  assert.ok(surfacesAt(...at, { U }).length, 'the counter is under the point');
  const maker = piece('coffee-maker', ...at, { rot: 90 });
  Object.assign(maker, placeByType(maker, { items: [maker], U }));
  assert.equal(maker.on, 'f:kitchen');
  assert.ok(near(maker.y, 3));
  assert.deepEqual(problems(maker, [maker], U), []);
  const tall = { ...maker, uid: 'tallone', h: 2 };
  assert.match(problems(tall, [tall], U).join(), /overlaps the kitchen cabinets/);
});

test('art hangs on a wall over a sofa; not over a window; curtains may', () => {
  const sofa = piece('sofa', 4, 0.04 + 1.5);
  const art = piece('wall-art', 4, 2, { y: 45 / 12 });
  const hung = hangOnWall(art, art.x, art.z, U);
  assert.ok(hung, 'found the north wall');
  assert.equal(hung.rot, 0);
  assert.ok(near(hung.z, art.d / 2), 'back flush with the wall face');
  Object.assign(art, hung, { on: 'wall' });
  const items = [sofa, art];
  assert.deepEqual(problems(art, items, U), []);
  assert.deepEqual(problems(sofa, items, U), []);
  // Too low, it runs into the sofa's back.
  assert.match(problems({ ...art, y: 1.5 }, items, U).join(), /overlaps Sofa/);
  // Slid along the wall, it stops short of the window.
  assert.equal(hangOnWall(art, 10, 1, U), null, 'no wall at that height behind the window');
  assert.match(problems({ ...art, x: 10 }, items, U).join(), /hangs over a window or doorway/);
  const curtains = piece('curtains', 10, 1, { y: 4 / 12 });
  const c = hangOnWall(curtains, 10, 1, U);
  assert.ok(c, 'curtains hang in front of the window');
  Object.assign(curtains, c, { on: 'wall' });
  assert.deepEqual(problems(curtains, [curtains], U), []);
  // Away from any wall.
  assert.match(problems({ ...art, z: 7 }, items, U).join(), /isn't against a wall/);
  // Slid along the wall, it stops where the window begins, and at the corner.
  const shapes = blockersFor(art, U, items);
  const slid = slideOnWall(art, 12, art.z, U, shapes);
  assert.ok(near(slid.x, 7 - art.w / 2, 0.05), `stopped at the window (${slid.x})`);
  const back = slideOnWall(art, -5, art.z, U, shapes);
  assert.ok(near(back.x, art.w / 2, 0.05), `stopped at the corner (${back.x})`);
  // Straight out from the wall is no move along it.
  assert.deepEqual(slideOnWall(art, art.x, art.z + 2, U, shapes), { x: art.x, z: art.z });
});

test('art above a door doesn\'t block its swing; lower down it covers the doorway', () => {
  const art = piece('wall-art', 0.04, 7, { rot: 90 });
  Object.assign(art, hangOnWall(art, 0.2, 7, U, { y: 7 }), { y: 7, on: 'wall' });
  assert.ok(!problems(art, [art], U).some((p) => /blocks/.test(p)), problems(art, [art], U).join());
  const low = { ...art, uid: 'lowart1', y: 4 };
  assert.match(problems(low, [low], U).join(), /hangs over a window or doorway/);
});

test('a pendant hangs from the ceiling over the table', () => {
  const pendant = piece('pendant', 10, 8);
  Object.assign(pendant, placeByType(pendant, { items: [pendant], U }));
  assert.equal(pendant.on, 'ceiling');
  assert.ok(near(pendant.y + pendant.h, 9));
  assert.deepEqual(problems(pendant, [pendant], U), []);
  const table = piece('table', 10, 8);
  assert.deepEqual(problems(table, [table, pendant], U), []);
  assert.match(problems({ ...pendant, y: 5 }, [pendant], U).join(), /below the ceiling/);
});

test('saved supports point at something that exists, with no loops', () => {
  const d = cleanDesign({
    unit,
    items: [
      { uid: 'table001', type: 'table', x: 10, z: 8 },
      { uid: 'lamp0001', type: 'table-lamp', x: 10, z: 8, y: 2.5, on: 'p:table001' },
      { uid: 'lamp0002', type: 'table-lamp', x: 10, z: 8, y: 2.5, on: 'p:missing1' },
      { uid: 'loopa001', type: 'books', x: 1, z: 1, y: 1, on: 'p:loopb001' },
      { uid: 'loopb001', type: 'books', x: 1, z: 1, y: 1, on: 'p:loopa001' },
      { uid: 'maker001', type: 'coffee-maker', x: 19, z: 5, y: 3, on: 'f:kitchen' },
      { uid: 'maker002', type: 'coffee-maker', x: 19, z: 5, y: 3, on: 'f:nothere' },
      { uid: 'art00001', type: 'wall-art', x: 4, z: 0.06, y: 3.75, on: 'wall' },
    ],
  });
  const on = Object.fromEntries(d.items.map((i) => [i.uid, i.on ?? null]));
  assert.deepEqual(on, { table001: null, lamp0001: 'p:table001', lamp0002: null, loopa001: null, loopb001: 'p:loopa001', maker001: 'f:kitchen', maker002: null, art00001: 'wall' });
  assert.equal(d.items.find((i) => i.uid === 'lamp0002').y, 2.5, 'keeps its height');
});

test('a piece standing in a doorway is caught; art above it is not', () => {
  const shelf = piece('bookshelf', -0.19, 7, { rot: 90 });
  assert.match(problems(shelf, [shelf], U).join(), /stands in the doorway of the bedroom door/);
  const art = piece('wall-art', 0.06, 7, { rot: 90, y: 7, on: 'wall' });
  assert.ok(!problems(art, [art], U).some((p) => /doorway of/.test(p)));
});
