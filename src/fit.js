// Will it fit? Overlap, clearance and free-spot checks for placed pieces, used
// by the browser (clearance lines, snapping) and the server (MCP tools). Feet.
// `U` is a built unit (src/unit.js buildUnit). Pieces collide by their parts
// (src/parts.js), so a chair tucks under a table; `assets` (the design's
// custom assets, by id or as a list) gives custom pieces their parts.

import { footprint, isFlat } from './catalog.js';
import { overlap, rectPoly, frontOf, polyBounds } from './geometry.js';
import { pieceBody, pieceParts, placeBody, fixtureParts } from './parts.js';

export { overlap };

// Where a horizontal (axis 0) or vertical (axis 1) line at `c` crosses a
// convex polygon: [lo, hi] along the axis, or null.
function spanAt(poly, axis, c) {
  const o = 1 - axis;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if ((p[o] < c && q[o] < c) || (p[o] > c && q[o] > c)) continue;
    const v = p[o] === q[o] ? [p[axis], q[axis]] : [p[axis] + ((c - p[o]) / (q[o] - p[o])) * (q[axis] - p[axis])];
    for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
  }
  return lo <= hi ? [lo, hi] : null;
}

// Distance from each side of the piece to the nearest wall, fixture or other
// standing piece, along that axis. Measured between the outlines, so a turned
// piece's corner counts, not its bounding box. Each side: { side, axis, sign,
// edge, at, dist }: the gap runs from (edge, at) for dist along the axis.
export function clearances(item, others = [], obstacles = []) {
  const poly = footprint(item), b = polyBounds(poly), square = item.rot % 90 === 0;
  const obs = [
    ...obstacles.map((r) => ({ poly: rectPoly(r), b: r, square: true })),
    ...others.filter((o) => o !== item && o.uid !== item.uid && !isFlat(o))
      .map((o) => { const op = footprint(o); return { poly: op, b: polyBounds(op), square: o.rot % 90 === 0 }; }),
  ];
  const sides = [
    { side: 'east', axis: 0, sign: 1, lo: b[1], hi: b[3] },
    { side: 'west', axis: 0, sign: -1, lo: b[1], hi: b[3] },
    { side: 'south', axis: 1, sign: 1, lo: b[0], hi: b[2] },
    { side: 'north', axis: 1, sign: -1, lo: b[0], hi: b[2] },
  ];
  const out = [];
  for (const s of sides) {
    const o = 1 - s.axis;
    let best = null;
    for (const ob of obs) {
      const ov0 = Math.max(s.lo, ob.b[o]), ov1 = Math.min(s.hi, ob.b[o + 2]);
      if (ov1 - ov0 < 0.02) continue;
      let near = null;
      if (square && ob.square) {
        // Both square to the plan: the gap is the same all along the overlap.
        const edge = s.sign > 0 ? b[s.axis + 2] : b[s.axis];
        near = { edge, at: (ov0 + ov1) / 2, dist: s.sign > 0 ? ob.b[s.axis] - edge : edge - ob.b[s.axis + 2] };
      } else {
        // The gap is convex along the overlap: its least is at an end or a corner.
        const cs = [(ov0 + ov1) / 2, ov0 + 1e-6, ov1 - 1e-6];
        for (const p of [...poly, ...ob.poly]) if (p[o] > ov0 && p[o] < ov1) cs.push(p[o]);
        for (const c of cs) {
          const a = spanAt(poly, s.axis, c), e = spanAt(ob.poly, s.axis, c);
          if (!a || !e) continue;
          const edge = s.sign > 0 ? a[1] : a[0];
          const dist = s.sign > 0 ? e[0] - a[1] : a[0] - e[1];
          if (!near || dist < near.dist - 1e-4) near = { dist, edge, at: c };
        }
      }
      if (!near || near.dist < -0.01) continue;
      if (!best || near.dist < best.dist) best = { ...near, dist: Math.max(0, near.dist) };
    }
    if (best && best.dist < 15) out.push({ side: s.side, axis: s.axis, sign: s.sign, ...best });
  }
  return out;
}

// What is wrong with where a piece sits, as short sentences. Parts that only
// meet, or pass over and under each other (a chair's seat under a table),
// are fine.
export function problems(item, others = [], U = null, assets = null) {
  if (!U) return [];
  const out = [];
  const body = pieceBody(item, assets), parts = placeBody(body, item.x, item.z);
  const box = [item.x + body.box[0], item.z + body.box[1], item.x + body.box[2], item.z + body.box[3]];
  // Corners pulled in a hair, so a piece flush against a wall still counts as inside.
  if (parts.some((p) => inset(p.poly, 0.04).some(([x, z]) => !U.insideUnit(x, z)))) out.push('sticks out past a wall or outside the unit');
  for (const s of collisionShapes(U)) {
    if (s.kind === 'trim' || !meets(parts, [s])) continue;
    out.push(s.kind === 'wall' ? 'runs into a wall' : `overlaps the ${s.name.toLowerCase()}`);
  }
  if (!isFlat(item)) {
    for (const d of U.doorSwings) if (parts.some((p) => overlap(p.poly, d.poly, 0.1))) out.push(`blocks the ${d.name.toLowerCase()} from opening`);
    for (const o of others) {
      if (o === item || o.uid === item.uid || isFlat(o)) continue;
      const ob = pieceBody(o, assets).box;
      if (o.x + ob[0] >= box[2] || o.x + ob[2] <= box[0] || o.z + ob[1] >= box[3] || o.z + ob[3] <= box[1]) continue;
      if (meets(parts, pieceParts(o, assets))) out.push(`overlaps ${o.name}${o.uid ? ` (${o.uid})` : ''}`);
    }
  }
  return [...new Set(out)];
}

// Do any two parts overlap by more than ½" across and in height?
function meets(a, b, tol = 0.04) {
  for (const p of a) for (const q of b) {
    if (Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0) <= tol) continue;
    if (p.aabb[0] >= q.aabb[2] - tol || q.aabb[0] >= p.aabb[2] - tol || p.aabb[1] >= q.aabb[3] - tol || q.aabb[1] >= p.aabb[3] - tol) continue;
    if (overlap(p.poly, q.poly, tol)) return true;
  }
  return false;
}

// A convex outline with its corners pulled in toward its middle by up to r.
function inset(poly, r) {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  return poly.map(([x, z]) => {
    const dx = cx - x, dz = cz - z, len = Math.hypot(dx, dz);
    const k = len > 1e-9 ? Math.min(1, r / len) : 0;
    return [x + dx * k, z + dz * k];
  });
}

// Spots where a w × d piece fits in a room without hitting anything, best first.
// With againstWall, the piece's back is slid up to the nearest wall (its
// baseboard) or fixture.
export function findSpots({ w, d, h = 3, room = null, againstWall = true, items = [], count = 5, type = 'box', U, assets = null }) {
  const match = (r) => r.id === room || r.name.toLowerCase() === String(room).toLowerCase();
  const rooms = room ? U.rooms.filter(match) : U.rooms.filter((r) => !r.minor && !r.outdoor && r.kind !== 'bath');
  const found = [];
  const seen = new Set();
  const step = room ? 0.5 : 1;
  const doors = U.doorSwings.map((s) => { const b = polyBounds(s.poly); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; });
  // Backs go against the baseboard, not into it.
  const againstObstacles = [...U.obstacles, ...trimRects(U)];
  for (const r of rooms) {
    const [x0, z0, x1, z1] = r.bbox;
    for (const rot of [0, 90, 180, 270]) {
      for (let x = x0 + step / 2; x <= x1 - step / 2; x += step) {
        for (let z = z0 + step / 2; z <= z1 - step / 2; z += step) {
          const cand = { type, w, d, h, x, z, rot, uid: '_spot' };
          if (againstWall) {
            const [fx, fz] = frontOf(rot);
            const back = fx > 0.5 ? 'west' : fx < -0.5 ? 'east' : fz > 0.5 ? 'north' : 'south';
            const c = clearances(cand, items, againstObstacles).find((s) => s.side === back);
            if (!c || c.dist > 3) continue;
            if (c.axis === 0) cand.x += c.dist * c.sign; else cand.z += c.dist * c.sign;
          }
          const key = `${rot}:${cand.x.toFixed(2)}:${cand.z.toFixed(2)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!footprint(cand, -0.04).every(([px, pz]) => U.roomAt(px, pz)?.id === r.id)) continue;
          if (problems(cand, items, U, assets).length) continue;
          // Keep spots apart, and prefer ones farther from doors.
          if (found.some((f) => Math.hypot(f.x - cand.x, f.z - cand.z) < 2 && f.rot === rot)) continue;
          const doorGap = doors.length ? Math.min(...doors.map(([dx, dz]) => Math.hypot(dx - cand.x, dz - cand.z))) : 8;
          found.push({ x: cand.x, z: cand.z, rot, room: r.name, roomId: r.id, score: Math.min(doorGap, 8) });
        }
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, count);
}

// ---------------------------------------------------------------------------
// Collisions while placing furniture: what a piece may not overlap, each shape
// with the heights it occupies, so a coffee table can slide under a window sill
// that stops a sofa, and a chair's seat under a table top that stops its back.
// Two pieces collide only where a part of one overlaps a part of the other
// both on the plan and in height. Pieces may touch (sit flush against walls,
// trim and each other) but not overlap. The trim matches src/architecture.js:
// baseboards stand ½" proud of the wall, door casings ¾" and 3½" wide, window
// stools 1¼".

const BASEBOARD = { t: 0.045, h: 0.42 };
const CASING = { t: 0.06, w: 0.29 };
const STOOL = { t: 0.1, past: 0.17, drop: 0.32 };
const HARD_FLOORS = new Set(['tile', 'stone']);
const TOUCH = 0.002;  // overlap smaller than this (about 1/40") counts as touching

const shape = (poly, y0, y1, kind) => ({ poly, aabb: polyBounds(poly), y0, y1, kind });
const edgePoly = (p, u, n, s0, s1, t0, t1) => [[s0, t0], [s1, t0], [s1, t1], [s0, t1]]
  .map(([s, t]) => [p[0] + u[0] * s + n[0] * t, p[1] + u[1] * s + n[1] * t]);

const shapeCache = new WeakMap();
// Walls, trim and built-ins of a unit (not furniture), built once per unit.
// Built-ins come as their parts (src/parts.js): an island's overhang, wall
// cabinets and closet rods at their real heights.
export function collisionShapes(U) {
  if (!U) return [];
  if (shapeCache.has(U)) return shapeCache.get(U);
  const out = U.wallRects.map((r) => shape(rectPoly(r), 0, 99, 'wall'));
  const step = 1 / 24;
  // Along room edges wherever the wall behind stands on the floor: the wall's
  // true face (the grid of wall cells can sit up to ¼" behind the outline, so
  // a strip fills that in and pieces stop at the outline), and the baseboard.
  for (const e of U.edges) {
    const r = U.roomById[e.room];
    const base = !r.outdoor && !HARD_FLOORS.has(r.floor);
    let s0 = null;
    for (let s = step / 2; s <= e.len; s += step) {
      const back = U.floorSolidAt(e.p[0] + e.u[0] * s + e.n[0] / 24, e.p[1] + e.u[1] * s + e.n[1] / 24);
      if (back && s0 === null) s0 = s - step / 2;
      if ((!back || s + step > e.len) && s0 !== null) {
        const s1 = back ? e.len : s - step / 2;
        if (s1 - s0 > 0.05) {
          out.push(shape(edgePoly(e.p, e.u, e.n, s0, s1, 0, 1 / 12), 0, 99, 'wall'));
          if (base) out.push(shape(edgePoly(e.p, e.u, e.n, s0, s1, -BASEBOARD.t, 0), 0, BASEBOARD.h, 'trim'));
        }
        s0 = null;
      }
    }
  }
  for (const o of U.openings) {
    if (o.kind === 'window') {
      // The stool and apron under a window, on the room side.
      if (o.sill > 0.35) out.push(shape(edgePoly(o.p, o.u, o.n, o.a - STOOL.past, o.b + STOOL.past, -STOOL.t, 0), Math.max(0, o.sill - STOOL.drop), o.sill + 0.012, 'trim'));
      continue;
    }
    // Casing legs beside the opening, on both faces where there is wall.
    const top = o.head + CASING.w;
    for (const [s0, s1] of [[o.a - CASING.w, o.a], [o.b, o.b + CASING.w]]) {
      const wallThere = U.floorSolidAt(...o.world((s0 + s1) / 2, o.t1 / 2));
      if (!wallThere) continue;
      out.push(shape(edgePoly(o.p, o.u, o.n, s0, s1, -CASING.t, 0), 0, top, 'trim'));
      out.push(shape(edgePoly(o.p, o.u, o.n, s0, s1, o.t1, o.t1 + CASING.t), 0, top, 'trim'));
    }
  }
  for (const f of U.fixtures) {
    const ceiling = U.roomById?.[f.room]?.ceiling ?? U.heights?.ceiling ?? 9;
    for (const p of fixtureParts(f, ceiling)) out.push({ ...p, kind: 'fixture', id: f.id, name: f.name });
  }
  shapeCache.set(U, out);
  return out;
}

// The shapes a piece must keep clear of: the unit's, plus the parts of the
// other standing pieces. Only what reaches below the piece's top can hit it.
export function blockersFor(item, U, items = [], assets = null) {
  const top = pieceBody(item, assets).y1 - 1e-3;
  const own = collisionShapes(U).filter((s) => s.y0 < top);
  if (isFlat(item)) return own;
  const out = [...own];
  for (const o of items) {
    if (o.uid === item.uid || isFlat(o)) continue;
    for (const p of pieceParts(o, assets)) if (p.y0 < top) out.push({ ...p, kind: 'piece', uid: o.uid });
  }
  return out;
}

// Axis-aligned boxes of the trim, for clearance lines and the wall magnet.
export function trimRects(U) {
  return collisionShapes(U).filter((s) => s.kind === 'trim' && s.y0 < 0.05).map((s) => s.aabb);
}

// How far, and which way, to push polygon a (moved by ox, oz) out of polygon
// b (separating-axis minimum translation), or null when they only touch or
// are apart.
function separation(a, ox, oz, b) {
  let best = null;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
      let nx = z1 - z0, nz = x0 - x1;
      const len = Math.hypot(nx, nz);
      if (len < 1e-9) continue;
      nx /= len; nz /= len;
      const off = ox * nx + oz * nz;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const [x, z] of a) { const p = x * nx + z * nz + off; if (p < aMin) aMin = p; if (p > aMax) aMax = p; }
      for (const [x, z] of b) { const p = x * nx + z * nz; if (p < bMin) bMin = p; if (p > bMax) bMax = p; }
      const out1 = aMax - bMin, out2 = bMax - aMin;   // push a toward -n, or toward +n
      if (out1 <= TOUCH || out2 <= TOUCH) return null;
      const depth = Math.min(out1, out2);
      if (!best || depth < best.depth) best = { depth, dir: out1 < out2 ? [-nx, -nz] : [nx, nz] };
    }
  }
  return best;
}

// The deepest overlap of a body (src/parts.js pieceBody) at (x, z) with any
// shape, part by part: only parts that share some height can meet.
function deepest(body, x, z, shapes) {
  const bx0 = x + body.box[0], bz0 = z + body.box[1], bx1 = x + body.box[2], bz1 = z + body.box[3];
  let hit = null;
  for (const s of shapes) {
    const a = s.aabb;
    if (a[0] >= bx1 || a[2] <= bx0 || a[1] >= bz1 || a[3] <= bz0) continue;
    for (const p of body.parts) {
      if (p.y0 >= s.y1 - TOUCH || s.y0 >= p.y1 - TOUCH) continue;
      if (a[0] >= x + p.box[2] || a[2] <= x + p.box[0] || a[1] >= z + p.box[3] || a[3] <= z + p.box[1]) continue;
      const sep = separation(p.pts, x, z, s.poly);
      if (sep && (!hit || sep.depth > hit.depth)) hit = sep;
    }
  }
  return hit;
}

// Does the piece, where it is now, overlap any of the shapes?
export function collides(item, shapes, assets = null) {
  return !!deepest(pieceBody(item, assets), item.x, item.z, shapes);
}

// Push the piece out of whatever it overlaps, moving it at most `reach` feet.
// Returns the free position, or null when there is no room within reach.
export function pushOut(item, shapes, reach = 0.5, assets = null) {
  const body = pieceBody(item, assets);
  let x = item.x, z = item.z;
  for (let k = 0; k < 24; k++) {
    const hit = deepest(body, x, z, shapes);
    if (!hit) return Math.hypot(x - item.x, z - item.z) <= reach ? { x, z } : null;
    const push = hit.depth - TOUCH / 2;
    x += hit.dir[0] * push; z += hit.dir[1] * push;
  }
  return null;
}

// Move the piece toward (tx, tz) in short steps, sliding along whatever it
// meets and stopping flush against it. Returns where it ends up. A piece that
// already overlaps something moves freely until it is clear. Steps are
// shorter than the piece's thinnest part (a leg, a chair's back), so nothing
// thin passes through anything thin.
export function slideTo(item, tx, tz, shapes, assets = null) {
  const body = pieceBody(item, assets);
  if (deepest(body, item.x, item.z, shapes)) return { x: tx, z: tz };
  const dx = tx - item.x, dz = tz - item.z, dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return { x: item.x, z: item.z };
  const stepLen = Math.min(0.15, Math.max(0.02, Math.min(item.w / 3, item.d / 3, body.thin + 0.04)));
  const steps = Math.min(400, Math.ceil(dist / stepLen));
  // Only what the path can reach.
  const pad = stepLen + 0.05, b = body.box;
  const x0 = Math.min(item.x, tx) + b[0] - pad, x1 = Math.max(item.x, tx) + b[2] + pad;
  const z0 = Math.min(item.z, tz) + b[1] - pad, z1 = Math.max(item.z, tz) + b[3] + pad;
  const near = shapes.filter((s) => s.aabb[0] < x1 && s.aabb[2] > x0 && s.aabb[1] < z1 && s.aabb[3] > z0);
  let x = item.x, z = item.z;
  for (let i = 0; i < steps; i++) {
    let nx = x + dx / steps, nz = z + dz / steps;
    for (let k = 0; k < 4; k++) {
      const hit = deepest(body, nx, nz, near);
      if (!hit) break;
      const push = hit.depth - TOUCH / 2;
      nx += hit.dir[0] * push; nz += hit.dir[1] * push;
    }
    if (deepest(body, nx, nz, near)) break;
    x = nx; z = nz;
  }
  return { x, z };
}

// A piece set down by an agent a little into a wall or its trim (an outline's
// edge is the wall's face, so a sofa placed there sinks into the baseboard) is
// eased out, up to 3". Other pieces are left alone: chairs may tuck under tables.
export function settleOffWalls(item, U, assets = null) {
  if (!U || isFlat(item)) return null;
  const top = pieceBody(item, assets).y1 - 1e-3;
  const shapes = collisionShapes(U).filter((s) => (s.kind === 'wall' || s.kind === 'trim') && s.y0 < top);
  if (!collides(item, shapes, assets)) return null;
  return pushOut(item, shapes, 0.25, assets);
}
