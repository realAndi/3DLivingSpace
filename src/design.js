// A design document: one person's unit (src/unit.js), the furniture placed in
// it and the custom pieces made for it. Shared by the browser and the server,
// which both run everything through these checks.
//
// Placed items are in feet: x and z are the footprint's center (x east, z
// south, in the unit's own coordinates), w/d/h are width, depth and height,
// rot is degrees clockwise on the plan with 0 facing south.
//
// Assets are custom 3D pieces built from primitives, usually by an AI through
// the MCP server. Their parts are in inches, in the piece's own frame: origin
// at the center of its footprint on the floor, +x to the piece's right as you
// face it, +y up, +z toward its front.

import { catalogByType, swatchKeys } from './catalog.js';
import { cleanUnit } from './unit.js';

export const LIMITS = { items: 150, assets: 40, parts: 120, title: 60, author: 40, name: 40, description: 200, partInches: 240 };
export const SHAPES = ['box', 'cylinder', 'cone', 'sphere'];
export const FINISHES = ['matte', 'satin', 'gloss', 'metal', 'glass', 'fabric', 'wood'];

const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
export function randomId(length = 10) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const num = (v, lo, hi, dflt) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, +v)) : dflt);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const uidOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{4,24}$/.test(v);
const r3 = (v) => Math.round(v * 1000) / 1000;

export function cleanColor(v) {
  if (v == null || v === '') return null;
  if (swatchKeys.includes(v)) return v;
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

// ---------------------------------------------------------------- assets
function cleanPart(p) {
  if (!p || !SHAPES.includes(p.shape)) return null;
  const v3 = (v, lo, hi, dflt) => (Array.isArray(v) ? [0, 1, 2].map((i) => r3(num(v[i], lo, hi, dflt))) : [dflt, dflt, dflt]);
  const L = LIMITS.partInches;
  return {
    shape: p.shape,
    size: v3(p.size, 0.05, L, 1),
    at: v3(p.at, -L, L, 0),
    rot: v3(p.rot, -360, 360, 0),
    color: cleanColor(p.color) ?? '#b8b2a8',
    finish: FINISHES.includes(p.finish) ? p.finish : 'matte',
  };
}

// Axis-aligned box around a part after its rotation (degrees, XYZ order).
function partBox(p) {
  const [rx, ry, rz] = p.rot.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const m = [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
  const h = p.size.map((s) => s / 2);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) {
    const v = [a * h[0], b * h[1], c * h[2]];
    for (let i = 0; i < 3; i++) {
      const w = m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] + p.at[i];
      lo[i] = Math.min(lo[i], w); hi[i] = Math.max(hi[i], w);
    }
  }
  return { lo, hi };
}

// Validate an asset and move its parts so the footprint is centered on the
// origin and the lowest point sits on the floor. Returns null if unusable.
export function cleanAsset(raw) {
  if (!raw || !Array.isArray(raw.parts)) return null;
  const parts = raw.parts.slice(0, LIMITS.parts).map(cleanPart).filter(Boolean);
  if (!parts.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const b = partBox(p);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.lo[i]); hi[i] = Math.max(hi[i], b.hi[i]); }
  }
  const shift = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  for (const p of parts) p.at = p.at.map((v, i) => r3(v - shift[i]));
  return {
    id: uidOk(raw.id) ? raw.id : randomId(8),
    name: text(raw.name, LIMITS.name) || 'Custom piece',
    description: text(raw.description, LIMITS.description),
    parts,
    // Size in inches, as built.
    w: r3(hi[0] - lo[0]), h: r3(hi[1] - lo[1]), d: r3(hi[2] - lo[2]),
  };
}

// ---------------------------------------------------------------- items
export function cleanItem(raw, assets = {}) {
  if (!raw) return null;
  const asset = raw.type === 'asset' ? assets[raw.asset] : null;
  const def = catalogByType[raw.type];
  if (!def && !asset) return null;
  const base = asset ? { name: asset.name, w: asset.w / 12, d: asset.d / 12, h: asset.h / 12 } : { name: def.name, w: def.w / 12, d: def.d / 12, h: def.h / 12 };
  const item = {
    uid: uidOk(raw.uid) ? raw.uid : randomId(8),
    type: asset ? 'asset' : raw.type,
    name: text(raw.name, LIMITS.name) || base.name,
    w: r3(num(raw.w, 0.1, 30, base.w)), d: r3(num(raw.d, 0.1, 30, base.d)), h: r3(num(raw.h, 0.02, 9, base.h)),
    x: r3(num(raw.x, -200, 400, 10)), z: r3(num(raw.z, -200, 400, 10)),
    rot: r3((((num(raw.rot, -3600, 3600, 0)) % 360) + 360) % 360),
    color: cleanColor(raw.color),
  };
  if (asset) item.asset = asset.id;
  return item;
}

// A whole design document: { title, author, unit, items, assets }.
export function cleanDesign(raw = {}) {
  const assets = {};
  for (const a of (Array.isArray(raw.assets) ? raw.assets : Object.values(raw.assets ?? {})).slice(0, LIMITS.assets)) {
    const clean = cleanAsset(a);
    if (clean) assets[clean.id] = clean;
  }
  const seen = new Set();
  const items = [];
  for (const i of (Array.isArray(raw.items) ? raw.items : []).slice(0, LIMITS.items)) {
    const clean = cleanItem(i, assets);
    if (!clean || seen.has(clean.uid)) continue;
    seen.add(clean.uid);
    items.push(clean);
  }
  return { title: text(raw.title, LIMITS.title), author: text(raw.author, LIMITS.author), unit: cleanUnit(raw.unit ?? {}).unit, items, assets: Object.values(assets) };
}
