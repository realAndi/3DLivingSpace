// Textures from recipes: a surface described as plain data (a pattern of
// planks or tiles, layers of grain, veins, chips and weave, a finish), drawn
// the same way in the browser, on the server and in the skill's scripts. An
// agent writes one to match a photo of a real floor, counter or fabric, looks
// at what it draws, and adjusts it; the unit keeps it (`unit.textures`) and
// finishes, floors, fixtures and furniture name it as "tex:<id>".
//
// Sizes are real ones, in inches, so a 3" plank is 3" wide wherever it goes.
// Colors are "#rrggbb". No DOM and no three.js: renderTexture() returns plain
// pixel arrays (color, height, roughness) over one repeat of the surface, which
// tiles seamlessly; src/materials.js turns them into maps, and the agent's
// tools into a preview picture (src/png.js).
//
// A recipe:
//   { id, name, for, base, pattern: {type, size, …}, layers: [{type, …}], finish, repeat }
// pattern.type lays the surface out in pieces (planks, tiles, herringbone …),
// each piece taking one of pattern.colors; layers then draw into every piece
// in its own frame (grain runs along each plank), or across the whole surface
// when there are no pieces. imageStats() and compareStats() measure a picture
// against a photo, so the agent can tell how close it got.

export const PATTERNS = ['none', 'planks', 'tiles', 'checker', 'herringbone', 'chevron', 'basketweave', 'hexagons', 'stripes', 'plaid'];
export const LAYERS = ['mottle', 'grain', 'veins', 'speckle', 'pits', 'noise', 'weave'];
export const USES = ['floor', 'counter', 'cabinet', 'tile', 'wall', 'wood', 'stone', 'fabric', 'leather', 'rug', 'metal', 'other'];
export const TEXTURE_LIMITS = { textures: 24, layers: 8, colors: 8, name: 40, about: 200 };

// The surface one repeat covers (inches, at least), by what it's for, and the
// finish it has unless the recipe says.
const TARGET = { floor: 48, counter: 48, tile: 36, cabinet: 24, wall: 48, wood: 24, stone: 36, fabric: 8, leather: 8, rug: 24, metal: 12, other: 24 };
const ROUGH = { floor: 0.6, counter: 0.22, tile: 0.3, cabinet: 0.5, wall: 0.85, wood: 0.6, stone: 0.4, fabric: 0.95, leather: 0.6, rug: 1, metal: 0.35, other: 0.7 };

// How each layer draws unless the recipe says: how far its marks raise (+) or
// sink (-) the surface, and how much rougher they are.
const LAYER_DEFAULTS = {
  mottle: { amount: 0.3, scale: 12, depth: 0, rough: 0 },
  grain: { amount: 0.5, scale: 0.3, depth: -0.3, rough: 0.08, wave: 0.4, figure: 'straight', knots: 0 },
  veins: { amount: 0.6, scale: 10, depth: 0, rough: 0, width: 0.08, angle: 30, turbulence: 0.5 },
  speckle: { amount: 0.5, scale: 0.15, depth: 0, rough: 0, vary: 0.5 },
  pits: { amount: 0.15, scale: 0.12, depth: -1, rough: 0.25, vary: 0.6 },
  noise: { amount: 0.2, scale: 0.08, depth: 0.3, rough: 0.05 },
  weave: { amount: 0.6, scale: 0.04, depth: 0.8, rough: 0, twill: false },
};

export const TEX_REF = /^tex:[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
export const isTexRef = (v) => typeof v === 'string' && TEX_REF.test(v);
export const texId = (v) => (isTexRef(v) ? v.slice(4) : null);

// ---------------------------------------------------------------------------
// Cleaning: what an agent or a page sends comes through here.

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v, lo, hi, dflt) => (v !== null && v !== '' && v !== undefined && Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : dflt);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);
const hexes = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(hex).filter(Boolean).slice(0, TEXTURE_LIMITS.colors);
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

// The pattern's own sizes: what `size` holds for each type, and its defaults.
const SIZES = {
  none: [], planks: [5, 48], tiles: [12, 12], checker: [12], herringbone: [3, 18], chevron: [3, 18],
  basketweave: [2], hexagons: [3], stripes: [1, 1], plaid: [1, 0.5, 2],
};
const JOINT = { none: 0, planks: 0.04, tiles: 0.125, checker: 0.06, herringbone: 0.04, chevron: 0.04, basketweave: 0.06, hexagons: 0.1, stripes: 0, plaid: 0 };

function cleanPattern(raw, why, where) {
  const type = PATTERNS.includes(raw?.type) ? raw.type : 'none';
  if (raw?.type && raw.type !== type) why.push(`${where}: pattern type "${raw.type}" isn't one of ${PATTERNS.join(', ')}; drawn plain.`);
  const out = { type };
  if (type === 'none') return out;
  const dflt = SIZES[type];
  const given = (Array.isArray(raw.size) ? raw.size : raw.size != null ? [raw.size] : []).map((v) => num(v, 0.05, 120, null)).filter((v) => v != null);
  const many = type === 'stripes' || type === 'plaid';
  out.size = (many ? (given.length ? given : dflt).slice(0, 12) : dflt.map((d, i) => given[i] ?? d)).map(r3);
  if (type === 'herringbone' || type === 'chevron') {
    // A herringbone plank's length is a whole number of its widths.
    const [w, l] = out.size;
    out.size = [w, r3(Math.max(2, Math.round(l / w)) * w)];
  }
  // Snapped to the turns it still tiles at.
  const step = turnsOf(type);
  out.angle = ((Math.round(num(raw.angle, -360, 360, type === 'herringbone' ? 45 : 0) / step) * step) % 360 + 360) % 360;
  out.joint = r3(num(raw.joint, 0, 2, JOINT[type]));
  const jc = hex(raw.joint_color);
  if (jc) out.joint_color = jc;
  const colors = hexes(raw.colors);
  if (colors.length) out.colors = colors;
  out.vary = r3(num(raw.vary, 0, 1, type === 'stripes' || type === 'plaid' ? 0 : 0.2));
  const bevel = r3(num(raw.bevel, 0, 2, 0));
  if (bevel) out.bevel = bevel;
  if (type === 'planks' || type === 'tiles') {
    out.bond = raw.bond === 'random' || (raw.bond == null && type === 'planks') ? 'random' : r3(num(raw.bond, 0, 1, 0));
  }
  if (type === 'basketweave') out.strips = Math.round(num(raw.strips, 2, 6, 3));
  if (type === 'chevron') out.cut = num(raw.cut, 20, 70, 45);
  return out;
}

function cleanLayer(raw, why, where) {
  if (!LAYERS.includes(raw?.type)) { why.push(`${where}: layer type "${raw?.type}" isn't one of ${LAYERS.join(', ')}; left out.`); return null; }
  const d = LAYER_DEFAULTS[raw.type];
  const out = { type: raw.type };
  const c = hex(raw.color);
  if (c) out.color = c;
  const colors = hexes(raw.colors);
  if (colors.length) out.colors = colors;
  out.amount = r3(num(raw.amount, 0, 1, d.amount));
  out.scale = r3(num(raw.scale, 0.01, 120, d.scale));
  out.depth = r3(num(raw.depth, -1, 1, d.depth));
  const rough = num(raw.rough, -1, 1, d.rough);
  if (rough) out.rough = r3(rough);
  if (raw.type === 'grain') {
    out.wave = r3(num(raw.wave, 0, 1, d.wave));
    out.figure = raw.figure === 'cathedral' ? 'cathedral' : 'straight';
    out.knots = r3(num(raw.knots, 0, 1, d.knots));
  }
  if (raw.type === 'veins') {
    out.width = r3(num(raw.width, 0.005, 6, d.width));
    out.angle = num(raw.angle, -360, 360, d.angle);
    out.turbulence = r3(num(raw.turbulence, 0, 1, d.turbulence));
  }
  if (raw.type === 'speckle' || raw.type === 'pits') out.vary = r3(num(raw.vary, 0, 1, d.vary));
  if (raw.type === 'weave') out.twill = !!raw.twill;
  return out;
}

// One texture. `used` holds ids taken already; `why` collects what was
// changed or left out, as sentences an agent can act on.
export function cleanTexture(raw, used = new Set(), why = []) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, TEXTURE_LIMITS.name) || 'Texture';
  let id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : slug(name) || 'texture';
  if (!ID.test(id)) id = 'texture';
  for (let k = 2, stem = id; used.has(id); k++) id = `${stem.slice(0, 20)}-${k}`;
  used.add(id);
  const where = `Texture ${id}`;
  const use = USES.includes(raw.for) ? raw.for : 'other';
  const base = hex(raw.base) ?? hexes(raw.pattern?.colors)[0] ?? '#b5aa9a';
  const out = { id, name, for: use, base, pattern: cleanPattern(raw.pattern ?? {}, why, where) };
  const about = text(raw.about, TEXTURE_LIMITS.about);
  if (about) out.about = about;
  const layers = Array.isArray(raw.layers) ? raw.layers : [];
  if (layers.length > TEXTURE_LIMITS.layers) why.push(`${where}: only ${TEXTURE_LIMITS.layers} layers fit; the rest were left out.`);
  out.layers = layers.slice(0, TEXTURE_LIMITS.layers).map((l, i) => cleanLayer(l, why, `${where} layer ${i + 1}`)).filter(Boolean);
  const f = raw.finish ?? {};
  out.finish = {
    roughness: r3(num(f.roughness, 0.02, 1, ROUGH[use])),
    relief: r3(num(f.relief, 0, 1, 0.5)),
  };
  const sheen = r3(num(f.sheen, 0, 1, 0));
  if (sheen) out.finish.sheen = sheen;
  const metal = r3(num(f.metal, 0, 1, 0));
  if (metal) out.finish.metal = metal;
  const repeat = num(raw.repeat, 2, 120, null);
  if (repeat) out.repeat = r3(repeat);
  return out;
}

export function cleanTextures(list, why = []) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > TEXTURE_LIMITS.textures) why.push(`Only ${TEXTURE_LIMITS.textures} textures fit; the rest were left out.`);
  const used = new Set();
  return arr.slice(0, TEXTURE_LIMITS.textures).map((t) => cleanTexture(t, used, why)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Noise. Value noise on an integer lattice, optionally periodic (px, py cells),
// so a surface with no pieces still tiles.

function hash(x, y, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const wrap = (i, p) => (p ? ((i % p) + p) % p : i);

function vnoise(x, y, s, px, py) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = wrap(xi, px), x1 = wrap(xi + 1, px), y0 = wrap(yi, py), y1 = wrap(yi + 1, py);
  const a = hash(x0, y0, s), b = hash(x1, y0, s), c = hash(x0, y1, s), d = hash(x1, y1, s);
  return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
}

function fbm(x, y, s, octaves = 4, px = 0, py = 0) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let k = 0; k < octaves; k++) {
    sum += amp * vnoise(x, y, s + k * 131, px, py);
    norm += amp; x *= 2; y *= 2; px *= 2; py *= 2; amp *= 0.5;
  }
  return sum / norm;
}

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const rgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const toHex = (c) => '#' + c.map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// ---------------------------------------------------------------------------
// Patterns: where a point of the surface falls. Each returns, for a point
// (u, v) in inches in the pattern's own frame, the piece it's in (`cx`, `cy`:
// its center, for telling pieces apart; `along`, `across`: the point in the
// piece's frame, along its length; `edge`: how far in from its edge) and the
// repeat [ru, rv] it tiles over. Surface patterns (none, stripes, plaid)
// have one piece, and say which color a point takes.

const SQRT2 = Math.SQRT2, SQRT3 = Math.sqrt(3);
const atLeast = (step, target) => step * Math.max(1, Math.round(target / step));
// The smallest number of rows after which a row offset of `bond` (a fraction)
// comes round again, so an offset pattern still tiles.
function bondRows(bond) {
  if (bond === 'random' || !bond) return 1;
  for (let q = 1; q <= 12; q++) if (Math.abs(q * bond - Math.round(q * bond)) < 0.02) return q;
  return 12;
}

function layout(p, target) {
  const type = p.type;
  const [a = 1, b = a] = p.size ?? [];
  if (type === 'planks' || type === 'tiles') {
    // a: width (row height), b: length, for planks; a × b tiles, b tall.
    const [len, wid] = type === 'planks' ? [b, a] : [a, b];
    const q = bondRows(p.bond), seedRows = q;
    return {
      cell: [len, wid * q], diag: type === 'tiles' && a === b && !p.bond ? [SQRT2 * a, SQRT2 * a] : null,
      at(u, v) {
        // Random offsets come round with the repeat (span: its size in this frame).
        const r = Math.floor(v / wid), rows = Math.max(1, Math.round(this.span[1] / wid));
        const off = p.bond === 'random' ? hash(wrap(r, rows), 7, 99) * len : ((r % seedRows) * p.bond % 1) * len;
        const x = u - off, c = Math.floor(x / len);
        const along = x - c * len, across = v - r * wid;
        return { cx: c * len + len / 2 + off, cy: r * wid + wid / 2, along, across, len, wid, edge: Math.min(along, len - along, across, wid - across) };
      },
    };
  }
  if (type === 'checker') {
    return {
      cell: [2 * a, 2 * a], diag: [SQRT2 * a, SQRT2 * a],
      at(u, v) {
        const i = Math.floor(u / a), j = Math.floor(v / a), along = u - i * a, across = v - j * a;
        return { cx: i * a + a / 2, cy: j * a + a / 2, along, across, len: a, wid: a, edge: Math.min(along, a - along, across, a - across), index: (i + j) & 1 };
      },
    };
  }
  if (type === 'herringbone') {
    // Planks a wide and n·a long, in staircases (H_k, V_k) that fill the band
    // 0 <= x - y < 2n (in plank widths); bands repeat every (2n, 0).
    // Turned 45°, (1, 1) and (2n, 0) become (0, √2) and (√2·n, 0): it tiles
    // over a rectangle again.
    const n = Math.round(b / a);
    return {
      cell: [2 * n * a, 2 * n * a], diag: [SQRT2 * n * a, SQRT2 * a],
      at(u, v) {
        // By the grid cell the point is in: cells (k+i, k) are H_k, (k+n, k-n+1+j) V_k.
        const x = u / a, y = v / a, X = Math.floor(x), Y = Math.floor(y);
        const m = Math.floor((X - Y) / (2 * n)), xx = x - m * 2 * n, dd = X - m * 2 * n - Y;
        let along, across, cx, cy;
        if (dd < n) {
          along = xx - Y; across = y - Y; cx = m * 2 * n + Y + n / 2; cy = Y + 0.5;
        } else {
          const k = X - m * 2 * n - n;
          along = y - (k - n + 1); across = xx - (k + n); cx = m * 2 * n + k + n + 0.5; cy = k - n + 1 + n / 2;
        }
        return { cx: cx * a, cy: cy * a, along: along * a, across: across * a, len: n * a, wid: a, edge: Math.min(along, n - along, across, 1 - across) * a };
      },
    };
  }
  if (type === 'chevron') {
    // Columns L·cos(cut) wide, planks slanting up and down by turns, their
    // ends cut to meet on the column lines.
    const cut = (p.cut * Math.PI) / 180, col = b * Math.cos(cut), hs = a / Math.cos(cut), tan = Math.tan(cut);
    return {
      cell: [2 * col, hs],
      at(u, v) {
        const c = Math.floor(u / col), x = u - c * col, t = c & 1 ? col - x : x;
        const s = v - t * tan, r = Math.floor(s / hs);
        const along = x / Math.cos(cut), across = (s - r * hs) * Math.cos(cut);
        return { cx: c * col + col / 2, cy: r * hs + hs / 2 + (col / 2) * tan, along: c & 1 ? b - along : along, across, len: b, wid: a, edge: Math.min(along, b - along, across, a - across) };
      },
    };
  }
  if (type === 'basketweave') {
    const n = p.strips, blk = n * a;
    return {
      cell: [2 * blk, 2 * blk],
      at(u, v) {
        const bi = Math.floor(u / blk), bj = Math.floor(v / blk), lu = u - bi * blk, lv = v - bj * blk;
        const flat = ((bi + bj) & 1) === 0;
        const s = Math.floor((flat ? lv : lu) / a);
        const along = flat ? lu : lv, across = (flat ? lv : lu) - s * a;
        const cx = flat ? bi * blk + blk / 2 : bi * blk + s * a + a / 2, cy = flat ? bj * blk + s * a + a / 2 : bj * blk + blk / 2;
        return { cx, cy, along, across, len: blk, wid: a, edge: Math.min(along, blk - along, across, a - across), turn: !flat };
      },
    };
  }
  if (type === 'hexagons') {
    // Pointy-top hexagons a across the flats.
    const rh = (a * SQRT3) / 2, R = a / SQRT3;
    return {
      cell: [a, 2 * rh],
      at(u, v) {
        const r0 = Math.round(v / rh);
        let best = null, bd = Infinity;
        for (let r = r0 - 1; r <= r0 + 1; r++) {
          const off = r & 1 ? a / 2 : 0, c = Math.round((u - off) / a);
          for (let k = c - 1; k <= c + 1; k++) {
            const x = k * a + off, y = r * rh, d = (u - x) ** 2 + (v - y) ** 2;
            if (d < bd) { bd = d; best = [x, y]; }
          }
        }
        const dx = u - best[0], dy = v - best[1];
        const reach = Math.max(Math.abs(dx), Math.abs(dx * 0.5 + dy * (SQRT3 / 2)), Math.abs(dx * 0.5 - dy * (SQRT3 / 2)));
        return { cx: best[0], cy: best[1], along: dx + a / 2, across: dy + R, len: a, wid: 2 * R, edge: a / 2 - reach };
      },
    };
  }
  if (type === 'stripes' || type === 'plaid') {
    const widths = p.size, period = widths.reduce((s, w) => s + w, 0);
    const band = (s) => {
      let x = ((s % period) + period) % period;
      for (let i = 0; i < widths.length; i++) { if (x < widths[i]) return [i, Math.min(x, widths[i] - x)]; x -= widths[i]; }
      return [widths.length - 1, 0];
    };
    return { cell: [period, period], diag: [SQRT2 * period, SQRT2 * period], surface: true, at: (u, v) => ({ band: band(v), cross: type === 'plaid' ? band(u) : null }) };
  }
  return { cell: [target, target], diag: null, surface: true, at: () => ({}) };
}

// Turns a pattern can take and still tile: quarter turns, and for some an
// eighth (herringbone, checker, square tiles, stripes and plaid).
export const turnsOf = (type) => (['herringbone', 'checker', 'tiles', 'stripes', 'plaid'].includes(type) ? 45 : 90);

// The pattern turned to its angle: the repeat it tiles over in the surface's
// own frame (u, v), several of its cells so pieces don't repeat too soon.
function frame(P, target) {
  const pat = layout(P, target);
  let turn = ((Math.round((P.angle ?? 0) / 45) % 8) + 8) % 8;
  if (turn % 2 && !pat.diag) turn -= 1;
  const swap = turn % 4 === 2 || turn % 4 === 3;
  const cell = turn % 2 ? pat.diag : pat.cell;
  const [su, sv] = swap ? [cell[1], cell[0]] : cell;
  const repeat = [atLeast(su, target), atLeast(sv, target)];
  return { ...pat, turn, swap, repeat, span: swap ? [repeat[1], repeat[0]] : repeat };
}

// The repeat a recipe tiles over, in inches [u, v].
export function repeatOf(t) {
  return frame(t.pattern, t.repeat ?? TARGET[t.for] ?? 24).repeat.map(r3);
}

// ---------------------------------------------------------------------------
// Layers. Each is set up once for a render, then asked per point: in a
// piece's frame (x along it, y across, a seed of its own) or, with no pieces,
// across the whole surface, periodic over the repeat [pu, pv].

function makeLayer(L, ctx) {
  const { surface, ru, rv, seed } = ctx;
  const s = seed + LAYERS.indexOf(L.type) * 1009;
  // A lattice step close to `scale` that divides the repeat, for surface layers.
  const fit = (scale, r) => (surface ? r / Math.max(1, Math.round(r / scale)) : scale);
  const sx = fit(L.scale, ru), sy = fit(L.scale, rv);
  const per = (scale, r) => (surface ? Math.max(1, Math.round(r / scale)) : 0);
  const color = rgb(L.color ?? '#000000');
  const colors = (L.colors ?? (L.color ? [L.color] : [])).map(rgb);

  if (L.type === 'mottle') {
    const px = per(L.scale, ru), py = per(L.scale, rv);
    return (x, y) => {
      const n = fbm(x / sx, y / sy, s, 5, px, py);
      return [L.color ? color : null, L.amount * smooth(-0.15, 0.6, n), L.color ? 0 : n * L.amount * 0.35];
    };
  }
  if (L.type === 'noise') {
    const px = per(L.scale, ru), py = per(L.scale, rv);
    return (x, y) => {
      const n = fbm(x / sx, y / sy, s, 3, px, py);
      return L.color ? [color, L.amount * (0.5 + 0.5 * n), 0] : [null, 0, n * L.amount * 0.5, n];
    };
  }
  if (L.type === 'grain') {
    // Lines every `scale` across the piece, wavering along it; cathedral
    // figure bends them into arches. Fine fibres run between.
    const k = surface ? Math.max(1, Math.round(rv / L.scale)) : 0, sp = surface ? rv / k : L.scale;
    const pu = surface ? Math.max(1, Math.round(ru / (sp * 24))) : 0, pv = surface ? Math.max(1, Math.round(rv / (sp * 4))) : 0;
    const su = surface ? ru / pu : sp * 24, sv = surface ? rv / pv : sp * 4;
    const fu = surface ? Math.max(1, Math.round(ru / (sp * 40))) : 0, fv = surface ? Math.max(1, Math.round(rv / (sp * 0.35))) : 0;
    const gu = surface ? ru / fu : sp * 40, gv = surface ? rv / fv : sp * 0.35;
    return (x, y, piece) => {
      let q = y + L.wave * sp * 2.5 * fbm(x / su, y / sv, s, 3, pu, pv);
      if (L.figure === 'cathedral') {
        const len = piece?.len ?? ru, mid = piece ? len / 2 : 0;
        q += surface ? Math.cos((2 * Math.PI * x) / ru) * sp * 3 : (((x - mid) / len) ** 2) * sp * 14;
      }
      let knot = 0;
      if (L.knots > 0 && piece) {
        const kx = piece.len * (0.2 + 0.6 * hash(piece.id, 3, s)), ky = piece.wid * (0.25 + 0.5 * hash(piece.id, 5, s));
        if (hash(piece.id, 11, s) < L.knots) {
          const d = Math.hypot((x - kx) / 2.2, y - ky), r = Math.min(piece.wid * 0.18, 0.6);
          q += (r * r * 3) / (d + r);
          knot = 1 - smooth(r * 0.35, r * 0.7, d);
        }
      }
      const ring = (0.5 + 0.5 * Math.sin((2 * Math.PI * q) / sp)) ** 5;
      const fibre = 0.5 + 0.5 * fbm(x / gu, y / gv, s + 7, 2, fu, fv);
      const w = clamp(L.amount * (0.75 * ring + 0.25 * fibre) + knot * 0.9);
      return [color, w, 0, w];
    };
  }
  if (L.type === 'veins') {
    // Bands of width `width` every `scale`, turned to `angle` and pushed about
    // by turbulence: marble.
    const a = (L.angle * Math.PI) / 180;
    let kx, ky;
    if (surface) {
      kx = Math.round((-Math.sin(a) * ru) / L.scale); ky = Math.round((Math.cos(a) * rv) / L.scale);
      if (!kx && !ky) ky = 1;
    }
    const ts = L.scale * 0.9, tpu = per(ts, ru), tpv = per(ts, rv), tsu = fit(ts, ru), tsv = fit(ts, rv);
    return (x, y) => {
      const base = surface ? (kx * x) / ru + (ky * y) / rv : (-x * Math.sin(a) + y * Math.cos(a)) / L.scale;
      const q = base + L.turbulence * 1.6 * fbm(x / tsu, y / tsv, s, 5, tpu, tpv);
      const d = Math.abs(q - Math.round(q)) * L.scale;
      const w = L.amount * (1 - smooth(L.width * 0.25, L.width * 0.25 + L.width, d));
      return [color, w, 0, w];
    };
  }
  if (L.type === 'speckle' || L.type === 'pits') {
    // A jittered grid of cells, `scale` apart; a share (amount) of them holds a
    // chip of about `scale` across. Pits are stretched along the surface.
    const cell = L.scale * (L.type === 'pits' ? 2.2 : 1.25);
    const nu = surface ? Math.max(1, Math.round(ru / cell)) : 0, nv = surface ? Math.max(1, Math.round(rv / cell)) : 0;
    const cu = surface ? ru / nu : cell, cv = surface ? rv / nv : cell;
    const stretch = L.type === 'pits' ? 2.4 : 1;
    const tint = colors.length ? colors : [L.type === 'pits' ? [0.25, 0.22, 0.2] : [0.1, 0.1, 0.1]];
    return (x, y) => {
      const i0 = Math.floor(x / cu), j0 = Math.floor(y / cv);
      let best = 0, pick = 0;
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        for (let i = i0 - 1; i <= i0 + 1; i++) {
          const wi = wrap(i, nu), wj = wrap(j, nv);
          if (hash(wi, wj, s) > L.amount) continue;
          const px = (i + hash(wi, wj, s + 1)) * cu, py = (j + hash(wi, wj, s + 2)) * cv;
          const r = (L.scale / 2) * (1 - L.vary * hash(wi, wj, s + 3));
          const dx = (x - px) / stretch, dy = y - py;
          const wob = 1 + 0.35 * vnoise(dx / r * 1.3 + wi * 7.1, dy / r * 1.3 + wj * 3.7, s + 4, 0, 0);
          const v = 1 - smooth(r * wob * 0.8, r * wob, Math.hypot(dx, dy));
          if (v > best) { best = v; pick = hash(wi, wj, s + 5); }
        }
      }
      return [tint[Math.floor(pick * tint.length) % tint.length], best, 0, best];
    };
  }
  if (L.type === 'weave') {
    // Threads `scale` wide: warp along u over weft along v, one over one
    // (plain) or two over two (twill); crevices shade between them.
    const rep = L.twill ? 4 : 2;
    const nu = surface ? Math.max(1, Math.round(ru / (L.scale * rep))) * rep : 0, nv = surface ? Math.max(1, Math.round(rv / (L.scale * rep))) * rep : 0;
    const tu = surface ? ru / nu : L.scale, tv = surface ? rv / nv : L.scale;
    return (x, y) => {
      const i = Math.floor(x / tu), j = Math.floor(y / tv), fu = x / tu - i, fv = y / tv - j;
      const warp = L.twill ? ((((i + j) % 4) + 4) % 4) < 2 : ((i + j) & 1) === 0;
      const prof = Math.sqrt(Math.sin(Math.PI * (warp ? fv : fu)));
      const slub = 0.92 + 0.16 * hash(wrap(warp ? j : i, warp ? nv : nu), warp ? 1 : 2, s);
      const h = prof * slub;
      return [warp || !L.color ? null : color, warp || !L.color ? 0 : L.amount, (h - 0.75) * L.amount * 0.6, h];
    };
  }
  return () => [null, 0, 0, 0];
}

// ---------------------------------------------------------------------------
// Drawing

// The surface, one repeat of it, `w` × `h` px: { w, h, inches, color (RGBA
// bytes, rows top to bottom with v up), height and rough (0–1 floats) }.
// `maxPx` caps the long side; `ppi` caps the detail (pixels per inch).
export function renderTexture(t, { maxPx = 512, ppi = 48 } = {}) {
  const job = startRender(t, { maxPx, ppi });
  while (!job.step(1e9));
  return job.out;
}

// The same, a few rows at a time: step(rows) draws that many and returns true
// when done, so a page can draw a big texture between frames.
export function startRender(t, { maxPx = 512, ppi = 48 } = {}) {
  const target = t.repeat ?? TARGET[t.for] ?? 24;
  const pat = frame(t.pattern, target);
  const [ru, rv] = pat.repeat;
  const k = Math.min(ppi, maxPx / Math.max(ru, rv));
  const w = Math.max(8, Math.round(ru * k)), h = Math.max(8, Math.round(rv * k));
  const out = { w, h, inches: [r3(ru), r3(rv)], color: new Uint8ClampedArray(w * h * 4), height: new Float32Array(w * h), rough: new Float32Array(w * h) };
  const P = t.pattern, surface = !!pat.surface;
  const seed = [...t.id].reduce((acc, ch) => Math.imul(acc ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0;
  const base = rgb(t.base);
  const colors = (P.colors?.length ? P.colors : [t.base]).map(rgb);
  const joint = rgb(P.joint_color ?? toHex(shade(base, 0.55)));
  // With no pieces, layers draw across the surface, turned a quarter if the
  // pattern is (grain running up a cabinet door).
  const turned = surface && pat.swap;
  const layers = t.layers.map((L) => ({ L, at: makeLayer(L, { surface, ru: turned ? rv : ru, rv: turned ? ru : rv, seed }) }));
  const ang = (pat.turn * Math.PI) / 4, ca = Math.cos(ang), sa = Math.sin(ang);
  // A joint stays at least a pixel wide, so thin ones don't vanish at a distance.
  const rough0 = t.finish.roughness, halfJoint = P.joint ? Math.max(P.joint / 2, 0.55 * (ru / w)) : 0, bevel = P.bevel ?? 0;
  let row = 0;

  function pixel(u, v) {
    // Into the pattern's frame, turned by its angle.
    const pu = u * ca + v * sa, pv = -u * sa + v * ca;
    const at = pat.at(pu, pv);
    let col, piece = null, lx = turned ? v : u, ly = turned ? u : v;
    if (surface) {
      if (at.band) {
        const ci = at.band[0] % colors.length;
        col = colors[ci];
        if (at.cross) col = mix(col, colors[at.cross[0] % colors.length], 0.5);
      } else col = base;
    } else {
      // Pieces are told apart by where their centers fall in the repeat.
      const cu = at.cx * ca - at.cy * sa, cv = at.cx * sa + at.cy * ca;
      const fu = cu / ru - Math.floor(cu / ru), fv = cv / rv - Math.floor(cv / rv);
      const id = (Math.round(fu * 4096) % 4096) * 73856093 ^ (Math.round(fv * 4096) % 4096) * 19349663;
      piece = { id, len: at.len, wid: at.wid };
      const pick = at.index != null ? at.index % colors.length : Math.floor(hash(id, 1, seed) * colors.length);
      col = colors[pick];
      if (P.vary) col = shade(col, 1 + (hash(id, 2, seed) - 0.5) * P.vary * 0.5);
      // Layers draw in the piece's frame, from a place of its own.
      lx = at.along + hash(id, 3, seed) * 500; ly = at.across + hash(id, 4, seed) * 500;
    }
    let hgt = 0.6, rough = rough0;
    for (const { L, at: draw } of layers) {
      const [c, wgt, lit = 0, mark = wgt] = draw(lx, ly, piece);
      if (c && wgt > 0) col = mix(col, c, wgt);
      if (lit) col = shade(col, 1 + lit);
      hgt += L.depth * 0.3 * mark;
      if (L.rough) rough += L.rough * mark;
    }
    if (!surface && at.edge !== undefined) {
      if (at.edge < halfJoint) {
        const soft = smooth(halfJoint * 0.6, halfJoint, at.edge);
        col = mix(joint, col, soft * 0.4);
        hgt = 0.15 + hgt * soft * 0.3;
        rough = Math.min(1, rough0 + 0.3);
      } else if (bevel > 0 && at.edge < halfJoint + bevel) {
        const f = (at.edge - halfJoint) / bevel;
        hgt = 0.15 + (hgt - 0.15) * Math.sin((f * Math.PI) / 2);
      }
    }
    return [col, clamp(hgt), clamp(rough, 0.02, 1)];
  }

  return {
    out,
    // One point of the surface, (u, v) in inches: [rgb 0–1, height, roughness],
    // and the repeat it tiles over, unrounded.
    at: pixel, repeat: [ru, rv],
    step(rows) {
      const end = Math.min(h, row + rows);
      for (; row < end; row++) {
        const v = rv * (1 - (row + 0.5) / h);
        for (let x = 0; x < w; x++) {
          const [c, hg, rg] = pixel(ru * ((x + 0.5) / w), v);
          const i = row * w + x;
          out.color[i * 4] = c[0] * 255; out.color[i * 4 + 1] = c[1] * 255; out.color[i * 4 + 2] = c[2] * 255; out.color[i * 4 + 3] = 255;
          out.height[i] = hg; out.rough[i] = rg;
        }
      }
      return row >= h;
    },
  };
}

// The color picture lit from the upper left by its own relief, the way it
// reads on a surface: for previews, and for comparing with a photo.
// Height 0–1 stands `relief` × 0.3 in (src/materials.js uses the same), so
// slopes and the shading come out as they will on the surface.
export function litColor({ w, h, color, height, inches }, relief = 0.5) {
  const out = new Uint8ClampedArray(color.length);
  const k = relief * 0.15 * (w / inches[0]);
  for (let y = 0; y < h; y++) {
    const up = ((y + h - 1) % h) * w, dn = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const l = (x + w - 1) % w, r = (x + 1) % w, i = y * w + x;
      const dx = height[y * w + r] - height[y * w + l], dy = height[dn + x] - height[up + x];
      // Lit from the upper left: rising to the right or downward faces the light.
      const lit = clamp(1 + k * (dx * 0.6 + dy * 0.8) * 0.9, 0.6, 1.3);
      for (let c = 0; c < 3; c++) out[i * 4 + c] = color[i * 4 + c] * lit;
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

// `rgba` tiled out to `w` × `h` px covering `inches` [u, v] of the surface,
// from a picture `tw` × `th` px covering `tin` inches: a patch of the surface
// bigger than one repeat.
export function tileOut(rgba, tw, th, tin, inches, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((((y + 0.5) / h) * inches[1] / tin[1]) * th) % th;
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((((x + 0.5) / w) * inches[0] / tin[0]) * tw) % tw;
      const i = (y * w + x) * 4, j = (sy * tw + sx) * 4;
      out[i] = rgba[j]; out[i + 1] = rgba[j + 1]; out[i + 2] = rgba[j + 2]; out[i + 3] = 255;
    }
  }
  return out;
}

// A patch of the surface `inches` wide, `px` px wide, lit: what previews and
// comparisons look at.
export function patch(t, { inches = null, px = 384 } = {}) {
  const side = inches ?? Math.min(96, (t.repeat ?? TARGET[t.for] ?? 24) * 0.75);
  const ppi = px / side;
  const r = renderTexture(t, { maxPx: Math.max(64, Math.ceil(Math.max(...repeatOf(t)) * ppi)), ppi });
  const lit = litColor(r, t.finish.relief);
  return { w: px, h: px, inches: side, rgba: tileOut(lit, r.w, r.h, r.inches, [side, side], px, px) };
}

// ---------------------------------------------------------------------------
// Measuring: a picture's colors in CIELAB, so a photo and a texture can be
// compared the way they look.

function lab(r, g, b) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// { mean, lab, contrast, palette: [{ color, share }] } of an RGBA picture.
// The palette is the picture's main colors (k-means in Lab), biggest first.
export function imageStats(rgba, w, h, k = 5) {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4096)));
  const px = [], cols = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4;
    if (rgba[i + 3] < 128) continue;
    const c = [rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255];
    cols.push(c); px.push(lab(...c));
  }
  const n = px.length;
  const mean = [0, 0, 0], meanRgb = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { mean[c] += px[i][c] / n; meanRgb[c] += cols[i][c] / n; }
  let varL = 0;
  for (const p of px) varL += (p[0] - mean[0]) ** 2 / n;
  // k-means from lightness quantiles, so it comes out the same every time.
  const order = px.map((p, i) => i).sort((a, b) => px[a][0] - px[b][0]);
  let centers = Array.from({ length: k }, (_, j) => px[order[Math.min(n - 1, Math.floor(((j + 0.5) / k) * n))]].slice());
  const owner = new Int32Array(n);
  for (let it = 0; it < 10; it++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) { const d = dE(px[i], centers[j]); if (d < bd) { bd = d; best = j; } }
      owner[i] = best;
      const s = sum[best]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++;
    }
    centers = centers.map((c, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c));
  }
  const groups = centers.map(() => ({ rgb: [0, 0, 0], count: 0 }));
  for (let i = 0; i < n; i++) { const g = groups[owner[i]]; for (let c = 0; c < 3; c++) g.rgb[c] += cols[i][c]; g.count++; }
  const palette = groups.map((g, j) => ({ color: toHex(g.rgb.map((v) => v / Math.max(1, g.count))), share: g.count / n, lab: centers[j] }))
    .filter((p) => p.share >= 0.02).sort((a, b) => b.share - a.share);
  return { mean: toHex(meanRgb), lab: mean.map((v) => Math.round(v * 10) / 10), contrast: Math.round(Math.sqrt(varL) * 10) / 10, palette };
}

const pal = (p) => p.map(({ color, share }) => ({ color, share: Math.round(share * 100) / 100 }));

// How a texture's picture compares with a photo's: the differences in plain
// numbers, a 0–100 match, and what to change, as sentences.
export function compareStats(photo, tex) {
  const [pl, pa, pb] = photo.lab, [tl, ta, tb] = tex.lab;
  const hints = [];
  const dl = tl - pl, db = tb - pb, da = ta - pa;
  if (Math.abs(dl) >= 3) hints.push(`The texture is ${dl > 0 ? 'lighter' : 'darker'} than the photo by ${Math.abs(Math.round(dl))} (L*, 0–100): ${dl > 0 ? 'darken' : 'lighten'} base and the pattern's colors.`);
  if (Math.abs(db) >= 3) hints.push(`It is ${db > 0 ? 'yellower (warmer)' : 'bluer (cooler)'} than the photo by ${Math.abs(Math.round(db))} (b*).`);
  if (Math.abs(da) >= 3) hints.push(`It is ${da > 0 ? 'redder' : 'greener'} than the photo by ${Math.abs(Math.round(da))} (a*).`);
  const ratio = tex.contrast / Math.max(0.5, photo.contrast);
  if (ratio > 1.3) hints.push(`It has more contrast than the photo (${tex.contrast} against ${photo.contrast}): bring the colors closer together or lower layer amounts.`);
  else if (ratio < 0.75) hints.push(`It is flatter than the photo (${tex.contrast} against ${photo.contrast} contrast): spread the colors further apart or raise layer amounts.`);
  let palette = 0, weight = 0;
  for (const p of photo.palette) {
    const near = tex.palette.reduce((best, q) => (dE(p.lab, q.lab) < best.d ? { d: dE(p.lab, q.lab), q } : best), { d: Infinity, q: null });
    palette += near.d * p.share; weight += p.share;
    if (p.share >= 0.12 && near.d > 10) hints.push(`The photo has ${p.color} (${Math.round(p.share * 100)}% of it) that the texture lacks; its nearest is ${near.q?.color ?? 'none'} (ΔE ${Math.round(near.d)}).`);
  }
  palette /= Math.max(1e-6, weight);
  const meanDiff = dE(photo.lab, tex.lab);
  const match = Math.round(clamp(1 - (meanDiff * 0.6 + palette * 0.4 + Math.abs(Math.log(ratio)) * 12) / 40) * 100);
  if (!hints.length) hints.push('Colors and contrast match the photo closely. Compare the pattern\'s scale and shapes by eye.');
  return {
    match,
    photo: { mean: photo.mean, contrast: photo.contrast, palette: pal(photo.palette) },
    texture: { mean: tex.mean, contrast: tex.contrast, palette: pal(tex.palette) },
    difference: { mean_dE: Math.round(meanDiff * 10) / 10, palette_dE: Math.round(palette * 10) / 10, lightness: Math.round(dl * 10) / 10, contrast_ratio: Math.round(ratio * 100) / 100 },
    hints,
  };
}

// ---------------------------------------------------------------------------
// Built-in finishes drawn from recipes (src/materials.js), and worked examples
// for an agent writing its own (get_catalog's texture_examples).

export const PRESETS = {
  chevron: {
    name: 'Oak chevron', for: 'floor', base: '#b08a60',
    about: 'Natural oak, 3½" by 21" planks cut at 45° and laid in a chevron.',
    pattern: { type: 'chevron', size: [3.5, 21], cut: 45, colors: ['#b08a60', '#a57f56', '#bb946a', '#9f784f'], vary: 0.2, joint: 0.04, joint_color: '#6f5137' },
    layers: [{ type: 'grain', color: '#7c5a39', amount: 0.42, scale: 0.2, wave: 0.45, figure: 'cathedral', knots: 0.06 }, { type: 'noise', amount: 0.12, scale: 0.05 }],
    finish: { roughness: 0.55, relief: 0.4 },
  },
  checker: {
    name: 'Marble checkerboard', for: 'floor', base: '#ecebe6',
    about: 'Twelve-inch white and nero marble squares, set on the diagonal.',
    pattern: { type: 'checker', size: [12], angle: 45, colors: ['#ecebe6', '#2b2b2c'], joint: 0.06, joint_color: '#a3a19b' },
    layers: [{ type: 'mottle', color: '#d6d5d0', amount: 0.35, scale: 10 }, { type: 'veins', color: '#9c9c99', amount: 0.45, scale: 7, width: 0.04, angle: 40, turbulence: 0.8 }],
    finish: { roughness: 0.25, relief: 0.35 },
  },
  soapstone: {
    name: 'Soapstone', for: 'counter', base: '#4a4f4e',
    about: 'Honed charcoal soapstone with soft pale-green veins.',
    pattern: { type: 'none' },
    layers: [{ type: 'mottle', color: '#3c4140', amount: 0.5, scale: 16 }, { type: 'veins', color: '#7d8a84', amount: 0.55, scale: 11, width: 0.05, angle: 25, turbulence: 0.75 }, { type: 'veins', color: '#626d68', amount: 0.4, scale: 4, width: 0.025, angle: -35, turbulence: 0.9 }],
    finish: { roughness: 0.45, relief: 0.1 },
  },
  'herringbone-tile': {
    name: 'Herringbone marble tile', for: 'tile', base: '#efeeea',
    about: 'White marble 2" by 8" tiles in a herringbone, light gray grout.',
    pattern: { type: 'herringbone', size: [2, 8], angle: 45, colors: ['#efeeea', '#e6e5e0', '#f4f3ef'], vary: 0.15, joint: 0.1, joint_color: '#cdcac3', bevel: 0.06 },
    layers: [{ type: 'veins', color: '#a9aaa8', amount: 0.4, scale: 3, width: 0.03, angle: 30, turbulence: 0.85 }],
    finish: { roughness: 0.18, relief: 0.4 },
  },
  // Examples only, for the agent.
  linen: {
    name: 'Oatmeal linen', for: 'fabric', base: '#c8bda9',
    about: 'Plain-woven linen with slubby, uneven threads.',
    pattern: { type: 'none' },
    layers: [{ type: 'weave', amount: 0.7, scale: 0.03 }, { type: 'noise', amount: 0.25, scale: 0.4 }, { type: 'mottle', amount: 0.2, scale: 3 }],
    finish: { roughness: 0.95, relief: 0.6 },
  },
  terrazzo: {
    name: 'Venetian terrazzo', for: 'floor', base: '#e7e1d6',
    about: 'Cream terrazzo: half-inch chips of red, slate blue and ochre in fine gray aggregate.',
    pattern: { type: 'none' },
    layers: [{ type: 'speckle', colors: ['#b85c43', '#46606f', '#cf9f45', '#8d8984', '#f5f2ec'], amount: 0.4, scale: 0.5, vary: 0.7 }, { type: 'speckle', colors: ['#9b9189', '#6f655d'], amount: 0.55, scale: 0.1 }],
    finish: { roughness: 0.3, relief: 0.2 },
  },
};
// The presets the app itself uses as finishes.
export const BUILT_IN = ['chevron', 'checker', 'soapstone', 'herringbone-tile'];
export const preset = (key) => cleanTexture({ id: key, ...PRESETS[key] });

// The recipe format in brief, for a Claude asked from the page itself (src/match.js),
// which has no tool schema to read. The agent's create_texture says the same at length.
export const RECIPE_GUIDE = `A texture recipe is JSON. Sizes are real, in inches; colors "#rrggbb".
{
  "name": "Short name", "for": one of ${USES.join(', ')},
  "base": "#rrggbb"  (the overall color, or what shows between what the layers draw),
  "pattern": {
    "type": one of ${PATTERNS.join(', ')},
    "size": inches. planks, herringbone, chevron: [width, length]; tiles: [width, height]; checker, hexagons (across the flats): [width]; basketweave: [strip width]; stripes, plaid: each band's width in turn,
    "colors": ["#..", ...] each piece takes one at random (in order for checker, stripes, plaid); give 2 to 4 close colors for natural variation,
    "vary": 0-1 extra lightness variation per piece (default 0.2),
    "joint": grout or gap width in inches, "joint_color": "#..", "bevel": inches of rounded edge,
    "bond": planks and tiles row offset as a fraction of the length (0.5 running bond) or "random",
    "angle": quarter turns; 45 for herringbone (default), checker (diamonds), square tiles, stripes, plaid,
    "strips": basketweave strips per block, "cut": chevron cut angle in degrees
  },
  "layers": [ drawn in order inside each piece, in its own frame (grain runs along each plank). Each: {"type", "color", "amount" 0-1, "scale" inches, "depth" -1..1 relief, "rough" -1..1}
    mottle: soft clouds (color, or lighter/darker without one); scale = cloud size.
    grain: wood grain; scale = inches between grain lines (0.1-0.4), "wave" 0-1, "figure": "straight" or "cathedral", "knots" 0-1.
    veins: marble veins; "width" inches, scale = inches between veins, "angle" degrees, "turbulence" 0-1.
    speckle: chips; "colors" list, scale = chip size, amount = how many, "vary" size variation. Granite, terrazzo, quartz.
    pits: small holes (travertine, concrete); scale = hole size.
    noise: fine grit; scale = grain size.
    weave: threads; scale = thread width (0.02-0.1), "twill": true for diagonal weave. Fabric, rugs, cane.
  ],
  "finish": {"roughness": 0.02 polished to 1 matte, "relief": 0-1 how deep joints and grain read, "sheen": 0-1 velvet, "metal": 0-1}
}
Example: ${JSON.stringify(PRESETS.chevron)}
Example: ${JSON.stringify(PRESETS.terrazzo)}`;
