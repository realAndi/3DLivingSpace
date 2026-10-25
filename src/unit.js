// A unit: the apartment itself, as plain data, and everything derived from it
// that both the browser and the server need. No three.js, so Node imports it
// as is.
//
// The spec is what gets stored: rooms (clear floor outlines), extra walls,
// doors and windows, built-in fixtures (kitchen, baths, laundry, closets),
// finishes and a few heights. Feet throughout; the MCP server speaks inches
// and converts at its edge with fromInches / toInches below.
//
// Walls are not drawn one by one. Rooms are the clear floor inside the walls,
// so wherever two rooms sit a few inches apart the gap between them is wall,
// where they touch they are open to each other, and every indoor room gets an
// outside wall `exteriorWall` thick around whatever doesn't touch another
// room. Extra walls (a pier, a half wall, a column) are listed separately.
// Doors and windows are placed by a point on or in the wall; each is cut out
// of the wall it lands in.
//
// Axes: x east (plan right), z south (plan down), y up. Rotations are degrees
// clockwise on the plan, and 0 means a fixture's front faces south (+z), the
// same as furniture. Compass yaw: 0 north, 90 east.

import { pointInPoly, polygonArea, polyBounds, labelPoint, orientedRect, frontOf, rightOf, parseFeetInches } from './geometry.js';

// ---------------------------------------------------------------------------
// Vocabulary

export const ROOM_KINDS = ['living', 'kitchen', 'dining', 'bedroom', 'bath', 'closet', 'hall', 'entry', 'laundry', 'office', 'storage', 'pantry', 'utility', 'balcony', 'other'];
export const OUTDOOR_KINDS = new Set(['balcony']);
// Small rooms: smaller labels, no furniture suggestions.
export const MINOR_KINDS = new Set(['closet', 'storage', 'pantry', 'utility', 'laundry']);
export const FLOORS = ['wood', 'wood-dark', 'tile', 'stone', 'carpet', 'concrete', 'deck'];

export const OPENING_TYPES = [
  { type: 'door', name: 'Door', about: 'A hinged door.' },
  { type: 'entry', name: 'Entry door', about: 'The front door: a solid hinged door.' },
  { type: 'double', name: 'Double doors', about: 'A pair of hinged doors (French doors).' },
  { type: 'pocket', name: 'Pocket door', about: 'Slides into the wall.' },
  { type: 'barn', name: 'Barn door', about: 'Slides along the face of the wall.' },
  { type: 'bifold', name: 'Bifold doors', about: 'Folding closet doors.' },
  { type: 'closet-slider', name: 'Sliding closet doors', about: 'Two overlapping sliding panels.' },
  { type: 'slider', name: 'Sliding glass door', about: 'A glass patio or balcony door.' },
  { type: 'opening', name: 'Open doorway', about: 'A cased opening with no door.' },
  { type: 'window', name: 'Window', about: 'A window, sill to head.' },
];
const OPENING = Object.fromEntries(OPENING_TYPES.map((o) => [o.type, o]));
const SWINGS = new Set(['door', 'entry', 'double']);

// Built-in fixtures. Sizes are typical, in inches: width side to side as you
// face the front, depth back to front, height. `wall` marks fixtures that
// normally stand against a wall (their back is slid flush when placed).
export const FIXTURES = [
  { type: 'kitchen-run', name: 'Kitchen cabinets', group: 'Kitchen', w: 120, d: 25.5, h: 36, wall: true,
    about: 'A run of base cabinets along a wall with one continuous counter, and uppers above. List its parts left to right as you face it in `segments`; appliances are segments too. Height is the counter height.' },
  { type: 'island', name: 'Island', group: 'Kitchen', w: 72, d: 36, h: 36, about: 'Cabinets with a counter that overhangs the front for stools.' },
  { type: 'fridge', name: 'Refrigerator', group: 'Kitchen', w: 36, d: 30, h: 70, wall: true },
  { type: 'range', name: 'Range', group: 'Kitchen', w: 30, d: 26, h: 36, wall: true },
  { type: 'dishwasher', name: 'Dishwasher', group: 'Kitchen', w: 24, d: 25.5, h: 36, wall: true },
  { type: 'sink-cabinet', name: 'Sink cabinet', group: 'Kitchen', w: 33, d: 25.5, h: 36, wall: true },
  { type: 'base-cabinet', name: 'Base cabinet', group: 'Kitchen', w: 24, d: 25.5, h: 36, wall: true },
  { type: 'upper-cabinet', name: 'Wall cabinet', group: 'Kitchen', w: 30, d: 12, h: 30, wall: true, blocks: false, about: 'Hung on the wall; `bottom` is how high its underside is.' },
  { type: 'pantry', name: 'Pantry cabinet', group: 'Kitchen', w: 24, d: 24, h: 84, wall: true },

  { type: 'toilet', name: 'Toilet', group: 'Bath', w: 20, d: 28, h: 30, wall: true },
  { type: 'vanity', name: 'Vanity', group: 'Bath', w: 36, d: 21, h: 34, wall: true, about: 'Cabinet with a stone top and sink(s), a mirror and a light bar above.' },
  { type: 'tub', name: 'Bathtub', group: 'Bath', w: 60, d: 30, h: 20, wall: true, about: 'Alcove tub; with shower: true it gets a shower head and tile around it.' },
  { type: 'shower', name: 'Walk-in shower', group: 'Bath', w: 60, d: 36, h: 84, wall: true, about: 'Shower floor with tiled walls on the sides that touch walls, and glass on the open sides. Height is how high the tile and glass go.' },
  { type: 'wall-tile', name: 'Tiled wall', group: 'Bath', w: 60, d: 0.5, h: 48, wall: true, blocks: false, about: 'Tile on a wall face: a backsplash, wainscot or shower wall. Height is the top of the tile.' },

  { type: 'washer-dryer', name: 'Stacked washer and dryer', group: 'Laundry', w: 27, d: 30, h: 76, wall: true },
  { type: 'washer', name: 'Washer', group: 'Laundry', w: 27, d: 30, h: 38, wall: true },
  { type: 'dryer', name: 'Dryer', group: 'Laundry', w: 27, d: 30, h: 38, wall: true },
  { type: 'water-heater', name: 'Water heater', group: 'Laundry', w: 22, d: 22, h: 60 },
  { type: 'utility-sink', name: 'Utility sink', group: 'Laundry', w: 24, d: 22, h: 36, wall: true },

  { type: 'closet', name: 'Closet shelf and rod', group: 'Storage', w: 48, d: 24, h: 66, wall: true, blocks: false, about: 'A shelf with a hanging rod under it. Height is the rod height.' },
  { type: 'shelves', name: 'Built-in shelves', group: 'Storage', w: 36, d: 12, h: 84, wall: true },
  { type: 'built-in', name: 'Built-in cabinet', group: 'Storage', w: 36, d: 24, h: 36, wall: true },

  { type: 'fireplace', name: 'Fireplace', group: 'Other', w: 60, d: 16, h: 48, wall: true },
  { type: 'column', name: 'Column', group: 'Other', w: 12, d: 12, h: 0, about: 'Floor to ceiling.' },
  { type: 'radiator', name: 'Radiator', group: 'Other', w: 36, d: 6, h: 24, wall: true },
  { type: 'ac-unit', name: 'Wall AC unit', group: 'Other', w: 42, d: 14, h: 16, wall: true },
  { type: 'counter', name: 'Bar counter', group: 'Other', w: 60, d: 16, h: 42 },
];
export const fixtureByType = Object.fromEntries(FIXTURES.map((f) => [f.type, f]));

// Kitchen parts, for a kitchen-run's segments; widths in inches.
export const SEGMENTS = {
  base: { w: 24, upper: true, about: 'Base cabinet with doors (drawers: true for a drawer on top).' },
  drawers: { w: 24, upper: true, about: 'Stack of drawers.' },
  sink: { w: 33, upper: true, about: 'Sink base with an undermount sink and faucet.' },
  dishwasher: { w: 24, upper: true },
  range: { w: 30, upper: false, about: 'Range; the run\'s `hood` puts a microwave or hood above it.' },
  cooktop: { w: 30, upper: false, about: 'Cooktop over a base cabinet.' },
  fridge: { w: 36, upper: false, about: 'Refrigerator, with a cabinet above when the run has uppers.' },
  pantry: { w: 24, upper: false, about: 'Tall cabinet up to the top of the uppers.' },
  oven: { w: 30, upper: false, about: 'Tall cabinet with a wall oven.' },
  filler: { w: 3, upper: true },
  corner: { w: 24, upper: true, about: 'Blind corner cabinet where another run meets this one; the counter continues.' },
  end: { w: 0.75, upper: false, about: 'End panel.' },
  open: { w: 24, upper: true, about: 'Open knee space under the counter.' },
};
const KITCHEN_TYPES = { fridge: 'fridge', range: 'range', dishwasher: 'dishwasher', 'sink-cabinet': 'sink', 'base-cabinet': 'base', pantry: 'pantry' };

// Per-type options. 'len' values are lengths (inches over MCP, feet stored).
export const FIXTURE_OPTIONS = {
  'kitchen-run': {
    segments: 'segments', uppers: 'bool', upper_bottom: 'len', upper_top: 'len', soffit: 'bool',
    backsplash: ['subway', 'stone', 'none'], hood: ['microwave', 'hood', 'none'], drawers: 'bool',
  },
  island: { overhang: 'len', sink: 'bool', cooktop: 'bool' },
  'base-cabinet': { drawers: 'bool' },
  'upper-cabinet': { bottom: 'len' },
  range: { hood: ['microwave', 'hood', 'none'] },
  vanity: { sinks: [1, 2], mirror: 'bool', light: 'bool' },
  tub: { shower: 'bool', enclosure: ['curtain', 'glass', 'none'], tile_height: 'len' },
  shower: { glass: ['panel', 'door', 'none'], entry: ['left', 'right', 'center'], curb: 'bool' },
  'wall-tile': { bottom: 'len' },
  closet: { double: 'bool' },
  fireplace: { mantel: 'bool' },
};

export const FINISH_OPTIONS = {
  walls: 'paint color, "#rrggbb"',
  floor: FLOORS,
  cabinets: ['oak', 'walnut', 'white', 'gray', 'navy', 'sage', 'black'],
  counters: ['quartz', 'marble', 'black', 'wood', 'concrete'],
  backsplash: ['subway', 'stone', 'none'],
  appliances: ['steel', 'white', 'black'],
  hardware: ['black', 'steel', 'brass'],
  tile: ['warm-gray', 'white', 'charcoal'],
};
export const DEFAULT_FINISHES = { walls: '#f2f1ee', floor: 'wood', cabinets: 'oak', counters: 'quartz', backsplash: 'subway', appliances: 'steel', hardware: 'black', tile: 'warm-gray' };

export const UNIT_LIMITS = { rooms: 40, walls: 80, openings: 100, fixtures: 150, labels: 20, lights: 150, points: 48, name: 60, roomName: 40, text: 40 };

export const DEFAULTS = { ceiling: 9, doorHeight: 80 / 12, windowSill: 2, windowHead: 80 / 12, exteriorWall: 8 / 12, level: 3 };

// ---------------------------------------------------------------------------
// Cleaning: everything stored passes through here, from the browser or an agent.

const COORD = 400;
const r4 = (v) => Math.round(v * 10000) / 10000;
const num = (v, lo, hi, dflt) => (v !== null && v !== '' && v !== undefined && Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : dflt);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const pt = (v) => (Array.isArray(v) && v.length >= 2 && Number.isFinite(+v[0]) && Number.isFinite(+v[1])
  ? [r4(num(v[0], -COORD, COORD, 0)), r4(num(v[1], -COORD, COORD, 0))] : null);
const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const compass = (v) => {
  const s = String(v ?? '').toLowerCase().trim();
  return { n: 'north', north: 'north', s: 'south', south: 'south', e: 'east', east: 'east', w: 'west', west: 'west' }[s] ?? null;
};
const DIR = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

function uniqueId(raw, fallback, used) {
  let id = typeof raw === 'string' && ID.test(raw) ? raw : (slug(fallback) || 'x');
  if (!ID.test(id)) id = 'x';
  let out = id, k = 2;
  while (used.has(out)) out = `${id.slice(0, 20)}-${k++}`;
  used.add(out);
  return out;
}

export function cleanRoom(raw, used = new Set(), why = []) {
  const poly = (Array.isArray(raw?.poly) ? raw.poly : []).slice(0, UNIT_LIMITS.points).map(pt).filter(Boolean);
  // Drop repeated points and a closing point that repeats the first.
  const p2 = poly.filter((p, i) => { const q = poly[(i + poly.length - 1) % poly.length]; return poly.length < 2 || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3; });
  const name = text(raw?.name, UNIT_LIMITS.roomName);
  if (p2.length < 3 || Math.abs(polygonArea(p2)) < 1) {
    why.push(`Room ${name || raw?.id || '?'} needs an outline of at least 3 corners enclosing at least 1 sq ft.`);
    return null;
  }
  const kind = ROOM_KINDS.includes(raw?.kind) ? raw.kind : 'other';
  const out = {
    id: uniqueId(raw?.id, name || kind, used),
    name: name || kind[0].toUpperCase() + kind.slice(1),
    kind,
    poly: p2,
    floor: FLOORS.includes(raw?.floor) ? raw.floor : null,
  };
  const ceiling = num(raw?.ceiling, 6, 20, null);
  if (ceiling) out.ceiling = r4(ceiling);
  const planSize = text(raw?.planSize, 30);
  if (planSize) out.planSize = planSize;
  const label = pt(raw?.label);
  if (label) out.label = label;
  if (raw?.view && pt(raw.view.at)) out.view = { at: pt(raw.view.at), yaw: r4(num(raw.view.yaw, -360, 360, 0)) };
  return out;
}

export function cleanWall(raw, used = new Set(), why = []) {
  const a = pt(raw?.a), b = pt(raw?.b);
  if (!a || !b || Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) { why.push(`Wall ${raw?.id ?? ''} needs two different end points.`.replace('  ', ' ')); return null; }
  const out = { id: uniqueId(raw?.id, 'wall', used), a, b, t: r4(num(raw?.t, 0.05, 4, 4.5 / 12)) };
  const h = num(raw?.h, 0.25, 20, null);
  if (h) out.h = r4(h);
  return out;
}

export function cleanOpening(raw, used = new Set(), why = []) {
  const type = OPENING[raw?.type] ? raw.type : null;
  const at = pt(raw?.at);
  if (!type) { why.push(`Opening ${raw?.id ?? ''}: type must be one of ${OPENING_TYPES.map((o) => o.type).join(', ')}.`); return null; }
  if (!at) { why.push(`Opening ${raw?.id ?? ''}: needs a position (at).`); return null; }
  const out = {
    id: uniqueId(raw?.id, type === 'window' ? 'window' : type === 'opening' ? 'opening' : 'door', used),
    type, at,
    width: r4(num(raw?.width, 1, 20, type === 'window' ? 4 : type === 'slider' ? 6 : type === 'double' ? 5 : type === 'entry' ? 3 : 2.667)),
  };
  const name = text(raw?.name, UNIT_LIMITS.text);
  if (name) out.name = name;
  const head = num(raw?.head, 1, 20, null);
  if (head) out.head = r4(head);
  if (type === 'window') {
    const sill = num(raw?.sill, 0, 15, null);
    if (sill !== null) out.sill = r4(sill);
    const panes = num(raw?.panes, 1, 8, null);
    if (panes) out.panes = Math.round(panes);
    if (Array.isArray(raw?.mullions)) out.mullions = raw.mullions.map((f) => num(f, 0.02, 0.98, null)).filter((f) => f !== null).map(r4).slice(0, 7).sort((p, q) => p - q);
    const transom = num(raw?.transom, 0.5, 15, null);
    if (transom) out.transom = r4(transom);
  } else {
    const hinge = compass(raw?.hinge);
    if (hinge) out.hinge = hinge;
    const opens = compass(raw?.opens) ?? (typeof raw?.opens === 'string' && ID.test(raw.opens) ? raw.opens : null);
    if (opens) out.opens = opens;
    const open = num(raw?.open, 0, 120, null);
    if (open !== null) out.open = Math.round(open);
  }
  return out;
}

function cleanSegments(raw, why, id) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const s of raw.slice(0, 24)) {
    const kind = typeof s === 'string' ? s : s?.kind;
    if (!SEGMENTS[kind]) { why.push(`Fixture ${id}: "${kind}" is not a kitchen segment (${Object.keys(SEGMENTS).join(', ')}).`); continue; }
    const seg = { kind, w: r4(num(s?.w, 0.05, 12, SEGMENTS[kind].w / 12)) };
    if (typeof s?.upper === 'boolean') seg.upper = s.upper;
    if (typeof s?.drawers === 'boolean') seg.drawers = s.drawers;
    out.push(seg);
  }
  return out;
}

function cleanOpts(type, raw = {}, why = [], id = '') {
  const spec = FIXTURE_OPTIONS[type] ?? {};
  const out = {};
  for (const [key, kind] of Object.entries(spec)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (kind === 'bool') { if (typeof v === 'boolean') out[key] = v; }
    else if (kind === 'len') { const n = num(v, 0, 20, null); if (n !== null) out[key] = r4(n); }
    else if (kind === 'segments') { const s = cleanSegments(v, why, id); if (s) out[key] = s; }
    else if (Array.isArray(kind)) { if (kind.includes(v)) out[key] = v; else why.push(`Fixture ${id}: ${key} must be one of ${kind.join(', ')}.`); }
  }
  return out;
}

export function cleanFixture(raw, used = new Set(), why = []) {
  const meta = fixtureByType[raw?.type];
  if (!meta) { why.push(`Fixture ${raw?.id ?? ''}: "${raw?.type}" is not a fixture type (${FIXTURES.map((f) => f.type).join(', ')}).`); return null; }
  const at = pt(raw?.at) ?? pt([raw?.x, raw?.z]);
  if (!at) { why.push(`Fixture ${raw?.id ?? raw.type}: needs a position (at).`); return null; }
  const id = uniqueId(raw?.id, raw.type, used);
  const out = {
    id, type: raw.type,
    x: at[0], z: at[1],
    w: r4(num(raw?.w, 0.1, 40, meta.w / 12)),
    d: r4(num(raw?.d, 0.02, 20, meta.d / 12)),
    h: r4(num(raw?.h, 0, 20, meta.h / 12)),
    rot: r4((((num(raw?.rot, -3600, 3600, 0)) % 360) + 360) % 360),
  };
  const name = text(raw?.name, UNIT_LIMITS.text);
  if (name) out.name = name;
  const c = color(raw?.color) ?? (FINISH_OPTIONS.cabinets.includes(raw?.color) ? raw.color : null);
  if (c) out.color = c;
  const opts = cleanOpts(raw.type, raw.opts ?? {}, why, id);
  if (Object.keys(opts).length) out.opts = opts;
  return out;
}

export function emptyUnit() {
  return { name: '', ...DEFAULTS, finishes: { ...DEFAULT_FINISHES }, rooms: [], walls: [], openings: [], fixtures: [], labels: [], lights: null, start: null, planImage: null };
}

// The whole spec. Returns { unit, dropped }: what could not be used, and why.
export function cleanUnit(raw = {}) {
  const why = [];
  const u = emptyUnit();
  u.name = text(raw.name, UNIT_LIMITS.name);
  for (const k of ['beds', 'baths']) { const v = num(raw[k], 0, 20, null); if (v !== null) u[k] = Math.round(v * 2) / 2; }
  // The area the listing states, if any; the rooms' own area is computed.
  const sqft = num(raw.sqft, 50, 50000, null);
  if (sqft) u.sqft = Math.round(sqft);
  u.ceiling = r4(num(raw.ceiling, 6.5, 20, DEFAULTS.ceiling));
  u.doorHeight = r4(num(raw.doorHeight, 5.5, u.ceiling, Math.min(DEFAULTS.doorHeight, u.ceiling)));
  u.windowSill = r4(num(raw.windowSill, 0, u.ceiling - 1, DEFAULTS.windowSill));
  u.windowHead = r4(num(raw.windowHead, u.windowSill + 0.5, u.ceiling, Math.min(DEFAULTS.windowHead, u.ceiling)));
  u.exteriorWall = r4(num(raw.exteriorWall, 2 / 12, 2.5, DEFAULTS.exteriorWall));
  u.level = Math.round(num(raw.level, 1, 80, DEFAULTS.level));
  const f = raw.finishes ?? {};
  u.finishes = {
    walls: color(f.walls) ?? DEFAULT_FINISHES.walls,
    floor: FLOORS.includes(f.floor) ? f.floor : DEFAULT_FINISHES.floor,
    cabinets: FINISH_OPTIONS.cabinets.includes(f.cabinets) ? f.cabinets : color(f.cabinets) ?? DEFAULT_FINISHES.cabinets,
    ...Object.fromEntries(['counters', 'backsplash', 'appliances', 'hardware', 'tile'].map((k) => [k, FINISH_OPTIONS[k].includes(f[k]) ? f[k] : DEFAULT_FINISHES[k]])),
  };
  const take = (list, max, clean, label) => {
    const arr = Array.isArray(list) ? list : [];
    if (arr.length > max) why.push(`Only ${max} ${label} fit; the rest were left out.`);
    const used = new Set();
    return arr.slice(0, max).map((x) => clean(x, used, why)).filter(Boolean);
  };
  u.rooms = take(raw.rooms, UNIT_LIMITS.rooms, cleanRoom, 'rooms');
  u.walls = take(raw.walls, UNIT_LIMITS.walls, cleanWall, 'walls');
  // Doors and windows share one id space, and fixtures another.
  u.openings = take(raw.openings, UNIT_LIMITS.openings, cleanOpening, 'doors and windows');
  u.fixtures = take(raw.fixtures, UNIT_LIMITS.fixtures, cleanFixture, 'fixtures');
  u.labels = (Array.isArray(raw.labels) ? raw.labels : []).slice(0, UNIT_LIMITS.labels)
    .map((l) => ({ text: text(l?.text, UNIT_LIMITS.text), at: pt(l?.at) })).filter((l) => l.text && l.at);
  u.lights = Array.isArray(raw.lights) ? raw.lights.slice(0, UNIT_LIMITS.lights).map(pt).filter(Boolean) : null;
  u.start = raw.start && pt(raw.start.at) ? { at: pt(raw.start.at), yaw: r4(num(raw.start.yaw, -360, 360, 0)) } : null;
  // Only the server's own pictures (the example unit's leasing plan).
  const pi = raw.planImage;
  u.planImage = pi && typeof pi.src === 'string' && /^assets\/[\w.-]+\.(png|jpg)$/.test(pi.src) && [pi.x, pi.z, pi.w, pi.h].every(Number.isFinite)
    ? { src: pi.src, x: r4(pi.x), z: r4(pi.z), w: r4(pi.w), h: r4(pi.h) } : null;
  return { unit: u, dropped: why };
}

// ---------------------------------------------------------------------------
// Inches and snake_case at the MCP edge.

const ftOf = (v) => (Number.isFinite(+v) && v !== null && v !== '' ? +v / 12 : undefined);
const ptFt = (p) => (Array.isArray(p) ? p.map((v) => ftOf(v)) : undefined);
const inch = (ft) => Math.round(ft * 12 * 100) / 100;
const ptIn = (p) => p.map(inch);
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function optsFromInches(type, raw) {
  const spec = FIXTURE_OPTIONS[type] ?? {};
  const out = {};
  for (const [key, kind] of Object.entries(spec)) {
    if (raw[key] === undefined) continue;
    if (kind === 'len') out[key] = ftOf(raw[key]);
    else if (kind === 'segments') out[key] = Array.isArray(raw[key]) ? raw[key].map((s) => (typeof s === 'string' ? { kind: s } : drop({ kind: s?.kind, w: ftOf(s?.width), upper: s?.upper, drawers: s?.drawers }))) : raw[key];
    else out[key] = raw[key];
  }
  return out;
}
function optsToInches(type, opts = {}) {
  const spec = FIXTURE_OPTIONS[type] ?? {};
  const out = {};
  for (const [key, v] of Object.entries(opts)) {
    if (spec[key] === 'len') out[key] = inch(v);
    else if (spec[key] === 'segments') out[key] = v.map((s) => drop({ kind: s.kind, width: inch(s.w), upper: s.upper, drawers: s.drawers }));
    else out[key] = v;
  }
  return out;
}

export const fromInches = {
  room: (r = {}) => drop({
    id: r.id, name: r.name, kind: r.kind, poly: Array.isArray(r.outline) ? r.outline.map(ptFt) : undefined, floor: r.floor,
    ceiling: ftOf(r.ceiling_height), planSize: r.plan_size, label: ptFt(r.label_at),
    view: r.walk_view?.at ? { at: ptFt(r.walk_view.at), yaw: r.walk_view.facing } : undefined,
  }),
  wall: (w = {}) => drop({ id: w.id, a: ptFt(w.from), b: ptFt(w.to), t: ftOf(w.thickness), h: ftOf(w.height) }),
  opening: (o = {}) => drop({ id: o.id, type: o.type, at: ptFt(o.at), width: ftOf(o.width), name: o.name, head: ftOf(o.head_height), sill: ftOf(o.sill_height), hinge: o.hinge, opens: o.opens, open: o.open_angle, panes: o.panes, mullions: o.mullions, transom: ftOf(o.transom_height) }),
  fixture: (f = {}) => drop({
    id: f.id, type: f.type, at: ptFt(f.at), w: ftOf(f.width), d: ftOf(f.depth), h: ftOf(f.height), rot: f.rotation, name: f.name, color: f.color,
    opts: optsFromInches(f.type, f),
  }),
  label: (l = {}) => drop({ text: l.text, at: ptFt(l.at) }),
  // Unit-wide settings (heights, finishes, name); lists are handled one by one.
  settings: (s = {}) => drop({
    name: s.name, beds: s.beds, baths: s.baths, sqft: s.sqft, ceiling: ftOf(s.ceiling_height), doorHeight: ftOf(s.door_height),
    windowSill: ftOf(s.window_sill), windowHead: ftOf(s.window_head), exteriorWall: ftOf(s.exterior_wall), level: s.floor_level, finishes: s.finishes,
  }),
};

export const toInches = {
  room: (r) => drop({
    id: r.id, name: r.name, kind: r.kind, outline: r.poly.map(ptIn), floor: r.floor ?? undefined, ceiling_height: r.ceiling ? inch(r.ceiling) : undefined,
    plan_size: r.planSize, label_at: r.label ? ptIn(r.label) : undefined, walk_view: r.view ? { at: ptIn(r.view.at), facing: r.view.yaw } : undefined,
  }),
  wall: (w) => drop({ id: w.id, from: ptIn(w.a), to: ptIn(w.b), thickness: inch(w.t), height: w.h ? inch(w.h) : undefined }),
  opening: (o) => drop({ id: o.id, type: o.type, at: ptIn(o.at), width: inch(o.width), name: o.name, head_height: o.head ? inch(o.head) : undefined, sill_height: o.sill !== undefined ? inch(o.sill) : undefined, hinge: o.hinge, opens: o.opens, open_angle: o.open, panes: o.panes, mullions: o.mullions, transom_height: o.transom ? inch(o.transom) : undefined }),
  fixture: (f) => drop({ id: f.id, type: f.type, name: f.name, at: [inch(f.x), inch(f.z)], width: inch(f.w), depth: inch(f.d), height: inch(f.h), rotation: f.rot, color: f.color, ...optsToInches(f.type, f.opts) }),
  label: (l) => ({ text: l.text, at: ptIn(l.at) }),
  settings: (u) => drop({ name: u.name, beds: u.beds, baths: u.baths, sqft: u.sqft, ceiling_height: inch(u.ceiling), door_height: inch(u.doorHeight), window_sill: inch(u.windowSill), window_head: inch(u.windowHead), exterior_wall: inch(u.exteriorWall), floor_level: u.level, finishes: u.finishes }),
};

// ---------------------------------------------------------------------------
// Building: walls, openings, fixtures in place, and the queries everything
// else uses.

const SWING_PRIORITY = { closet: 6, storage: 6, pantry: 6, utility: 5, laundry: 5, bath: 4, bedroom: 3, office: 3, other: 2, dining: 1, kitchen: 1, living: 0, hall: 0, entry: 0, balcony: -1 };

// `checks: false` skips the slower checks behind `problems` (the browser
// doesn't show them).
export function buildUnit(spec, { checks = true } = {}) {
  const u = spec ?? emptyUnit();
  const H = { ceiling: u.ceiling, door: Math.min(u.doorHeight, u.ceiling), sill: u.windowSill, head: Math.min(u.windowHead, u.ceiling) };
  const problems = [];

  // ---- rooms
  const rooms = u.rooms.map((r, index) => {
    const bbox = polyBounds(r.poly);
    const outdoor = OUTDOOR_KINDS.has(r.kind);
    const rect = r.poly.length === 4 && r.poly.every((p, i) => {
      const q = r.poly[(i + 1) % 4];
      return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6;
    });
    return {
      ...r, index, outdoor, minor: MINOR_KINDS.has(r.kind), rect,
      floor: r.floor ?? (outdoor ? 'deck' : r.kind === 'bath' ? 'tile' : u.finishes.floor),
      ceiling: r.ceiling ?? H.ceiling,
      area: Math.abs(polygonArea(r.poly)), bbox,
      w: bbox[2] - bbox[0], d: bbox[3] - bbox[1],
      at: r.label ?? labelPoint(r.poly),
    };
  });
  const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));

  // ---- the grid
  const ext = u.exteriorWall;
  let bb = null;
  const grow = ([x0, z0, x1, z1]) => { bb = bb ? [Math.min(bb[0], x0), Math.min(bb[1], z0), Math.max(bb[2], x1), Math.max(bb[3], z1)] : [x0, z0, x1, z1]; };
  rooms.forEach((r) => grow(r.bbox));
  u.walls.forEach((w) => grow(polyBounds([w.a, w.b])));
  const empty = !bb;
  if (empty) bb = [0, 0, 30, 20];
  const pad = ext + 1.5;
  const span = Math.max(bb[2] - bb[0], bb[3] - bb[1]) + 2 * pad;
  let res = span > 160 ? 1 / 8 : span > 90 ? 1 / 12 : 1 / 24;
  // At most about 4 million cells, however big the outline: memory is shared.
  const areaFt = (bb[2] - bb[0] + 2 * pad) * (bb[3] - bb[1] + 2 * pad);
  if (areaFt / (res * res) > 4e6) res = Math.sqrt(areaFt / 4e6);
  const gx0 = Math.floor((bb[0] - pad) / res) * res, gz0 = Math.floor((bb[1] - pad) / res) * res;
  const nx = empty ? 0 : Math.ceil((bb[2] + pad - gx0) / res), nz = empty ? 0 : Math.ceil((bb[3] + pad - gz0) / res);
  const N = nx * nz;
  const room = new Int16Array(N).fill(-1);   // room index, or -1
  const prof = new Uint8Array(N);            // wall profile index, 0 = no wall
  const pass = new Uint8Array(N);            // doorway cut through a wall
  const profiles = [null];
  const profileKeys = new Map();
  const profile = (solid) => {
    const s = solid.filter(([a, b]) => b - a > 1e-3);
    if (!s.length) return 0;
    const key = s.map(([a, b]) => `${a.toFixed(4)}:${b.toFixed(4)}`).join('|');
    if (!profileKeys.has(key)) {
      if (profiles.length >= 250) return 1;
      profileKeys.set(key, profiles.length);
      profiles.push({ solid: s, floor: s[0][0] < 0.05 });
    }
    return profileKeys.get(key);
  };
  const FULL = profile([[0, H.ceiling]]);
  const cellAt = (x, z) => {
    const i = Math.floor((x - gx0) / res), j = Math.floor((z - gz0) / res);
    return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
  };
  const center = (k) => [gx0 + ((k % nx) + 0.5) * res, gz0 + (Math.floor(k / nx) + 0.5) * res];

  // Cells whose centers fall inside a polygon (half-open, so rooms that
  // share an edge never share a cell).
  function scan(poly, fn) {
    if (!N) return;
    const [, pz0, , pz1] = polyBounds(poly);
    const j0 = Math.max(0, Math.ceil((pz0 - gz0) / res - 0.5)), j1 = Math.min(nz - 1, Math.floor((pz1 - gz0) / res - 0.5));
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const zc = gz0 + (j + 0.5) * res;
      xs.length = 0;
      for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
        const [xa, za] = poly[m], [xb, zb] = poly[k];
        if ((za > zc) !== (zb > zc)) xs.push(xa + ((zc - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - gx0) / res - 0.5)), i1 = Math.min(nx - 1, Math.ceil((xs[q + 1] - gx0) / res - 0.5) - 1);
        for (let i = i0; i <= i1; i++) fn(j * nx + i);
      }
    }
  }

  const overlaps = new Map();
  for (const r of rooms) {
    scan(r.poly, (k) => {
      if (room[k] >= 0) {
        const key = `${room[k]}:${r.index}`;
        overlaps.set(key, (overlaps.get(key) ?? 0) + 1);
      } else room[k] = r.index;
    });
  }
  for (const [key, n] of overlaps) {
    const sqft = n * res * res;
    if (sqft < 0.25) continue;
    const [a, b] = key.split(':').map(Number);
    problems.push(`Rooms ${rooms[a].id} and ${rooms[b].id} overlap by ${sqft.toFixed(1)} sq ft. Rooms are the clear floor inside the walls: leave the wall's thickness between rooms that have a wall between them, and let rooms that are open to each other just touch.`);
  }

  // Outside walls: every cell within `ext` of an indoor room that isn't
  // itself a room is wall (a square reach, so outside corners come out square).
  if (N) {
    const k = Math.max(1, Math.round(ext / res));
    const mask = new Uint8Array(N);
    for (let c = 0; c < N; c++) if (room[c] >= 0 && !rooms[room[c]].outdoor) mask[c] = 1;
    const tmp = new Uint8Array(N);
    const pre = new Int32Array(Math.max(nx, nz) + 1);
    for (let j = 0; j < nz; j++) {
      pre[0] = 0;
      for (let i = 0; i < nx; i++) pre[i + 1] = pre[i] + mask[j * nx + i];
      for (let i = 0; i < nx; i++) if (pre[Math.min(nx, i + k + 1)] - pre[Math.max(0, i - k)] > 0) tmp[j * nx + i] = 1;
    }
    for (let i = 0; i < nx; i++) {
      pre[0] = 0;
      for (let j = 0; j < nz; j++) pre[j + 1] = pre[j] + tmp[j * nx + i];
      for (let j = 0; j < nz; j++) {
        const c = j * nx + i;
        if (room[c] < 0 && pre[Math.min(nz, j + k + 1)] - pre[Math.max(0, j - k)] > 0) prof[c] = FULL;
      }
    }
    // Pockets enclosed by walls and rooms (a shaft, a chase, a gap left
    // between rooms) are solid too.
    const seen = new Uint8Array(N);
    const stack = new Int32Array(N);
    let sp = 0;
    const open = (c) => room[c] < 0 && prof[c] === 0 && !seen[c];
    const push = (c) => { seen[c] = 1; stack[sp++] = c; };
    for (let i = 0; i < nx; i++) { if (open(i)) push(i); if (open((nz - 1) * nx + i)) push((nz - 1) * nx + i); }
    for (let j = 0; j < nz; j++) { if (open(j * nx)) push(j * nx); if (open(j * nx + nx - 1)) push(j * nx + nx - 1); }
    while (sp) {
      const c = stack[--sp], i = c % nx;
      if (i > 0 && open(c - 1)) push(c - 1);
      if (i < nx - 1 && open(c + 1)) push(c + 1);
      if (c >= nx && open(c - nx)) push(c - nx);
      if (c < N - nx && open(c + nx)) push(c + nx);
    }
    for (let c = 0; c < N; c++) if (room[c] < 0 && prof[c] === 0 && !seen[c]) prof[c] = FULL;
  }

  // Extra walls, possibly short of the ceiling.
  const segRect = (a, b, t) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    const nx2 = -uz * t / 2, nz2 = ux * t / 2;
    return [[a[0] + nx2, a[1] + nz2], [b[0] + nx2, b[1] + nz2], [b[0] - nx2, b[1] - nz2], [a[0] - nx2, a[1] - nz2]];
  };
  for (const w of u.walls) {
    const p = profile([[0, Math.min(w.h ?? H.ceiling, H.ceiling)]]);
    scan(segRect(w.a, w.b, w.t), (c) => { prof[c] = p; });
  }

  const isWall = (c) => c >= 0 && prof[c] > 0;
  const floorSolid = (c) => c >= 0 && prof[c] > 0 && profiles[prof[c]].floor;

  // ---- room edges: direction along the edge and the normal out of the room
  const edges = [];
  for (const r of rooms) {
    for (let i = 0; i < r.poly.length; i++) {
      const p = r.poly[i], q = r.poly[(i + 1) % r.poly.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1e-3) continue;
      const ux = (q[0] - p[0]) / len, uz = (q[1] - p[1]) / len;
      let n = [uz, -ux];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      if (pointInPoly(mx + n[0] * 0.02, mz + n[1] * 0.02, r.poly)) n = [-n[0], -n[1]];
      edges.push({ room: r.id, roomIndex: r.index, p, q, u: [ux, uz], n, len });
    }
  }
  // How much wall lies beyond an edge at s along it.
  const wallDepth = (e, s) => {
    const x0 = e.p[0] + e.u[0] * s, z0 = e.p[1] + e.u[1] * s;
    let t = res * 0.5, any = false;
    for (; t < 3; t += res * 0.5) {
      if (!isWall(cellAt(x0 + e.n[0] * t, z0 + e.n[1] * t))) break;
      any = true;
    }
    return any ? t : 0;
  };

  // ---- doors and windows
  const openings = [];
  for (const o of u.openings) {
    let best = null;
    for (const e of edges) {
      const dx = o.at[0] - e.p[0], dz = o.at[1] - e.p[1];
      const s = dx * e.u[0] + dz * e.u[1], t = dx * e.n[0] + dz * e.n[1];
      if (s < -0.25 || s > e.len + 0.25 || t < -1.5 || t > 3.5) continue;
      const sc = Math.max(0, Math.min(e.len, s));
      const depth = wallDepth(e, sc);
      if (!depth) continue;
      // How far the point is outside this wall, then a preference for thin
      // walls and for edges the point is close to: a point in a partition is
      // also "inside" any thick run of wall that happens to lie beyond it.
      const outside = t < 0 ? -t : Math.max(0, t - depth);
      if (outside > 1) continue;
      const score = outside + 0.3 * depth + 0.2 * Math.max(0, t) + (rooms[e.roomIndex].outdoor ? 0.05 : 0);
      if (!best || score < best.score) best = { e, s: sc, depth, score };
    }
    if (!best) {
      problems.push(`${o.name ?? o.id} (${o.type} at ${fmtPt(o.at)}) isn't in a wall. Put its position on the wall between two rooms, or on a room's outside edge.`);
      continue;
    }
    const { e, s, depth } = best;
    const kind = o.type === 'window' ? 'window' : o.type === 'opening' ? 'opening' : 'door';
    const a = s - o.width / 2, b = s + o.width / 2;
    const t1 = depth;
    const mid = [e.p[0] + e.u[0] * s + e.n[0] * t1 / 2, e.p[1] + e.u[1] * s + e.n[1] * t1 / 2];
    const beyond = cellAt(e.p[0] + e.u[0] * s + e.n[0] * (t1 + 0.3), e.p[1] + e.u[1] * s + e.n[1] * (t1 + 0.3));
    const other = beyond >= 0 && room[beyond] >= 0 ? rooms[room[beyond]] : null;
    const A = rooms[e.roomIndex];
    if (wallDepth(e, Math.max(0, a + 0.08)) === 0 || wallDepth(e, Math.min(e.len, b - 0.08)) === 0 || a < -0.05 || b > e.len + 0.05) {
      problems.push(`${o.name ?? o.id} is ${fmtLen(o.width)} wide but runs past the end of its wall at ${fmtPt(o.at)}.`);
    }
    const res1 = {
      id: o.id, type: o.type, kind, name: o.name ?? defaultName(o, A, other),
      p: e.p, u: e.u, n: e.n, a, b, t0: 0, t1, width: o.width,
      x: mid[0], z: mid[1],
      rooms: [A.id, other?.id ?? null],
      sill: kind === 'window' ? Math.min(o.sill ?? H.sill, H.ceiling - 0.5) : 0,
      head: Math.min(o.head ?? (kind === 'window' ? H.head : H.door), H.ceiling),
    };
    if (kind === 'window') {
      // Mullions are stored from the west (or north) end; flip them to run from end a.
      let fr = o.mullions ?? Array.from({ length: (o.panes ?? (o.width <= 3.5 ? 1 : o.width <= 7 ? 2 : 3)) - 1 }, (_, i) => (i + 1) / (o.panes ?? (o.width <= 3.5 ? 1 : o.width <= 7 ? 2 : 3)));
      const alongX = Math.abs(e.u[0]) >= Math.abs(e.u[1]);
      if ((alongX ? e.u[0] : e.u[1]) < 0) fr = fr.map((f) => 1 - f).reverse();
      res1.mullions = fr;
      res1.transom = o.transom && o.transom > res1.sill + 0.3 && o.transom < res1.head - 0.3 ? o.transom : null;
      if (other && !other.outdoor) problems.push(`Window ${o.id} is in the wall between ${A.id} and ${other.id}, not an outside wall.`);
    } else {
      // Which end the hinges are on, and which side the door opens into.
      const towards = (dir, vec) => DIR[dir][0] * vec[0] + DIR[dir][1] * vec[1];
      if (o.hinge && Math.abs(towards(o.hinge, e.u)) > 0.3) res1.hinge = towards(o.hinge, e.u) > 0 ? 'b' : 'a';
      else res1.hinge = a - 0 <= e.len - b ? 'a' : 'b';
      let side;
      if (o.opens && DIR[o.opens] && Math.abs(towards(o.opens, e.n)) > 0.3) side = towards(o.opens, e.n) > 0 ? 1 : -1;
      else if (o.opens && roomById[o.opens]) side = o.opens === A.id ? -1 : 1;
      else if (!other) side = -1;
      else side = (SWING_PRIORITY[other.kind] ?? 2) > (SWING_PRIORITY[A.kind] ?? 2) || ((SWING_PRIORITY[other.kind] ?? 2) === (SWING_PRIORITY[A.kind] ?? 2) && other.area < A.area) ? 1 : -1;
      res1.swing = side;
      res1.leaves = o.type === 'double' ? 2 : 1;
      const into = side > 0 ? other : A;
      res1.open = o.open ?? (SWINGS.has(o.type) && !(o.type === 'entry' || !other || MINOR_KINDS.has(into?.kind)) ? 85 : 0);
      if (o.hinge && Math.abs(towards(o.hinge, e.u)) <= 0.3) problems.push(`${o.id}: hinge "${o.hinge}" runs across its wall, not along it; used the ${res1.hinge === 'a' ? 'nearer' : 'other'} end.`);
    }
    const W = (s2, t) => [e.p[0] + e.u[0] * s2 + e.n[0] * t, e.p[1] + e.u[1] * s2 + e.n[1] * t];
    res1.poly = [W(a, 0), W(b, 0), W(b, t1), W(a, t1)];
    res1.world = W;
    if (SWINGS.has(o.type)) {
      const face = res1.swing > 0 ? t1 : 0, reach = o.width / res1.leaves;
      res1.swingPoly = [W(a, face), W(b, face), W(b, face + res1.swing * reach), W(a, face + res1.swing * reach)];
    }
    openings.push(res1);
  }
  for (let i = 0; i < openings.length; i++) for (let j = i + 1; j < openings.length; j++) {
    const p = openings[i], q = openings[j];
    if (Math.abs(p.x - q.x) < (p.width + q.width) / 2 + 0.2 && Math.abs(p.z - q.z) < (p.width + q.width) / 2 + 0.2) {
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < (p.width + q.width) / 2 - 0.05 && Math.abs((p.x - q.x) * p.n[0] + (p.z - q.z) * p.n[1]) < 0.5) problems.push(`${p.id} and ${q.id} overlap in the same wall.`);
    }
  }
  // Cut them out of the walls.
  for (const o of openings) {
    const W = o.world;
    const poly = [W(o.a, -res), W(o.b, -res), W(o.b, o.t1 + res), W(o.a, o.t1 + res)];
    const p = o.kind === 'window' ? null : profile([[o.head, H.ceiling]]);
    scan(poly, (c) => {
      if (!prof[c]) return;
      const top = profiles[prof[c]].solid.at(-1)[1];
      if (o.kind === 'window') prof[c] = profile([[0, Math.min(o.sill, top)], [o.head, top]]);
      else { prof[c] = o.head >= top ? 0 : p; pass[c] = 1; }
    });
  }

  // ---- fixtures
  const fixtures = u.fixtures.map((f) => resolveFixture(f));
  function sideAgainst(f, side) {
    const fr = frontOf(f.rot), rt = rightOf(f.rot);
    const [ax, len, off] = side === 'back' ? [fr, f.w, -f.d / 2] : side === 'front' ? [fr, f.w, f.d / 2] : side === 'left' ? [rt, f.d, -f.w / 2] : [rt, f.d, f.w / 2];
    const along = side === 'back' || side === 'front' ? rt : fr;
    const out = Math.sign(off) * (2 / 12);
    let hits = 0, n = 0;
    for (let k = 1; k < 6; k++) {
      const s = (k / 6 - 0.5) * len;
      const x = f.x + ax[0] * (off + out) + along[0] * s, z = f.z + ax[1] * (off + out) + along[1] * s;
      n++;
      if (isWall(cellAt(x, z))) hits++;
    }
    return hits >= 3;
  }
  function resolveFixture(f) {
    const meta = fixtureByType[f.type];
    const h = f.type === 'column' || !f.h ? H.ceiling : f.h;
    const poly = orientedRect(f.x, f.z, f.w, f.d, f.rot);
    const out = {
      ...f, h, name: f.name ?? meta.name, group: meta.group, opts: { ...(f.opts ?? {}) },
      poly, aabb: polyBounds(poly), blocks: meta.blocks !== false,
      room: (() => { const c = cellAt(f.x, f.z); return c >= 0 && room[c] >= 0 ? rooms[room[c]].id : null; })(),
    };
    out.against = Object.fromEntries(['back', 'left', 'right', 'front'].map((s) => [s, sideAgainst(f, s)]));
    if (f.type === 'kitchen-run' || KITCHEN_TYPES[f.type]) {
      // Lay the segments out across the width, left to right as you face it.
      let segs = f.type === 'kitchen-run' ? (f.opts?.segments ?? [{ kind: 'base', w: f.w }]) : [{ kind: KITCHEN_TYPES[f.type], w: f.w, drawers: f.opts?.drawers }];
      let total = segs.reduce((a, s) => a + s.w, 0);
      if (total > f.w + 0.02) {
        problems.push(`${f.id}: its segments add up to ${fmtLen(total)}, more than its ${fmtLen(f.w)} width; they were squeezed to fit.`);
        segs = segs.map((s) => ({ ...s, w: (s.w * f.w) / total }));
        total = f.w;
      } else if (f.w - total > 0.02) segs = [...segs, { kind: 'base', w: f.w - total, filled: true }];
      let s0 = -f.w / 2;
      const uppers = f.type === 'kitchen-run' ? (f.opts?.uppers ?? out.against.back) : false;
      out.segments = segs.map((s) => {
        const seg = { kind: s.kind, s0, s1: s0 + s.w, upper: uppers && (s.upper ?? SEGMENTS[s.kind].upper), drawers: s.drawers ?? (s.kind === 'base' && f.opts?.drawers) ?? false };
        s0 += s.w;
        return seg;
      });
      out.upperBottom = f.opts?.upper_bottom ?? 4.5;
      out.upperTop = Math.min(H.ceiling, f.opts?.upper_top ?? Math.min(H.ceiling, 8));
      out.soffit = f.opts?.soffit ?? (uppers && H.ceiling - out.upperTop > 0.05 && H.ceiling - out.upperTop <= 1.25);
      out.backsplash = f.opts?.backsplash ?? (out.against.back ? u.finishes.backsplash : 'none');
      out.hood = f.opts?.hood ?? 'microwave';
      out.uppers = uppers;
    }
    if (out.blocks && out.room === null) problems.push(`${f.id} (${out.name}) at ${fmtPt([f.x, f.z])} isn't inside any room.`);
    return out;
  }
  // Fixtures running into walls.
  for (const f of fixtures) {
    if (!f.blocks) continue;
    let hit = 0, n = 0;
    scan(orientedRect(f.x, f.z, f.w, f.d, f.rot, -1 / 12), (c) => { n++; if (floorSolid(c)) hit++; });
    if (n && hit / n > 0.04) problems.push(`${f.id} (${f.name}) runs ${hit * res * res >= 1 ? `${(hit * res * res).toFixed(1)} sq ft` : 'into'} a wall. Its center is (x, z) and it is width × depth turned by rotation; slide it into the room.`);
  }

  // Doors that hit a blocking fixture as they swing open: points over each
  // leaf's quarter circle, an inch inside the fixture.
  for (const o of openings) {
    if (!o.swingPoly) continue;
    const face = o.swing > 0 ? o.t1 : 0, r = o.width / o.leaves;
    const leaves = o.leaves === 2 ? [[o.a, 1], [o.b, -1]] : [[o.hinge === 'b' ? o.b : o.a, o.hinge === 'b' ? -1 : 1]];
    const pts = [];
    for (const [sh, along] of leaves) {
      for (let i = 1; i <= 6; i++) for (let j = 0; j <= 8; j++) {
        const d = (r * i) / 6, th = (Math.PI / 2) * (j / 8);
        pts.push(o.world(sh + along * d * Math.cos(th), face + o.swing * d * Math.sin(th)));
      }
    }
    for (const f of fixtures) {
      if (!f.blocks) continue;
      const inner = orientedRect(f.x, f.z, f.w, f.d, f.rot, -1 / 12);
      if (pts.some(([x, z]) => pointInPoly(x, z, inner))) problems.push(`${o.name} (${o.id}) hits ${f.id} (${f.name}) when it swings open. Move one of them, or change the door's hinge or the way it opens.`);
    }
  }

  // ---- greedy rectangles over the wall cells
  function rectsOf(test, sameKey) {
    const out = [];
    const done = new Uint8Array(N);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (done[c] || !test(c)) continue;
      const key = sameKey(c);
      let i2 = i;
      while (i2 + 1 < nx && !done[c + i2 + 1 - i] && test(c + i2 + 1 - i) && sameKey(c + i2 + 1 - i) === key) i2++;
      let j2 = j;
      grow: while (j2 + 1 < nz) {
        for (let ii = i; ii <= i2; ii++) { const cc = (j2 + 1) * nx + ii; if (done[cc] || !test(cc) || sameKey(cc) !== key) break grow; }
        j2++;
      }
      for (let jj = j; jj <= j2; jj++) for (let ii = i; ii <= i2; ii++) done[jj * nx + ii] = 1;
      out.push({ rect: [r4(gx0 + i * res), r4(gz0 + j * res), r4(gx0 + (i2 + 1) * res), r4(gz0 + (j2 + 1) * res)], key });
    }
    return out;
  }
  const wallBoxes = rectsOf((c) => prof[c] > 0, (c) => prof[c]).map(({ rect, key }) => ({ rect, solid: profiles[key].solid }));
  const wallRects = rectsOf(floorSolid, () => 1).map(({ rect }) => rect);

  // ---- walls that look wrong: far thicker than a wall (a missing room, or
  // rooms placed apart), or a sliver where rooms were meant to be open.
  if (N && checks) {
    // Distance from each cell to the nearest room, in cells (two passes).
    const dist = new Uint16Array(N);
    const BIG = 65000;
    for (let c = 0; c < N; c++) dist[c] = room[c] >= 0 ? 0 : BIG;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!dist[c]) continue;
      let d = dist[c];
      if (i > 0) d = Math.min(d, dist[c - 1] + 1);
      if (j > 0) d = Math.min(d, dist[c - nx] + 1);
      if (i > 0 && j > 0) d = Math.min(d, dist[c - nx - 1] + 1);
      if (i < nx - 1 && j > 0) d = Math.min(d, dist[c - nx + 1] + 1);
      dist[c] = d;
    }
    for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      const c = j * nx + i;
      if (!dist[c]) continue;
      let d = dist[c];
      if (i < nx - 1) d = Math.min(d, dist[c + 1] + 1);
      if (j < nz - 1) d = Math.min(d, dist[c + nx] + 1);
      if (i < nx - 1 && j < nz - 1) d = Math.min(d, dist[c + nx + 1] + 1);
      if (i > 0 && j < nz - 1) d = Math.min(d, dist[c + nx - 1] + 1);
      dist[c] = d;
    }
    const limit = Math.ceil(Math.max(ext, 7 / 12) / res) + 1;
    const seen = new Uint8Array(N);
    const blobs = [];
    for (let c = 0; c < N; c++) {
      if (seen[c] || !prof[c] || dist[c] <= limit) continue;
      // Gather the thick patch.
      const stack = [c];
      seen[c] = 1;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, n = 0;
      while (stack.length) {
        const k = stack.pop(), i = k % nx, j = (k - i) / nx;
        n++; x0 = Math.min(x0, i); x1 = Math.max(x1, i); z0 = Math.min(z0, j); z1 = Math.max(z1, j);
        for (const m of [k - 1, k + 1, k - nx, k + nx]) {
          if (m < 0 || m >= N || seen[m] || !prof[m] || dist[m] <= limit) continue;
          if ((m === k - 1 && i === 0) || (m === k + 1 && i === nx - 1)) continue;
          seen[m] = 1; stack.push(m);
        }
      }
      blobs.push({ x0, z0, x1, z1, n });
    }
    for (const b of blobs.sort((p, q) => q.n - p.n).slice(0, 5)) {
      // The rooms around it: first room hit looking out each way from its middle.
      const ci = Math.round((b.x0 + b.x1) / 2), cj = Math.round((b.z0 + b.z1) / 2);
      const near = new Set();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let i = ci, j = cj; i >= 0 && j >= 0 && i < nx && j < nz; i += di, j += dj) {
          const r = room[j * nx + i];
          if (r >= 0) { near.add(rooms[r].id); break; }
        }
      }
      const w = (b.x1 - b.x0 + 1) * res, d = (b.z1 - b.z0 + 1) * res;
      const span = Math.min(w, d) + 2 * limit * res;
      problems.push(`There is solid wall about ${fmtLen(span)} thick around (${Math.round(((b.x0 + b.x1) / 2) * res * 12 + gx0 * 12)}, ${Math.round(((b.z0 + b.z1) / 2) * res * 12 + gz0 * 12)}) in${near.size ? `, between ${[...near].join(', ')}` : ''}. Is a room missing there, or are rooms placed too far apart?`);
    }
    // Along each row and column, what lies between two different rooms: a
    // sliver of wall under 2½" (rooms meant to be open to each other), or a
    // slot of open air between their walls (rooms placed apart).
    const thin = new Set(), gaps = new Map();
    const runs = (len, at) => {
      let last = -1, wall = 0, air = 0;
      for (let q = 0; q < len; q++) {
        const c = at(q);
        if (room[c] >= 0) {
          if (last >= 0 && last !== room[c] && (wall || air)) {
            const key = [last, room[c]].sort((p, s) => p - s).join(':');
            const L = (wall + air) * res;
            if (!air && L < 2.5 / 12) thin.add(key);
            if (air && L < 3) gaps.set(key, Math.max(gaps.get(key) ?? 0, L));
          }
          last = room[c]; wall = air = 0;
        } else if (pass[c]) { last = -1; wall = air = 0; }
        else if (prof[c] > 0) wall++;
        else air++;
      }
    };
    for (let j = 0; j < nz; j++) runs(nx, (q) => j * nx + q);
    for (let i = 0; i < nx; i++) runs(nz, (q) => q * nx + i);
    for (const key of [...thin].slice(0, 6)) {
      const [a, b] = key.split(':').map(Number);
      problems.push(`There is a sliver of wall under 2½" between ${rooms[a].id} and ${rooms[b].id}. If they are open to each other, make their outlines touch; if not, leave a full wall's thickness.`);
    }
    for (const [key, L] of [...gaps].slice(0, 6)) {
      const [a, b] = key.split(':').map(Number);
      problems.push(`${rooms[a].id} and ${rooms[b].id} are ${fmtLen(L)} apart with open air between their walls. Rooms that share a wall should be one wall's thickness apart (about 4½" inside the unit).`);
    }
  }
  // Printed sizes that don't match the outline.
  for (const r of rooms) {
    if (!r.planSize || !r.rect) continue;
    const parts = r.planSize.split(/\s*[x×X]\s*/).map(parseFeetInches);
    if (parts.length !== 2 || parts.some((v) => v === null)) continue;
    const [p, q] = parts.sort((m, n) => m - n), [w, d] = [r.w, r.d].sort((m, n) => m - n);
    if (Math.abs(p - w) > 6 / 12 || Math.abs(q - d) > 6 / 12) problems.push(`${r.id} measures ${fmtLen(w)} × ${fmtLen(d)} but its plan size is ${r.planSize}.`);
  }

  const cellRoom = (x, z) => { const c = cellAt(x, z); return c >= 0 && room[c] >= 0 ? rooms[room[c]] : null; };
  const walkable = (x, z) => { const c = cellAt(x, z); return c >= 0 && (room[c] >= 0 || pass[c] === 1) && !floorSolid(c); };

  // ---- ceiling lights: given, or a few per room
  let lights = u.lights;
  if (!lights) {
    lights = [];
    for (const r of rooms) {
      if (r.outdoor) continue;
      const nxl = Math.max(1, Math.round(r.w / 7)), nzl = Math.max(1, Math.round(r.d / 7));
      const pts = r.area < 40 ? [r.at] : [];
      if (!pts.length) for (let i = 0; i < nxl; i++) for (let j = 0; j < nzl; j++) pts.push([r.bbox[0] + (r.w * (i + 0.5)) / nxl, r.bbox[1] + (r.d * (j + 0.5)) / nzl]);
      for (const p of pts) if (cellRoom(p[0], p[1])?.id === r.id) lights.push(p);
    }
  }

  // ---- where to stand in each room in walk mode
  const yawTo = (from, to) => (Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180) / Math.PI;
  const views = {};
  for (const r of rooms) {
    if (r.view) { views[r.id] = { x: r.view.at[0], z: r.view.at[1], yaw: r.view.yaw }; continue; }
    const door = openings.find((o) => o.kind !== 'window' && o.rooms.includes(r.id));
    if (door) {
      const sign = door.rooms[0] === r.id ? -1 : 1;
      const mid = door.world((door.a + door.b) / 2, door.rooms[0] === r.id ? 0 : door.t1);
      const step = Math.min(2.2, Math.min(r.w, r.d) * 0.4);
      const at = [mid[0] + door.n[0] * sign * step, mid[1] + door.n[1] * sign * step];
      if (walkable(at[0], at[1])) { views[r.id] = { x: at[0], z: at[1], yaw: yawTo(at, r.at) }; continue; }
    }
    const far = r.w > r.d ? [r.bbox[0] + r.w * 0.15, r.at[1]] : [r.at[0], r.bbox[1] + r.d * 0.15];
    const at = walkable(far[0], far[1]) ? far : r.at;
    views[r.id] = { x: at[0], z: at[1], yaw: at === r.at ? 90 : yawTo(at, r.at) };
  }
  let start = null;
  if (u.start) start = { x: u.start.at[0], z: u.start.at[1], yaw: u.start.yaw };
  else {
    const entry = openings.find((o) => o.type === 'entry') ?? openings.find((o) => o.kind === 'door' && !o.rooms[1]);
    if (entry) {
      const r = roomById[entry.rooms[0]];
      const at = entry.world((entry.a + entry.b) / 2, -2.5);
      if (walkable(at[0], at[1])) start = { x: at[0], z: at[1], yaw: yawTo(at, r.at) };
    }
    if (!start && rooms.length) start = views[(rooms.find((r) => r.kind === 'living') ?? rooms[0]).id];
  }

  if (!rooms.length) problems.push('No rooms yet.');
  const indoor = rooms.filter((r) => !r.outdoor);
  if (rooms.length && !openings.some((o) => o.kind !== 'window' && !o.rooms[1] && !roomById[o.rooms[0]].outdoor)) problems.push('No door leads outside the unit. Add the entry door (type "entry") on the outside wall.');

  const bounds = (() => {
    if (empty) return { x0: 0, z0: 0, x1: 30, z1: 20 };
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const { rect } of wallBoxes) { x0 = Math.min(x0, rect[0]); z0 = Math.min(z0, rect[1]); x1 = Math.max(x1, rect[2]); z1 = Math.max(z1, rect[3]); }
    for (const r of rooms) { x0 = Math.min(x0, r.bbox[0]); z0 = Math.min(z0, r.bbox[1]); x1 = Math.max(x1, r.bbox[2]); z1 = Math.max(z1, r.bbox[3]); }
    return { x0, z0, x1, z1 };
  })();

  return {
    spec: u, empty: !rooms.length, heights: H, finishes: u.finishes, level: u.level,
    rooms, roomById, labels: u.labels, edges, openings, fixtures,
    lights, views, start, bounds, planImage: u.planImage,
    area: indoor.reduce((a, r) => a + r.area, 0),
    grid: { x0: gx0, z0: gz0, res, nx, nz, room, prof, pass, profiles },
    wallBoxes, wallRects,
    // Furniture can't overlap these (axis-aligned [x0, z0, x1, z1]).
    obstacles: [...wallRects, ...fixtures.filter((f) => f.blocks).map((f) => f.aabb)],
    doorSwings: openings.filter((o) => o.swingPoly).map((o) => ({ id: o.id, name: o.name, poly: o.swingPoly })),
    problems,
    cellAt, center,
    roomAt: cellRoom,
    insideUnit: walkable,
    isWallAt: (x, z) => isWall(cellAt(x, z)),
    floorSolidAt: (x, z) => floorSolid(cellAt(x, z)),
    // Height of the wall at (x, z): its solid spans, or null.
    wallAt: (x, z) => { const c = cellAt(x, z); return c >= 0 && prof[c] ? profiles[prof[c]].solid : null; },
  };
}

function defaultName(o, A, B) {
  const t = OPENING[o.type].name;
  if (o.type === 'window') return `${A.name} window`;
  if (!B) return o.type === 'entry' ? 'Entry door' : `${A.name} ${t.toLowerCase()}`;
  const into = (SWING_PRIORITY[B.kind] ?? 2) >= (SWING_PRIORITY[A.kind] ?? 2) ? B : A;
  return `${into.name} ${t.toLowerCase()}`;
}

const fmtLen = (ft) => { const t = Math.round(ft * 24) / 2; const f = Math.floor(t / 12), i = t - f * 12; return f ? `${f}'${i ? `${i}"` : ''}` : `${i}"`; };
const fmtPt = (p) => `(${Math.round(p[0] * 12)}, ${Math.round(p[1] * 12)}) in`;

// Slide a wall-backed fixture back until it touches the wall behind it, if
// one is within a foot. Returns the new center, or null when nothing is there.
export function snapToWall(U, f) {
  const fr = frontOf(f.rot), rt = rightOf(f.rot);
  // Is the strip t feet behind the fixture's back in a wall, at any of three points across it?
  const inWall = (t) => [-0.4, 0, 0.4].some((k) => U.floorSolidAt(
    f.x - fr[0] * (f.d / 2 + t) + rt[0] * k * f.w, f.z - fr[1] * (f.d / 2 + t) + rt[1] * k * f.w));
  let hit = null;
  for (let t = -0.25; t <= 1; t += 1 / 48) if (inWall(t)) { hit = t; break; }
  if (hit === null) return null;
  // The face lies between the last open sample and the first one in the wall.
  let lo = hit - 1 / 48, hi = hit;
  if (inWall(lo)) lo = hit - 0.5;
  for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (inWall(mid)) hi = mid; else lo = mid; }
  if (Math.abs(lo) < 1 / 192) return null;
  return [Math.round((f.x - fr[0] * lo) * 1e4) / 1e4, Math.round((f.z - fr[1] * lo) * 1e4) / 1e4];
}
