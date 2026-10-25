// Small plane-geometry helpers shared by the browser and the server. Feet,
// x east, z south.

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

export function polyBounds(poly) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return [x0, z0, x1, z1];
}

export const rectPoly = ([x0, z0, x1, z1]) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

export function distToSegment(x, z, [ax, az], [bx, bz]) {
  const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
}

// A point well inside a polygon, for its label: the centroid when that is
// inside, else the sampled point farthest from the edges.
export function labelPoint(poly) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    const f = x0 * z1 - x1 * z0;
    a += f; cx += (x0 + x1) * f; cz += (z0 + z1) * f;
  }
  const edgeDist = (x, z) => Math.min(...poly.map((p, i) => distToSegment(x, z, p, poly[(i + 1) % poly.length])));
  if (Math.abs(a) > 1e-9) {
    cx /= 3 * a; cz /= 3 * a;
    const [bx0, bz0, bx1, bz1] = polyBounds(poly);
    if (pointInPoly(cx, cz, poly) && edgeDist(cx, cz) > Math.min(bx1 - bx0, bz1 - bz0) * 0.25) return [cx, cz];
  }
  const [x0, z0, x1, z1] = polyBounds(poly);
  let best = [(x0 + x1) / 2, (z0 + z1) / 2], bestD = -1;
  for (let i = 1; i < 16; i++) for (let j = 1; j < 16; j++) {
    const x = x0 + ((x1 - x0) * i) / 16, z = z0 + ((z1 - z0) * j) / 16;
    if (!pointInPoly(x, z, poly)) continue;
    const d = edgeDist(x, z);
    if (d > bestD) { bestD = d; best = [x, z]; }
  }
  return best;
}

// Corners of a w × d rectangle centered on (x, z), turned rot degrees
// clockwise on the plan. At rot 0 its front (+d/2) faces south (+z).
export function orientedRect(x, z, w, d, rot, pad = 0) {
  const a = -(rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const hw = w / 2 + pad, hd = d / 2 + pad;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [x + lx * c + lz * s, z - lx * s + lz * c]);
}

// Unit vector a piece faces at rot (degrees clockwise on the plan, 0 = south).
export const frontOf = (rot) => [-Math.sin((rot * Math.PI) / 180), Math.cos((rot * Math.PI) / 180)];
// Its right-hand side as you face its front.
export const rightOf = (rot) => [Math.cos((rot * Math.PI) / 180), Math.sin((rot * Math.PI) / 180)];

// Separating-axis test for two convex polygons; `tol` shrinks the overlap that counts.
export function overlap(a, b, tol = 0.04) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
      const nx = z1 - z0, nz = x0 - x1, len = Math.hypot(nx, nz) || 1;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const [x, z] of a) { const p = (x * nx + z * nz) / len; aMin = Math.min(aMin, p); aMax = Math.max(aMax, p); }
      for (const [x, z] of b) { const p = (x * nx + z * nz) / len; bMin = Math.min(bMin, p); bMax = Math.max(bMax, p); }
      if (aMax <= bMin + tol || bMax <= aMin + tol) return false;
    }
  }
  return true;
}

// Feet to 9'10½" style text, for messages and labels made outside the browser.
export function feetInches(ft) {
  const t = Math.round(ft * 24) / 2;
  const f = Math.floor(t / 12), i = t - f * 12;
  return `${f}'${Number.isInteger(i) ? i : i.toFixed(1)}"`;
}

// "12'7\"", "12' 7\"", "12-7", "151in", "151\"", "12.5'" → feet, or null.
export function parseFeetInches(s) {
  const t = String(s ?? '').trim().replace(/[″”]/g, '"').replace(/[′’]/g, "'");
  let m = /^(\d+(?:\.\d+)?)\s*'\s*(?:-?\s*(\d+(?:\.\d+)?)\s*(?:"|in)?)?$/.exec(t);
  if (m) return +m[1] + (m[2] ? +m[2] / 12 : 0);
  m = /^(\d+(?:\.\d+)?)\s*(?:"|in|inches)$/.exec(t);
  if (m) return +m[1] / 12;
  return null;
}
