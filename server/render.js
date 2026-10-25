// Top-down drawings of a design, as SVG and PNG. Two layouts:
//   card   — 1200 × 630, for link previews when a design is shared
//   detail — a large plan with a 1' grid, inch coordinates and piece ids, which
//            the MCP server hands to an agent so it can check its own work
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { ROOMS, UNIT, wallPieces, openings, BUILTINS, polygonArea } from '../src/space.js';
import { footprint, catalogByType, SWATCHES, isFlat } from '../src/catalog.js';

const FONTS = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf', 'IBMPlexMono-Regular.ttf']
  .map((f) => fileURLToPath(new URL(`./fonts/${f}`, import.meta.url)));

const C = {
  bg: '#ebe8e3', wood: '#e2d4bf', tile: '#e6e4e0', wall: '#3d3b38', window: '#a9c7d1',
  fixture: '#d3cdc3', fixtureLine: '#b3ab9f', swing: '#9b958c', ink: '#1c1b19', ink2: '#625e57', oak: '#a87a43', grid: '#d8d2c8',
};
const TYPE_FILL = {
  sofa: '#9d978f', sectional: '#9d978f', armchair: '#7a756f', ottoman: '#a39d95', bed: '#efe9df', rug: '#dcd2c2',
  coffeetable: '#8a6a4f', sidetable: '#8a6a4f', tvstand: '#7b5a3e', bookshelf: '#7b5a3e', table: '#8a6a4f', roundtable: '#8a6a4f',
  chair: '#7b5a3e', bench: '#8a6a4f', nightstand: '#7b5a3e', dresser: '#7b5a3e', desk: '#8a6a4f', officechair: '#4f4c48',
  lamp: '#efe3c8', plant: '#7f9668', box: '#c4bcae',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

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

function doorArc(o, P, s) {
  const w = o.w, r = (o.b - o.a) * s;
  const sw = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[o.swing];
  const hingeS = o.hinge === 'from' ? o.a : o.b;
  const along = w.axis === 'x' ? [o.hinge === 'from' ? 1 : -1, 0] : [0, o.hinge === 'from' ? 1 : -1];
  const [hx, hz] = w.axis === 'x' ? [hingeS, sw[1] > 0 ? w.z1 : w.z0] : [sw[0] > 0 ? w.x1 : w.x0, hingeS];
  const H = P(hx, hz);
  const p1 = [H[0] + along[0] * r, H[1] + along[1] * r], p2 = [H[0] + sw[0] * r, H[1] + sw[1] * r];
  const sweep = along[0] * sw[1] - along[1] * sw[0] > 0 ? 1 : 0;
  return `<path d="M${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A${r.toFixed(1)} ${r.toFixed(1)} 0 0 ${sweep} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}" fill="none" stroke="${C.swing}" stroke-width="1" stroke-dasharray="3 3"/>`
    + `<line x1="${H[0].toFixed(1)}" y1="${H[1].toFixed(1)}" x2="${p2[0].toFixed(1)}" y2="${p2[1].toFixed(1)}" stroke="${C.swing}" stroke-width="1.6"/>`;
}

// The plan, scaled into the box [bx, by, bw, bh].
function planGroup(design, [bx, by, bw, bh], { detail = false } = {}) {
  const fp = UNIT.footprint, pad = detail ? 2.2 : 0.6;
  const fw = fp.x1 - fp.x0 + pad * 2, fh = fp.z1 - fp.z0 + pad * 2;
  const s = Math.min(bw / fw, bh / fh);
  const ox = bx + (bw - fw * s) / 2 + (pad - fp.x0) * s, oz = by + (bh - fh * s) / 2 + (pad - fp.z0) * s;
  const P = (x, z) => [ox + x * s, oz + z * s];
  const pts = (poly) => poly.map(([x, z]) => P(x, z).map((v) => v.toFixed(1)).join(',')).join(' ');
  const rect = ([x0, z0, x1, z1], attrs) => `<rect x="${(ox + x0 * s).toFixed(1)}" y="${(oz + z0 * s).toFixed(1)}" width="${((x1 - x0) * s).toFixed(1)}" height="${((z1 - z0) * s).toFixed(1)}" ${attrs}/>`;
  const out = [];
  const assets = Object.fromEntries((design.assets ?? []).map((a) => [a.id, a]));

  if (detail) {
    // A 1' grid with inch coordinates every 5', so an agent can read positions off the picture.
    for (let x = 0; x <= fp.x1 + 0.01; x += 1) {
      const [px] = P(x, 0);
      out.push(`<line x1="${px.toFixed(1)}" y1="${P(0, fp.z0 - 1)[1].toFixed(1)}" x2="${px.toFixed(1)}" y2="${P(0, fp.z1 + 1)[1].toFixed(1)}" stroke="${C.grid}" stroke-width="${x % 5 === 0 ? 1.2 : 0.5}"/>`);
      if (x % 5 === 0) out.push(`<text x="${px.toFixed(1)}" y="${(P(0, fp.z0 - 1)[1] - 6).toFixed(1)}" font-family="IBM Plex Mono" font-size="12" fill="${C.ink2}" text-anchor="middle">${x * 12}</text>`);
    }
    for (let z = 0; z <= fp.z1 + 0.01; z += 1) {
      const [, pz] = P(0, z);
      out.push(`<line x1="${P(fp.x0 - 1, 0)[0].toFixed(1)}" y1="${pz.toFixed(1)}" x2="${P(fp.x1 + 1, 0)[0].toFixed(1)}" y2="${pz.toFixed(1)}" stroke="${C.grid}" stroke-width="${z % 5 === 0 ? 1.2 : 0.5}"/>`);
      if (z % 5 === 0) out.push(`<text x="${(P(fp.x0 - 1, 0)[0] - 8).toFixed(1)}" y="${(pz + 4).toFixed(1)}" font-family="IBM Plex Mono" font-size="12" fill="${C.ink2}" text-anchor="end">${z * 12}</text>`);
    }
  }
  for (const r of ROOMS) out.push(`<polygon points="${pts(r.poly)}" fill="${r.floor === 'tile' ? C.tile : C.wood}"/>`);
  for (const f of BUILTINS) out.push(rect(f.rect, `fill="${C.fixture}" stroke="${C.fixtureLine}" stroke-width="1"`));
  for (const o of openings) if (o.type === 'door') out.push(doorArc(o, P, s));

  // Furniture: rugs first, then everything else; a darker edge marks each front.
  const items = [...(design.items ?? [])].sort((a, b) => Number(isFlat(b)) - Number(isFlat(a)));
  for (const it of items) {
    const poly = footprint(it);
    const fill = fillFor(it, assets);
    out.push(`<polygon points="${pts(poly)}" fill="${fill}" stroke="${C.ink}" stroke-opacity="0.55" stroke-width="${detail ? 1.4 : 1}" fill-opacity="${isFlat(it) ? 0.85 : 1}"/>`);
    const [a, b] = [P(...poly[2]), P(...poly[3])];
    out.push(`<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${C.oak}" stroke-width="${detail ? 3 : 2.2}"/>`);
  }
  for (const w of wallPieces) out.push(rect(w, `fill="${C.wall}"`));
  for (const o of openings) {
    if (o.type !== 'window') continue;
    const w = o.w, inset = 0.22;
    const r = w.axis === 'x' ? [o.a, w.z0 + inset, o.b, w.z1 - inset] : [w.x0 + inset, o.a, w.x1 - inset, o.b];
    out.push(rect(r, `fill="${C.window}"`));
  }

  // Labels.
  const big = Math.max(10, Math.min(15, s * 0.55));
  for (const r of ROOMS) {
    if (!detail && /closet|coat|laundry/i.test(r.name)) continue;
    if (!detail) {
      const [lx, lz] = P(...r.at);
      out.push(`<text x="${lx.toFixed(1)}" y="${lz.toFixed(1)}" font-family="IBM Plex Sans" font-weight="600" font-size="${(big * 0.8).toFixed(1)}" letter-spacing="1" fill="${C.ink2}" fill-opacity="0.75" text-anchor="middle">${esc(r.name.toUpperCase())}</text>`);
      continue;
    }
    // Detail: name, size, id and extent in the room's top-left corner, clear of furniture labels.
    const xs = r.poly.map((p) => p[0]), zs = r.poly.map((p) => p[1]);
    const [lx, lz] = P(Math.min(...xs) + 0.25, Math.min(...zs) + 0.25);
    const small = /closet|coat|laundry/i.test(r.name);
    const dims = r.dims ?? `${Math.round(Math.abs(polygonArea(r.poly)))} sq ft`;
    out.push(`<text x="${lx.toFixed(1)}" y="${(lz + 12).toFixed(1)}" font-family="IBM Plex Sans" font-weight="600" font-size="${small ? 10 : 12}" letter-spacing="1" fill="${C.ink2}">${esc(r.name.toUpperCase())} <tspan font-family="IBM Plex Mono" font-weight="400" letter-spacing="0">${esc(r.id)}</tspan></text>`);
    if (!small) out.push(`<text x="${lx.toFixed(1)}" y="${(lz + 26).toFixed(1)}" font-family="IBM Plex Mono" font-size="10.5" fill="${C.ink2}">${esc(dims)} · x ${Math.round(Math.min(...xs) * 12)}–${Math.round(Math.max(...xs) * 12)}, z ${Math.round(Math.min(...zs) * 12)}–${Math.round(Math.max(...zs) * 12)}</text>`);
  }
  if (detail) {
    for (const it of items) {
      const [cx, cz] = P(it.x, it.z);
      const fill = fillFor(it, assets);
      const ink = isFlat(it) ? C.ink : inkOn(fill);
      out.push(`<text x="${cx.toFixed(1)}" y="${(cz - 2).toFixed(1)}" font-family="IBM Plex Sans" font-weight="600" font-size="12" fill="${ink}" text-anchor="middle">${esc(it.name)}</text>`);
      out.push(`<text x="${cx.toFixed(1)}" y="${(cz + 12).toFixed(1)}" font-family="IBM Plex Mono" font-size="10.5" fill="${ink}" text-anchor="middle">${esc(it.uid)}</text>`);
    }
  }
  return out.join('\n');
}

export function cardSvg(design) {
  const W = 1200, H = 630;
  const title = design.title || 'An untitled design';
  const lines = wrap(title, 15).slice(0, 4);
  const count = (design.items ?? []).length;
  const by = design.author ? `by ${design.author}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<text x="56" y="92" font-family="IBM Plex Mono" font-size="20" letter-spacing="2" fill="${C.ink2}">3D LIVING SPACE</text>
${lines.map((l, i) => `<text x="56" y="${166 + i * 52}" font-family="IBM Plex Sans" font-weight="600" font-size="44" fill="${C.ink}">${esc(l)}</text>`).join('\n')}
${by ? `<text x="56" y="${166 + lines.length * 52 + 12}" font-family="IBM Plex Sans" font-size="26" fill="${C.ink2}">${esc(by.slice(0, 40))}</text>` : ''}
<text x="56" y="560" font-family="IBM Plex Mono" font-size="20" fill="${C.ink2}">${count} piece${count === 1 ? '' : 's'} · 2 bed · 2 bath · 821 sq ft</text>
<rect x="56" y="580" width="56" height="5" fill="${C.oak}"/>
${planGroup(design, [470, 30, 700, 570])}
</svg>`;
}

export function detailSvg(design) {
  const W = 1600, H = 1160;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#f6f4f0"/>
<text x="24" y="34" font-family="IBM Plex Sans" font-weight="600" font-size="20" fill="${C.ink}">${esc(design.title || 'Untitled design')}</text>
<text x="24" y="58" font-family="IBM Plex Mono" font-size="13" fill="${C.ink2}">Plan view, north up. Coordinates in inches: x east (left to right), z south (top to bottom). Orange edge = front of a piece. Labels: name and id.</text>
${planGroup(design, [40, 70, W - 60, H - 90], { detail: true })}
</svg>`;
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
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
