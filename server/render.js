// Top-down drawings of a unit, as SVG and PNG. Two layouts:
//   card   — 1200 × 630, for link previews when a unit is shared
//   detail — a plan with a 1' grid, inch coordinates and the ids of rooms,
//            doors, windows, fixtures and pieces, which the MCP server hands
//            to an agent so it can compare its work with the floor plan
// Both take the stored document ({ title, author, unit, items, assets }) and
// the unit as built (src/unit.js buildUnit), and scale to any unit's size.
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { footprint, catalogByType, SWATCHES, isFlat } from '../src/catalog.js';
import { polygonArea, pointInPoly, frontOf, rightOf } from '../src/geometry.js';
import { OUTDOOR_KINDS } from '../src/unit.js';

const FONTS = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf', 'IBMPlexMono-Regular.ttf']
  .map((f) => fileURLToPath(new URL(`./fonts/${f}`, import.meta.url)));

const C = {
  bg: '#ebe8e3', paper: '#f6f4f0', wall: '#3d3b38', halfWall: '#8a857d', window: '#a9c7d1', glass: '#5d8796',
  fixture: '#d6d0c6', fixtureLine: '#a39b8f', upper: '#8f877b', swing: '#8f897f', ink: '#1c1b19', ink2: '#625e57', oak: '#a87a43', grid: '#ddd7cd',
};
const FLOOR = { wood: '#e2d4bf', 'wood-dark': '#cfb898', tile: '#e2e4e3', stone: '#d9d4cb', carpet: '#e6dfd2', concrete: '#d6d4d0', deck: '#d3c2a4' };
const TYPE_FILL = {
  sofa: '#9d978f', sectional: '#9d978f', armchair: '#7a756f', ottoman: '#a39d95', bed: '#efe9df', rug: '#dcd2c2',
  coffeetable: '#8a6a4f', sidetable: '#8a6a4f', tvstand: '#7b5a3e', bookshelf: '#7b5a3e', table: '#8a6a4f', roundtable: '#8a6a4f',
  chair: '#7b5a3e', bench: '#8a6a4f', nightstand: '#7b5a3e', dresser: '#7b5a3e', desk: '#8a6a4f', officechair: '#4f4c48',
  lamp: '#efe3c8', plant: '#7f9668', box: '#c4bcae',
  'table-lamp': '#efe3c8', books: '#8d6f5a', vase: '#cfd6d2', 'plant-small': '#7f9668', plates: '#f2efe9', laptop: '#5c6066',
  microwave: '#4a4c4f', 'coffee-maker': '#3a3b3d', 'wall-art': '#c9b79c', mirror: '#c8d2d8', 'wall-shelf': '#8a6a4f',
  'wall-tv': '#26282b', sconce: '#efe3c8', curtains: '#e6dfd2', blinds: '#ddd6ca', pendant: '#efe3c8', 'ceiling-fan': '#bdb6aa',
};
// Kitchen parts worth naming on the detail plan, long and short.
const SEGMENT_LABEL = { fridge: ['FRIDGE', 'F'], range: ['RANGE', 'R'], cooktop: ['COOK', 'C'], sink: ['SINK', 'S'], dishwasher: ['DW', 'D'], oven: ['OVEN', 'O'], pantry: ['PANTRY', 'P'], drawers: ['DRW', ''], open: ['OPEN', ''] };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const f1 = (v) => v.toFixed(1);
const inches = (ft) => String(Math.round(ft * 12 * 10) / 10);
// Rough text widths, for fitting labels: Plex Sans averages ~0.56 em, Mono 0.6.
const sansWidth = (s, size) => String(s).length * size * 0.56;
const monoWidth = (s, size) => String(s).length * size * 0.6;

function text(x, y, str, { size = 12, mono = false, bold = false, fill = C.ink, anchor = 'start', halo = null, spacing = 0, opacity = 1 } = {}) {
  return `<text x="${f1(x)}" y="${f1(y)}" font-family="${mono ? 'IBM Plex Mono' : 'IBM Plex Sans'}"${bold ? ' font-weight="600"' : ''} font-size="${size}"`
    + `${spacing ? ` letter-spacing="${spacing}"` : ''} fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''} text-anchor="${anchor}"`
    + `${halo ? ` stroke="${halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"` : ''}>${esc(str)}</text>`;
}

function fillFor(item, assets) {
  const sw = SWATCHES.find((s) => s.key === item.color);
  if (sw?.hex != null) return hex(sw.hex);
  if (/^#[0-9a-f]{6}$/.test(item.color ?? '')) return item.color;
  if (item.type === 'asset') return assets[item.asset]?.parts[0]?.color ?? TYPE_FILL.box;
  const def = catalogByType[item.type];
  return TYPE_FILL[def?.build ?? def?.type] ?? TYPE_FILL.box;
}

// Light or dark text for a fill.
const inkOn = (fill) => {
  const n = parseInt(fill.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? C.ink : '#f6f3ee';
};

// "2 bed", "2 bath", "821 sq ft", "12 pieces": from the spec when it says,
// else the room count and the rooms' own area.
export function facts(spec, items = []) {
  const out = [];
  const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (spec?.beds != null) out.push(spec.beds === 0 ? 'Studio' : `${num(spec.beds)} bed`);
  if (spec?.baths != null) out.push(`${num(spec.baths)} bath`);
  const rooms = spec?.rooms ?? [];
  if (!out.length && rooms.length) out.push(`${rooms.length} room${rooms.length === 1 ? '' : 's'}`);
  const area = spec?.sqft ?? Math.round(rooms.filter((r) => !OUTDOOR_KINDS.has(r.kind)).reduce((a, r) => a + Math.abs(polygonArea(r.poly)), 0));
  if (area) out.push(`${area.toLocaleString('en-US')} sq ft`);
  out.push(`${items.length} piece${items.length === 1 ? '' : 's'}`);
  return out;
}

// A point inside a room near its top-left corner, for a label that stays
// clear of the furniture labels in the middle.
function cornerOf(r) {
  const [x, z] = r.poly.reduce((best, p) => (p[0] + p[1] < best[0] + best[1] ? p : best));
  for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    if (pointInPoly(x + dx * 0.3, z + dz * 0.3, r.poly)) return [x + (dx > 0 ? 0.25 : -0.25), z + (dz > 0 ? 0.25 : -0.25), dx > 0 ? 'start' : 'end'];
  }
  return [r.at[0], r.at[1], 'middle'];
}

// Everything on the floor plan, scaled into the box [bx, by, bw, bh].
function planGroup(doc, U, [bx, by, bw, bh], { detail = false } = {}) {
  const b = U.bounds, pad = detail ? 1 : 0.4;
  const fw = b.x1 - b.x0 + 2 * pad, fh = b.z1 - b.z0 + 2 * pad;
  const s = Math.min(bw / fw, bh / fh, detail ? 64 : 40);
  const ox = bx + (bw - fw * s) / 2 + (pad - b.x0) * s, oz = by + (bh - fh * s) / 2 + (pad - b.z0) * s;
  const P = (x, z) => [ox + x * s, oz + z * s];
  const pts = (poly) => poly.map(([x, z]) => P(x, z).map(f1).join(',')).join(' ');
  const line = (p, q, attrs) => { const [a, c] = [P(...p), P(...q)]; return `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(c[0])}" y2="${f1(c[1])}" ${attrs}/>`; };
  const rect = ([x0, z0, x1, z1], attrs) => `<rect x="${f1(ox + x0 * s)}" y="${f1(oz + z0 * s)}" width="${f1((x1 - x0) * s)}" height="${f1((z1 - z0) * s)}" ${attrs}/>`;
  const out = [];
  const assets = Object.fromEntries((doc.assets ?? []).map((a) => [a.id, a]));
  // Bottom up: rugs, pieces on the floor, what rests on them (lowest first),
  // what hangs on the walls, then what hangs from the ceiling.
  const tier = (it) => (isFlat(it, assets) ? 0 : !it.on ? 1 : it.on === 'wall' ? 3 : it.on === 'ceiling' ? 4 : 2);
  const items = [...(doc.items ?? [])].sort((p, q) => tier(p) - tier(q) || (p.y ?? 0) - (q.y ?? 0));

  if (detail) {
    // A 1' grid with inch coordinates every 5', so an agent can read positions off the picture.
    const gx0 = Math.floor(b.x0 - pad), gx1 = Math.ceil(b.x1 + pad), gz0 = Math.floor(b.z0 - pad), gz1 = Math.ceil(b.z1 + pad);
    for (let x = gx0; x <= gx1; x++) {
      out.push(line([x, gz0], [x, gz1], `stroke="${C.grid}" stroke-width="${x % 5 === 0 ? 1.2 : 0.5}"`));
      if (x % 5 === 0) out.push(text(P(x, 0)[0], P(0, gz0)[1] - 6, String(x * 12), { size: 11, mono: true, fill: C.ink2, anchor: 'middle' }));
    }
    for (let z = gz0; z <= gz1; z++) {
      out.push(line([gx0, z], [gx1, z], `stroke="${C.grid}" stroke-width="${z % 5 === 0 ? 1.2 : 0.5}"`));
      if (z % 5 === 0) out.push(text(P(gx0, 0)[0] - 6, P(0, z)[1] + 4, String(z * 12), { size: 11, mono: true, fill: C.ink2, anchor: 'end' }));
    }
  }

  // Floors, then the floor under doorways so they read as passages.
  for (const r of U.rooms) out.push(`<polygon points="${pts(r.poly)}" fill="${FLOOR[r.floor] ?? FLOOR.wood}"/>`);
  for (const o of U.openings) {
    if (o.kind === 'window') continue;
    const r = U.roomById[o.rooms[0]];
    out.push(`<polygon points="${pts(o.poly)}" fill="${FLOOR[r?.floor] ?? FLOOR.wood}"/>`);
  }

  // Fixtures: light footprints with a darker front edge; kitchen parts ticked.
  for (const f of U.fixtures) {
    const solid = f.blocks;
    out.push(`<polygon points="${pts(f.poly)}" fill="${solid ? C.fixture : 'none'}" fill-opacity="${detail ? 0.95 : 1}" stroke="${C.fixtureLine}" stroke-width="1"${solid ? '' : ' stroke-dasharray="4 3"'}/>`);
    if (solid) out.push(line(f.poly[2], f.poly[3], `stroke="${C.upper}" stroke-width="${detail ? 1.6 : 1.2}"`));
    if (!f.segments) continue;
    const L = local(f);
    f.segments.forEach((g, i) => {
      if (i > 0) out.push(line(L(g.s0, 0), L(g.s0, f.d), `stroke="${C.fixtureLine}" stroke-width="1"`));
      // Wall cabinets above: a dashed line where their fronts are.
      if (detail && g.upper) out.push(line(L(g.s0, 13 / 12), L(g.s1, 13 / 12), `stroke="${C.upper}" stroke-width="0.8" stroke-dasharray="3 3"`));
    });
  }

  // Door swings: each leaf hinged at its end of the opening, on the face it
  // swings from, with a quarter circle to where it stands open.
  const drawSwings = () => {
    for (const o of U.openings) {
      if (!o.swingPoly) continue;
      const face = o.swing > 0 ? o.t1 : 0, r = o.width / o.leaves;
      const leaves = o.leaves === 2 ? [[o.a, 1], [o.b, -1]] : [[o.hinge === 'b' ? o.b : o.a, o.hinge === 'b' ? -1 : 1]];
      for (const [sh, along] of leaves) {
        const H = P(...o.world(sh, face)), shut = P(...o.world(sh + along * r, face)), open = P(...o.world(sh, face + o.swing * r));
        const cross = (shut[0] - H[0]) * (open[1] - H[1]) - (shut[1] - H[1]) * (open[0] - H[0]);
        out.push(`<path d="M${f1(shut[0])} ${f1(shut[1])} A${f1(r * s)} ${f1(r * s)} 0 0 ${cross > 0 ? 1 : 0} ${f1(open[0])} ${f1(open[1])}" fill="none" stroke="${C.swing}" stroke-width="1" stroke-dasharray="3 3"/>`);
        out.push(`<line x1="${f1(H[0])}" y1="${f1(H[1])}" x2="${f1(open[0])}" y2="${f1(open[1])}" stroke="${C.swing}" stroke-width="${detail ? 2 : 1.6}"/>`);
      }
    }
  };
  const drawWalls = () => {
    if (!detail) { for (const w of U.wallRects) out.push(rect(w, `fill="${C.wall}"`)); return; }
    // Walls that stop short of the ceiling (half walls, a pier) in gray.
    for (const w of U.wallBoxes) {
      if (w.solid[0][0] > 0.05) continue;
      const half = w.solid.length === 1 && w.solid[0][1] < U.heights.ceiling - 0.05;
      out.push(rect(w.rect, `fill="${half ? C.halfWall : C.wall}"`));
    }
  };
  const drawOpenings = () => {
    for (const o of U.openings) {
      const W = (sv, t) => o.world(sv, t);
      if (o.kind === 'window') {
        out.push(`<polygon points="${pts(o.poly)}" fill="${C.window}"/>`);
        out.push(line(W(o.a, o.t1 / 2), W(o.b, o.t1 / 2), `stroke="${C.glass}" stroke-width="1"`));
        for (const m of o.mullions ?? []) { const sv = o.a + m * (o.b - o.a); out.push(line(W(sv, 0), W(sv, o.t1), `stroke="${C.glass}" stroke-width="1"`)); }
        continue;
      }
      const ink = `stroke="${C.ink2}" stroke-width="1.3"`;
      const mid = o.t1 / 2, w = o.b - o.a;
      if (o.type === 'opening') {
        out.push(line(W(o.a, 0), W(o.b, 0), `${ink} stroke-dasharray="2 3"`), line(W(o.a, o.t1), W(o.b, o.t1), `${ink} stroke-dasharray="2 3"`));
      } else if (o.type === 'slider' || o.type === 'closet-slider') {
        const lap = w * 0.06;
        out.push(line(W(o.a, o.t1 * 0.35), W(o.a + w / 2 + lap, o.t1 * 0.35), ink), line(W(o.b - w / 2 - lap, o.t1 * 0.65), W(o.b, o.t1 * 0.65), ink));
      } else if (o.type === 'pocket') {
        out.push(line(W(o.a, mid), W(o.b, mid), `${ink} stroke-dasharray="5 3"`));
      } else if (o.type === 'barn') {
        const t = o.swing > 0 ? o.t1 + 0.12 : -0.12;
        out.push(line(W(o.a - 0.15, t), W(o.b + 0.15, t), `stroke="${C.ink2}" stroke-width="2.4"`));
      } else if (o.type === 'bifold') {
        // Two pairs of panels folding out toward the side they open into.
        const face = o.swing > 0 ? o.t1 : 0, k = o.swing * Math.min(0.9, w / 5);
        const zz = [W(o.a, face), W(o.a + w / 4, face + k), W(o.a + w / 2, face), W(o.b - w / 4, face + k), W(o.b, face)].map((p) => P(...p).map(f1).join(','));
        out.push(`<polyline points="${zz.join(' ')}" fill="none" ${ink}/>`);
      }
    }
  };
  if (detail) { drawWalls(); drawOpenings(); } else drawSwings();

  // Furniture, bottom up; a darker edge marks each front. What hangs from the
  // ceiling is a dashed outline, so what's under it still shows.
  for (const it of items) {
    const poly = footprint(it);
    if (it.on === 'ceiling') {
      out.push(`<polygon points="${pts(poly)}" fill="${fillFor(it, assets)}" fill-opacity="0.25" stroke="${C.ink}" stroke-opacity="0.6" stroke-width="${detail ? 1.3 : 1}" stroke-dasharray="${detail ? '5 4' : '4 3'}"/>`);
      continue;
    }
    out.push(`<polygon points="${pts(poly)}" fill="${fillFor(it, assets)}" stroke="${C.ink}" stroke-opacity="0.55" stroke-width="${detail ? 1.3 : 1}" fill-opacity="${isFlat(it, assets) ? 0.85 : 1}"/>`);
    out.push(line(poly[2], poly[3], `stroke="${C.oak}" stroke-width="${detail ? 3 : 2.2}"`));
  }
  // On the detail plan swings go over the furniture, so a blocked door shows.
  if (!detail) { drawWalls(); drawOpenings(); } else drawSwings();

  // ---- labels
  if (!detail) {
    const size = Math.max(9, Math.min(14, s * 0.5));
    for (const r of U.rooms) {
      if (r.minor || r.kind === 'bath' || r.kind === 'hall' || sansWidth(r.name, size) > r.w * s * 1.1) continue;
      const [lx, lz] = P(...r.at);
      out.push(text(lx, lz, r.name.toUpperCase(), { size: f1(size), bold: true, spacing: 1, fill: C.ink2, anchor: 'middle', opacity: 0.8 }));
    }
    return out.join('\n');
  }
  const halo = C.paper;
  for (const r of U.rooms) {
    // Name, id, size (inches) and area from the room's top-left inner corner,
    // shortened to what fits across the room.
    const [x, z, anchor] = cornerOf(r);
    const [lx, lz] = P(x, z);
    const room = r.w * s - 10;
    const nameFits = (size) => sansWidth(r.name, size) * 1.08 + monoWidth(` ${r.id}`, size) <= room;
    const size = nameFits(13) ? 13 : nameFits(11) ? 11 : 0;
    if (size) {
      out.push(`<text x="${f1(lx)}" y="${f1(lz + size)}" font-family="IBM Plex Sans" font-weight="600" font-size="${size}" letter-spacing="0.6" fill="${C.ink}" text-anchor="${anchor}" stroke="${halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(r.name.toUpperCase())} <tspan font-family="IBM Plex Mono" font-weight="400" letter-spacing="0" fill="${C.ink2}">${esc(r.id)}</tspan></text>`);
    } else out.push(text(lx, lz + 11, r.id, { size: 10.5, mono: true, anchor, halo }));
    const dims = [`${inches(r.w)} × ${inches(r.d)} in · ${Math.round(r.area)} sq ft`, `${inches(r.w)}×${inches(r.d)}`].find((t) => monoWidth(t, 10.5) <= room);
    if (dims) out.push(text(lx, lz + (size || 11) + 14, dims, { size: 10.5, mono: true, fill: C.ink2, anchor, halo }));
  }
  for (const l of U.labels) { const [lx, lz] = P(...l.at); out.push(text(lx, lz, l.text, { size: 12, bold: true, fill: C.ink2, anchor: 'middle', halo, opacity: 0.85 })); }

  for (const f of U.fixtures) {
    if (f.type === 'wall-tile') continue;
    const L = local(f);
    // Kitchen parts by name inside the run, where they fit.
    if (f.segments) {
      const across = Math.abs(rightOf(f.rot)[0]) > 0.7;
      for (const g of f.segments) {
        const names = SEGMENT_LABEL[g.kind];
        if (!names) continue;
        const room = (across ? g.s1 - g.s0 : f.d) * s - 4;
        const label = names.find((n) => n && monoWidth(n, 9) <= room);
        if (!label) continue;
        const [cx, cz] = P(...L((g.s0 + g.s1) / 2, f.d / 2));
        out.push(text(cx, cz + 3, label, { size: 9, mono: true, fill: C.ink2, anchor: 'middle' }));
      }
    }
    // Name and id: in the middle of anything big enough, else just in front of it.
    const big = Math.min(f.w, f.d) * s > 34 && !f.segments;
    const [cx, cz] = P(...(big ? [f.x, f.z] : L(0, f.d + 0.55)));
    out.push(text(cx, cz - 1, f.name, { size: 10.5, bold: true, fill: C.ink2, anchor: 'middle', halo }));
    out.push(text(cx, cz + 10, f.id, { size: 9.5, mono: true, fill: C.ink2, anchor: 'middle', halo }));
  }

  // Opening ids: just outside the unit for windows and doors in an outside
  // wall, else on the opening itself.
  for (const o of U.openings) {
    const outside = !o.rooms[1];
    const t = outside ? o.t1 + 0.3 : o.t1 / 2;
    const [cx, cz] = P(...o.world((o.a + o.b) / 2, t));
    const [nx, nz] = o.n;
    const anchor = outside && nx > 0.7 ? 'start' : outside && nx < -0.7 ? 'end' : 'middle';
    const dy = outside && nz > 0.7 ? 10 : outside && nz < -0.7 ? -2 : 3.5;
    out.push(text(cx, cz + dy, o.id, { size: 10, mono: true, fill: o.kind === 'window' ? C.glass : C.ink, anchor, halo }));
  }

  for (const it of items) {
    const [cx, cz] = P(it.x, it.z);
    // What rests on a piece or hangs from the ceiling is labeled by id alone
    // (they crowd the piece under them); the rest by name and id.
    if (it.on && it.on !== 'wall') {
      const below = it.on === 'ceiling' ? Math.max(...footprint(it).map(([x, z]) => P(x, z)[1])) + 10 : cz + 3.5;
      out.push(text(cx, below, it.uid, { size: 9.5, mono: true, fill: C.ink, anchor: 'middle', halo }));
      continue;
    }
    const wall = it.on === 'wall';
    const ink = isFlat(it, assets) || wall ? C.ink : inkOn(fillFor(it, assets));
    const h = wall ? halo : null, size = wall ? 10.5 : 12;
    out.push(text(cx, cz - 2, it.name, { size, bold: true, fill: ink, anchor: 'middle', halo: h }));
    out.push(text(cx, cz + size - 1, it.uid, { size: size - 1.5, mono: true, fill: ink, anchor: 'middle', halo: h }));
  }

  // North: where the unit says true north is (up the plan unless set).
  const [nx, ny] = [bx + bw - 18, by + 26];
  const north = U.north ?? 0;
  out.push(`<g transform="rotate(${f1(north)} ${nx} ${ny - 4})"><path d="M${nx} ${ny - 18} l7 16 l-7 -5 l-7 5 z" fill="${C.ink2}"/></g>`, text(nx, ny + 12, 'N', { size: 12, bold: true, fill: C.ink2, anchor: 'middle' }));
  return out.join('\n');
}

// A fixture's own frame: s across its width (+ to your right as you face its
// front), t from its back (0) to its front (d). Returns plan [x, z].
function local(f) {
  const fr = frontOf(f.rot), rt = rightOf(f.rot);
  return (sv, t) => [f.x + rt[0] * sv + fr[0] * (t - f.d / 2), f.z + rt[1] * sv + fr[1] * (t - f.d / 2)];
}

function nothingYet([bx, by, bw, bh], hint) {
  const cx = bx + bw / 2, cy = by + bh / 2;
  return `<rect x="${f1(bx + 20)}" y="${f1(by + 20)}" width="${f1(bw - 40)}" height="${f1(bh - 40)}" rx="18" fill="none" stroke="${C.fixtureLine}" stroke-width="2" stroke-dasharray="10 8"/>
${text(cx, cy - (hint ? 8 : -10), 'Nothing built yet', { size: 30, bold: true, fill: C.ink2, anchor: 'middle' })}
${hint ? text(cx, cy + 26, hint, { size: 16, fill: C.ink2, anchor: 'middle' }) : ''}`;
}

// The link preview. `headline` and `tagline` replace the title and byline (the home page's card).
export function cardSvg(doc, U, { headline, tagline } = {}) {
  const W = 1200, H = 630;
  const lines = wrap(headline ?? (doc.title || doc.unit?.name || 'An untitled unit'), 15).slice(0, 4);
  const by = tagline ?? (doc.author ? `by ${doc.author.slice(0, 40)}` : '');
  const byLines = wrap(by, 30).slice(0, 3);
  const box = [470, 30, 700, 570];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${text(56, 92, '3D LIVING SPACE', { size: 20, mono: true, spacing: 2, fill: C.ink2 })}
${lines.map((l, i) => text(56, 166 + i * 52, l, { size: 44, bold: true })).join('\n')}
${byLines.map((l, i) => text(56, 166 + lines.length * 52 + 12 + i * 34, l, { size: 26, fill: C.ink2 })).join('\n')}
${text(56, 560, U.empty ? 'Waiting for its floor plan' : (headline ? facts(doc.unit).slice(0, -1) : facts(doc.unit, doc.items)).join(' · '), { size: 20, mono: true, fill: C.ink2 })}
<rect x="56" y="580" width="56" height="5" fill="${C.oak}"/>
${U.empty ? nothingYet(box) : planGroup(doc, U, box)}
</svg>`;
}

// The plan an agent looks at. The canvas follows the unit's shape and stays
// near the size a model sees without downscaling (~1.2 megapixels).
export function detailSvg(doc, U) {
  const head = 92, left = 56, right = 64, top = 22, bottom = 18;
  const b = U.bounds, fw = b.x1 - b.x0 + 2, fh = b.z1 - b.z0 + 2;
  let s = 64;
  while (s > 8 && ((fw * s + left + right) * (fh * s + head + top + bottom) > 1.25e6 || fw * s + left + right > 1560 || fh * s + head + top + bottom > 1560)) s -= 0.5;
  const W = Math.max(900, Math.round(fw * s + left + right)), H = Math.max(560, Math.round(fh * s + head + top + bottom));
  const box = [left, head + top, W - left - right, H - head - top - bottom];
  const sub = U.empty ? '' : facts(doc.unit, doc.items).join(' · ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.paper}"/>
${text(24, 32, `${doc.title || 'Untitled unit'}${sub ? `  ·  ${sub}` : ''}`, { size: 19, bold: true })}
${text(24, 56, 'Plan view, north up. Inches: x east (left to right), z south (top to bottom); grid 1 ft, numbers every 5 ft.', { size: 12.5, mono: true, fill: C.ink2 })}
${text(24, 76, 'Blue = windows, arcs = door swings, gray = fixtures (dashed: wall-hung), orange edge = front of a piece, dashed piece = from the ceiling.', { size: 12.5, mono: true, fill: C.ink2 })}
${U.empty ? nothingYet(box, 'Call build_unit with the rooms from the floor plan.') : planGroup(doc, U, box, { detail: true })}
</svg>`;
}

function wrap(str, width) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

export function png(svg) {
  return new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' } }).render().asPng();
}
