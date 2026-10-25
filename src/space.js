// The unit as plain data for anything that needs to reason about space: the
// browser (walking, snapping, clearances), the server's MCP tools and its plan
// renderer. No three.js here, so Node can import it as is. Feet throughout.

import { WALLS, wallById, OPENINGS, ROOMS, HEIGHT, X, Z, UNIT } from './plan.js';

export function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

// Openings resolved to feet along their wall.
export const openings = OPENINGS.map((o) => {
  const w = wallById[o.wall];
  const conv = w.axis === 'x' ? X : Z;
  const isWindow = o.type === 'window';
  return {
    ...o, w,
    a: conv(o.from), b: conv(o.to),
    sill: isWindow ? HEIGHT.windowSill : 0,
    head: isWindow ? HEIGHT.windowHead : HEIGHT.doorHead,
  };
});
export const doorways = openings.filter((o) => o.type !== 'window');

// Wall rectangles with the doorways cut out: [x0, z0, x1, z1].
export const wallPieces = [];
for (const w of WALLS) {
  let parts = [w.axis === 'x' ? [w.x0, w.x1] : [w.z0, w.z1]];
  for (const o of doorways) {
    if (o.wall !== w.id) continue;
    parts = parts.flatMap(([p, q]) => (o.b <= p || o.a >= q ? [[p, q]] : [...(o.a > p ? [[p, o.a]] : []), ...(o.b < q ? [[o.b, q]] : [])]));
  }
  for (const [p, q] of parts) wallPieces.push(w.axis === 'x' ? [p, w.z0, q, w.z1] : [w.x0, p, w.x1, q]);
}

// The floor under each doorway, so a doorway counts as inside the unit.
export const thresholds = doorways.map((o) => (o.w.axis === 'x' ? [o.a, o.w.z0, o.b, o.w.z1] : [o.w.x0, o.a, o.w.x1, o.b]));

export const inRect = (x, z, [x0, z0, x1, z1], r = 0) => x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r;
export const roomAt = (x, z) => ROOMS.find((r) => pointInPoly(x, z, r.poly)) ?? null;
export const insideUnit = (x, z) => !!roomAt(x, z) || thresholds.some((t) => inRect(x, z, t));

// Kitchen lines shared with the kitchen model.
export const KITCHEN_LINE = { west: X(517), south: Z(699), pier: X(804), northEnd: Z(497), counterDepth: 2.125 };
const K = KITCHEN_LINE;

// Built-in fixtures that furniture cannot go through: [x0, z0, x1, z1] and height.
export const BUILTINS = [
  { name: 'Kitchen: fridge, base cabinet and range', rect: [K.west, K.south - K.counterDepth - 0.8, K.pier, K.south], height: 8 },
  { name: 'Kitchen: sink, dishwasher and corner cabinets', rect: [K.west, K.northEnd, K.west + K.counterDepth, K.south], height: 8 },
  { name: 'Primary bath vanity', rect: [16.66, 5.5, 18.72, Z(247)], height: 2.8 },
  { name: 'Primary bath toilet', rect: [17.1, 3.85, X(595), 5.55], height: 2.5 },
  { name: 'Primary bath shower glass', rect: [16.38, 3.55, 16.5, Z(247)], height: 6.9 },
  { name: 'Bath 2 vanity', rect: [X(258), Z(515), X(258) + 1.8, Z(592)], height: 2.8 },
  { name: 'Bath 2 toilet', rect: [X(258), Z(664) - 0.85, X(258) + 2.4, Z(664) + 0.85], height: 2.5 },
  { name: 'Bath 2 tub', rect: [X(440), Z(570), X(504), Z(699)], height: 1.5 },
  { name: 'Stacked washer and dryer', rect: [X(395), Z(270), X(447), Z(325)], height: 6.6 },
  { name: 'Water heater', rect: [X(492) - 0.9, Z(295) - 0.9, X(492) + 0.9, Z(295) + 0.9], height: 5.1 },
];

// Everything a piece of furniture can't overlap.
export const OBSTACLES = [...wallPieces, ...BUILTINS.map((b) => b.rect)];

// The floor a door sweeps as it opens: a square as wide as the door on its swing side.
export const doorSwings = doorways.filter((o) => o.type === 'door').map((o) => {
  const w = o.w, width = o.b - o.a;
  const s = { N: -1, S: 1, E: 1, W: -1 }[o.swing];
  if (w.axis === 'x') {
    const face = s > 0 ? w.z1 : w.z0;
    return { id: o.id, name: o.name, rect: [o.a, Math.min(face, face + s * width), o.b, Math.max(face, face + s * width)] };
  }
  const face = s > 0 ? w.x1 : w.x0;
  return { id: o.id, name: o.name, rect: [Math.min(face, face + s * width), o.a, Math.max(face, face + s * width), o.b] };
});

export { ROOMS, WALLS, HEIGHT, UNIT };
