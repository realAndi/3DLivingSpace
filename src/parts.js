// Hitboxes: the parts a placed piece or a built-in is made of, each a convex
// outline on the plan with the heights it spans. A chair's seat then slides
// under a table top while its back stops at the edge, and a stool tucks under
// an island's overhang. Pure (no three.js): the server checks placements with
// the same shapes.
//
// They follow the builders in src/furniture.js and src/fixtures.js part for
// part, in the same frame (s across, + to the right as you face the front; t
// from the back at 0 to the front at d; y up; feet) and with the same
// proportions. Left out: base cabinets' pulls (within ½" of the counter's
// edge), and what stands against the wall above a counter, vanity or tub
// where no piece can reach (faucets, backsplash, outlets, mirrors, a shower
// head), and a water heater's pipes.

import { catalogByType } from './catalog.js';

const ROUND = 16;  // sides on a round outline, drawn around the circle so finer meshes stay inside

// Parts in a builder's frame, kept as outlines centered on the footprint
// (x = s, z = t - d/2). Boxes take corners in any order, like Frame.box.
class Parts {
  constructor(d) { this.d = d; this.list = []; }
  add(poly, y0, y1) {
    if (Math.abs(y1 - y0) > 1e-6) this.list.push({ poly, y0: Math.min(y0, y1), y1: Math.max(y0, y1) });
    return this;
  }
  box(s0, t0, s1, t1, y0, y1) {
    const a = Math.min(s0, s1), b = Math.max(s0, s1), c = Math.min(t0, t1) - this.d / 2, e = Math.max(t0, t1) - this.d / 2;
    if (b - a < 1e-6 || e - c < 1e-6) return this;
    return this.add([[a, c], [b, c], [b, e], [a, e]], y0, y1);
  }
  // An upright ellipse (radii rs across, rt deep) around (s, t).
  round(s, t, rs, rt, y0, y1, n = ROUND) {
    return this.add(ring(s, t - this.d / 2, rs, rt, n), y0, y1);
  }
  // Four legs, as legs() in src/furniture.js places them.
  legs(w, d, h, inset, r) {
    for (const s of [-w / 2 + inset, w / 2 - inset]) for (const t of [inset, d - inset]) this.box(s - r, t - r, s + r, t + r, 0, h);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Catalog pieces, builder by builder (src/furniture.js BUILDERS).
const PIECES = {
  bed(P, w, d, h) {
    P.legs(w - 0.1, d, 0.35, 0.2, 0.035);
    P.box(-w / 2, 0.25, w / 2, d, 0.3, 1.05);
    P.box(-w / 2, 0, w / 2, 0.28, 0.3, h);
    P.box(-w / 2 + 0.1, 0.3, w / 2 - 0.1, d - 0.05, 1.05, 1.9);
    P.box(-w / 2 + 0.02, 1.75, w / 2 - 0.02, d, 1.25, 1.98);
    P.box(-w / 2 + 0.12, 1.75, w / 2 - 0.12, Math.min(d - 0.3, 2.6), 1.92, 2.0);
    P.box(-w / 2 + 0.18, 0.38, w / 2 - 0.18, 1.15, 1.9, 2.32);
  },
  sofa(P, w, d, h) {
    P.legs(w - 0.2, d, 0.35, 0.2, 0.04);
    P.box(-w / 2, 0, w / 2, d, 0.33, 1.3);
    P.box(-w / 2, 0, w / 2, 0.75, 1.3, h);
    for (const s of [-w / 2, w / 2 - 0.55]) P.box(s, 0, s + 0.55, d, 1.3, 2.15);
    const inner = w - 1.1;
    P.box(-inner / 2 + 0.02, 0.75, inner / 2 - 0.02, d - 0.03, 1.3, 1.72);
    P.box(-inner / 2 + 0.04, 0.72, inner / 2 - 0.04, 1.12, 1.6, h - 0.1);
  },
  // An L: the sofa along the back and the chaise on the right; the corner in
  // front of the sofa's left part is free.
  sectional(P, w, d, h) {
    const sd = Math.min(3.0, d), cw = Math.min(3.0, w);
    P.legs(w - 0.2, sd, 0.35, 0.2, 0.04);
    if (d - sd > 0.5) for (const s of [w / 2 - cw + 0.3, w / 2 - 0.3]) P.box(s - 0.04, d - 0.24, s + 0.04, d - 0.16, 0, 0.35);
    P.box(-w / 2, 0, w / 2, sd, 0.33, 1.3);
    P.box(w / 2 - cw, sd, w / 2, d, 0.33, 1.3);
    P.box(-w / 2, 0, w / 2, 0.75, 1.3, h);
    P.box(-w / 2, 0, -w / 2 + 0.55, sd, 1.3, 2.15);
    P.box(w / 2 - 0.55, 0.75, w / 2, d, 1.3, 2.15);
    P.box(-w / 2 + 0.57, 0.75, w / 2 - cw - 0.57, sd - 0.03, 1.3, 1.72);
    P.box(w / 2 - cw + 0.02, 0.75, w / 2 - 0.57, d - 0.03, 1.3, 1.72);
    P.box(-w / 2 + 0.59, 0.72, w / 2 - 0.59, 1.12, 1.6, h - 0.1);
  },
  armchair(P, w, d, h) {
    P.legs(w - 0.2, d, 0.35, 0.18, 0.035);
    P.box(-w / 2, 0, w / 2, d, 0.33, 1.3);
    P.box(-w / 2, 0, w / 2, 0.6, 1.3, h);
    for (const s of [-w / 2, w / 2 - 0.4]) P.box(s, 0, s + 0.4, d, 1.3, 2.05);
    P.box(-w / 2 + 0.42, 0.6, w / 2 - 0.42, d - 0.03, 1.3, 1.68);
  },
  ottoman(P, w, d, h) {
    P.legs(w, d, 0.3, 0.1, 0.03);
    P.box(-w / 2, 0, w / 2, d, 0.28, h);
  },
  coffeetable(P, w, d, h) {
    P.box(-w / 2, 0, w / 2, d, h - 0.1, h);
    P.box(-w / 2 + 0.1, 0.1, w / 2 - 0.1, d - 0.1, 0.35, 0.4);
    P.legs(w, d, h - 0.1, 0.1, 0.035);
  },
  sidetable(P, w, d, h) {
    P.box(-w / 2, 0, w / 2, d, h - 0.1, h);
    P.legs(w, d, h - 0.1, 0.1, 0.03);
  },
  tvstand(P, w, d, h, def) {
    P.box(-w / 2, 0, w / 2, d, 0.4, h);
    P.legs(w, d, 0.4, 0.1, 0.035);
    if (def.tv) {
      const tw = 4.03;
      P.box(-0.35, d / 2 - 0.25, 0.35, d / 2 + 0.25, h, h + 0.04);
      P.box(-0.05, d / 2 - 0.05, 0.05, d / 2 + 0.05, h, h + 0.25);
      P.box(-tw / 2, d / 2 - 0.04, tw / 2, d / 2 + 0.04, h + 0.22, h + 0.22 + tw * 0.5625);
    }
  },
  bookshelf(P, w, d, h) { P.box(-w / 2, 0, w / 2, d, 0, h); },
  // Base, pole and a shade as wide as the piece, which can reach over a sofa's arm.
  lamp(P, w, d, h) {
    const r = Math.min(w, d);
    P.round(0, d / 2, r * 0.4, r * 0.4, 0, 0.05);
    P.box(-0.03, d / 2 - 0.03, 0.03, d / 2 + 0.03, 0.05, h - 0.95);
    P.round(0, d / 2, r * 0.5, r * 0.5, h - 1.15, h);
  },
  rug(P, w, d, h) { P.box(-w / 2, 0, w / 2, d, 0, h); },
  table(P, w, d, h) {
    P.box(-w / 2, 0, w / 2, d, h - 0.1, h);
    P.legs(w, d, h - 0.1, 0.15, 0.045);
  },
  roundtable(P, w, d, h) {
    P.round(0, d / 2, w / 2, d / 2, h - 0.1, h);
    P.box(-0.08, d / 2 - 0.08, 0.08, d / 2 + 0.08, 0.06, h - 0.09);
    P.round(0, d / 2, Math.min(w, d) * 0.3, Math.min(w, d) * 0.3, 0, 0.06);
  },
  // Legs and seat as one block; the back stops at a table's edge.
  chair(P, w, d, h) {
    P.box(-w / 2, 0, w / 2, d, 0, 1.6);
    P.box(-w / 2, 0, w / 2, 0.08, 1.6, h);
  },
  bench(P, w, d, h) {
    P.box(-w / 2, 0, w / 2, d, h - 0.12, h);
    P.legs(w, d, h - 0.12, 0.12, 0.035);
  },
  nightstand(P, w, d, h) {
    P.box(-w / 2, 0, w / 2, d, 0.25, h);
    P.legs(w, d, 0.25, 0.08, 0.03);
  },
  dresser(P, w, d, h) {
    P.box(-w / 2, 0, w / 2, d, 0.3, h);
    P.legs(w, d, 0.3, 0.1, 0.035);
  },
  desk(P, w, d, h) {
    P.box(-w / 2, 0, w / 2, d, h - 0.1, h);
    P.legs(w, d, h - 0.1, 0.1, 0.035);
    P.box(w / 2 - 1.3, 0.1, w / 2 - 0.12, d - 0.05, h - 0.55, h - 0.1);
  },
  // Star base on casters, the post, the seat and the back.
  officechair(P, w, d, h) {
    const r = Math.min(w, d) * 0.46, star = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
      star.push(...ring(x, z, 0.06, 0.06, 8));
    }
    P.add(hull(star), 0, 0.16);
    P.box(-0.05, d / 2 - 0.05, 0.05, d / 2 + 0.05, 0.12, 1.37);
    P.box(-w * 0.4, d * 0.1, w * 0.4, d * 0.9, 1.35, 1.6);
    P.box(-w * 0.38, d * 0.08, w * 0.38, d * 0.2, 1.6, h);
  },
  // Pot, and the foliage over it (kept inside the footprint and under h).
  plant(P, w, d, h) {
    const r = Math.min(w, d) / 2;
    P.round(0, d / 2, r * 0.85, r * 0.85, 0, Math.min(1.3, h * 0.35));
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 4; k++) {
      const rk = r * (0.85 - k * 0.1), y = plantLeafY(h, k, rk);
      lo = Math.min(lo, y - rk); hi = Math.max(hi, y + rk);
    }
    P.round(0, d / 2, r, r, Math.max(0, lo), hi);
  },
  box(P, w, d, h) { P.box(-w / 2, 0, w / 2, d, 0, h); },
};

// Where the plant builder puts leaf k of radius rk (src/furniture.js).
export const plantLeafY = (h, k, rk) => Math.max(rk, Math.min(h * (0.55 + k * 0.12), h - rk));

// ---------------------------------------------------------------------------
// Custom assets: each primitive's outline and height range, scaled to the item
// the way buildAsset scales the mesh. Boxes (and tipped round shapes) use the
// hull of their eight corners; upright cylinders and cones, and spheres, use
// their circle.

// Rotation matrix for XYZ Euler degrees, as partBox in src/design.js (and three.js).
function rotation([x, y, z]) {
  const [rx, ry, rz] = [x, y, z].map((v) => (v * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
}

function assetParts(asset, w, d, h) {
  const kx = w / asset.w, ky = h / asset.h, kz = d / asset.d;  // feet per inch of the asset
  const out = [];
  for (const p of asset.parts) {
    const m = rotation(p.rot), [hx, hy, hz] = p.size.map((v) => v / 2), at = p.at;
    const map = (v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] + at[i]);
    let pts, y0, y1;
    if (p.shape === 'sphere' && hx === hy && hy === hz) {
      pts = ring(at[0], at[2], hx, hx);
      [y0, y1] = [at[1] - hy, at[1] + hy];
    } else if (p.shape !== 'box' && Math.abs(m[1][1]) > 1 - 1e-6) {
      pts = ring(0, 0, hx, hz).map(([x, z]) => { const v = map([x, 0, z]); return [v[0], v[2]]; });
      [y0, y1] = [at[1] - hy, at[1] + hy];
    } else {
      const corners = [];
      for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) corners.push(map([a * hx, b * hy, c * hz]));
      pts = hull(corners.map((v) => [v[0], v[2]]));
      y0 = Math.min(...corners.map((v) => v[1])); y1 = Math.max(...corners.map((v) => v[1]));
    }
    if (pts.length < 3) continue;
    out.push({ poly: pts.map(([x, z]) => [x * kx, z * kz]), y0: y0 * ky, y1: y1 * ky });
  }
  return out;
}

// An n-sided outline around an ellipse: its edges touch it, its corners lie
// outside, and (n a multiple of 4) its extent across and deep is the ellipse's.
function ring(cx, cz, rx, rz, n = 12) {
  const k = 1 / Math.cos(Math.PI / n), out = [];
  for (let i = 0; i < n; i++) { const a = ((i + 0.5) / n) * Math.PI * 2; out.push([cx + Math.cos(a) * rx * k, cz + Math.sin(a) * rz * k]); }
  return out;
}

// Convex hull of plan points (monotone chain).
function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 1e-12) upper.pop();
    upper.push(p[i]);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const assetOf = (item, assets) => (item.type !== 'asset' || !assets ? null
  : Array.isArray(assets) ? assets.find((a) => a.id === item.asset) ?? null : assets[item.asset] ?? null);

// A piece's parts in its own frame, unturned: [{ poly, y0, y1 }], centered on
// the footprint. Unknown types and missing assets are one box.
export function localParts(item, assets = null) {
  const { w, d, h } = item;
  const asset = assetOf(item, assets);
  if (asset) {
    const parts = assetParts(asset, w, d, h);
    if (parts.length) return parts;
  }
  const def = catalogByType[item.type];
  const P = new Parts(d);
  (PIECES[def?.build ?? def?.type] ?? PIECES.box)(P, w, d, h, def ?? {});
  return P.list.length ? P.list : new Parts(d).box(-w / 2, 0, w / 2, d, 0, h).list;
}

// ---------------------------------------------------------------------------
// Turned and placed.

// Outlines turned by rot (degrees clockwise on the plan), relative to the
// center, as footprint() in src/catalog.js turns them.
function turn(parts, rot) {
  const a = (-rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out = parts.map((p) => {
    const pts = p.poly.map(([lx, lz]) => [lx * c + lz * s, -lx * s + lz * c]);
    return { pts, box: boxOf(pts), y0: p.y0, y1: p.y1, thin: thinOf(p.poly) };
  });
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of out) { box[0] = Math.min(box[0], p.box[0]); box[1] = Math.min(box[1], p.box[1]); box[2] = Math.max(box[2], p.box[2]); box[3] = Math.max(box[3], p.box[3]); }
  return {
    parts: out, box,
    y0: Math.min(...out.map((p) => p.y0)), y1: Math.max(...out.map((p) => p.y1)),
    thin: Math.min(...out.map((p) => p.thin)),
  };
}

function boxOf(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
}
const thinOf = (poly) => { const b = boxOf(poly); return Math.min(b[2] - b[0], b[3] - b[1]); };

// Bodies are cached per shape and turn: a drag asks for the same one every step.
const catalogBodies = new Map();
const assetBodies = new WeakMap();

// A piece's parts turned to its rotation, relative to its center:
// { parts: [{ pts, box, y0, y1 }], box, y0, y1, thin }. Move it by adding (x, z).
export function pieceBody(item, assets = null) {
  const key = `${item.type}|${item.w}|${item.d}|${item.h}|${item.rot}`;
  const asset = assetOf(item, assets);
  let cache = catalogBodies;
  if (asset) {
    if (!assetBodies.has(asset)) assetBodies.set(asset, new Map());
    cache = assetBodies.get(asset);
  } else if (item.type === 'asset') return turn(localParts(item), item.rot);
  let body = cache.get(key);
  if (!body) {
    if (cache.size > 2000) cache.clear();
    body = turn(localParts(item, assets), item.rot);
    cache.set(key, body);
  }
  return body;
}

// A body moved to (x, z): world outlines with their boxes.
export function placeBody(body, x, z) {
  return body.parts.map((p) => ({
    poly: p.pts.map(([dx, dz]) => [x + dx, z + dz]),
    aabb: [x + p.box[0], z + p.box[1], x + p.box[2], z + p.box[3]],
    y0: p.y0, y1: p.y1,
  }));
}

// A placed piece's parts: [{ poly, aabb, y0, y1 }] in plan coordinates.
export function pieceParts(item, assets = null) {
  return placeBody(pieceBody(item, assets), item.x, item.z);
}

// ---------------------------------------------------------------------------
// Fixtures (src/fixtures.js): counters at counter height with stools' room
// under an overhang, wall cabinets at their real heights, a fridge's doors
// and a range's handle past the counter's edge.

const SLAB = 0.104, DOOR = 0.06, UPPER_D = 1.0, FRIDGE_H = 5.83, TOE = 0.33, PULL = 0.11;
const TALL = new Set(['fridge', 'pantry', 'oven']);
const COUNTER = new Set(['base', 'drawers', 'sink', 'dishwasher', 'cooktop', 'filler', 'corner', 'open']);
const KITCHEN = new Set(['kitchen-run', 'fridge', 'range', 'dishwasher', 'sink-cabinet', 'base-cabinet', 'pantry']);

// A run of kitchen segments, as run() and above() build it.
function kitchen(P, f, ceiling) {
  const n0 = { kind: 'base', s0: -f.w / 2, s1: f.w / 2, upper: false };
  const segs = f.segments ?? [n0], n = segs.length;
  const alone = f.type !== 'kitchen-run', d = f.d;
  const ct = f.type === 'fridge' || f.type === 'pantry' ? 3 : f.h, cd = d - 0.125, cTop = ct - SLAB;
  const uppers = !!f.uppers, ub = f.upperBottom ?? 4.5, ut = f.upperTop ?? Math.min(8, ceiling);
  const fridgeH = f.type === 'fridge' ? f.h : FRIDGE_H, fridgeFront = alone ? d : d + 0.635;
  const tallH = f.type === 'pantry' ? f.h : f.upperTop ?? Math.min(8, ceiling);
  const againstBack = !!f.against?.back, hood = f.hood ?? 'microwave';
  const kind = (i) => segs[i]?.kind;
  const tallEnd = (i) => kind(i) === 'end' && (TALL.has(kind(i - 1)) || TALL.has(kind(i + 1)));
  const hasCounter = (i) => COUNTER.has(kind(i)) || (kind(i) === 'end' && !tallEnd(i));
  const tallOf = (k) => (k === 'fridge' ? fridgeH : tallH);
  // A wall cabinet, with its pulls near the bottom of its doors.
  const upper = (s0, s1, y0, y1, depth = UPPER_D) => {
    P.box(s0, 0, s1, depth + DOOR, y0, y1);
    P.box(s0, depth + DOOR, s1, depth + DOOR + PULL, y0 + 0.17, y0 + 0.17 + Math.min(0.55, (y1 - y0) * 0.6));
  };

  segs.forEach((g, i) => {
    const { s0, s1 } = g;
    if (hasCounter(i)) {
      if (g.kind !== 'open') P.box(s0, 0, s1, d, 0, ct);
      else {
        // Knee space: only the counter, and a leg panel at the run's ends.
        P.box(s0, 0, s1, d, cTop, ct);
        if (i === 0) P.box(s0, 0, s0 + 0.06, d, 0, cTop);
        if (i === n - 1) P.box(s1 - 0.06, 0, s1, d, 0, cTop);
      }
    }
    if (g.kind === 'range') {
      // The oven door and cooktop a little past the counter, the knobs and handle more.
      P.box(s0, 0, s1, cd + 0.2, 0, ct + 0.04);
      P.box(s0, cd + 0.2, s1, cd + 0.335, ct - 0.68, ct - 0.07);
    }
    if (g.kind === 'fridge') {
      const k = fridgeH / FRIDGE_H, f0 = s0 + 0.13, f1 = s1 - 0.13, split = f0 + (f1 - f0) * 0.42;
      P.box(f0, 0, f1, fridgeFront, 0, fridgeH);
      P.box(split - 0.19, fridgeFront, split + 0.19, fridgeFront + 0.26, 2.25 * k - 0.03, 5.25 * k);
      if (uppers && ut - (fridgeH + 0.17) > 0.5) upper(s0, s1, fridgeH + 0.17, ut, cd);
    }
    // Tall cabinets, and their pulls (and the oven's handle) where they are.
    const pulls = (y0, y1) => P.box(s0, cd + DOOR, s1, cd + DOOR + PULL, y0, y1);
    if (g.kind === 'pantry') {
      const split = Math.min(tallH - 0.8, Math.max(TOE + 1.5, tallH - 2.5));
      const lo = Math.min(0.55, (split - TOE) * 0.6), at = Math.min(split - 0.4, 3.5);
      P.box(s0, 0, s1, cd + DOOR, 0, tallH);
      pulls(at - lo / 2, at + lo / 2);
      pulls(split + 0.17, split + 0.17 + Math.min(0.55, (tallH - split) * 0.6));
    }
    if (g.kind === 'oven') {
      const o0 = 2.55, o1 = Math.min(tallH - 0.7, 5.0), mid = (TOE + o0) / 2;
      P.box(s0, 0, s1, cd + DOOR, 0, tallH);
      for (const y of [mid, o0]) pulls(y - 0.27, y - 0.23);
      P.box(s0, cd + DOOR, s1, cd + 0.295, o0, o1);
      if (tallH - o1 > 0.4) pulls(o1 + 0.17, o1 + 0.17 + Math.min(0.55, (tallH - o1) * 0.6));
    }
    if (tallEnd(i)) {
      const next = TALL.has(kind(i - 1)) ? kind(i - 1) : kind(i + 1);
      P.box(s0, 0, s1, next === 'fridge' ? fridgeFront - 0.16 : d, 0, uppers ? Math.max(ut, tallOf(next)) : tallOf(next));
    }
    // What hangs over a range or cooktop.
    if ((g.kind === 'range' || g.kind === 'cooktop') && againstBack) {
      if (hood === 'microwave') {
        P.box(s0, 0, s1, 1.42, ub - 0.03, ub + 1.38);
        if (uppers && ut - (ub + 1.4) > 0.4) upper(s0, s1, ub + 1.4, ut);
      } else if (hood === 'hood') {
        if (uppers) {
          const y = Math.min(ub + 1.0, ut - 0.9);
          P.box(s0, 0, s1, 1.66, y - 0.006, y + 0.22);
          upper(s0, s1, y + 0.22, ut);
        } else {
          const y = ct + 2.5, c = (s0 + s1) / 2;
          P.box(s0, 0, s1, 1.66, y - 0.006, y + 0.72);
          P.box(c - 0.45, 0, c + 0.45, 0.8, y + 0.72, ceiling);
        }
      } else if (uppers && ut - (ub + 1.4) > 0.4) upper(s0, s1, ub + 1.4, ut);
    }
  });

  const spans = (test) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (!test(i)) continue;
      let j = i;
      while (j + 1 < n && test(j + 1)) j++;
      out.push([i, j]);
      i = j;
    }
    return out;
  };
  const plainUpper = (i) => segs[i].upper && !TALL.has(kind(i)) && !['range', 'cooktop', 'end'].includes(kind(i));
  if (uppers) for (const [i, j] of spans(plainUpper)) upper(segs[i].s0, segs[j].s1, ub, ut);
  if (f.soffit && uppers && ceiling - ut > 0.02) {
    const reaches = (i) => plainUpper(i) || TALL.has(kind(i)) || tallEnd(i) || (['range', 'cooktop'].includes(kind(i)) && againstBack);
    const depthOf = (i) => (kind(i) === 'fridge' ? cd : kind(i) === 'pantry' || kind(i) === 'oven' ? cd + DOOR : tallEnd(i) ? 0 : UPPER_D);
    for (const [i, j] of spans(reaches)) {
      let depth = 0;
      for (let k = i; k <= j; k++) depth = Math.max(depth, depthOf(k));
      P.box(segs[i].s0, 0, segs[j].s1, depth + 0.06, ut, ceiling);
    }
  }
}

const FIXTURES = {
  // Cabinets on the kitchen side, the counter overhanging the seating side.
  island(P, f) {
    const { w, d, h } = f, o = f.opts ?? {};
    const ov = Math.max(0, Math.min(o.overhang ?? Math.max(0.5, Math.min(1.25, d - 2.0)), d - 1.2));
    const back = d - ov, W = Math.max(0.5, w - 0.16);
    P.box(-W / 2, 0, W / 2, back + 0.06, 0, h - SLAB);
    P.box(-w / 2, 0, w / 2, d, h - SLAB, h);
  },
  counter(P, f) {
    const { w, d, h } = f;
    P.box(-w / 2, 0, w / 2, Math.min(0.5, d * 0.6), 0, h - SLAB);
    P.box(-w / 2, 0, w / 2, d, h - SLAB, h);
  },
  'upper-cabinet'(P, f, ceiling) {
    const y0 = Math.min(f.opts?.bottom ?? 4.5, ceiling - 0.5), y1 = Math.min(y0 + f.h, ceiling), depth = f.d + DOOR;
    P.box(-f.w / 2, 0, f.w / 2, depth, y0, y1);
    P.box(-f.w / 2, depth, f.w / 2, depth + PULL, y0 + 0.17, y0 + 0.17 + Math.min(0.55, (y1 - y0) * 0.6));
  },
  // Doors flush with the front, the top's lip and the pulls past it.
  'built-in'(P, f) {
    const { w, d, h } = f, top = h - 0.06, split = h > 4.5 ? Math.min(3, h - 1) : null, low = split ?? top;
    P.box(-w / 2, 0, w / 2, d, 0, h);
    P.box(-w / 2, d, w / 2, d + 0.03, top, h);
    const py = Math.max(TOE + 0.05, low - 0.72);
    P.box(-w / 2, d, w / 2, d + PULL, py, py + Math.min(0.55, (low - TOE) * 0.6));
    if (split) P.box(-w / 2, d, w / 2, d + PULL, split + 0.17, split + 0.17 + Math.min(0.55, (top - split) * 0.6));
  },
  // Front loaders: their round doors stand out from the front.
  washer(P, f) { laundry(P, f, [[0.04, f.h]]); },
  dryer(P, f) { laundry(P, f, [[0.04, f.h]]); },
  'washer-dryer'(P, f) { laundry(P, f, [[0.04, f.h / 2 - 0.02], [f.h / 2 + 0.02, f.h]]); },
  'ac-unit'(P, f) { P.box(-f.w / 2, 0, f.w / 2, f.d + 0.01, 0, f.h + 0.004); },
  // The shelf, and the rod (or two) under it.
  closet(P, f) {
    const { w, d, h } = f;
    P.box(-w / 2, 0, w / 2, d, h + 0.25, h + 0.3);
    const rod = (y) => P.box(-w / 2, d * 0.52 - 0.04, w / 2, d * 0.52 + 0.04, y - 0.04, y + 0.04);
    rod(h);
    if (f.opts?.double) rod(Math.max(1.5, h - 3.3));
  },
  'wall-tile'(P, f) {
    P.box(-f.w / 2, 0, f.w / 2, Math.max(f.d, 0.02), Math.min(f.opts?.bottom ?? 0, f.h - 0.05), f.h);
  },
  'water-heater'(P, f) {
    const r = Math.min(f.w, f.d) / 2;
    P.round(0, f.d / 2, r, r, 0, f.h + 0.12);
  },
  // Hearth in front, mantel shelf on top.
  fireplace(P, f) {
    const { w, d, h } = f, mantel = f.opts?.mantel !== false, body = h - (mantel ? 0.2 : 0);
    P.box(-w / 2 - 0.15, 0, w / 2 + 0.15, d + 0.5, 0, 0.08);
    P.box(-w / 2, 0, w / 2, d, 0.08, body);
    if (mantel) P.box(-w / 2 - 0.12, 0, w / 2 + 0.12, d + 0.18, body, h);
  },
};

function laundry(P, f, units) {
  P.box(-f.w / 2, 0, f.w / 2, f.d + 0.025, 0, f.h);
  for (const [y0, y1] of units) {
    const k = Math.min((y1 - y0) / 3.23, f.w / 2), y = y0 + (y1 - y0) * 0.45;
    P.box(-0.66 * k, f.d, 0.66 * k, f.d + 0.075, y - 0.66 * k, y + 0.66 * k);
  }
}

// A built fixture's parts (src/unit.js, U.fixtures[]) in plan coordinates.
// `ceiling` is its room's.
export function fixtureParts(f, ceiling = 9) {
  const P = new Parts(f.d);
  if (KITCHEN.has(f.type)) kitchen(P, f, ceiling);
  else if (FIXTURES[f.type]) FIXTURES[f.type](P, f, ceiling);
  if (!P.list.length) P.box(-f.w / 2, 0, f.w / 2, f.d, 0, f.h);
  return placeBody(turn(P.list, f.rot), f.x, f.z);
}
