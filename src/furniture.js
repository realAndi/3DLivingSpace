import * as THREE from 'three';
import { Batch, Frame } from './kit.js';
import { catalogByType, SWATCHES } from './catalog.js';
import { plantLeafY } from './hitbox.js';

// 3D models for placed furniture: the catalog pieces, and custom assets built
// from primitives (see src/design.js for their format). Pieces collide by the
// parts in src/hitbox.js, which follow these builders: change both together,
// and keep every piece inside its footprint (only a TV may overhang it).
export { CATALOG, catalogByType, SWATCHES, isFlat, footprint, bounds, nearPiece } from './catalog.js';

const colorCache = new Map();
function swatchMaterial(M, key) {
  if (!key) return null;
  if (key === 'oak') return M.oak;
  if (key === 'walnut') return M.walnut;
  const s = SWATCHES.find((x) => x.key === key);
  const hex = s?.hex ?? (/^#[0-9a-f]{6}$/.test(key) ? parseInt(key.slice(1), 16) : null);
  if (hex == null) return null;
  if (!colorCache.has(key)) colorCache.set(key, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85 }));
  return colorCache.get(key);
}

// Materials for asset parts, one per color and finish.
const FINISH = {
  matte: { roughness: 0.9 }, satin: { roughness: 0.55 }, gloss: { roughness: 0.18 },
  metal: { roughness: 0.32, metalness: 1 }, glass: { roughness: 0.05, transparent: true, opacity: 0.32, depthWrite: false },
  fabric: { roughness: 1 }, wood: { roughness: 0.62 },
};
const partCache = new Map();
function partMaterial(color, finish) {
  const key = `${color}|${finish}`;
  if (!partCache.has(key)) partCache.set(key, new THREE.MeshStandardMaterial({ color: parseInt(color.slice(1), 16), ...(FINISH[finish] ?? FINISH.matte) }));
  return partCache.get(key);
}
const UNIT_GEO = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 28),
  cone: () => new THREE.CylinderGeometry(0, 0.5, 1, 28),
  sphere: () => new THREE.SphereGeometry(0.5, 28, 18),
};

// Parts in inches, piece frame: origin at the footprint center on the floor.
function buildAsset(B, asset, item, colorOverride) {
  const sx = (item.w * 12) / asset.w, sy = (item.h * 12) / asset.h, sz = (item.d * 12) / asset.d;
  const scale = new THREE.Matrix4().makeScale(sx / 12, sy / 12, sz / 12);
  B.push(scale);
  for (const p of asset.parts) {
    const g = UNIT_GEO[p.shape]();
    g.scale(...p.size);
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...p.rot.map((d) => (d * Math.PI) / 180), 'XYZ')));
    g.translate(...p.at);
    B.add(g, colorOverride ?? partMaterial(p.color, p.finish));
  }
  B.pop();
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
    F.box(B, M.duvet, -w / 2 + 0.02, 1.25, 1.75, w / 2 - 0.02, 1.98, d);
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
    const main = m ?? M.fabric, sd = Math.min(3.0, d), cw = Math.min(3.0, w);
    legs(B, M.black, F, w - 0.2, sd, 0.35, 0.2, 0.04);
    if (d - sd > 0.5) for (const s of [w / 2 - cw + 0.3, w / 2 - 0.3]) { const [x, z] = F.p(s, d - 0.2); B.cyl(M.black, x, 0, z, 0.04, 0.35, 10); }
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
    F.box(B, main, -w / 2, 0.4, 0, w / 2, h, d - 0.03);
    legs(B, M.black, F, w, d, 0.4, 0.1, 0.035);
    const n = w > 4 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const s0 = -w / 2 + (k * w) / n;
      F.box(B, main, s0 + 0.03, 0.45, d - 0.03, s0 + w / n - 0.03, h - 0.05, d);
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
    F.box(B, main, -w / 2, 0.25, 0, w / 2, h, d - 0.03);
    legs(B, M.black, F, w, d, 0.25, 0.08, 0.03);
    F.box(B, M.black, -0.25, h - 0.45, d - 0.03, 0.25, h - 0.42, d);
  },
  dresser(B, M, F, w, d, h, m) {
    const main = m ?? M.walnut;
    F.box(B, main, -w / 2, 0.3, 0, w / 2, h, d - 0.06);
    legs(B, M.black, F, w, d, 0.3, 0.1, 0.035);
    const rows = Math.max(2, Math.round((h - 0.38) / 0.8)), rh = (h - 0.38) / rows;
    const cols = w > 3.5 ? 2 : 1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const y0 = 0.36 + r * rh, s0 = -w / 2 + (c * w) / cols, s1 = s0 + w / cols, sc = (s0 + s1) / 2;
      F.box(B, main, s0 + 0.03, y0, d - 0.06, s1 - 0.03, y0 + rh - 0.05, d - 0.03);
      F.box(B, M.black, sc - 0.2, y0 + rh - 0.2, d - 0.03, sc + 0.2, y0 + rh - 0.17, d);
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
      const rk = r * (0.85 - k * 0.1), leaf = new THREE.IcosahedronGeometry(rk, 1);
      const a = k * 2.1;
      leaf.translate(x + Math.cos(a) * r * 0.15, plantLeafY(h, k, rk), z + Math.sin(a) * r * 0.15);
      B.add(leaf, M.plant);
    }
  },
  box(B, M, F, w, d, h, m) {
    F.box(B, m ?? M.customPiece, -w / 2, 0, 0, w / 2, h, d);
  },
};

// One placed piece, as a group positioned and turned in the room.
// item: { id, type, name, w, d, h (feet), x, z (center, feet), rot (degrees clockwise on the plan), color }
export function buildPiece(M, item, assets = {}) {
  const B = new Batch(`piece-${item.uid}`);
  const asset = item.type === 'asset' ? assets[item.asset] : null;
  if (asset) buildAsset(B, asset, item, swatchMaterial(M, item.color));
  else {
    const def = catalogByType[item.type] ?? catalogByType.box;
    const F = new Frame(0, -item.d / 2, [1, 0], [0, 1]);
    BUILDERS[def.build ?? def.type](B, M, F, item.w, item.d, item.h, swatchMaterial(M, item.color), { tv: def.tv });
  }
  const g = B.build();
  g.position.set(item.x, 0, item.z);
  g.rotation.y = -THREE.MathUtils.degToRad(item.rot);
  g.traverse((o) => { if (o.isMesh) o.userData.pieceId = item.uid; });
  g.userData.pieceId = item.uid;
  return g;
}




