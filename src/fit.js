// Will it fit? Overlap, clearance and free-spot checks for placed pieces, used
// by the browser (clearance lines, snapping) and the server (MCP tools). Feet.
// `U` is a built unit (src/unit.js buildUnit).

import { footprint, bounds, isFlat } from './catalog.js';
import { overlap, rectPoly, frontOf, polyBounds } from './geometry.js';

export { overlap };

// Distance from each side of the piece's bounding box to the nearest wall,
// fixture or other standing piece, along that axis.
export function clearances(item, others = [], obstacles = []) {
  const b = bounds(item);
  const obs = [...obstacles, ...others.filter((o) => o !== item && o.uid !== item.uid && !isFlat(o)).map(bounds)];
  const sides = [
    { side: 'east', axis: 0, sign: 1, edge: b[2], lo: b[1], hi: b[3] },
    { side: 'west', axis: 0, sign: -1, edge: b[0], lo: b[1], hi: b[3] },
    { side: 'south', axis: 1, sign: 1, edge: b[3], lo: b[0], hi: b[2] },
    { side: 'north', axis: 1, sign: -1, edge: b[1], lo: b[0], hi: b[2] },
  ];
  const out = [];
  for (const s of sides) {
    let best = null;
    for (const o of obs) {
      const [olo, ohi] = s.axis === 0 ? [o[1], o[3]] : [o[0], o[2]];
      const ov0 = Math.max(s.lo, olo), ov1 = Math.min(s.hi, ohi);
      if (ov1 - ov0 < 0.02) continue;
      const face = s.sign > 0 ? o[s.axis] : o[s.axis + 2];
      const dist = (face - s.edge) * s.sign;
      if (dist < -0.01) continue;
      if (!best || dist < best.dist) best = { dist: Math.max(0, dist), at: (ov0 + ov1) / 2 };
    }
    if (best && best.dist < 15) out.push({ ...s, ...best });
  }
  return out;
}

// What is wrong with where a piece sits, as short sentences.
export function problems(item, others = [], U = null) {
  if (!U) return [];
  const out = [];
  const poly = footprint(item);
  // Corners pulled in a hair, so a piece flush against a wall still counts as inside.
  if (footprint(item, -0.04).some(([x, z]) => !U.insideUnit(x, z))) out.push('sticks out past a wall or outside the unit');
  for (const w of U.wallRects) if (overlap(poly, rectPoly(w))) { out.push('runs into a wall'); break; }
  for (const f of U.fixtures) if (f.blocks && overlap(poly, f.poly)) out.push(`overlaps the ${f.name.toLowerCase()}`);
  if (!isFlat(item)) {
    for (const d of U.doorSwings) if (overlap(poly, d.poly, 0.1)) out.push(`blocks the ${d.name.toLowerCase()} from opening`);
    for (const o of others) {
      if (o === item || o.uid === item.uid || isFlat(o)) continue;
      if (overlap(poly, footprint(o))) out.push(`overlaps ${o.name}${o.uid ? ` (${o.uid})` : ''}`);
    }
  }
  return [...new Set(out)];
}

// Spots where a w × d piece fits in a room without hitting anything, best first.
// With againstWall, the piece's back is slid up to the nearest wall (its
// baseboard) or fixture.
export function findSpots({ w, d, h = 3, room = null, againstWall = true, items = [], count = 5, type = 'box', U }) {
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
          if (problems(cand, items, U).length) continue;
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
// that stops a sofa. Pieces may touch (sit flush against walls, trim and each
// other) but not overlap. The trim matches src/architecture.js: baseboards
// stand ½" proud of the wall, door casings ¾" and 3½" wide, window stools 1¼".

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
export function collisionShapes(U) {
  if (!U) return [];
  if (shapeCache.has(U)) return shapeCache.get(U);
  const out = U.wallRects.map((r) => shape(rectPoly(r), 0, 99, 'wall'));
  const step = 1 / 24;
  // Baseboards: along room edges wherever the wall behind stands on the floor.
  for (const e of U.edges) {
    const r = U.roomById[e.room];
    if (r.outdoor || HARD_FLOORS.has(r.floor)) continue;
    let s0 = null;
    for (let s = step / 2; s <= e.len; s += step) {
      const back = U.floorSolidAt(e.p[0] + e.u[0] * s + e.n[0] / 24, e.p[1] + e.u[1] * s + e.n[1] / 24);
      if (back && s0 === null) s0 = s - step / 2;
      if ((!back || s + step > e.len) && s0 !== null) {
        const s1 = back ? e.len : s - step / 2;
        if (s1 - s0 > 0.05) out.push(shape(edgePoly(e.p, e.u, e.n, s0, s1, -BASEBOARD.t, 0), 0, BASEBOARD.h, 'trim'));
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
  for (const f of U.fixtures) if (f.blocks) out.push(shape(f.poly, 0, f.h, 'fixture'));
  shapeCache.set(U, out);
  return out;
}

// The shapes a piece must keep clear of: the unit's, plus the other standing pieces.
export function blockersFor(item, U, items = []) {
  const own = collisionShapes(U).filter((s) => s.y0 < item.h - 1e-3);
  if (isFlat(item)) return own;
  return [...own, ...items.filter((o) => o.uid !== item.uid && !isFlat(o)).map((o) => shape(footprint(o), 0, o.h, 'piece'))];
}

// Axis-aligned boxes of the trim, for clearance lines and the wall magnet.
export function trimRects(U) {
  return collisionShapes(U).filter((s) => s.kind === 'trim' && s.y0 < 0.05).map((s) => s.aabb);
}

// How far, and which way, to push polygon a out of polygon b (separating-axis
// minimum translation), or null when they only touch or are apart.
function separation(a, b) {
  let best = null;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
      let nx = z1 - z0, nz = x0 - x1;
      const len = Math.hypot(nx, nz);
      if (len < 1e-9) continue;
      nx /= len; nz /= len;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const [x, z] of a) { const p = x * nx + z * nz; aMin = Math.min(aMin, p); aMax = Math.max(aMax, p); }
      for (const [x, z] of b) { const p = x * nx + z * nz; bMin = Math.min(bMin, p); bMax = Math.max(bMax, p); }
      const out1 = aMax - bMin, out2 = bMax - aMin;   // push a toward -n, or toward +n
      if (out1 <= TOUCH || out2 <= TOUCH) return null;
      const depth = Math.min(out1, out2);
      if (!best || depth < best.depth) best = { depth, dir: out1 < out2 ? [-nx, -nz] : [nx, nz] };
    }
  }
  return best;
}

const near = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
function deepest(item, x, z, shapes) {
  const poly = footprint({ ...item, x, z });
  const box = polyBounds(poly);
  let hit = null;
  for (const s of shapes) {
    if (!near(box, s.aabb)) continue;
    const sep = separation(poly, s.poly);
    if (sep && (!hit || sep.depth > hit.depth)) hit = sep;
  }
  return hit;
}

// Does the piece, where it is now, overlap any of the shapes?
export function collides(item, shapes) {
  return !!deepest(item, item.x, item.z, shapes);
}

// Push the piece out of whatever it overlaps, moving it at most `reach` feet.
// Returns the free position, or null when there is no room within reach.
export function pushOut(item, shapes, reach = 0.5) {
  let x = item.x, z = item.z;
  for (let k = 0; k < 24; k++) {
    const hit = deepest(item, x, z, shapes);
    if (!hit) return Math.hypot(x - item.x, z - item.z) <= reach ? { x, z } : null;
    const push = hit.depth - TOUCH / 2;
    x += hit.dir[0] * push; z += hit.dir[1] * push;
  }
  return null;
}

// Move the piece toward (tx, tz) in short steps, sliding along whatever it
// meets and stopping flush against it. Returns where it ends up. A piece that
// already overlaps something moves freely until it is clear.
export function slideTo(item, tx, tz, shapes) {
  if (collides(item, shapes)) return { x: tx, z: tz };
  const dx = tx - item.x, dz = tz - item.z, dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return { x: item.x, z: item.z };
  const stepLen = Math.min(0.15, Math.max(0.02, Math.min(item.w, item.d) / 3));
  const steps = Math.min(400, Math.ceil(dist / stepLen));
  let x = item.x, z = item.z;
  for (let i = 0; i < steps; i++) {
    let nx = x + dx / steps, nz = z + dz / steps;
    for (let k = 0; k < 4; k++) {
      const hit = deepest(item, nx, nz, shapes);
      if (!hit) break;
      const push = hit.depth - TOUCH / 2;
      nx += hit.dir[0] * push; nz += hit.dir[1] * push;
    }
    if (deepest(item, nx, nz, shapes)) break;
    x = nx; z = nz;
  }
  return { x, z };
}

// A piece set down by an agent a little into a wall or its trim (an outline's
// edge is the wall's face, so a sofa placed there sinks into the baseboard) is
// eased out, up to 3". Other pieces are left alone: chairs may tuck under tables.
export function settleOffWalls(item, U) {
  if (!U || isFlat(item)) return null;
  const shapes = collisionShapes(U).filter((s) => (s.kind === 'wall' || s.kind === 'trim') && s.y0 < item.h - 1e-3);
  if (!collides(item, shapes)) return null;
  return pushOut(item, shapes, 0.25);
}
