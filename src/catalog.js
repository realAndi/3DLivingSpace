// Furniture you can place, and the footprint math for placed pieces. Shared by
// the browser and the server, so no three.js here.
//
// Catalog sizes are typical retail sizes in inches (width × depth × height);
// every piece can be resized after placing. Width runs side to side as you face
// the piece's front, depth runs back to front, so a bed's depth is its length.
//
// `place` is where a piece goes: floor (stands on the floor), surface (sits on
// a table, counter, shelf or dresser, or on the floor when there is none under
// it), wall (hangs on a wall, its back against it; `y` is the usual height of
// its underside, inches) or ceiling (hangs from the ceiling, its top against
// it). `kind` groups the catalog. `act` is what E or a tap does to it in 3D:
// light (on and off), screen (on and off), curtain (open and close), fan
// (spin) or door (open and close).
export const KINDS = [
  { key: 'furniture', name: 'Furniture' },
  { key: 'lighting', name: 'Lighting' },
  { key: 'decor', name: 'Decor' },
  { key: 'electronics', name: 'Electronics' },
  { key: 'appliance', name: 'Appliances' },
  { key: 'plant', name: 'Plants' },
  { key: 'rug', name: 'Rugs' },
];
export const PLACES = ['floor', 'surface', 'wall', 'ceiling'];
export const ACTS = ['light', 'screen', 'curtain', 'fan', 'door'];

const F = { kind: 'furniture', place: 'floor' };
export const CATALOG = [
  { type: 'sofa', name: 'Sofa', group: 'Living', ...F, w: 84, d: 36, h: 34 },
  { type: 'loveseat', name: 'Loveseat', group: 'Living', ...F, w: 64, d: 36, h: 34, build: 'sofa' },
  { type: 'sectional', name: 'Sectional', group: 'Living', ...F, w: 112, d: 84, h: 34 },
  { type: 'armchair', name: 'Armchair', group: 'Living', ...F, w: 34, d: 34, h: 32 },
  { type: 'ottoman', name: 'Ottoman', group: 'Living', ...F, w: 24, d: 24, h: 18 },
  { type: 'coffeetable', name: 'Coffee table', group: 'Living', ...F, w: 48, d: 24, h: 18 },
  { type: 'sidetable', name: 'Side table', group: 'Living', ...F, w: 20, d: 20, h: 24 },
  { type: 'tvstand', name: 'TV stand', group: 'Living', ...F, w: 60, d: 16, h: 22 },
  { type: 'tvstand-tv', name: 'TV stand + 55" TV', group: 'Living', kind: 'electronics', place: 'floor', w: 60, d: 16, h: 22, build: 'tvstand', tv: true, act: 'screen' },
  { type: 'bookshelf', name: 'Bookshelf', group: 'Living', ...F, w: 32, d: 12, h: 72 },
  { type: 'lamp', name: 'Floor lamp', group: 'Living', kind: 'lighting', place: 'floor', w: 14, d: 14, h: 62, act: 'light' },
  { type: 'rug-8x10', name: "Rug 8' × 10'", group: 'Living', kind: 'rug', place: 'floor', w: 120, d: 96, h: 0.5, build: 'rug' },
  { type: 'rug-5x8', name: "Rug 5' × 8'", group: 'Living', kind: 'rug', place: 'floor', w: 96, d: 60, h: 0.5, build: 'rug' },

  { type: 'table', name: 'Dining table', group: 'Dining', ...F, w: 60, d: 36, h: 30 },
  { type: 'roundtable', name: 'Round table', group: 'Dining', ...F, w: 42, d: 42, h: 30 },
  { type: 'chair', name: 'Dining chair', group: 'Dining', ...F, w: 18, d: 20, h: 34 },
  { type: 'bench', name: 'Bench', group: 'Dining', ...F, w: 48, d: 16, h: 18 },

  { type: 'bed-king', name: 'King bed', group: 'Bedroom', ...F, w: 80, d: 86, h: 48, build: 'bed' },
  { type: 'bed-queen', name: 'Queen bed', group: 'Bedroom', ...F, w: 64, d: 86, h: 48, build: 'bed' },
  { type: 'bed-full', name: 'Full bed', group: 'Bedroom', ...F, w: 58, d: 80, h: 44, build: 'bed' },
  { type: 'bed-twin', name: 'Twin bed', group: 'Bedroom', ...F, w: 42, d: 80, h: 40, build: 'bed' },
  { type: 'nightstand', name: 'Nightstand', group: 'Bedroom', ...F, w: 22, d: 16, h: 24 },
  { type: 'dresser', name: 'Dresser', group: 'Bedroom', ...F, w: 60, d: 18, h: 32 },
  { type: 'chest', name: 'Tall dresser', group: 'Bedroom', ...F, w: 36, d: 18, h: 48, build: 'dresser' },
  { type: 'desk', name: 'Desk', group: 'Bedroom', ...F, w: 48, d: 24, h: 30 },
  { type: 'officechair', name: 'Desk chair', group: 'Bedroom', ...F, w: 26, d: 26, h: 40 },

  { type: 'plant', name: 'Plant', group: 'Other', kind: 'plant', place: 'floor', w: 18, d: 18, h: 48 },
  { type: 'box', name: 'Custom piece', group: 'Other', ...F, w: 36, d: 24, h: 30 },

  // On tables, counters, shelves and dressers.
  { type: 'table-lamp', name: 'Table lamp', group: 'Living', kind: 'lighting', place: 'surface', w: 14, d: 14, h: 24, act: 'light' },
  { type: 'books', name: 'Books', group: 'Living', kind: 'decor', place: 'surface', w: 12, d: 8, h: 9 },
  { type: 'vase', name: 'Vase', group: 'Living', kind: 'decor', place: 'surface', w: 6, d: 6, h: 12 },
  { type: 'plant-small', name: 'Small plant', group: 'Living', kind: 'plant', place: 'surface', w: 8, d: 8, h: 12 },
  { type: 'plates', name: 'Plates', group: 'Dining', kind: 'decor', place: 'surface', w: 11, d: 11, h: 3 },
  { type: 'laptop', name: 'Laptop', group: 'Bedroom', kind: 'electronics', place: 'surface', w: 13, d: 11, h: 9, act: 'screen' },
  { type: 'microwave', name: 'Countertop microwave', group: 'Kitchen', kind: 'appliance', place: 'surface', w: 20, d: 15, h: 12, act: 'door' },
  { type: 'coffee-maker', name: 'Coffee maker', group: 'Kitchen', kind: 'appliance', place: 'surface', w: 9, d: 11, h: 14 },

  // On the walls. y: the usual height of the underside, inches.
  { type: 'wall-art', name: 'Wall art', group: 'Living', kind: 'decor', place: 'wall', w: 36, d: 1.5, h: 24, y: 45 },
  { type: 'mirror', name: 'Mirror', group: 'Bedroom', kind: 'decor', place: 'wall', w: 24, d: 1, h: 36, y: 42 },
  { type: 'wall-shelf', name: 'Wall shelf', group: 'Living', kind: 'furniture', place: 'wall', w: 36, d: 10, h: 2, y: 54 },
  { type: 'wall-tv', name: 'Wall TV (55")', group: 'Living', kind: 'electronics', place: 'wall', w: 49, d: 2, h: 28.5, y: 36, act: 'screen' },
  { type: 'sconce', name: 'Wall sconce', group: 'Living', kind: 'lighting', place: 'wall', w: 6, d: 8, h: 12, y: 60, act: 'light' },
  { type: 'curtains', name: 'Curtains', group: 'Living', kind: 'decor', place: 'wall', w: 84, d: 6, h: 95, y: 1, act: 'curtain' },
  { type: 'blinds', name: 'Blinds', group: 'Living', kind: 'decor', place: 'wall', w: 36, d: 3, h: 60, y: 22, act: 'curtain' },

  // From the ceiling. Height runs from the ceiling down to the bottom.
  { type: 'pendant', name: 'Pendant light', group: 'Dining', kind: 'lighting', place: 'ceiling', w: 14, d: 14, h: 36, act: 'light' },
  { type: 'ceiling-fan', name: 'Ceiling fan', group: 'Living', kind: 'appliance', place: 'ceiling', w: 52, d: 52, h: 14, act: 'fan' },
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

// What a piece is made of, besides its color: its main material (a sofa's
// upholstery, a table's top), or one of the unit's own textures ("tex:<id>").
// Tinted ones take the piece's color; the rest show their own.
export const MATERIALS = [
  { key: 'fabric', name: 'Woven', tint: true }, { key: 'linen', name: 'Linen', tint: true },
  { key: 'velvet', name: 'Velvet', tint: true }, { key: 'boucle', name: 'Bouclé', tint: true },
  { key: 'leather', name: 'Leather', tint: true }, { key: 'jute', name: 'Jute', tint: true },
  { key: 'oak', name: 'Oak' }, { key: 'ash', name: 'Ash' }, { key: 'walnut', name: 'Walnut' }, { key: 'rattan', name: 'Rattan' },
  { key: 'marble', name: 'Marble' }, { key: 'travertine', name: 'Travertine' }, { key: 'terrazzo', name: 'Terrazzo' },
  { key: 'concrete', name: 'Concrete' }, { key: 'brass', name: 'Brass' }, { key: 'steel', name: 'Steel' },
];
export const materialKeys = MATERIALS.map((m) => m.key);

// Where a placed piece goes, and what it is, from its catalog entry or custom
// asset (`assets` by id or as a list).
const assetFor = (item, assets) => (item.type !== 'asset' || !assets ? null
  : Array.isArray(assets) ? assets.find((a) => a.id === item.asset) ?? null : assets[item.asset] ?? null);
export const placeOf = (item, assets = null) => (item.type === 'asset' ? assetFor(item, assets)?.place : catalogByType[item.type]?.place) ?? 'floor';
export const kindOf = (item, assets = null) => (item.type === 'asset' ? assetFor(item, assets)?.kind : catalogByType[item.type]?.kind) ?? 'furniture';
export const actOf = (item, assets = null) => (item.type === 'asset' ? (assetFor(item, assets)?.light ? 'light' : null) : catalogByType[item.type]?.act) ?? null;

// Rugs lie flat: you walk over them, other pieces stand on them, and they don't
// block doors. That's the catalog's rugs, a custom piece made as a rug, and
// anything else on the floor an inch tall or less (a mat, a rug made as
// furniture). Placed sizes are in feet.
const FLAT_H = 1 / 12 + 1e-6;
export const isFlat = (item, assets = null) => (catalogByType[item.type]?.build ?? item.type) === 'rug'
  || (!item.on && !(item.y > 0.02) && (item.h <= FLAT_H || kindOf(item, assets) === 'rug'));

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
