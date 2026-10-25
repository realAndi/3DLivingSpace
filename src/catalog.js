// Furniture you can place, and the footprint math for placed pieces. Shared by
// the browser and the server, so no three.js here.
//
// Catalog sizes are typical retail sizes in inches (width × depth × height);
// every piece can be resized after placing. Width runs side to side as you face
// the piece's front, depth runs back to front, so a bed's depth is its length.
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
  { key: 'oak', name: 'Light oak', hex: 0xc9a170 },
  { key: 'walnut', name: 'Walnut', hex: 0x6e4e35 },
  { key: 'white', name: 'White', hex: 0xf1efea },
  { key: 'black', name: 'Black', hex: 0x232323 },
  { key: 'gray', name: 'Gray', hex: 0x8e8984 },
  { key: 'charcoal', name: 'Charcoal', hex: 0x4f4c48 },
  { key: 'beige', name: 'Beige', hex: 0xd6cbb8 },
  { key: 'navy', name: 'Navy', hex: 0x2f3d56 },
  { key: 'sage', name: 'Sage', hex: 0x8b9a7e },
  { key: 'rust', name: 'Rust', hex: 0xa85c3f },
];
export const swatchKeys = SWATCHES.map((s) => s.key).filter(Boolean);

// Rugs lie flat and never block walking.
export const isFlat = (item) => (catalogByType[item.type]?.build ?? item.type) === 'rug';

const rad = (deg) => (deg * Math.PI) / 180;

// Corners of a placed piece's footprint. rot is degrees clockwise on the plan;
// at 0 the piece's front faces plan south (+z).
export function footprint(item, pad = 0) {
  const a = -rad(item.rot), c = Math.cos(a), s = Math.sin(a);
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
  const a = -rad(item.rot), c = Math.cos(a), s = Math.sin(a);
  const dx = x - item.x, dz = z - item.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) < item.w / 2 + r && Math.abs(lz) < item.d / 2 + r;
}
