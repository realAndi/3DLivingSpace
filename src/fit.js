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
// With againstWall, the piece's back is slid up to the nearest wall or fixture.
export function findSpots({ w, d, h = 3, room = null, againstWall = true, items = [], count = 5, type = 'box', U }) {
  const match = (r) => r.id === room || r.name.toLowerCase() === String(room).toLowerCase();
  const rooms = room ? U.rooms.filter(match) : U.rooms.filter((r) => !r.minor && !r.outdoor && r.kind !== 'bath');
  const found = [];
  const seen = new Set();
  const step = room ? 0.5 : 1;
  const doors = U.doorSwings.map((s) => { const b = polyBounds(s.poly); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; });
  for (const r of rooms) {
    const [x0, z0, x1, z1] = r.bbox;
    for (const rot of [0, 90, 180, 270]) {
      for (let x = x0 + step / 2; x <= x1 - step / 2; x += step) {
        for (let z = z0 + step / 2; z <= z1 - step / 2; z += step) {
          const cand = { type, w, d, h, x, z, rot, uid: '_spot' };
          if (againstWall) {
            const [fx, fz] = frontOf(rot);
            const back = fx > 0.5 ? 'west' : fx < -0.5 ? 'east' : fz > 0.5 ? 'north' : 'south';
            const c = clearances(cand, items, U.obstacles).find((s) => s.side === back);
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
