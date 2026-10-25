import * as THREE from 'three';
import { Batch, Frame } from './kit.js';

// Furniture you can place yourself. Catalog sizes are typical retail sizes in
// inches (width × depth × height); every piece can be resized after placing.
// Width runs side to side as you face the piece's front, depth runs back to
// front, so a bed's depth is its length.
export const CATALOG = [
  { type: 'sofa', name: 'Sofa', group: 'Living', w: 84, d: 36, h: 34 },
  { type: 'loveseat', name: 'Loveseat', group: 'Living', w: 64, d: 36, h: 34, build: 'sofa' },
  { type: 'sectional', name: 'Sectional', group: 'Living', w: 112, d: 84, h: 34 },
  { type: 'armchair', name: 'Armchair', group: 'Living', w: 34, d: 34, h: 32 },
  { type: 'ottoman', name: 'Ottoman', group: 'Living', w: 24, d: 24, h: 18 },
  { type: 'coffeetable', name: 'Coffee table', group: 'Living', w: 48, d: 24, h: 18 },
  { type: 'sidetable', name: 'Side table', group: 'Living', w: 20, d: 20, h: 24 },
  { type: 'tvstand', name: 'TV stand', group: 'Living', w: 60, d: 16, h: 22 },
  { type: 'tvstand-tv', name: 'TV stand + 55" TV', group: 'Living', w: 60, d: 16, h: 22, build: 'tvstand', tv: true },
  { type: 'bookshelf', name: 'Bookshelf', group: 'Living', w: 32, d: 12, h: 72 },
  { type: 'lamp', name: 'Floor lamp', group: 'Living', w: 14, d: 14, h: 62 },
  { type: 'rug-8x10', name: "Rug 8' × 10'", group: 'Living', w: 120, d: 96, h: 0.5, build: 'rug' },
  { type: 'rug-5x8', name: "Rug 5' × 8'", group: 'Living', w: 96, d: 60, h: 0.5, build: 'rug' },

  { type: 'table', name: 'Dining table', group: 'Dining', w: 60, d: 36, h: 30 },
  { type: 'roundtable', name: 'Round table', group: 'Dining', w: 42, d: 42, h: 30 },
  { type: 'chair', name: 'Dining chair', group: 'Dining', w: 18, d: 20, h: 34 },
  { type: 'bench', name: 'Bench', group: 'Dining', w: 48, d: 16, h: 18 },

  { type: 'bed-king', name: 'King bed', group: 'Bedroom', w: 80, d: 86, h: 48, build: 'bed' },
  { type: 'bed-queen', name: 'Queen bed', group: 'Bedroom', w: 64, d: 86, h: 48, build: 'bed' },
  { type: 'bed-full', name: 'Full bed', group: 'Bedroom', w: 58, d: 80, h: 44, build: 'bed' },
  { type: 'bed-twin', name: 'Twin bed', group: 'Bedroom', w: 42, d: 80, h: 40, build: 'bed' },
  { type: 'nightstand', name: 'Nightstand', group: 'Bedroom', w: 22, d: 16, h: 24 },
  { type: 'dresser', name: 'Dresser', group: 'Bedroom', w: 60, d: 18, h: 32 },
  { type: 'chest', name: 'Tall dresser', group: 'Bedroom', w: 36, d: 18, h: 48, build: 'dresser' },
  { type: 'desk', name: 'Desk', group: 'Bedroom', w: 48, d: 24, h: 30 },
  { type: 'officechair', name: 'Desk chair', group: 'Bedroom', w: 26, d: 26, h: 40 },

  { type: 'plant', name: 'Plant', group: 'Other', w: 18, d: 18, h: 48 },
  { type: 'box', name: 'Custom piece', group: 'Other', w: 36, d: 24, h: 30 },
];
export const catalogByType = Object.fromEntries(CATALOG.map((c) => [c.type, c]));

// Color choices. `null` keeps each piece's own finish.
export const SWATCHES = [
  { key: null, name: 'Default', css: 'conic-gradient(#8e8984 0 25%, #7b5a3e 0 50%, #e9e5dd 0 75%, #5f5b56 0)' },
  { key: 'oak', name: 'Light oak', css: '#c9a170' },
  { key: 'walnut', name: 'Walnut', css: '#6e4e35' },
  { key: 'white', name: 'White', hex: 0xf1efea },
  { key: 'black', name: 'Black', hex: 0x232323 },
  { key: 'gray', name: 'Gray', hex: 0x8e8984 },
  { key: 'charcoal', name: 'Charcoal', hex: 0x4f4c48 },
  { key: 'beige', name: 'Beige', hex: 0xd6cbb8 },
  { key: 'navy', name: 'Navy', hex: 0x2f3d56 },
  { key: 'sage', name: 'Sage', hex: 0x8b9a7e },
  { key: 'rust', name: 'Rust', hex: 0xa85c3f },
];

const colorCache = new Map();
function swatchMaterial(M, key) {
  if (key === 'oak') return M.oak;
  if (key === 'walnut') return M.walnut;
  const s = SWATCHES.find((x) => x.key === key);
  if (!s?.hex) return null;
  if (!colorCache.has(key)) colorCache.set(key, new THREE.MeshStandardMaterial({ color: s.hex, roughness: 0.85 }));
  return colorCache.get(key);
}

// ---------------------------------------------------------------------------
// Builders work in the piece's frame: s across (centered), t from the back (0)
// to the front (d), y up; sizes in feet. `m` is the piece's main material.
function legs(B, mat, F, w, d, h, inset = 0.12, r = 0.035) {
  for (const s of [-w / 2 + inset, w / 2 - inset]) for (const t of [inset, d - inset]) {
    const [x, z] = F.p(s, t);
    B.cyl(mat, x, 0, z, r, h, 10);
  }
}

const BUILDERS = {
  bed(B, M, F, w, d, h, m) {
    const main = m ?? M.headboard;
    legs(B, M.black, F, w - 0.1, d, 0.35, 0.2);
    F.box(B, main, -w / 2, 0.3, 0.25, w / 2, 1.05, d);
    F.box(B, main, -w / 2, 0.3, 0, w / 2, h, 0.28);
    F.box(B, M.linen, -w / 2 + 0.1, 1.05, 0.3, w / 2 - 0.1, 1.9, d - 0.05);
    F.box(B, M.duvet, -w / 2 + 0.02, 1.25, 1.75, w / 2 - 0.02, 1.98, d + 0.02);
    F.box(B, M.cushion, -w / 2 + 0.12, 1.92, 1.75, w / 2 - 0.12, 2.0, Math.min(d - 0.3, 2.6));
    const n = w > 4 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const s0 = -w / 2 + 0.12 + (i * (w - 0.24)) / n, s1 = s0 + (w - 0.24) / n;
      F.box(B, M.linen, s0 + 0.06, 1.9, 0.38, s1 - 0.06, 2.32, 1.15);
    }
  },
  sofa(B, M, F, w, d, h, m) {
    const main = m ?? M.fabric;
    legs(B, M.black, F, w - 0.2, d, 0.35, 0.2, 0.04);
    F.box(B, main, -w / 2, 0.33, 0, w / 2, 1.3, d);
    F.box(B, main, -w / 2, 1.3, 0, w / 2, h, 0.75);
    for (const s of [-w / 2, w / 2 - 0.55]) F.box(B, main, s, 1.3, 0, s + 0.55, 2.15, d);
    const inner = w - 1.1, n = inner > 5 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const s0 = -inner / 2 + (k * inner) / n;
      F.box(B, M.cushion, s0 + 0.02, 1.3, 0.75, s0 + inner / n - 0.02, 1.72, d - 0.03);
      F.box(B, M.cushion, s0 + 0.04, 1.6, 0.72, s0 + inner / n - 0.04, h - 0.1, 1.12);
    }
  },
  // L-shaped: a sofa along the back with a chaise on the right-hand end.
  sectional(B, M, F, w, d, h, m) {
    const main = m ?? M.fabric, sd = 3.0, cw = 3.0;
    legs(B, M.black, F, w - 0.2, sd, 0.35, 0.2, 0.04);
    F.box(B, main, -w / 2, 0.33, 0, w / 2, 1.3, sd);
    F.box(B, main, w / 2 - cw, 0.33, sd, w / 2, 1.3, d);
    F.box(B, main, -w / 2, 1.3, 0, w / 2, h, 0.75);
    F.box(B, main, -w / 2, 1.3, 0, -w / 2 + 0.55, 2.15, sd);
    F.box(B, main, w / 2 - 0.55, 1.3, 0.75, w / 2, 2.15, d);
    const inner = w - 0.55 - cw - 0.55;
    for (let k = 0; k < 2; k++) {
      const s0 = -w / 2 + 0.55 + (k * inner) / 2;
      F.box(B, M.cushion, s0 + 0.02, 1.3, 0.75, s0 + inner / 2 - 0.02, 1.72, sd - 0.03);
    }
    F.box(B, M.cushion, w / 2 - cw + 0.02, 1.3, 0.75, w / 2 - 0.57, 1.72, d - 0.03);
    for (let k = 0; k < 3; k++) {
      const span = w - 1.1, s0 = -w / 2 + 0.55 + (k * span) / 3;
      F.box(B, M.cushion, s0 + 0.04, 1.6, 0.72, s0 + span / 3 - 0.04, h - 0.1, 1.12);
    }
  },
  armchair(B, M, F, w, d, h, m) {
    const main = m ?? M.fabricDark;
    legs(B, M.black, F, w - 0.2, d, 0.35, 0.18, 0.035);
    F.box(B, main, -w / 2, 0.33, 0, w / 2, 1.3, d);
    F.box(B, main, -w / 2, 1.3, 0, w / 2, h, 0.6);
    for (const s of [-w / 2, w / 2 - 0.4]) F.box(B, main, s, 1.3, 0, s + 0.4, 2.05, d);
    F.box(B, M.cushion, -w / 2 + 0.42, 1.3, 0.6, w / 2 - 0.42, 1.68, d - 0.03);
  },
  ottoman(B, M, F, w, d, h, m) {
    legs(B, M.black, F, w, d, 0.3, 0.1, 0.03);
    F.box(B, m ?? M.fabric, -w / 2, 0.28, 0, w / 2, h, d);
  },
  coffeetable(B, M, F, w, d, h, m) {
    F.box(B, m ?? M.walnut, -w / 2, h - 0.1, 0, w / 2, h, d);
    F.box(B, m ?? M.walnut, -w / 2 + 0.1, 0.35, 0.1, w / 2 - 0.1, 0.4, d - 0.1);
    legs(B, M.black, F, w, d, h - 0.1, 0.1, 0.035);
  },
  sidetable(B, M, F, w, d, h, m) {
    F.box(B, m ?? M.walnut, -w / 2, h - 0.1, 0, w / 2, h, d);
    legs(B, M.black, F, w, d, h - 0.1, 0.1, 0.03);
  },
  tvstand(B, M, F, w, d, h, m, item) {
    const main = m ?? M.walnut;
    F.box(B, main, -w / 2, 0.4, 0, w / 2, h, d);
    legs(B, M.black, F, w, d, 0.4, 0.1, 0.035);
    const n = w > 4 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const s0 = -w / 2 + (k * w) / n;
      F.box(B, main, s0 + 0.03, 0.45, d, s0 + w / n - 0.03, h - 0.05, d + 0.03);
    }
    if (item.tv) {
      const tw = 4.03, y = h;
      F.box(B, M.black, -0.35, y, d / 2 - 0.25, 0.35, y + 0.04, d / 2 + 0.25);
      F.box(B, M.black, -0.05, y, d / 2 - 0.05, 0.05, y + 0.25, d / 2 + 0.05);
      F.box(B, M.screen, -tw / 2, y + 0.22, d / 2 - 0.04, tw / 2, y + 0.22 + tw * 0.5625, d / 2 + 0.04);
    }
  },
  bookshelf(B, M, F, w, d, h, m) {
    const main = m ?? M.walnut, th = 0.06;
    F.box(B, main, -w / 2, 0, 0, -w / 2 + th, h, d);
    F.box(B, main, w / 2 - th, 0, 0, w / 2, h, d);
    F.box(B, main, -w / 2, 0, 0, w / 2, h, 0.03);
    const n = Math.max(2, Math.round(h / 1.15));
    for (let k = 0; k <= n; k++) {
      const y = 0.15 + (k * (h - 0.15 - th)) / n;
      F.box(B, main, -w / 2 + th, y, 0, w / 2 - th, y + th, d);
    }
  },
  lamp(B, M, F, w, d, h, m) {
    const [x, z] = F.p(0, d / 2);
    B.cyl(M.black, x, 0, z, Math.min(w, d) * 0.4, 0.05, 24);
    B.cyl(M.black, x, 0.05, z, 0.03, h - 1.0, 8);
    B.cyl(m ?? M.lampShade, x, h - 1.15, z, Math.min(w, d) * 0.5, 1.15, 28, Math.min(w, d) * 0.36);
  },
  rug(B, M, F, w, d, _h, m) {
    F.box(B, m ?? M.rug, -w / 2, 0.004, 0, w / 2, 0.035, d);
  },
  table(B, M, F, w, d, h, m) {
    F.box(B, m ?? M.walnut, -w / 2, h - 0.1, 0, w / 2, h, d);
    legs(B, M.black, F, w, d, h - 0.1, 0.15, 0.045);
  },
  roundtable(B, M, F, w, d, h, m) {
    const [x, z] = F.p(0, d / 2);
    const top = new THREE.CylinderGeometry(w / 2, w / 2, 0.1, 48);
    top.scale(1, 1, d / w);
    top.translate(x, h - 0.05, z);
    B.add(top, m ?? M.walnut);
    B.cyl(M.black, x, 0.06, z, 0.08, h - 0.15, 16);
    B.cyl(M.black, x, 0, z, Math.min(w, d) * 0.3, 0.06, 32);
  },
  chair(B, M, F, w, d, h, m) {
    legs(B, M.black, F, w, d, 1.5, 0.08, 0.03);
    F.box(B, m ?? M.walnut, -w / 2, 1.5, 0, w / 2, 1.6, d);
    F.box(B, m ?? M.walnut, -w / 2, 1.6, 0, w / 2, h, 0.08);
  },
  bench(B, M, F, w, d, h, m) {
    F.box(B, m ?? M.walnut, -w / 2, h - 0.12, 0, w / 2, h, d);
    legs(B, M.black, F, w, d, h - 0.12, 0.12, 0.035);
  },
  nightstand(B, M, F, w, d, h, m) {
    const main = m ?? M.walnut;
    F.box(B, main, -w / 2, 0.25, 0, w / 2, h, d);
    legs(B, M.black, F, w, d, 0.25, 0.08, 0.03);
    F.box(B, M.black, -0.25, h - 0.45, d, 0.25, h - 0.42, d + 0.03);
  },
  dresser(B, M, F, w, d, h, m) {
    const main = m ?? M.walnut;
    F.box(B, main, -w / 2, 0.3, 0, w / 2, h, d);
    legs(B, M.black, F, w, d, 0.3, 0.1, 0.035);
    const rows = Math.max(2, Math.round((h - 0.38) / 0.8)), rh = (h - 0.38) / rows;
    const cols = w > 3.5 ? 2 : 1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const y0 = 0.36 + r * rh, s0 = -w / 2 + (c * w) / cols, s1 = s0 + w / cols, sc = (s0 + s1) / 2;
      F.box(B, main, s0 + 0.03, y0, d, s1 - 0.03, y0 + rh - 0.05, d + 0.03);
      F.box(B, M.black, sc - 0.2, y0 + rh - 0.2, d + 0.03, sc + 0.2, y0 + rh - 0.17, d + 0.06);
    }
  },
  desk(B, M, F, w, d, h, m) {
    const main = m ?? M.walnut;
    F.box(B, main, -w / 2, h - 0.1, 0, w / 2, h, d);
    legs(B, M.black, F, w, d, h - 0.1, 0.1, 0.035);
    F.box(B, main, w / 2 - 1.3, h - 0.55, 0.1, w / 2 - 0.12, h - 0.1, d - 0.05);
  },
  officechair(B, M, F, w, d, h, m) {
    const [x, z] = F.p(0, d / 2);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2, r = Math.min(w, d) * 0.46;
      B.rod(M.black, [x, 0.12, z], [x + Math.cos(a) * r, 0.1, z + Math.sin(a) * r], 0.035);
      B.cyl(M.black, x + Math.cos(a) * r, 0, z + Math.sin(a) * r, 0.06, 0.1, 10);
    }
    B.cyl(M.steel, x, 0.12, z, 0.05, 1.25, 12);
    F.box(B, m ?? M.fabricDark, -w * 0.4, 1.35, d * 0.1, w * 0.4, 1.6, d * 0.9);
    F.box(B, m ?? M.fabricDark, -w * 0.38, 1.6, d * 0.08, w * 0.38, h, d * 0.2);
  },
  plant(B, M, F, w, d, h, m) {
    const [x, z] = F.p(0, d / 2), r = Math.min(w, d) / 2;
    B.cyl(m ?? M.pot, x, 0, z, r * 0.7, Math.min(1.3, h * 0.35), 24, r * 0.85);
    for (let k = 0; k < 4; k++) {
      const leaf = new THREE.IcosahedronGeometry(r * (0.85 - k * 0.1), 1);
      const a = k * 2.1;
      leaf.translate(x + Math.cos(a) * r * 0.25, h * (0.55 + k * 0.12), z + Math.sin(a) * r * 0.25);
      B.add(leaf, M.plant);
    }
  },
  box(B, M, F, w, d, h, m) {
    F.box(B, m ?? M.customPiece, -w / 2, 0, 0, w / 2, h, d);
  },
};

// One placed piece, as a group positioned and turned in the room.
// item: { id, type, name, w, d, h (feet), x, z (center, feet), rot (degrees clockwise on the plan), color }
export function buildPiece(M, item) {
  const def = catalogByType[item.type] ?? catalogByType.box;
  const B = new Batch(`piece-${item.id}`);
  const F = new Frame(0, -item.d / 2, [1, 0], [0, 1]);
  BUILDERS[def.build ?? def.type](B, M, F, item.w, item.d, item.h, swatchMaterial(M, item.color), { tv: def.tv });
  const g = B.build();
  g.position.set(item.x, 0, item.z);
  g.rotation.y = -THREE.MathUtils.degToRad(item.rot);
  g.traverse((o) => { if (o.isMesh) o.userData.pieceId = item.id; });
  g.userData.pieceId = item.id;
  return g;
}

// Rugs lie flat and never block walking.
export const isFlat = (item) => (catalogByType[item.type]?.build ?? item.type) === 'rug';

// Corners of the footprint in world space.
export function footprint(item, pad = 0) {
  const a = -THREE.MathUtils.degToRad(item.rot), c = Math.cos(a), s = Math.sin(a);
  const hw = item.w / 2 + pad, hd = item.d / 2 + pad;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [item.x + lx * c + lz * s, item.z - lx * s + lz * c]);
}

export function bounds(item) {
  const pts = footprint(item);
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

// Is (x, z) within r of the piece's footprint?
export function nearPiece(item, x, z, r) {
  const a = -THREE.MathUtils.degToRad(item.rot), c = Math.cos(a), s = Math.sin(a);
  const dx = x - item.x, dz = z - item.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) < item.w / 2 + r && Math.abs(lz) < item.d / 2 + r;
}
