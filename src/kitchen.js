import * as THREE from 'three';
import { Batch, Frame } from './kit.js';
import { X, Z, HEIGHT } from './plan.js';

// L-shaped kitchen in the south-west corner of the great room.
// The plan draws the outline; the cabinet sequence comes from the kitchen photo:
//   south run (east -> west): fridge, base with drawer, range, filler, blind corner
//   west run (south -> north): corner, 12" base, sink base, dishwasher, end panel
// The west run stops about 6" short of the hall wall's end: both photos show a
// strip of bare wall between the end panel and the hall.
export const K = {
  toe: 0.33, toeIn: 0.25,
  carcassTop: 2.896, counterTop: 3.0,
  depth: 2.0, counterDepth: 2.125,
  upperBottom: 4.5, upperTop: 8.0, upperDepth: 1.0,
  fridgeH: 5.83,
};

const WEST = X(517), SOUTH = Z(699), PIER = X(804), NORTH_END = Z(497);
export const RUN_A_LEN = PIER - WEST;        // 11.1'
export const RUN_B_LEN = SOUTH - NORTH_END;  // 7.8'

// Footprints for collision: [x0, z0, x1, z1]
export const KITCHEN_BLOCKS = [
  [WEST, SOUTH - K.counterDepth - 0.8, PIER, SOUTH],
  [WEST, NORTH_END, WEST + K.counterDepth, SOUTH],
];

function pullV(B, M, F, s, y0, len, t) {
  F.box(B, M.black, s - 0.017, y0, t + 0.075, s + 0.017, y0 + len, t + 0.11);
  F.box(B, M.black, s - 0.012, y0 + 0.04, t, s + 0.012, y0 + 0.075, t + 0.08);
  F.box(B, M.black, s - 0.012, y0 + len - 0.075, t, s + 0.012, y0 + len - 0.04, t + 0.08);
}

function pullH(B, M, F, s, y, len, t) {
  F.box(B, M.black, s - len / 2, y - 0.017, t + 0.075, s + len / 2, y + 0.017, t + 0.11);
  F.box(B, M.black, s - len / 2 + 0.04, y - 0.012, t, s - len / 2 + 0.075, y + 0.012, t + 0.08);
  F.box(B, M.black, s + len / 2 - 0.075, y - 0.012, t, s + len / 2 - 0.04, y + 0.012, t + 0.08);
}

// Slab doors across [s0, s1] and [y0, y1] on face t; pulls near the top (base) or bottom (upper).
function doors(B, M, F, s0, s1, y0, y1, t, count, { pullsAt = 'top', hingeLeft = true } = {}) {
  const g = 0.012;
  const py = pullsAt === 'top' ? y1 - 0.72 : y0 + 0.17;
  if (count === 1) {
    F.box(B, M.oak, s0 + g, y0 + g, t, s1 - g, y1 - g, t + 0.06);
    pullV(B, M, F, hingeLeft ? s1 - 0.14 : s0 + 0.14, py, 0.55, t + 0.06);
    return;
  }
  const mid = (s0 + s1) / 2;
  F.box(B, M.oak, s0 + g, y0 + g, t, mid - g / 2, y1 - g, t + 0.06);
  F.box(B, M.oak, mid + g / 2, y0 + g, t, s1 - g, y1 - g, t + 0.06);
  pullV(B, M, F, mid - 0.14, py, 0.55, t + 0.06);
  pullV(B, M, F, mid + 0.14, py, 0.55, t + 0.06);
}

function base(B, M, F, s0, s1, { count = 2, drawer = false, falseFront = false, hingeLeft = true } = {}) {
  const { toe, toeIn, carcassTop, depth } = K;
  F.box(B, M.toeKick, s0, 0, 0, s1, toe, depth - toeIn);
  F.box(B, M.oak, s0, toe, 0, s1, carcassTop, depth - 0.005);
  let top = carcassTop;
  if (drawer || falseFront) {
    const y0 = carcassTop - 0.52;
    F.box(B, M.oak, s0 + 0.012, y0, depth, s1 - 0.012, carcassTop - 0.012, depth + 0.06);
    if (drawer) pullH(B, M, F, (s0 + s1) / 2, y0 + 0.26, 0.62, depth + 0.06);
    top = y0;
  }
  doors(B, M, F, s0, s1, toe, top, depth, count, { hingeLeft });
}

function upper(B, M, F, s0, s1, y0, y1, count, { depth = K.upperDepth, hingeLeft = true } = {}) {
  F.box(B, M.oak, s0, y0, 0, s1, y1, depth - 0.005);
  doors(B, M, F, s0, s1, y0, y1, depth, count, { pullsAt: 'bottom', hingeLeft });
}

function dishwasher(B, M, F, s0, s1) {
  const { toe, toeIn, carcassTop, depth } = K;
  F.box(B, M.toeKick, s0, 0, 0, s1, carcassTop, depth - 0.1);
  F.box(B, M.steel, s0 + 0.01, toe - 0.05, depth - 0.1, s1 - 0.01, carcassTop - 0.012, depth + 0.02);
  F.box(B, M.steelBrushed, s0 + 0.01, carcassTop - 0.22, depth + 0.02, s1 - 0.01, carcassTop - 0.012, depth + 0.04);
  F.rodS(B, M.steel, s0 + 0.18, s1 - 0.18, carcassTop - 0.36, depth + 0.16, 0.035);
  for (const s of [s0 + 0.22, s1 - 0.22]) F.rodT(B, M.steel, s, carcassTop - 0.36, depth + 0.02, depth + 0.16, 0.02);
  F.box(B, M.black, s0 + 0.05, 0.02, depth - toeIn - 0.02, s1 - 0.05, toe - 0.05, depth - toeIn);
}

function range(B, M, F, s0, s1) {
  const d = K.depth;
  F.box(B, M.steel, s0 + 0.01, 0.05, 0.1, s1 - 0.01, 2.93, d + 0.1);
  // Storage drawer, oven door with window and bar handle.
  F.box(B, M.steel, s0 + 0.02, 0.08, d + 0.1, s1 - 0.02, 0.6, d + 0.15);
  F.box(B, M.toeKick, s0 + 0.02, 0.0, d - 0.1, s1 - 0.02, 0.08, d + 0.1);
  F.box(B, M.steel, s0 + 0.02, 0.64, d + 0.1, s1 - 0.02, 2.52, d + 0.16);
  F.box(B, M.blackGlass, s0 + 0.32, 1.02, d + 0.16, s1 - 0.32, 2.05, d + 0.165);
  F.rodS(B, M.steel, s0 + 0.2, s1 - 0.2, 2.36, d + 0.3, 0.035);
  for (const s of [s0 + 0.24, s1 - 0.24]) F.rodT(B, M.steel, s, 2.36, d + 0.16, d + 0.3, 0.02);
  // Front control strip with five knobs and a small display.
  F.box(B, M.steelBrushed, s0 + 0.02, 2.58, d + 0.1, s1 - 0.02, 2.93, d + 0.2);
  F.box(B, M.blackGlass, (s0 + s1) / 2 - 0.25, 2.66, d + 0.2, (s0 + s1) / 2 + 0.25, 2.85, d + 0.205);
  for (const s of [s0 + 0.25, s0 + 0.55, s1 - 0.55, s1 - 0.25, (s0 + s1) / 2 + 0.42]) F.rodT(B, M.steel, s, 2.76, d + 0.2, d + 0.3, 0.075);
  // Cooktop and cast-iron grates.
  F.box(B, M.blackGlass, s0 + 0.02, 2.93, 0.15, s1 - 0.02, 2.97, d + 0.2);
  const gy = 2.97, gt0 = 0.25, gt1 = d + 0.1;
  for (const [a, b] of [[s0 + 0.06, (s0 + s1) / 2 - 0.02], [(s0 + s1) / 2 + 0.02, s1 - 0.06]]) {
    for (const s of [a, b - 0.05, (a + b) / 2 - 0.025]) F.box(B, M.black, s, gy, gt0, s + 0.05, gy + 0.07, gt1);
    for (const t of [gt0, gt1 - 0.05, (gt0 + gt1) / 2 - 0.025]) F.box(B, M.black, a, gy, t, b, gy + 0.07, t + 0.05);
  }
  for (const [s, t, r] of [[s0 + 0.62, 0.7, 0.2], [s1 - 0.62, 0.7, 0.2], [s0 + 0.62, 1.55, 0.16], [s1 - 0.62, 1.55, 0.22], [(s0 + s1) / 2, 1.12, 0.14]]) {
    const [x, z] = F.p(s, t);
    B.cyl(M.black, x, gy - 0.02, z, r, 0.05);
  }
}

function microwave(B, M, F, s0, s1, y0) {
  const h = 1.38, d = 1.3;
  F.box(B, M.steel, s0 + 0.01, y0, 0, s1 - 0.01, y0 + h, d);
  F.box(B, M.blackGlass, s0 + 0.08, y0 + 0.12, d, s1 - 0.56, y0 + h - 0.12, d + 0.02);
  F.box(B, M.blackGlass, s1 - 0.46, y0 + 0.3, d, s1 - 0.08, y0 + h - 0.15, d + 0.015);
  F.box(B, M.steel, s1 - 0.56, y0 + 0.2, d + 0.02, s1 - 0.5, y0 + h - 0.2, d + 0.12);
  F.box(B, M.steelBrushed, s0 + 0.01, y0 - 0.03, 0.2, s1 - 0.01, y0, d - 0.05);
}

function fridge(B, M, F, s0, s1) {
  const H = K.fridgeH, f0 = s0 + 0.13, f1 = s1 - 0.13, split = f0 + (f1 - f0) * 0.42;
  F.box(B, M.steelBrushed, f0, 0.04, 0.15, f1, H, 2.58);
  F.box(B, M.black, f0 + 0.02, 0.04, 2.44, f1 - 0.02, 0.25, 2.59);
  F.box(B, M.steel, f0, 0.27, 2.58, split - 0.012, H, 2.76);
  F.box(B, M.steel, split + 0.012, 0.27, 2.58, f1, H, 2.76);
  // Ice and water dispenser on the freezer door.
  const dc = (f0 + split) / 2;
  F.box(B, M.blackGlass, dc - 0.38, 3.15, 2.76, dc + 0.38, 4.45, 2.77);
  F.box(B, M.black, dc - 0.3, 3.25, 2.7, dc + 0.3, 3.95, 2.77);
  // Long bar handles either side of the seam.
  for (const s of [split - 0.16, split + 0.16]) {
    F.box(B, M.steel, s - 0.03, 2.25, 2.96, s + 0.03, 5.25, 3.02);
    F.rodT(B, M.steel, s, 2.35, 2.76, 2.98, 0.025);
    F.rodT(B, M.steel, s, 5.15, 2.76, 2.98, 0.025);
  }
}

function faucet(B, M, F, s, t) {
  B.push(F.matrixAt(s, K.counterTop, t));
  B.cyl(M.black, 0, 0, 0, 0.075, 0.18, 20);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.15, 0), new THREE.Vector3(0, 0.95, 0), new THREE.Vector3(0, 1.22, 0.18),
    new THREE.Vector3(0, 1.12, 0.48), new THREE.Vector3(0, 0.85, 0.58),
  ]);
  B.add(new THREE.TubeGeometry(curve, 40, 0.035, 10), M.black);
  B.cyl(M.black, 0, 0.62, 0.58, 0.045, 0.24, 16);
  B.rod(M.black, [0.07, 0.45, 0], [0.24, 0.62, 0.02], 0.022);
  B.pop();
}

// Undermount bowl: counter is built around the opening.
function sinkBowl(B, M, F, s0, s1, t0, t1) {
  const y1 = K.carcassTop + 0.02, y0 = y1 - 0.75, w = 0.02;
  F.box(B, M.steelBrushed, s0, y0, t0, s1, y0 + w, t1);
  F.box(B, M.steelBrushed, s0, y0, t0, s0 + w, y1, t1);
  F.box(B, M.steelBrushed, s1 - w, y0, t0, s1, y1, t1);
  F.box(B, M.steelBrushed, s0, y0, t0, s1, y1, t0 + w);
  F.box(B, M.steelBrushed, s0, y0, t1 - w, s1, y1, t1);
  const [x, z] = F.p((s0 + s1) / 2, (t0 + t1) / 2 + 0.2);
  B.cyl(M.black, x, y0 + w, z, 0.13, 0.005);
}

function outlet(B, M, F, s, y) {
  F.box(B, M.plate, s - 0.12, y - 0.19, 0.03, s + 0.12, y + 0.19, 0.045);
}

export function buildKitchen(M) {
  const B = new Batch('kitchen');
  const soffit = new Batch('kitchen-soffit');
  const { counterTop, carcassTop, counterDepth, upperBottom, upperTop, upperDepth } = K;
  const H = HEIGHT.ceiling;

  // Run A along the south wall. s = 0 at the pier (east), increasing west; t out from the wall.
  const A = new Frame(PIER, SOUTH, [-1, 0], [0, -1]);
  const a = { panel: [0, 0.1], fridge: [0.1, 3.35], base: [3.35, 6.35], range: [6.35, 8.85], filler: [8.85, 9.1], corner: [9.1, RUN_A_LEN] };
  A.box(B, M.oak, 0, 0, 0, 0.1, upperTop, 2.6);
  fridge(B, M, A, ...a.fridge);
  upper(B, M, A, 0.1, a.fridge[1], 6.0, upperTop, 2, { depth: 2.0 });
  base(B, M, A, ...a.base, { count: 2, drawer: true });
  range(B, M, A, ...a.range);
  A.box(B, M.oak, a.filler[0], K.toe, 0, a.filler[1], carcassTop, K.depth + 0.06);
  A.box(B, M.toeKick, a.filler[0], 0, 0, a.corner[1], K.toe, K.depth - K.toeIn);
  A.box(B, M.oak, a.corner[0], K.toe, 0, a.corner[1], carcassTop, K.depth);
  // Counter (run B's counter covers the corner).
  const aCounterEnd = RUN_A_LEN - counterDepth;
  A.box(B, M.quartz, a.base[0], carcassTop, 0, a.base[1], counterTop, counterDepth);
  A.box(B, M.quartz, a.range[1], carcassTop, 0, aCounterEnd, counterTop, counterDepth);
  // Uppers: over the base, microwave + cabinet over the range, corner cabinet.
  upper(B, M, A, ...a.base, upperBottom, upperTop, 2);
  microwave(B, M, A, ...a.range, upperBottom);
  upper(B, M, A, ...a.range, upperBottom + 1.4, upperTop, 2);
  const cornerFace = RUN_A_LEN - upperDepth;
  upper(B, M, A, a.filler[0], cornerFace, upperBottom, upperTop, 1, { hingeLeft: false });
  A.box(B, M.oak, cornerFace, upperBottom, 0, RUN_A_LEN, upperTop, upperDepth);
  // Backsplash, soffit, outlets.
  A.box(B, M.subway, a.base[0], counterTop, 0, RUN_A_LEN, upperBottom, 0.03);
  A.box(soffit, M.wall, 0, upperTop, 0, RUN_A_LEN, H, 2.06);
  outlet(B, M, A, a.base[0] + 0.6, 3.55);

  // Run B along the west wall. s = 0 at the south wall, increasing north; t out from the wall.
  const Bf = new Frame(WEST, SOUTH, [0, -1], [1, 0]);
  const b = { corner: [0, 2.0], base: [2.0, 3.0], sink: [3.0, 5.75], dw: [5.75, 7.75], end: [7.75, RUN_B_LEN] };
  base(B, M, Bf, ...b.base, { count: 1, hingeLeft: false });
  base(B, M, Bf, ...b.sink, { count: 2, falseFront: true });
  dishwasher(B, M, Bf, ...b.dw);
  Bf.box(B, M.oak, b.end[0], 0, 0, b.end[1], carcassTop, counterDepth);
  // Counter with an undermount sink opening.
  const sc = (b.sink[0] + b.sink[1]) / 2, ss0 = sc - 1.1, ss1 = sc + 1.1, st0 = 0.38, st1 = 1.76;
  Bf.box(B, M.quartz, 0, carcassTop, 0, ss0, counterTop, counterDepth);
  Bf.box(B, M.quartz, ss1, carcassTop, 0, RUN_B_LEN, counterTop, counterDepth);
  Bf.box(B, M.quartz, ss0, carcassTop, 0, ss1, counterTop, st0);
  Bf.box(B, M.quartz, ss0, carcassTop, st1, ss1, counterTop, counterDepth);
  sinkBowl(B, M, Bf, ss0, ss1, st0, st1);
  faucet(B, M, Bf, sc, 0.2);
  // Three double-door uppers from the corner to the north end.
  const u0 = upperDepth, uw = (RUN_B_LEN - u0) / 3;
  for (let i = 0; i < 3; i++) upper(B, M, Bf, u0 + i * uw, u0 + (i + 1) * uw, upperBottom, upperTop, 2);
  Bf.box(B, M.subway, 0, counterTop, 0, RUN_B_LEN, upperBottom, 0.03);
  Bf.box(soffit, M.wall, upperDepth + 0.06, upperTop, 0, RUN_B_LEN, H, 1.06);
  outlet(B, M, Bf, 2.5, 3.55);
  outlet(B, M, Bf, 6.75, 3.55);

  return { solid: B.build(), soffit: soffit.build() };
}
