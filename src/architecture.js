import * as THREE from 'three';
import { Batch, Frame, DIRS, pointInPoly } from './kit.js';
import { WALLS, ROOMS, HEIGHT, X, Z, UNIT } from './plan.js';
import { openings } from './space.js';

export { openings };

const DOOR_T = 0.146;     // 1¾" door leaf
const CASING_W = 0.29;    // 3½" flat casing
const CASING_T = 0.05;
const BASE_H = 0.42;      // 5" baseboard
const BASE_T = 0.05;


const span = (w) => (w.axis === 'x' ? [w.x0, w.x1] : [w.z0, w.z1]);
const thickness = (w) => (w.axis === 'x' ? w.z1 - w.z0 : w.x1 - w.x0);

// ---------------------------------------------------------------------------
function buildWalls(M, walls, caps) {
  const H = HEIGHT.ceiling;
  for (const w of WALLS) {
    const ops = openings.filter((o) => o.wall === w.id).sort((p, q) => p.a - q.a);
    const [lo, hi] = span(w);
    const piece = (s0, s1, y0, y1) => {
      if (s1 - s0 < 1e-3 || y1 - y0 < 1e-3) return;
      if (w.axis === 'x') walls.box(M.wall, s0, y0, w.z0, s1, y1, w.z1);
      else walls.box(M.wall, w.x0, y0, s0, w.x1, y1, s1);
    };
    let cur = lo;
    for (const o of ops) {
      piece(cur, o.a, 0, H);
      piece(o.a, o.b, 0, o.sill);
      piece(o.a, o.b, o.head, H);
      cur = o.b;
    }
    piece(cur, hi, 0, H);
    caps.box(M.wallTop, w.x0, H, w.z0, w.x1, H + 0.02, w.z1);
  }
}

function shapeGeo(poly, y, facingUp) {
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, facingUp ? -z : z)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(facingUp ? -Math.PI / 2 : Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

function buildFloors(M, floors) {
  for (const r of ROOMS) floors.add(shapeGeo(r.poly, 0, true), r.floor === 'tile' ? M.tileFloor : M.floor);
  // Fill the wall footprint under each doorway; baths get a stone saddle.
  for (const o of openings) {
    if (o.type === 'window') continue;
    const w = o.w;
    const bath = /bath/.test(o.id);
    const mat = bath ? M.marble : M.floor;
    const top = bath ? 0.03 : 0;
    if (w.axis === 'x') floors.box(mat, o.a, -0.02, w.z0, o.b, top, w.z1);
    else floors.box(mat, w.x0, -0.02, o.a, w.x1, top, o.b);
  }
}

function buildCeilings(M, ceil) {
  for (const r of ROOMS) ceil.add(shapeGeo(r.poly, r.ceiling ?? HEIGHT.ceiling, false), M.ceiling);
}

// Wall faces that line each room edge, as intervals along the edge.
export function roomEdges(room) {
  const out = [];
  const poly = room.poly;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const horizontal = Math.abs(az - bz) < 1e-6;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    let n = horizontal ? [0, 1] : [1, 0];
    if (!pointInPoly(mx + n[0] * 0.05, mz + n[1] * 0.05, poly)) n = [-n[0], -n[1]];
    const line = horizontal ? az : ax;
    const lo = horizontal ? Math.min(ax, bx) : Math.min(az, bz);
    const hi = horizontal ? Math.max(ax, bx) : Math.max(az, bz);
    const intervals = [];
    for (const w of WALLS) {
      let face, s0, s1;
      if (horizontal) { face = n[1] > 0 ? w.z1 : w.z0; s0 = w.x0; s1 = w.x1; }
      else { face = n[0] > 0 ? w.x1 : w.x0; s0 = w.z0; s1 = w.z1; }
      if (Math.abs(face - line) > 0.03) continue;
      const a = Math.max(lo, s0), b = Math.min(hi, s1);
      if (b - a > 0.01) intervals.push({ a, b, w });
    }
    out.push({ horizontal, line, n, lo, hi, intervals });
  }
  return out;
}

// Subtract door openings from an interval on wall w.
export function minusDoors(a, b, w, types = ['door', 'bifold']) {
  let parts = [[a, b]];
  for (const o of openings) {
    if (o.wall !== w.id || !types.includes(o.type)) continue;
    parts = parts.flatMap(([p, q]) => {
      if (o.b <= p || o.a >= q) return [[p, q]];
      const res = [];
      if (o.a > p) res.push([p, o.a]);
      if (o.b < q) res.push([o.b, q]);
      return res;
    });
  }
  return parts.filter(([p, q]) => q - p > 0.02);
}

// A box lying on a room edge: s along the edge, t out from the wall into the room.
export function edgeBox(batch, mat, edge, s0, s1, y0, y1, t0, t1) {
  const { horizontal, line, n } = edge;
  if (horizontal) batch.box(mat, s0, y0, line + n[1] * t0, s1, y1, line + n[1] * t1);
  else batch.box(mat, line + n[0] * t0, y0, s0, line + n[0] * t1, y1, s1);
}

function buildBaseboards(M, trim) {
  for (const r of ROOMS) {
    if (r.floor === 'tile') continue;
    for (const e of roomEdges(r)) {
      for (const iv of e.intervals) {
        for (const [p, q] of minusDoors(iv.a, iv.b, iv.w)) edgeBox(trim, M.trim, e, p, q, 0, BASE_H, 0, BASE_T);
      }
    }
  }
}

function buildCasings(M, trim) {
  for (const o of openings) {
    if (o.type === 'window') continue;
    const w = o.w;
    const [lo, hi] = span(w);
    const legs = [[Math.max(lo, o.a - CASING_W), o.a], [o.b, Math.min(hi, o.b + CASING_W)]];
    const faces = w.axis === 'x' ? [[w.z0, -1], [w.z1, 1]] : [[w.x0, -1], [w.x1, 1]];
    for (const [f, sgn] of faces) {
      const put = (s0, s1, y0, y1) => {
        if (s1 - s0 < 0.06) return;
        if (w.axis === 'x') trim.box(M.trim, s0, y0, f, s1, y1, f + sgn * CASING_T);
        else trim.box(M.trim, f, y0, s0, f + sgn * CASING_T, y1, s1);
      };
      for (const [s0, s1] of legs) put(s0, s1, 0, o.head + CASING_W);
      put(Math.max(lo, o.a - CASING_W), Math.min(hi, o.b + CASING_W), o.head, o.head + CASING_W);
    }
  }
}

function windowFrame(o) {
  const w = o.w;
  const n = DIRS[w.inside];
  if (w.axis === 'x') return new Frame(0, n[1] > 0 ? w.z0 : w.z1, [1, 0], n);
  return new Frame(n[0] > 0 ? w.x0 : w.x1, 0, [0, 1], n);
}

function buildWindows(M, frames, glass, trim) {
  for (const o of openings) {
    if (o.type !== 'window') continue;
    const F = windowFrame(o);
    const T = thickness(o.w);
    const { a, b, sill, head } = o;
    const fw = 0.17, t0 = 0.1, t1 = 0.42;
    const tr = HEIGHT.transom;
    F.box(frames, M.windowFrame, a, sill, t0, a + fw, head, t1);
    F.box(frames, M.windowFrame, b - fw, sill, t0, b, head, t1);
    F.box(frames, M.windowFrame, a, head - fw, t0, b, head, t1);
    F.box(frames, M.windowFrame, a, sill, t0, b, sill + fw, t1);
    F.box(frames, M.windowFrame, a, tr - 0.13, t0, b, tr + 0.13, t1);
    const cols = [a, ...(o.mullions || []).map((f) => a + f * (b - a)), b];
    for (let i = 1; i < cols.length - 1; i++) F.box(frames, M.windowFrame, cols[i] - 0.1, sill, t0, cols[i] + 0.1, head, t1);
    // Operable sash on the upper pane of the narrower (last) column.
    if (cols.length > 2) {
      const s0 = cols[cols.length - 2] + 0.1, s1 = b - fw, y0 = tr + 0.13, y1 = head - fw, sw = 0.11;
      F.box(frames, M.windowFrame, s0, y0, 0.2, s0 + sw, y1, 0.38);
      F.box(frames, M.windowFrame, s1 - sw, y0, 0.2, s1, y1, 0.38);
      F.box(frames, M.windowFrame, s0, y0, 0.2, s1, y0 + sw, 0.38);
      F.box(frames, M.windowFrame, s0, y1 - sw, 0.2, s1, y1, 0.38);
      F.box(frames, M.black, s1 - sw - 0.02, y0 + 0.25, 0.38, s1 - sw + 0.03, y0 + 0.5, 0.42);
    }
    F.box(glass, M.glass, a, sill, 0.25, b, head, 0.27);
    // Interior stool and apron.
    F.box(trim, M.trim, a - 0.17, sill - 0.06, t1, b + 0.17, sill + 0.012, T + 0.1);
    F.box(trim, M.trim, a - 0.1, sill - 0.32, T, b + 0.1, sill - 0.06, T + 0.04);
  }
}

// ---------------------------------------------------------------------------
// Doors are separate objects so they can swing open and shut.
function buildDoor(o, M) {
  const w = o.w;
  const width = o.b - o.a;
  const sw = DIRS[o.swing];
  const hingeS = o.hinge === 'from' ? o.a : o.b;
  const e = w.axis === 'x' ? [o.hinge === 'from' ? 1 : -1, 0] : [0, o.hinge === 'from' ? 1 : -1];
  const px = w.axis === 'x' ? hingeS : (sw[0] > 0 ? w.x1 : w.x0);
  const pz = w.axis === 'x' ? (sw[1] > 0 ? w.z1 : w.z0) : hingeS;
  const psi = Math.atan2(-e[1], e[0]);
  const lz = [Math.sin(psi), Math.cos(psi)];
  const sigma = Math.abs(lz[0] + sw[0]) < 1e-6 && Math.abs(lz[1] + sw[1]) < 1e-6 ? 1 : -1;

  const b = new Batch(`door-${o.id}`);
  const z0 = sigma > 0 ? 0.03 : -0.03 - DOOR_T, z1 = z0 + DOOR_T;
  const H = HEIGHT.doorHead;
  b.box(M.door, 0.03, 0.03, z0, width - 0.03, H - 0.03, z1);
  const lx = width - 0.23, ly = 3.0;
  for (const side of [-1, 1]) {
    const zf = side < 0 ? z0 : z1;
    b.rod(M.black, [lx, ly, zf], [lx, ly, zf + side * 0.19], 0.032);
    b.cyl(M.black, lx, ly - 0.001, zf, 0.09, 0.001);
    b.box(M.black, lx - 0.4, ly - 0.028, zf + side * 0.16, lx + 0.03, ly + 0.028, zf + side * 0.22);
  }
  for (const hy of [0.7, H / 2, H - 0.9]) b.box(M.black, 0.0, hy, z0 - 0.004, 0.035, hy + 0.29, z1 + 0.004);

  const pivot = new THREE.Group();
  pivot.position.set(px, 0, pz);
  const leaf = b.build();
  leaf.traverse((m) => { if (m.isMesh) m.userData.doorId = o.id; });
  pivot.add(leaf);
  pivot.name = `door-${o.id}`;
  const door = {
    id: o.id, name: o.name, pivot, width,
    angle: o.open, target: o.open,
    apply() { pivot.rotation.y = psi + sigma * THREE.MathUtils.degToRad(this.angle); },
    // Footprint of the closed leaf, used to block walking through shut doors.
    closedRect: w.axis === 'x' ? [o.a, w.z0, o.b, w.z1] : [w.x0, o.a, w.x1, o.b],
  };
  door.apply();
  return door;
}

function buildBifold(o, M, batch) {
  const w = o.w;
  const n = 4, gap = 0.02;
  const pw = (o.b - o.a - gap * (n + 1)) / n;
  const c = w.axis === 'x' ? (w.z0 + w.z1) / 2 : (w.x0 + w.x1) / 2;
  for (let i = 0; i < n; i++) {
    const s0 = o.a + gap + i * (pw + gap), s1 = s0 + pw;
    if (w.axis === 'x') batch.box(M.door, s0, 0.04, c - 0.06, s1, HEIGHT.doorHead - 0.04, c + 0.06);
    else batch.box(M.door, c - 0.06, 0.04, s0, c + 0.06, HEIGHT.doorHead - 0.04, s1);
  }
  // Vertical pulls on the two lead panels, on the room side (`o.face` = -1 for the lower coordinate side).
  const mid = (o.a + o.b) / 2;
  const face = c - 0.06 * (o.face ?? -1) * -1;
  const out = (o.face ?? -1) * 0.1;
  for (const s of [mid - 0.22, mid + 0.22]) {
    if (w.axis === 'x') batch.box(M.black, s - 0.02, 3.1, face, s + 0.02, 3.75, face + out);
    else batch.box(M.black, face, 3.1, s - 0.02, face + out, 3.75, s + 0.02);
  }
}

// ---------------------------------------------------------------------------
// Recessed cans and a supply vent, positioned from the photos (plan px).
const CANS = [
  [960, 455], [960, 610], [736, 520], [640, 560], [740, 610],
  [320, 430], [470, 425], [840, 230], [640, 125], [240, 220],
  [520, 160], [350, 600], [595, 312], [448, 305],
];

function buildCeilingFixtures(M, ceil) {
  for (const [px, pz] of CANS) {
    const x = X(px), z = Z(pz);
    const room = ROOMS.find((r) => pointInPoly(x, z, r.poly));
    const h = room?.ceiling ?? HEIGHT.ceiling;
    ceil.cyl(M.trim, x, h - 0.02, z, 0.3, 0.02, 32);
    ceil.cyl(M.canLight, x, h - 0.026, z, 0.23, 0.008, 32);
  }
  // Linear supply vent near the living room window (visible in the hall photo).
  const vx = X(965), vz = Z(538);
  ceil.box(M.vent, vx - 0.3, HEIGHT.ceiling - 0.03, vz - 0.75, vx + 0.3, HEIGHT.ceiling, vz + 0.75);
  for (let i = 0; i < 9; i++) ceil.box(M.toeKick, vx - 0.24, HEIGHT.ceiling - 0.035, vz - 0.66 + i * 0.16, vx + 0.24, HEIGHT.ceiling - 0.03, vz - 0.6 + i * 0.16);
}

// ---------------------------------------------------------------------------
export function buildArchitecture(M) {
  const walls = new Batch('walls');
  const caps = new Batch('wall-tops');
  const floors = new Batch('floors');
  const ceil = new Batch('ceilings');
  const trim = new Batch('trim');
  const glass = new Batch('glass');

  const { x0, z0, x1, z1 } = UNIT.footprint;
  floors.box(M.slab, x0 - 0.25, -0.6, z0 - 0.25, x1 + 0.25, -0.01, z1 + 0.25);

  buildWalls(M, walls, caps);
  buildFloors(M, floors);
  buildCeilings(M, ceil);
  buildCeilingFixtures(M, ceil);
  buildBaseboards(M, trim);
  buildCasings(M, trim);
  buildWindows(M, trim, glass, trim);

  const doors = [];
  for (const o of openings) {
    if (o.type === 'door') doors.push(buildDoor(o, M));
    if (o.type === 'bifold') buildBifold(o, M, trim);
  }

  const wallGroup = walls.build();
  // Dark back faces read as solid wall cuts when the dollhouse slices walls.
  const cutCaps = new THREE.Group();
  wallGroup.children.forEach((m) => cutCaps.add(new THREE.Mesh(m.geometry, M.wallCap)));
  cutCaps.visible = false;

  const floorGroup = floors.build({ shadows: false });
  floorGroup.children.forEach((m) => { m.userData.floor = true; });

  return {
    walls: wallGroup,
    cutCaps,
    tops: caps.build({ shadows: false }),
    floors: floorGroup,
    ceilings: ceil.build({ shadows: true }),
    trim: trim.build(),
    glass: glass.build({ shadows: false }),
    doors,
  };
}
