import * as THREE from 'three';
import { Batch } from './kit.js';
import { paint, floorMaterial } from './materials.js';

// The shell of a built unit (src/unit.js buildUnit): walls, floors, ceilings,
// trim, windows, doors and balcony railings, all placed from U alone.
//
// Walls come from U's wall grid as boxes. Everything else is built in a local
// frame through a matrix: a room edge or an opening runs s along the wall
// (direction u), t across it (n, out of the room), y up. So a wall at any
// angle gets the same casings, frames and doors as a square one.

const DOOR_T = 0.146;     // 1¾" door leaf
const CASING_W = 0.29;    // 3½" flat casing
const CASING_T = 0.06;
const BASE_H = 0.42;      // 5" baseboard
const BASE_T = 0.045;
const RAIL_H = 3.5;       // 42" guard rail
const STEP = 1 / 48;      // sampling step along walls
const CLOSETS = new Set(['closet', 'storage', 'pantry']);
const HARD_FLOORS = new Set(['tile', 'stone']);  // no baseboards on these
const UP = new THREE.Vector3(0, 1, 0);

const v3 = (d) => new THREE.Vector3(d[0], 0, d[1]);
const along = (p, u, n, s, t) => [p[0] + u[0] * s + n[0] * t, p[1] + u[1] * s + n[1] * t];
const aligned = (u) => Math.abs(u[0]) < 1e-6 || Math.abs(u[1]) < 1e-6;

// Local (s, y, t) to world: origin p, s along u, t along n.
function frame(p, u, n) {
  return new THREE.Matrix4().makeBasis(v3(u), UP, v3(n)).setPosition(p[0], 0, p[1]);
}

// Where the wall face behind a room edge really is, along the edge's outward
// normal. Walls are grid cells, so a square face sits on the grid line nearest
// the edge. An angled face is a staircase of cells, so a skin is laid just in
// front of it and that is the face.
function faceOffset(U, p, u, n) {
  const { x0, z0, res } = U.grid;
  if (!aligned(u)) return -0.75 * res;
  if (Math.abs(u[0]) > 0.5) return (z0 + Math.round((p[1] - z0) / res) * res - p[1]) * n[1];
  return (x0 + Math.round((p[0] - x0) / res) * res - p[0]) * n[0];
}

// Runs along a line (from p along u, `off` out along n) where key(x, z) gives
// the same non-null value: [{ s0, s1, key }].
function runs(p, u, n, s0, s1, off, key) {
  const out = [];
  let cur = null;
  for (let s = s0 + STEP / 2; s < s1; s += STEP) {
    const [x, z] = along(p, u, n, s, off);
    const k = key(x, z, s);
    if (cur && k === cur.key) { cur.s1 = Math.min(s1, s + STEP / 2); continue; }
    if (cur) out.push(cur);
    cur = k == null ? null : { s0: Math.max(s0, s - STEP / 2), s1: Math.min(s1, s + STEP / 2), key: k };
  }
  if (cur) out.push(cur);
  return out;
}

// A flat polygon on the floor (facing up) or ceiling (facing down).
function shapeGeo(poly, y, facingUp) {
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, facingUp ? -z : z)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(facingUp ? -Math.PI / 2 : Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

// ---------------------------------------------------------------------------
export function buildArchitecture(M, U) {
  const B = {
    walls: new Batch('walls'), caps: new Batch('wall-tops'), floors: new Batch('floors'),
    ceil: new Batch('ceilings'), trim: new Batch('trim'), glass: new Batch('glass'),
  };
  const ctx = {
    M, U, ...B,
    H: U.heights, res: U.grid.res,
    wallMat: paint(U.finishes.walls),
    floorOf: (room) => floorMaterial(M, room.floor, { tile: U.finishes.tile }),
    // Jamb liners stand this far proud of the nominal opening, enough to hide
    // the wall grid's steps.
    JL: Math.max(0.045, 0.75 * U.grid.res + 0.015),
  };

  buildWalls(ctx);
  buildSlab(ctx);
  for (const r of U.rooms) B.floors.add(shapeGeo(r.poly, 0, true), ctx.floorOf(r));
  buildCeilings(ctx);
  for (const e of U.edges) buildEdge(ctx, e);
  const doors = [];
  for (const o of U.openings) buildOpening(ctx, o, doors);

  const walls = B.walls.build();
  // Dark back faces read as solid wall cuts when the dollhouse slices walls.
  const cutCaps = new THREE.Group();
  cutCaps.name = 'wall-cuts';
  walls.children.forEach((m) => cutCaps.add(new THREE.Mesh(m.geometry, M.wallCap)));
  cutCaps.visible = false;
  const floors = B.floors.build({ shadows: false });
  floors.children.forEach((m) => { m.userData.floor = true; });

  const out = {
    walls, cutCaps,
    tops: B.caps.build({ shadows: false }),
    floors,
    ceilings: B.ceil.build({ shadows: true }),
    trim: B.trim.build(),
    glass: B.glass.build({ shadows: false }),
    doors,
    dispose() {
      const geos = new Set();
      for (const g of [out.walls, out.cutCaps, out.tops, out.floors, out.ceilings, out.trim, out.glass, ...doors.map((d) => d.pivot)]) {
        g.traverse((o) => { if (o.geometry) geos.add(o.geometry); });
      }
      geos.forEach((g) => g.dispose());
    },
  };
  return out;
}

// ---------------------------------------------------------------------------
// Walls, with dark caps on top for the dollhouse view.
function buildWalls({ U, M, H, walls, caps, wallMat }) {
  for (const { rect: [x0, z0, x1, z1], solid } of U.wallBoxes) {
    for (const [y0, y1] of solid) walls.box(wallMat, x0, y0, z0, x1, y1, z1);
    const top = solid[solid.length - 1][1];
    if (top >= H.ceiling - 0.01) caps.box(M.wallTop, x0, top, z0, x1, top + 0.02, z1);
  }
}

// A slab under the unit's footprint (rooms, walls, doorways) with a 3" lip.
function buildSlab({ U, M, floors }) {
  const y0 = -0.6, y1 = -0.01;
  if (U.empty) {
    const b = U.bounds;
    floors.box(M.slab, b.x0 - 0.25, y0, b.z0 - 0.25, b.x1 + 0.25, y1, b.z1 + 0.25);
    return;
  }
  const { x0, z0, res, nx, nz, room, prof, pass } = U.grid;
  const N = nx * nz, k = Math.max(1, Math.round(0.25 / res));
  const mask = new Uint8Array(N);
  for (let c = 0; c < N; c++) if (room[c] >= 0 || prof[c] > 0 || pass[c]) mask[c] = 1;
  // Grow the footprint by k cells: rows, then columns.
  const tmp = new Uint8Array(N), foot = new Uint8Array(N);
  const pre = new Int32Array(Math.max(nx, nz) + 1);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) pre[i + 1] = pre[i] + mask[j * nx + i];
    for (let i = 0; i < nx; i++) tmp[j * nx + i] = pre[Math.min(nx, i + k + 1)] - pre[Math.max(0, i - k)] > 0 ? 1 : 0;
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) pre[j + 1] = pre[j] + tmp[j * nx + i];
    for (let j = 0; j < nz; j++) foot[j * nx + i] = pre[Math.min(nz, j + k + 1)] - pre[Math.max(0, j - k)] > 0 ? 1 : 0;
  }
  // Greedy rectangles over the footprint.
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!foot[j * nx + i]) continue;
      let i2 = i;
      while (i2 + 1 < nx && foot[j * nx + i2 + 1]) i2++;
      let j2 = j;
      grow: while (j2 + 1 < nz) {
        for (let ii = i; ii <= i2; ii++) if (!foot[(j2 + 1) * nx + ii]) break grow;
        j2++;
      }
      for (let jj = j; jj <= j2; jj++) foot.fill(0, jj * nx + i, jj * nx + i2 + 1);
      floors.box(M.slab, x0 + i * res, y0, z0 + j * res, x0 + (i2 + 1) * res, y1, z0 + (j2 + 1) * res);
    }
  }
}

// Ceilings for indoor rooms at their own heights. The recessed cans in them
// are src/lighting.js's: they switch on and off by room.
function buildCeilings({ U, M, ceil }) {
  for (const r of U.rooms) if (!r.outdoor) ceil.add(shapeGeo(r.poly, r.ceiling, false), M.ceiling);
}

// ---------------------------------------------------------------------------
// Along one room edge: skins over angled walls, baseboards, slivers of floor
// and ceiling up to the wall face, bulkheads up to a taller ceiling, and
// railings along a balcony's open sides.
function buildEdge(ctx, e) {
  const { U, M, H, res, walls, caps, floors, ceil, trim, wallMat } = ctx;
  const r = U.rooms[e.roomIndex];
  const square = aligned(e.u);
  const f = faceOffset(U, e.p, e.u, e.n);
  const m = frame(e.p, e.u, e.n);
  const all = [walls, caps, floors, ceil, trim, ctx.glass];
  all.forEach((b) => b.push(m));

  const wallRuns = runs(e.p, e.u, e.n, 0, e.len, Math.max(1 / 12, f + res / 2), (x, z) => U.wallAt(x, z));
  for (const { s0, s1, key: solid } of wallRuns) {
    const top = solid[solid.length - 1][1];
    const onFloor = solid[0][0] < 0.05;
    if (!square) {
      // Skin the stepped face. An outside wall is skinned on both faces as
      // one slab, run on to meet the outside faces of the walls beside it.
      const out = outerFace(U, e, s0, s1, f);
      const a = out && s0 < 1e-3 ? s0 - out.start : s0, b = out && s1 > e.len - 1e-3 ? s1 + out.end : s1;
      const t1 = out ? out.t : res;
      for (const [y0, y1] of solid) walls.box(wallMat, a, y0, f, b, y1, t1);
      if (top >= H.ceiling - 0.01) caps.box(M.wallTop, a, top, f, b, top + 0.02, t1);
      // And the slab's lip below it.
      if (out) floors.box(M.slab, a, -0.6, 0, b, -0.01, t1 + 0.25 * (Math.abs(e.n[0]) + Math.abs(e.n[1])) + res);
    } else if (f > 0.002) {
      // The wall face sits a hair behind the outline: fill the sliver.
      if (onFloor) floors.box(ctx.floorOf(r), s0, -0.02, -0.01, s1, -0.003, f + 0.01);
      if (!r.outdoor && top >= r.ceiling - 0.01) ceil.box(M.ceiling, s0, r.ceiling + 0.003, -0.01, s1, r.ceiling + 0.02, f + 0.01);
    }
    if (onFloor && !r.outdoor && !HARD_FLOORS.has(r.floor)) {
      trim.box(M.trim, s0, 0, f - BASE_T, s1, Math.min(BASE_H, solid[0][1]), f + res);
    }
  }

  // A room taller than what lies beyond this edge gets a bulkhead up to its ceiling.
  if (!r.outdoor && r.ceiling > H.ceiling + 0.01) {
    // Key: what's beyond and its height; for a square wall also how many
    // cells thick it is there, so the bulkhead follows the wall below.
    const beyond = (x, z, s) => {
      const w = U.wallAt(x, z);
      if (w) return `${w[w.length - 1][1]}|${square ? Math.round((depth(U, e, s, f) - f) / res) : 'w'}`;
      // Through a full-height doorway, the room on its far side.
      let o = U.roomAt(x, z);
      for (let t = 0.25; !o && U.insideUnit(x, z) && t < 2; t += 0.25) o = U.roomAt(...along(e.p, e.u, e.n, s, t));
      return o && !o.outdoor ? `${o.ceiling}|room` : null;
    };
    for (const { s0, s1, key } of runs(e.p, e.u, e.n, 0, e.len, Math.max(1 / 12, f + res / 2), beyond)) {
      const [b, d] = key.split('|');
      if (+b >= r.ceiling - 0.01) continue;
      // A hair proud of the wall faces below, so the wall's dark cap inside
      // it never shows through.
      const t0 = d === 'room' ? -0.02 : f - 0.004;
      const t1 = d === 'room' ? 0.02 : (d === 'w' ? depth(U, e, (s0 + s1) / 2, f) + 1.1 * res : f + +d * res) + 0.004;
      // Run on round outside corners to meet the next bulkhead.
      const [prev, next] = d === 'room' ? [null, null] : neighbours(U, e);
      const a = s0 < 1e-3 ? s0 - cornerExt(U, e, prev, -1, t1) : s0, c = s1 > e.len - 1e-3 ? s1 + cornerExt(U, e, next, 1, t1) : s1;
      walls.box(wallMat, a, +b, t0, c, r.ceiling, t1);
      caps.box(M.wallTop, a, r.ceiling, t0, c, r.ceiling + 0.02, t1);
    }
  }

  if (r.outdoor) {
    const open = (x, z) => (!U.isWallAt(x, z) && !U.insideUnit(x, z) ? true : null);
    for (const { s0, s1 } of runs(e.p, e.u, e.n, 0, e.len, 0.15, open)) if (s1 - s0 > 0.3) railing(ctx, s0, s1);
  }
  all.forEach((b) => b.pop());
}

// How far the wall reaches beyond an edge at s (from its face f), to ¼ cell.
// Capped at about an outside wall's thickness, so a wall running away at a
// T-junction doesn't count.
function depth(U, e, s, f) {
  const res = U.grid.res, step = res / 4;
  const cap = f + Math.max(0.375, U.spec.exteriorWall ?? 0.667) * (Math.abs(e.n[0]) + Math.abs(e.n[1])) + 2 * res;
  // An angled face is stepped, so start a cell in, past the room's last cells.
  let t = (aligned(e.u) ? f : res) + step;
  while (t < cap && U.isWallAt(...along(e.p, e.u, e.n, s, t))) t += step;
  return Math.min(t, cap);
}

// For an angled edge backed by an outside wall: where that wall's outer face
// is ({ t }), and how far past each end of the edge it runs before meeting the
// outer face of the wall beside it. Null when the wall has a room behind it.
function outerFace(U, e, s0, s1, f) {
  const res = U.grid.res;
  const ds = [0.1, 0.3, 0.5, 0.7, 0.9].map((k) => depth(U, e, s0 + (s1 - s0) * k, f)).sort((p, q) => p - q);
  const D = ds[2];
  const past = along(e.p, e.u, e.n, (s0 + s1) / 2, D + 0.3);
  if (U.isWallAt(...past) || U.insideUnit(...past) || U.roomAt(...past)) return null;
  const t = D + 1.1 * res;
  const outside = (nb) => {
    if (!nb) return null;
    const sn = nb.q === e.p ? Math.max(0, nb.len - 0.4) : Math.min(nb.len, 0.4);
    const pn = along(nb.p, nb.u, nb.n, sn, depth(U, nb, sn, faceOffset(U, nb.p, nb.u, nb.n)) + 0.3);
    return U.isWallAt(...pn) || U.insideUnit(...pn) || U.roomAt(...pn) ? null : nb;
  };
  const [prev, next] = neighbours(U, e);
  return { t, start: cornerExt(U, e, outside(prev), -1, t), end: cornerExt(U, e, outside(next), 1, t) };
}

// The edges before and after this one around its room.
function neighbours(U, e) {
  return [U.edges.find((x) => x.roomIndex === e.roomIndex && x.q === e.p), U.edges.find((x) => x.roomIndex === e.roomIndex && x.p === e.q)];
}

// How far a slab t thick behind edge e must run past its start (sign -1) or
// end (+1) to meet the far face of the wall behind the neighbouring edge nb.
function cornerExt(U, e, nb, sign, t) {
  if (!nb) return 0;
  const sn = sign < 0 ? Math.max(0, nb.len - 0.4) : Math.min(nb.len, 0.4);
  const Dn = depth(U, nb, sn, faceOffset(U, nb.p, nb.u, nb.n)) + (aligned(nb.u) ? 0 : 1.1 * U.grid.res);
  const un = e.u[0] * nb.n[0] + e.u[1] * nb.n[1];
  if (Math.abs(un) < 0.05) return 0;
  const sAt = (Dn - t * (e.n[0] * nb.n[0] + e.n[1] * nb.n[1])) / un;
  return Math.min(3, Math.max(0, sign * sAt));
}

// A 42" glass guard rail inside the edge, posts at most 5' apart. Posts sit
// 2" in from each end so railings meeting at a corner share one.
function railing({ M, trim, glass }, s0, s1) {
  const t = -0.17, inset = 0.17;
  const a = s0 + inset, b = s1 - inset;
  const n = Math.max(1, Math.ceil((b - a) / 5));
  const posts = Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  for (const s of posts) trim.box(M.black, s - 0.07, 0, t - 0.07, s + 0.07, RAIL_H - 0.08, t + 0.07);
  trim.box(M.black, a - 0.09, RAIL_H - 0.1, t - 0.1, b + 0.09, RAIL_H, t + 0.1);
  trim.box(M.black, a, 0.22, t - 0.035, b, 0.3, t + 0.035);
  for (let i = 0; i < n; i++) glass.box(M.showerGlass, posts[i] + 0.09, 0.32, t - 0.02, posts[i + 1] - 0.09, RAIL_H - 0.12, t + 0.02);
}

// ---------------------------------------------------------------------------
// Openings

// The two wall faces of an opening, as t in its frame: room A's side and the far side.
function faces(U, o) {
  const res = U.grid.res;
  const tA = faceOffset(U, o.p, o.u, o.n);
  if (aligned(o.u)) {
    // Count wall cells straight through, above or beside the opening.
    const most = Math.ceil((o.t1 + 2 * res) / res);
    for (const s of [(o.a + o.b) / 2, o.a - 1.5 * res, o.b + 1.5 * res]) {
      let k = 0;
      while (k <= most && U.isWallAt(...o.world(s, tA + (k + 0.5) * res))) k++;
      if (k && k <= most) return [tA, tA + k * res];
    }
    return [tA, o.t1];
  }
  // Angled: the far room's parallel edge (its skin), else the measured depth.
  const mid = o.world((o.a + o.b) / 2, 0);
  let best = null;
  for (const e of U.edges) {
    if (e.room !== o.rooms[1] || Math.abs(e.u[0] * o.u[0] + e.u[1] * o.u[1]) < 0.999) continue;
    const d = (e.p[0] - mid[0]) * o.n[0] + (e.p[1] - mid[1]) * o.n[1];
    const s = (mid[0] - e.p[0]) * e.u[0] + (mid[1] - e.p[1]) * e.u[1];
    if (d > 0 && d < o.t1 + 2 * res && s > -0.5 && s < e.len + 0.5 && (best === null || d < best)) best = d;
  }
  return [tA, best !== null ? best + 0.75 * res : o.t1 + 0.25 * res];
}

function buildOpening(ctx, o, doors) {
  const { U, M, res, floors, trim, ceil } = ctx;
  const A = U.roomById[o.rooms[0]], Bm = o.rooms[1] ? U.roomById[o.rooms[1]] : null;
  const [tA, tB] = faces(U, o);
  const m = frame(o.p, o.u, o.n);
  const sides = { A, B: Bm, tA, tB };
  if (o.kind === 'window') { buildWindow(ctx, o, m, sides); return; }

  const { a, b, head } = o;
  const JL = ctx.JL;
  const lowCeil = Math.min(...[A, Bm].filter((r) => r && !r.outdoor).map((r) => r.ceiling), ctx.H.ceiling);
  const headed = head < ctx.H.ceiling - 0.01;

  // Floor through the doorway: the indoor neighbour's floor, with a stone
  // saddle at a bathroom door.
  const from = [A, Bm].find((r) => r && !r.outdoor) ?? A;
  const bath = [A, Bm].filter((r) => r?.kind === 'bath').length === 1;
  floors.push(m);
  floors.box(ctx.floorOf(from), a - res, -0.02, Math.min(tA, 0) - 0.01, b + res, -0.006, Math.max(tB, o.t1) + 0.01);
  if (bath) floors.box(M.marble, a, -0.02, tA, b, 0.03, tB);
  floors.pop();
  // A full-height opening has no wall above it: carry the ceiling across.
  if (!headed && !(A?.outdoor || Bm?.outdoor)) {
    ceil.push(m);
    ceil.box(M.ceiling, a - res, lowCeil + 0.002, tA - 0.01, b + res, lowCeil + 0.02, tB + 0.01);
    ceil.pop();
  }

  trim.push(m);
  const outside = (r) => r?.outdoor || (!r && o.type === 'slider');
  if (o.type === 'slider') {
    // Patio door frame: drywall returns, no wood jambs.
    ctx.walls.push(m);
    liner(ctx.walls, ctx.wallMat, o, 0, head, tA, tB, JL, headed, false, res);
    ctx.walls.pop();
  } else {
    liner(trim, M.trim, o, 0, head, tA, tB, JL, headed, false, res);
  }
  if (!outside(A)) casing(ctx, o, tA, -1, A, JL, headed);
  if (!outside(Bm)) casing(ctx, o, tB, 1, Bm, JL, headed);

  const kind = o.type;
  if (kind === 'door' || kind === 'entry' || kind === 'double') doors.push(swingDoor(ctx, o, m, sides));
  else if (kind === 'pocket') pocketDoor(ctx, o, sides);
  else if (kind === 'barn') barnDoor(ctx, o, sides);
  else if (kind === 'bifold') bifold(ctx, o, sides);
  else if (kind === 'closet-slider') closetSlider(ctx, o, sides);
  else if (kind === 'slider') patioSlider(ctx, o, m, sides);
  trim.pop();
}

// Jamb liners (and head and sill) lining the cut through the wall. They stand
// JL proud of the opening's nominal edges, covering the wall grid's steps.
function liner(batch, mat, o, y0, y1, tA, tB, JL, head, sill, res) {
  const { a, b } = o;
  batch.box(mat, a - res, y0, tA, a + JL, y1, tB);
  batch.box(mat, b - JL, y0, tA, b + res, y1, tB);
  if (head) batch.box(mat, a, y1 - JL, tA, b, y1 + res, tB);
  if (sill) batch.box(mat, a, y0 - res, tA, b, y0 + JL, tB);
}

// Flat casing on one face: dir -1 is room A's face (at tA), +1 the far face.
// Legs stop where the wall beside the opening ends.
function casing({ U, M, H, trim, res }, o, tf, dir, room, JL, headed) {
  // Probe just inside the wall; an angled face is a skin in front of steps.
  const inWall = tf - dir * (aligned(o.u) ? 0.5 : 1.75) * res;
  const reach = (s0, sgn) => {
    let x = 0;
    while (x < CASING_W && U.isWallAt(...o.world(s0 + sgn * (x + STEP / 2), inWall))) x += STEP;
    return Math.min(x, CASING_W);
  };
  const la = reach(o.a, -1), lb = reach(o.b, 1);
  const ceiling = (room && !room.outdoor ? room.ceiling : H.ceiling) - 0.005;
  const hb = o.head - JL + 0.012;
  const top = Math.min(headed ? hb + CASING_W : o.head, ceiling);
  const t0 = tf + dir * CASING_T, t1 = tf - dir * res;
  const inner = JL - 0.012;
  if (la > 0.02) trim.box(M.trim, o.a - la, 0, t0, o.a + inner, top, t1);
  if (lb > 0.02) trim.box(M.trim, o.b - inner, 0, t0, o.b + lb, top, t1);
  if (headed && top - hb > 0.08) trim.box(M.trim, o.a - la, hb, t0, o.b + lb, top, t1);
}

// ---------------------------------------------------------------------------
// Windows: frame, glass, mullions, an optional transom bar, an operable sash
// on the narrower end pane when there are mullions, and an interior stool and
// apron. Built from the room side: t' = 0 at the interior face, growing out.
function buildWindow(ctx, o, m0, { A, B, tA, tB }) {
  const { M, trim, glass, walls, wallMat, JL } = ctx;
  const { a, b, sill, head } = o;
  walls.push(m0);
  liner(walls, wallMat, o, sill, head, tA, tB, JL, true, true, ctx.res);
  walls.pop();

  const flip = A?.outdoor && B && !B.outdoor;
  const origin = o.world(0, flip ? tB : tA);
  const m = frame(origin, o.u, flip ? [-o.n[0], -o.n[1]] : o.n);
  trim.push(m); glass.push(m);
  const D = Math.abs(tB - tA);
  const oo = Math.min(0.1, D * 0.14);
  const fd = Math.max(0.06, Math.min(0.32, D - oo - 0.04));
  const f1 = Math.max(fd + 0.02, D - oo), f0 = f1 - fd;
  const fw = 0.17;
  const F = M.windowFrame;
  trim.box(F, a, sill, f0, a + fw, head, f1);
  trim.box(F, b - fw, sill, f0, b, head, f1);
  trim.box(F, a, head - fw, f0, b, head, f1);
  trim.box(F, a, sill, f0, b, sill + fw, f1);
  const tr = o.transom;
  if (tr) trim.box(F, a, tr - 0.13, f0, b, tr + 0.13, f1);
  const cols = [a, ...(o.mullions ?? []).map((x) => a + x * (b - a)), b];
  for (let i = 1; i < cols.length - 1; i++) trim.box(F, cols[i] - 0.1, sill, f0, cols[i] + 0.1, head, f1);
  if (cols.length > 2) {
    const n = cols.length;
    const last = cols[n - 1] - cols[n - 2] <= cols[1] - cols[0];
    const s0 = last ? cols[n - 2] + 0.1 : a + fw, s1 = last ? b - fw : cols[1] - 0.1;
    // The sash opens in the taller of the panes above and below a transom.
    const upper = !tr || head - tr >= tr - sill;
    const y0 = !tr ? sill + fw : upper ? tr + 0.13 : sill + fw, y1 = !tr || upper ? head - fw : tr - 0.13, sw = 0.11;
    const z0 = f0 + fd * 0.125, z1 = f0 + fd * 0.6875;
    trim.box(F, s0, y0, z0, s0 + sw, y1, z1);
    trim.box(F, s1 - sw, y0, z0, s1, y1, z1);
    trim.box(F, s0, y0, z0, s1, y0 + sw, z1);
    trim.box(F, s0, y1 - sw, z0, s1, y1, z1);
    // Latch on the side away from the mullion.
    const hs = last ? s1 - sw : s0 + sw;
    const ly = upper ? y0 + 0.25 : y1 - 0.5;
    trim.box(M.black, hs - 0.025, ly, f0, hs + 0.025, ly + 0.25, z0);
  }
  glass.box(M.glass, a, sill, f0 + fd * 0.5 - 0.01, b, head, f0 + fd * 0.5 + 0.01);
  // Interior stool and apron.
  if (sill > 0.35) {
    trim.box(M.trim, a - 0.17, sill - 0.06, -0.1, b + 0.17, sill + 0.012, f0);
    if (sill > 0.6) trim.box(M.trim, a - 0.1, sill - 0.32, -0.04, b + 0.1, sill - 0.06, 0.01);
  }
  trim.pop(); glass.pop();
}

// ---------------------------------------------------------------------------
// Hinged doors are their own objects so they can swing. The pivot holds one
// hinge group per leaf; apply() turns each about its hinge.
function swingDoor(ctx, o, m, { A, B, tA, tB }) {
  const { M, JL } = ctx;
  const sigma = o.swing;
  const tS = sigma > 0 ? tB : tA;              // the face the leaf swings out of
  const into = sigma > 0 ? [-o.n[0], -o.n[1]] : o.n;   // from that face into the wall
  const clear = o.b - o.a - 2 * JL;
  const pairs = o.type === 'double'
    ? [['a', clear / 2 - 0.006], ['b', clear / 2 - 0.006]]
    : [[o.hinge, clear - 0.008]];
  const pivot = new THREE.Group();
  pivot.name = `door-${o.id}`;
  const hinges = [];
  for (const [end, width] of pairs) {
    const e = end === 'a' ? o.u : [-o.u[0], -o.u[1]];
    const at = o.world(end === 'a' ? o.a + JL : o.b - JL, tS);
    const g = new THREE.Group();
    g.position.set(at[0], 0, at[1]);
    const leafBatch = new Batch(`door-${o.id}-${end}`);
    leafBatch.push(new THREE.Matrix4().makeBasis(v3(e), UP, v3(into)));
    leaf(leafBatch, M, o, width, sigma, end === 'a' && o.type === 'double');
    const leafGroup = leafBatch.build();
    leafGroup.traverse((x) => { if (x.isMesh) x.userData.doorId = o.id; });
    g.add(leafGroup);
    pivot.add(g);
    // Turning about +y moves e toward (e.z, -e.x); swing toward sigma * n.
    const k = Math.sign((e[1] * o.n[0] - e[0] * o.n[1]) * sigma) || 1;
    hinges.push({ g, k });
  }
  const closet = [A, B].some((r) => r && CLOSETS.has(r.kind));
  const door = {
    id: o.id, name: o.name, pivot, width: o.width,
    angle: o.open, target: o.open,
    openTo: o.open > 10 ? o.open : closet ? 80 : 90,
    closedPoly: o.poly,
    apply() { for (const h of hinges) h.g.rotation.y = h.k * THREE.MathUtils.degToRad(this.angle); },
  };
  door.apply();
  return door;
}

// One leaf in its hinge frame: x from the hinge across the opening, z from
// the swing face into the wall, y up.
function leaf(b, M, o, width, sigma, astragal) {
  const H = o.head;
  const z0 = 0.03, z1 = z0 + DOOR_T;
  b.box(M.door, 0.005, 0.03, z0, width, H - 0.03, z1);
  // On a pair, a strip on one leaf covers the gap where they meet.
  if (astragal) for (const [t0, t1] of [[z0 - 0.012, z0], [z1, z1 + 0.012]]) b.box(M.door, width - 0.03, 0.03, t0, width + 0.06, H - 0.03, t1);
  const lx = width - 0.23, ly = 3.0;
  for (const side of [-1, 1]) {
    const zf = side < 0 ? z0 : z1;
    b.rod(M.black, [lx, ly, zf], [lx, ly, zf + side * 0.02], 0.09, 20);
    b.rod(M.black, [lx, ly, zf], [lx, ly, zf + side * 0.19], 0.032);
    b.box(M.black, lx - 0.4, ly - 0.028, zf + side * 0.16, lx + 0.03, ly + 0.028, zf + side * 0.22);
  }
  for (const hy of [0.7, H / 2 - 0.15, H - 0.95]) {
    b.box(M.black, -0.012, hy, z0 - 0.004, 0.02, hy + 0.29, z1 + 0.004);
    b.cyl(M.black, 0, hy, z0 - 0.012, 0.022, 0.29, 10);
  }
  if (o.type === 'entry') {
    // Deadbolt above the lever: thumb turn inside, key cylinder outside; a peephole.
    const inside = sigma < 0 ? -1 : 1;   // the face toward room A
    for (const side of [-1, 1]) {
      const zf = side < 0 ? z0 : z1;
      b.rod(M.black, [lx, ly + 0.45, zf], [lx, ly + 0.45, zf + side * 0.03], 0.085, 20);
      if (side === inside) b.box(M.black, lx - 0.016, ly + 0.45 - 0.07, zf + side * 0.03, lx + 0.016, ly + 0.45 + 0.07, zf + side * 0.07);
      else b.rod(M.steelBrushed, [lx, ly + 0.45, zf + side * 0.03], [lx, ly + 0.45, zf + side * 0.045], 0.045, 16);
    }
    b.rod(M.black, [width / 2, 4.95, z0 - 0.012], [width / 2, 4.95, z1 + 0.012], 0.03, 12);
  }
}

// Pocket door: the leaf is in the wall; only its edge and pull show at the jamb.
function pocketDoor({ M, trim, JL }, o, { tA, tB }) {
  const c = (tA + tB) / 2, ps = o.hinge === 'a' ? -1 : 1;
  const jamb = ps < 0 ? o.a + JL : o.b - JL;
  const edge = jamb - ps * 0.06;
  trim.box(M.door, jamb + ps * 0.4, 0.03, c - DOOR_T / 2, edge, o.head - 0.03, c + DOOR_T / 2);
  trim.box(M.black, edge - ps * 0.006, 2.85, c - 0.035, edge + ps * 0.003, 3.45, c + 0.035);
}

// Barn door: a slab hung on the swing side's face, parked beside the
// opening on the hinge side, under a black rail.
function barnDoor({ U, M, trim, H }, o, { A, B, tA, tB }) {
  const sg = o.swing, face = sg > 0 ? tB : tA;
  const room = sg > 0 ? B : A;
  const ceiling = room && !room.outdoor ? room.ceiling : H.ceiling;
  const w = o.b - o.a + 0.3, gap = CASING_T + 0.05, th = 0.125;
  const t0 = face + sg * gap, t1 = face + sg * (gap + th), tm = (t0 + t1) / 2;
  // Park it beside the opening on the hinge side, or the other side when
  // there isn't wall enough there.
  const behind = face - sg * (aligned(o.u) ? 0.04 : 1.75 * U.grid.res);
  const cover = (from) => {
    let n = 0;
    for (let k = 0; k <= 8; k++) n += U.isWallAt(...o.world(from + 0.2 + ((w - 0.55) * k) / 8, behind)) ? 1 : 0;
    return n;
  };
  const left = o.a - w + 0.15, right = o.b - 0.15;
  const pref = o.hinge === 'a' ? [left, right] : [right, left];
  const s0 = cover(pref[0]) >= 8 || cover(pref[0]) >= cover(pref[1]) ? pref[0] : pref[1], s1 = s0 + w;
  const top = Math.min(o.head + 0.25, ceiling - 0.5);
  trim.box(M.oak, s0, 0.06, t0, s1, top, t1);
  // Plank seams on both faces.
  for (let i = 1; i < 4; i++) {
    const s = s0 + (w * i) / 4;
    for (const t of [t0, t1]) trim.box(M.toeKick, s - 0.006, 0.06, t - sg * 0.003, s + 0.006, top, t + sg * 0.003);
  }
  // Rail on standoffs, two wheels, straps down onto the slab.
  const ry = top + 0.18;
  const r0 = Math.min(s0, o.a) - 0.15, r1 = Math.max(s1, o.b) + 0.15;
  trim.box(M.black, r0, ry - 0.05, tm - 0.025, r1, ry + 0.05, tm + 0.025);
  for (const s of [r0 + 0.2, r1 - 0.2]) trim.rod(M.black, [s, ry, face], [s, ry, tm], 0.035);
  for (const s of [s0 + 0.35, s1 - 0.35]) {
    trim.rod(M.black, [s, ry + 0.17, tm - 0.04], [s, ry + 0.17, tm + 0.04], 0.12, 20);
    for (const t of [t0, t1]) trim.box(M.black, s - 0.06, top - 0.55, t, s + 0.06, ry + 0.17, t + sg * 0.02 * (t === t1 ? 1 : -1));
  }
  // Bar pull near the leading edge, both faces.
  const lead = s0 < o.a ? s1 - 0.28 : s0 + 0.28;
  for (const [t, d] of [[t1, sg], [t0, -sg]]) {
    trim.box(M.black, lead - 0.02, 2.75, t + d * 0.06, lead + 0.02, 4.0, t + d * 0.1);
    for (const y of [2.8, 3.95]) trim.box(M.black, lead - 0.015, y - 0.02, t, lead + 0.015, y + 0.02, t + d * 0.07);
  }
}

// Which side of a closet opening faces the room: toward room A is -1.
function roomSide(o, A, B) {
  const minor = (r) => r && (CLOSETS.has(r.kind) || r.minor);
  if (minor(B) && !minor(A)) return -1;
  if (minor(A) && !minor(B)) return 1;
  return -o.swing;
}

// Bifold closet doors: four panels (two in a narrow opening), shown closed.
function bifold({ M, trim, JL }, o, { A, B, tA, tB }) {
  const c = (tA + tB) / 2, dir = roomSide(o, A, B);
  const clear = o.b - o.a - 2 * JL, n = clear < 3.2 ? 2 : 4, gap = 0.02;
  const pw = (clear - gap * (n + 1)) / n;
  const top = o.head - JL - 0.02;
  for (let i = 0; i < n; i++) {
    const s0 = o.a + JL + gap + i * (pw + gap);
    trim.box(M.door, s0, 0.04, c - 0.06, s0 + pw, top, c + 0.06);
  }
  const mid = (o.a + o.b) / 2;
  for (const s of [mid - 0.22, mid + 0.22]) trim.box(M.black, s - 0.02, 3.1, c + dir * 0.06, s + 0.02, 3.75, c + dir * 0.16);
}

// Sliding closet doors: two overlapping panels on a head track.
function closetSlider({ M, trim, JL }, o, { A, B, tA, tB }) {
  const c = (tA + tB) / 2, dir = roomSide(o, A, B);
  const clear = o.b - o.a - 2 * JL, pw = clear / 2 + 0.08;
  const top = o.head - JL - 0.04;
  const sa = o.a + JL, sb = o.b - JL;
  const panel = (p0, p1, t0, t1) => {
    trim.box(M.door, p0, 0.04, t0, p1, top, t1);
    // A raised frame on the room face so each panel reads as a door.
    const tf = t1 + dir * 0.03, fw = 0.22;
    trim.box(M.door, p0, 0.04, t1, p0 + fw, top, tf);
    trim.box(M.door, p1 - fw, 0.04, t1, p1, top, tf);
    trim.box(M.door, p0 + fw, top - fw, t1, p1 - fw, top, tf);
    trim.box(M.door, p0 + fw, 0.04, t1, p1 - fw, 0.04 + fw * 1.4, tf);
  };
  panel(sa, sa + pw, c + dir * 0.01, c + dir * 0.11);
  panel(sb - pw, sb, c - dir * 0.11, c - dir * 0.01);
  // Shadow line where the front panel overlaps the back one.
  trim.box(M.toeKick, sa + pw, 0.04, c - dir * 0.01, sa + pw + 0.012, top, c + dir * 0.025);
  trim.box(M.steelBrushed, sa, top, c - 0.13, sb, o.head - JL, c + 0.13);
  // Finger pulls near the outer edges.
  trim.box(M.black, sa + 0.09, 2.9, c + dir * 0.14, sa + 0.14, 3.5, c + dir * 0.148);
  trim.box(M.black, sb - 0.14, 2.9, c + dir * 0.02, sb - 0.09, 3.5, c + dir * 0.028);
  trim.box(M.steelBrushed, (sa + sb) / 2 - 0.08, 0, c - 0.13, (sa + sb) / 2 + 0.08, 0.05, c + 0.13);
}

// Sliding glass door: a frame with a sill track, one fixed panel outside and
// one sliding panel inside (at the end away from the hinge side).
function patioSlider({ M, trim, glass }, o, m, { A, tA, tB }) {
  glass.push(m);
  const inDir = A && !A.outdoor ? -1 : 1;
  const c = (tA + tB) / 2, depth = Math.max(0.3, Math.min(0.45, Math.abs(tB - tA) - 0.04));
  const f0 = c - depth / 2, f1 = c + depth / 2, fw = 0.14, sillH = 0.08;
  const { a, b, head } = o;
  const F = M.windowFrame;
  trim.box(F, a, 0, f0, a + fw, head, f1);
  trim.box(F, b - fw, 0, f0, b, head, f1);
  trim.box(F, a, head - fw, f0, b, head, f1);
  trim.box(F, a, 0, f0, b, sillH, f1);
  const clear = b - a - 2 * fw, pw = clear / 2 + 0.06;
  const fixedAtA = o.hinge !== 'b';
  const slide = o.open > 0 ? Math.min(1, o.open / 90) * (pw - 0.2) : 0;
  const panel = (s0, tc, operable, lockAt) => {
    const s1 = s0 + pw, y0 = sillH, y1 = head - fw, t0 = tc - 0.055, t1 = tc + 0.055;
    trim.box(F, s0, y0, t0, s0 + 0.16, y1, t1);
    trim.box(F, s1 - 0.16, y0, t0, s1, y1, t1);
    trim.box(F, s0, y1 - 0.16, t0, s1, y1, t1);
    trim.box(F, s0, y0, t0, s1, y0 + 0.28, t1);
    glass.box(M.glass, s0 + 0.16, y0 + 0.28, tc - 0.01, s1 - 0.16, y1 - 0.16, tc + 0.01);
    if (operable) {
      const t = tc + inDir * 0.055;
      trim.box(M.black, lockAt - 0.025, 3.0, t, lockAt + 0.025, 3.9, t + inDir * 0.07);
    }
  };
  const tIn = c + inDir * 0.075, tOut = c - inDir * 0.075;
  if (fixedAtA) {
    panel(a + fw, tOut, false);
    const s0 = b - fw - pw - slide;
    panel(s0, tIn, true, s0 + pw - 0.08);
  } else {
    panel(b - fw - pw, tOut, false);
    const s0 = a + fw + slide;
    panel(s0, tIn, true, s0 + 0.08);
  }
  glass.pop();
}
