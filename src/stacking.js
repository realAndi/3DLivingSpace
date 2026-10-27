// Pieces off the floor: what holds each one up, and putting it there. A
// surface piece (a lamp, books, a coffee maker) rests on the top or a shelf
// of a placed piece or of a built-in (a counter, an island, a vanity); a wall
// piece (art, a mirror, a TV) hangs with its back against a wall at a height;
// a ceiling piece (a pendant, a fan) hangs with its top against the ceiling.
// Moving a piece carries whatever rests on it. Pure, so the browser's editor
// and the server's tools place things the same way. Feet; `U` is a built unit
// (src/unit.js), `items` the placed pieces, `assets` the custom ones.
//
// An item's `on` names its support: 'p:<uid>' a piece, 'f:<id>' a fixture,
// 'wall', 'ceiling', or nothing for the floor. Its `y` is the height of its
// underside, which for a resting piece is the height of the surface under it.

import { placeOf, actOf, footprint, catalogByType } from './catalog.js';
import { pieceSurfaces, fixtureSurfaces } from './parts.js';
import { pointInPoly } from './geometry.js';

const EPS = 0.02;   // ¼": a piece this close to a surface's height is on it

// ---------------------------------------------------------------------------
// Supports

export const onPiece = (item) => (item.on?.startsWith('p:') ? item.on.slice(2) : null);
export const onFixture = (item) => (item.on?.startsWith('f:') ? item.on.slice(2) : null);
export const restsOn = (item, uid) => item.on === `p:${uid}`;

// What holds the piece up: { kind: 'floor' | 'wall' | 'ceiling' } or
// { kind: 'piece', piece } or { kind: 'fixture', fixture }, or { kind:
// 'missing' } when its support isn't there.
export function supportOf(item, items = [], U = null) {
  if (!item.on) return { kind: 'floor' };
  if (item.on === 'wall' || item.on === 'ceiling') return { kind: item.on };
  const uid = onPiece(item);
  if (uid) {
    const piece = items.find((i) => i.uid === uid);
    return piece ? { kind: 'piece', piece } : { kind: 'missing' };
  }
  const fixture = U?.fixtures.find((f) => f.id === onFixture(item));
  return fixture ? { kind: 'fixture', fixture } : { kind: 'missing' };
}

// Everything resting on the piece, and on those, and so on.
export function descendants(uid, items) {
  const out = [];
  const queue = [uid];
  while (queue.length) {
    const at = queue.shift();
    for (const i of items) if (restsOn(i, at) && !out.includes(i) && i.uid !== uid) { out.push(i); queue.push(i.uid); }
  }
  return out;
}

// What holds the piece up, and what holds that up, and so on.
export function ancestors(item, items) {
  const out = [];
  let at = item;
  while (onPiece(at) && out.length < items.length) {
    const up = items.find((i) => i.uid === onPiece(at));
    if (!up || up === item || out.includes(up)) break;
    out.push(up);
    at = up;
  }
  return out;
}

// The pieces under and over this one: what it may touch or pass through
// without colliding (a vase on a bookshelf's middle shelf is inside the
// bookshelf's one solid box, and so are the books under the vase).
export function relatives(item, items) {
  return new Set([...descendants(item.uid, items), ...ancestors(item, items)].map((i) => i.uid));
}

// ---------------------------------------------------------------------------
// Surfaces

const fixtureCache = new WeakMap();
function fixtureSurfaceList(U) {
  if (!U) return [];
  if (!fixtureCache.has(U)) {
    fixtureCache.set(U, U.fixtures.flatMap((f) => fixtureSurfaces(f).map((s) => ({ ...s, on: `f:${f.id}`, name: f.name, rot: f.rot }))));
  }
  return fixtureCache.get(U);
}

// Every surface of a support: [{ poly, aabb, y, clear, on, name, rot }],
// lowest first; rot is the way the support faces.
export function surfacesOf(support, U = null, assets = null) {
  if (support.kind === 'piece') return pieceSurfaces(support.piece, assets).map((s) => ({ ...s, on: `p:${support.piece.uid}`, name: support.piece.name, rot: support.piece.rot }));
  if (support.kind === 'fixture') return fixtureSurfaceList(U).filter((s) => s.on === `f:${support.fixture.id}`);
  return [];
}

// Surfaces of placed pieces and built-ins over the point (x, z), highest
// first. `exclude` (uids) leaves out a piece being moved and what rests on it.
export function surfacesAt(x, z, { items = [], U = null, assets = null, exclude = new Set() } = {}) {
  const out = [];
  const inside = (s) => x >= s.aabb[0] && x <= s.aabb[2] && z >= s.aabb[1] && z <= s.aabb[3] && pointInPoly(x, z, s.poly);
  for (const s of fixtureSurfaceList(U)) if (inside(s)) out.push(s);
  for (const p of items) {
    if (exclude.has(p.uid)) continue;
    for (const s of pieceSurfaces(p, assets)) if (inside(s)) out.push({ ...s, on: `p:${p.uid}`, name: p.name, rot: p.rot });
  }
  return out.sort((a, b) => b.y - a.y);
}

// The surface a resting piece is on: its support's surface under its center
// at its height, or null.
export function surfaceUnder(item, items = [], U = null, assets = null) {
  const support = supportOf(item, items, U);
  if (support.kind !== 'piece' && support.kind !== 'fixture') return null;
  const y = item.y ?? 0;
  let best = null;
  for (const s of surfacesOf(support, U, assets)) {
    if (!pointInPoly(item.x, item.z, s.poly)) continue;
    if (!best || Math.abs(s.y - y) < Math.abs(best.y - y)) best = s;
  }
  return best;
}

// Move (x, z) so the piece's footprint lies inside a surface, as little as
// possible. Convex outlines only (every surface is one). Returns { x, z }, or
// null when it is too big to fit.
export function fitOnSurface(item, surface) {
  const inside = (x, z) => footprint({ ...item, x, z }).every(([px, pz]) => pointInPoly(px, pz, surface.poly) || onEdge(px, pz, surface.poly));
  if (inside(item.x, item.z)) return { x: item.x, z: item.z };
  // Toward the surface's middle, by halves, to the first spot that fits.
  const cx = surface.poly.reduce((a, p) => a + p[0], 0) / surface.poly.length;
  const cz = surface.poly.reduce((a, p) => a + p[1], 0) / surface.poly.length;
  if (!inside(cx, cz)) return null;
  let lo = 0, hi = 1;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2;
    if (inside(item.x + (cx - item.x) * mid, item.z + (cz - item.z) * mid)) hi = mid; else lo = mid;
  }
  return { x: item.x + (cx - item.x) * hi, z: item.z + (cz - item.z) * hi };
}

function onEdge(x, z, poly, tol = 1e-4) {
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    if (Math.hypot(x - ax - t * dx, z - az - t * dz) < tol) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Walls

// Wall faces are the room edges (U.edges); what stands behind one is the
// wall's solid spans of height (U.wallAt), so a window is a gap between its
// sill and its head, and a doorway has wall only above its head.

// The wall's solid spans of height behind an edge at s, or null.
const BEHIND = 1 / 24;
const wallBehind = (U, e, s) => U.wallAt(e.p[0] + e.u[0] * s + e.n[0] * BEHIND, e.p[1] + e.u[1] * s + e.n[1] * BEHIND);
const covers = (spans, y0, y1) => !!spans?.some(([a, b]) => a <= y0 + 1e-3 && b >= y1 - 1e-3);
// Where to look along a piece's width: both ends (⅛" in) and every 6" between.
function across(w) {
  const half = Math.max(0, w / 2 - 1 / 96), n = Math.max(2, Math.ceil((2 * half) / 0.5));
  return Array.from({ length: n + 1 }, (_, i) => -half + (2 * half * i) / n);
}

// The plan rotation that faces a piece away from a wall whose outward normal is n.
export const facing = (n) => Math.round(((((Math.atan2(n[0], -n[1]) * 180) / Math.PI) % 360) + 360) % 360 * 1e4) / 1e4;

// Hang a wall piece on the wall nearest (x, z), back flush against its face,
// facing into the room, at height y: { x, z, rot, room } or null when no wall
// within `reach` stands there at that height. Curtains and blinds may hang in
// front of a window; anything else needs wall behind all of it.
export function hangOnWall(item, x, z, U, { y = item.y ?? 0, reach = 3 } = {}) {
  if (!U) return null;
  const sheer = actOf(item) === 'curtain';
  // Faces of the room the point is in come first: a point near a wall
  // between two rooms means this room's side of it.
  const here = U.roomAt(x, z)?.id ?? null;
  let best = null;
  for (const e of U.edges) {
    const dx = x - e.p[0], dz = z - e.p[1];
    const t = dx * e.n[0] + dz * e.n[1];
    // The point has to be on the room's side of the face (or in the wall).
    if (t < -reach || t > 1.5) continue;
    // Kept between the edge's ends, clear of the walls at its corners.
    const half = item.w / 2, along = dx * e.u[0] + dz * e.u[1];
    const s = e.len >= item.w ? Math.max(half, Math.min(e.len - half, along)) : e.len / 2;
    const off = Math.hypot(t, along - s) + (here && e.room !== here ? 1 : 0);
    if (off > reach) continue;
    // Wall behind all of it, high enough.
    const ok = across(item.w).map((k) => s + k).every((k) => {
      const spans = wallBehind(U, e, k);
      return sheer ? !!spans : covers(spans, y, y + item.h);
    });
    if (!ok) continue;
    if (!best || off < best.off) best = { e, s, off };
  }
  if (!best) return null;
  const { e, s } = best;
  const bx = e.p[0] + e.u[0] * s, bz = e.p[1] + e.u[1] * s;
  return {
    x: round(bx - e.n[0] * (item.d / 2)), z: round(bz - e.n[1] * (item.d / 2)),
    rot: facing(e.n), room: e.room,
  };
}

// The wall within 1" behind a piece's back, at each point across it: its
// solid spans of height, or null where there's none.
function spansBehind(item, U) {
  const back = [-Math.sin((item.rot * Math.PI) / 180), Math.cos((item.rot * Math.PI) / 180)].map((v) => -v);
  const right = [Math.cos((item.rot * Math.PI) / 180), Math.sin((item.rot * Math.PI) / 180)];
  return across(item.w).map((k) => {
    const bx = item.x + back[0] * (item.d / 2) + right[0] * k, bz = item.z + back[1] * (item.d / 2) + right[1] * k;
    for (const t of [BEHIND, 1 / 12]) { const spans = U.wallAt(bx + back[0] * t, bz + back[1] * t); if (spans) return spans; }
    return null;
  });
}

// Is the piece's back against a wall that stands behind all of it? A note on
// what's wrong, or null.
export function wallProblem(item, U) {
  if (!U) return null;
  const y = item.y ?? 0, sheer = actOf(item) === 'curtain';
  const behind = spansBehind(item, U);
  if (behind.some((spans) => !spans)) return 'isn\'t against a wall';
  if (!sheer && !behind.every((spans) => covers(spans, y, y + item.h))) return 'hangs over a window or doorway';
  return null;
}

// Curtains and blinds are cloth: you walk through them. All but where one
// hangs against wall that stands from the floor all the way across behind it
// (in front of a window, the wall under the sill): there's nowhere to go, and
// it keeps you out of its folds. So one hung in the middle of a room, from
// the ceiling, or across a doorway doesn't stop you.
export function walkThrough(item, U, assets = null) {
  if (actOf(item, assets) !== 'curtain') return false;
  if (item.on !== 'wall') return true;
  return !!U && spansBehind(item, U).some((spans) => !spans || spans[0][0] > 0.05);
}

// ---------------------------------------------------------------------------
// Ceilings

export function ceilingAt(x, z, U) {
  return U?.roomAt(x, z)?.ceiling ?? U?.heights?.ceiling ?? 9;
}
// The height of a ceiling piece's underside: its top against the ceiling.
export const ceilingY = (item, U) => round(Math.max(0, ceilingAt(item.x, item.z, U) - item.h));

// ---------------------------------------------------------------------------
// Placing

// Where a piece goes by default, from its type: on a surface under (x, z) if
// it's a surface piece and there is one, on the nearest wall, on the ceiling,
// or on the floor. Returns the changes { x, z, y, on, rot }, with on: null
// for the floor (and face, the way a surface's support faces, for a piece
// set down new to face the same way); or null for a wall piece with no wall
// nearby.
export function placeByType(item, { items = [], U = null, assets = null } = {}) {
  const place = placeOf(item, assets);
  if (place === 'wall') {
    const y = item.y ?? (catalogByType[item.type]?.y ?? 48) / 12;
    const hung = hangOnWall({ ...item, y }, item.x, item.z, U, { y });
    return hung ? { x: hung.x, z: hung.z, rot: hung.rot, y, on: 'wall' } : null;
  }
  if (place === 'ceiling') return { x: item.x, z: item.z, y: ceilingY(item, U), on: 'ceiling' };
  if (place === 'surface') {
    const exclude = new Set([item.uid, ...descendants(item.uid, items).map((i) => i.uid)]);
    for (const s of surfacesAt(item.x, item.z, { items, U, assets, exclude })) {
      if (item.h > s.clear + EPS) continue;
      const p = fitOnSurface(item, s);
      if (p) return { ...p, y: s.y, on: s.on, face: s.rot ?? 0 };
    }
  }
  return { x: item.x, z: item.z, y: 0, on: null };
}

// Rest a piece on a support's surface: the surfaces under (x, z) (or all of
// them), nearest the height `y` or else the highest it fits under, the
// biggest first; the piece pulled in to fit on the first that holds it.
// Returns { x, z, y, on, face } (face: the way the support faces) or a
// sentence saying why not.
export function restOn(item, support, { x = item.x, z = item.z, y = null, U = null, assets = null } = {}) {
  const list = surfacesOf(support, U, assets);
  const name = support.piece?.name ?? support.fixture?.name ?? 'That';
  if (!list.length) return `${name} has no top or shelf to put things on.`;
  const under = list.filter((s) => pointInPoly(x, z, s.poly));
  const area = (s) => (s.aabb[2] - s.aabb[0]) * (s.aabb[3] - s.aabb[1]);
  const fits = (s) => item.h <= s.clear + EPS;
  const order = (y === null
    ? [...under].sort((a, b) => Number(fits(b)) - Number(fits(a)) || b.y - a.y || area(b) - area(a))
    : [...under].sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y) || area(b) - area(a)));
  // Then the rest, in the same order, centered on each.
  const rest = list.filter((s) => !under.includes(s)).sort((a, b) => (y === null ? Number(fits(b)) - Number(fits(a)) || b.y - a.y : Math.abs(a.y - y) - Math.abs(b.y - y)) || area(b) - area(a));
  for (const s of [...order, ...rest]) {
    const p = fitOnSurface({ ...item, ...(under.includes(s) ? { x, z } : centerOf(s.poly)) }, s);
    if (p) return { x: round(p.x), z: round(p.z), y: round(s.y), on: s.on, face: s.rot ?? 0 };
  }
  return `${item.name ?? 'It'} is too big to fit on ${name}.`;
}

const centerOf = (poly) => ({ x: poly.reduce((a, p) => a + p[0], 0) / poly.length, z: poly.reduce((a, p) => a + p[1], 0) / poly.length });
const round = (v) => Math.round(v * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Carrying

// A piece moved, turned, resized or raised from `before` to `after`: where
// everything resting on it goes, as [{ uid, x, z, rot, y }] for each
// descendant. They keep their spot relative to it (turning with it), and
// stay on the same shelf (the n-th surface from the bottom).
export function carry(before, after, items, assets = null) {
  const out = [];
  const move = (b, a) => {
    const turn = (((a.rot - b.rot) % 360) + 360) % 360, r = (turn * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const sb = pieceSurfaces(b, assets), sa = pieceSurfaces(a, assets);
    for (const child of items) {
      if (!restsOn(child, b.uid)) continue;
      const dx = child.x - b.x, dz = child.z - b.z;
      let k = 0;
      for (let i = 1; i < sb.length; i++) if (Math.abs(sb[i].y - (child.y ?? 0)) < Math.abs(sb[k].y - (child.y ?? 0))) k = i;
      const y = sa.length ? sa[Math.min(k, sa.length - 1)].y : (child.y ?? 0) + ((a.y ?? 0) - (b.y ?? 0));
      const next = {
        uid: child.uid,
        x: round(a.x + dx * c - dz * s), z: round(a.z + dx * s + dz * c),
        rot: round((((child.rot + turn) % 360) + 360) % 360), y: round(y),
      };
      out.push(next);
      move(child, { ...child, ...next });
    }
  };
  move(before, after);
  return out;
}

// ---------------------------------------------------------------------------
// Checks

// What is wrong with what holds a piece up, as short phrases: floating,
// sunk into or hanging off its surface, too tall for its shelf, not against
// a wall, not up against the ceiling.
export function restingProblems(item, items = [], U = null, assets = null) {
  if (!U) return [];
  const y = item.y ?? 0, out = [];
  const support = supportOf(item, items, U);
  if (support.kind === 'missing') return ['rests on something that isn\'t there'];
  if (support.kind === 'floor') {
    if (y > EPS) out.push(`floats ${inches(y)} above the floor`);
    return out;
  }
  if (support.kind === 'wall') {
    const w = wallProblem(item, U);
    if (w) out.push(w);
    if (y < -EPS) out.push('goes below the floor');
    return out;
  }
  if (support.kind === 'ceiling') {
    const gap = ceilingAt(item.x, item.z, U) - (y + item.h);
    if (gap > 1 / 12) out.push(`hangs ${inches(gap)} below the ceiling`);
    else if (gap < -1 / 12) out.push('goes up into the ceiling');
    return out;
  }
  const name = support.piece?.name ?? support.fixture?.name ?? 'it';
  const s = surfaceUnder(item, items, U, assets);
  if (!s || Math.abs(s.y - y) > EPS) {
    out.push(s && y < s.y ? `sinks into the ${name.toLowerCase()}` : `floats above the ${name.toLowerCase()}`);
    return out;
  }
  if (!fitOnSurface({ ...item }, s) || !footprint(item).every(([px, pz]) => pointInPoly(px, pz, s.poly) || onEdge(px, pz, s.poly, 0.02))) {
    out.push(`hangs off the edge of the ${name.toLowerCase()}`);
  }
  if (item.h > s.clear + EPS) out.push('is too tall for the shelf');
  return out;
}

function inches(ft) {
  const v = Math.round(ft * 24) / 2;
  return v >= 24 ? `${Math.floor(v / 12)}'${v % 12 ? `${v % 12}"` : ''}` : `${v}"`;
}
