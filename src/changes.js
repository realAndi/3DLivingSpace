// Changes between layouts, for suggestions. Someone makes their own version of
// a unit (a copy keeps every piece's uid), rearranges it and suggests it back.
// What they changed is their layout (theirs) against the original's layout as
// it was when they copied it (base); how it lands on the original as it is now
// (ours) says which of those changes clash with what its owner did since.
// Changes are per piece, grouped so a piece goes with what rests on it: a table
// moved with its lamp is one change. Pure, so the browser previews exactly what
// the server applies. Layouts are lists of placed items (src/design.js), feet.

import { carry } from './stacking.js';
//
// A copy made before suggestions existed has no base: then ours stands in for
// it, nothing counts as a clash, and nothing is suggested for removal (a piece
// missing from theirs may just be one the owner added since).

const NUM = ['w', 'd', 'h', 'x', 'z'];
const TEXT = ['type', 'asset', 'name', 'color', 'on'];
const EPS = 1e-4;

const angle = (a) => ((((a ?? 0) % 360) + 360) % 360);
const turnOf = (from, to) => ((angle(to) - angle(from) + 540) % 360) - 180;

// Is a piece the same in both layouts?
export function samePiece(a, b) {
  if (!a || !b) return false;
  for (const k of [...NUM, 'y']) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > EPS) return false;
  for (const k of TEXT) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return Math.abs(turnOf(a.rot, b.rot)) < 0.01;
}

// What changed about a piece, for saying so: { moved (feet on the plan),
// turned (degrees, + clockwise), resized, recolored, renamed, retyped, raised
// (feet up), onto (its new support: 'floor', 'wall', 'ceiling', 'p:<uid>' or
// 'f:<id>') }, only the ones that did.
export function whatChanged(from, to) {
  const out = {};
  const moved = Math.hypot((to.x ?? 0) - (from.x ?? 0), (to.z ?? 0) - (from.z ?? 0));
  if (moved > 1 / 48) out.moved = moved;
  const turned = turnOf(from.rot, to.rot);
  if (Math.abs(turned) >= 0.5) out.turned = turned;
  if (['w', 'd', 'h'].some((k) => Math.abs((from[k] ?? 0) - (to[k] ?? 0)) > EPS)) out.resized = true;
  if ((from.color ?? null) !== (to.color ?? null)) out.recolored = true;
  if ((from.name ?? '') !== (to.name ?? '')) out.renamed = true;
  if (from.type !== to.type || (from.asset ?? null) !== (to.asset ?? null)) out.retyped = true;
  if ((from.on ?? null) !== (to.on ?? null)) out.onto = to.on ?? 'floor';
  else if (Math.abs((to.y ?? 0) - (from.y ?? 0)) > 1 / 48) out.raised = (to.y ?? 0) - (from.y ?? 0);
  return out;
}

const byUid = (list) => new Map((list ?? []).map((i) => [i.uid, i]));
const supportUid = (item) => (item?.on?.startsWith('p:') ? item.on.slice(2) : null);

// The changes from base to theirs, as they land on ours: [{ id, kind, name,
// conflict, pieces: [{ uid, kind, name, base, theirs, ours, conflict, what }] }].
// kind: 'added', 'changed' or 'removed'. conflict (a piece's, and a group's
// when any of its pieces has one): 'changed' (the owner changed it too since
// the copy was made), 'removed' (the owner removed it since) or 'support'
// (what it rests on isn't in ours). Changes ours already has are left out.
// A group's id is the uid of the piece at its bottom.
export function layoutChanges({ base = null, theirs = [], ours = [] }) {
  const B = byUid(base ?? ours), T = byUid(theirs), O = byUid(ours);
  const pieces = new Map();
  const add = (p) => pieces.set(p.uid, { ...p, name: (p.theirs ?? p.base ?? p.ours).name });
  for (const [uid, t] of T) {
    const b = B.get(uid), o = O.get(uid) ?? null;
    if (o && samePiece(o, t)) continue;
    if (!b) { add({ uid, kind: o ? 'changed' : 'added', base: null, theirs: t, ours: o, conflict: o ? 'changed' : null, what: o ? whatChanged(o, t) : {} }); continue; }
    if (samePiece(b, t)) continue;
    add({ uid, kind: 'changed', base: b, theirs: t, ours: o, conflict: !o ? 'removed' : samePiece(o, b) ? null : 'changed', what: whatChanged(b, t) });
  }
  if (base) {
    for (const [uid, b] of B) {
      const o = O.get(uid);
      if (T.has(uid) || !o) continue;
      add({ uid, kind: 'removed', base: b, theirs: null, ours: o, conflict: samePiece(o, b) ? null : 'changed', what: {} });
    }
  }
  // What a piece rests on must be in ours, or come with it.
  for (const p of pieces.values()) {
    const up = supportUid(p.theirs);
    if (up && !O.has(up) && !pieces.has(up) && !p.conflict) p.conflict = 'support';
  }
  // Group each piece with the changed piece it rests on, down to the bottom one.
  const rootOf = (p) => {
    const seen = new Set([p.uid]);
    let at = p;
    for (;;) {
      const up = supportUid(at.theirs ?? at.base);
      if (!up || seen.has(up) || !pieces.has(up)) return at.uid;
      seen.add(up);
      at = pieces.get(up);
    }
  };
  const groups = new Map();
  for (const p of pieces.values()) {
    const id = rootOf(p);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(p);
  }
  const ORDER = { changed: 0, added: 1, removed: 2 };
  return [...groups].map(([id, list]) => {
    list.sort((a, b) => (a.uid === id ? -1 : b.uid === id ? 1 : a.name.localeCompare(b.name)));
    const root = list[0];
    return { id, kind: root.kind, name: root.name, conflict: list.find((p) => p.conflict)?.conflict ?? null, pieces: list };
  }).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name));
}

// Ours with the chosen groups (their ids, or 'all') taken from theirs:
// { items, assets, applied: number of groups }. The owner's own pieces resting
// on a piece that moves go with it; a piece whose support is gone is set on
// the floor; and the custom pieces it needs come along.
export function applyChanges({ base = null, theirs = [], ours = [], theirAssets = [], ourAssets = [], select = 'all' }) {
  const groups = layoutChanges({ base, theirs, ours });
  const chosen = select === 'all' ? groups : groups.filter((g) => select.includes(g.id));
  const out = new Map(ours.map((i) => [i.uid, { ...i }]));
  const taken = new Set();
  for (const g of chosen) {
    for (const p of g.pieces) {
      taken.add(p.uid);
      if (p.theirs) out.set(p.uid, { ...p.theirs });
      else out.delete(p.uid);
    }
  }
  // What the owner has set on a piece that moves (a vase added since) moves with it.
  for (const g of chosen) {
    for (const p of g.pieces) {
      if (!p.theirs || !p.ours) continue;
      for (const m of carry(p.ours, p.theirs, ours, ourAssets)) if (!taken.has(m.uid) && out.has(m.uid)) Object.assign(out.get(m.uid), m);
    }
  }
  for (const item of out.values()) {
    const up = supportUid(item);
    if (up && !out.has(up)) { delete item.on; delete item.y; }
  }
  const assets = [...ourAssets];
  const have = new Set(assets.map((a) => a.id));
  for (const item of out.values()) {
    if (item.type !== 'asset' || have.has(item.asset)) continue;
    const a = theirAssets.find((x) => x.id === item.asset);
    if (a) { assets.push(a); have.add(a.id); }
  }
  return { items: [...out.values()], assets, applied: chosen.length };
}
