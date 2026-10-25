import { Batch, Frame, DIRS } from './kit.js';
import { FURNITURE, X, Z } from './plan.js';

// Each piece is built in a local frame: s across the piece (centered),
// t from its back (0) to its front (d), y up. `face` is the front direction.
function frameFor(item) {
  const [px0, pz0, px1, pz1] = item.px;
  const x0 = X(px0), z0 = Z(pz0), x1 = X(px1), z1 = Z(pz1);
  const n = DIRS[item.face];
  const u = [n[1], -n[0]];
  const ns = item.face === 'S' || item.face === 'N';
  const w = ns ? x1 - x0 : z1 - z0;
  const d = ns ? z1 - z0 : x1 - x0;
  const back = { S: [(x0 + x1) / 2, z0], N: [(x0 + x1) / 2, z1], E: [x0, (z0 + z1) / 2], W: [x1, (z0 + z1) / 2] }[item.face];
  return { F: new Frame(back[0], back[1], u, n), w, d, rect: [x0, z0, x1, z1] };
}

function legs(B, mat, F, w, d, h, inset = 0.12, r = 0.035) {
  for (const s of [-w / 2 + inset, w / 2 - inset]) for (const t of [inset, d - inset]) {
    const [x, z] = F.p(s, t);
    B.cyl(mat, x, 0, z, r, h, 10);
  }
}

function lamp(B, M, F, s, t, y) {
  const [x, z] = F.p(s, t);
  B.cyl(M.pot, x, y, z, 0.16, 0.05, 20);
  B.cyl(M.black, x, y, z, 0.025, 1.0, 8);
  B.cyl(M.lampShade, x, y + 0.85, z, 0.42, 0.62, 28, 0.32);
}

function tv(B, M, F, w, t, y) {
  F.box(B, M.black, -0.35, y, t - 0.25, 0.35, y + 0.04, t + 0.25);
  F.box(B, M.black, -0.05, y, t - 0.05, 0.05, y + 0.25, t + 0.05);
  F.box(B, M.screen, -w / 2, y + 0.22, t - 0.04, w / 2, y + 0.22 + w * 0.5625, t + 0.04);
}

const BUILDERS = {
  bed(B, M, F, w, d) {
    legs(B, M.black, F, w - 0.1, d, 0.35, 0.2);
    F.box(B, M.headboard, -w / 2, 0.3, 0.25, w / 2, 1.05, d);
    F.box(B, M.headboard, -w / 2, 0.3, 0, w / 2, 3.9, 0.28);
    F.box(B, M.linen, -w / 2 + 0.1, 1.05, 0.3, w / 2 - 0.1, 1.9, d - 0.05);
    F.box(B, M.duvet, -w / 2 + 0.02, 1.25, 1.75, w / 2 - 0.02, 1.98, d + 0.02);
    F.box(B, M.cushion, -w / 2 + 0.12, 1.92, 1.75, w / 2 - 0.12, 2.0, 2.6);
    for (const s of [-w / 4, w / 4]) F.box(B, M.linen, s - w / 4 + 0.12, 1.9, 0.38, s + w / 4 - 0.12, 2.32, 1.15);
  },
  nightstand(B, M, F, w, d, item) {
    F.box(B, M.walnut, -w / 2, 0.25, 0, w / 2, 2.0, d);
    legs(B, M.black, F, w, d, 0.25, 0.08, 0.03);
    F.box(B, M.black, -0.25, 1.55, d, 0.25, 1.58, d + 0.03);
    if (item.lamp) lamp(B, M, F, 0, d / 2, 2.0);
  },
  dresser(B, M, F, w, d, item) {
    F.box(B, M.walnut, -w / 2, 0.3, 0, w / 2, 2.85, d);
    legs(B, M.black, F, w, d, 0.3, 0.1, 0.035);
    for (let r = 0; r < 3; r++) for (const s of [-w / 4, w / 4]) {
      const y0 = 0.38 + r * 0.82;
      F.box(B, M.walnut, s - w / 4 + 0.03, y0, d, s + w / 4 - 0.03, y0 + 0.76, d + 0.03);
      F.box(B, M.black, s - 0.2, y0 + 0.6, d + 0.03, s + 0.2, y0 + 0.63, d + 0.06);
    }
    if (item.tv) tv(B, M, F, 3.7, d / 2, 2.85);
  },
  sofa(B, M, F, w, d) {
    legs(B, M.black, F, w - 0.2, d, 0.35, 0.2, 0.04);
    F.box(B, M.fabric, -w / 2, 0.33, 0, w / 2, 1.3, d);
    F.box(B, M.fabric, -w / 2, 1.3, 0, w / 2, 2.75, 0.75);
    for (const s of [-w / 2, w / 2 - 0.55]) F.box(B, M.fabric, s, 1.3, 0, s + 0.55, 2.15, d);
    const inner = w - 1.1;
    for (const k of [0, 1]) {
      const s0 = -inner / 2 + k * inner / 2;
      F.box(B, M.cushion, s0 + 0.02, 1.3, 0.75, s0 + inner / 2 - 0.02, 1.72, d - 0.03);
      F.box(B, M.cushion, s0 + 0.04, 1.6, 0.72, s0 + inner / 2 - 0.04, 2.65, 1.12);
    }
  },
  armchair(B, M, F, w, d) {
    legs(B, M.black, F, w - 0.2, d, 0.35, 0.18, 0.035);
    F.box(B, M.fabricDark, -w / 2, 0.33, 0, w / 2, 1.3, d);
    F.box(B, M.fabricDark, -w / 2, 1.3, 0, w / 2, 2.6, 0.6);
    for (const s of [-w / 2, w / 2 - 0.4]) F.box(B, M.fabricDark, s, 1.3, 0, s + 0.4, 2.05, d);
    F.box(B, M.cushion, -w / 2 + 0.42, 1.3, 0.6, w / 2 - 0.42, 1.68, d - 0.03);
  },
  sidetable(B, M, F, w, d, item) {
    F.box(B, M.walnut, -w / 2, 1.85, 0, w / 2, 1.95, d);
    legs(B, M.black, F, w, d, 1.85, 0.1, 0.03);
    if (item.lamp) lamp(B, M, F, 0, d / 2, 1.95);
  },
  coffeetable(B, M, F, w, d) {
    F.box(B, M.walnut, -w / 2, 1.3, 0, w / 2, 1.4, d);
    F.box(B, M.walnut, -w / 2 + 0.1, 0.35, 0.1, w / 2 - 0.1, 0.4, d - 0.1);
    legs(B, M.black, F, w, d, 1.3, 0.1, 0.035);
  },
  console(B, M, F, w, d, item) {
    F.box(B, M.walnut, -w / 2, 0.4, 0, w / 2, 1.85, d);
    legs(B, M.black, F, w, d, 0.4, 0.1, 0.035);
    for (const s of [-w / 3, 0, w / 3]) F.box(B, M.walnut, s - w / 6 + 0.03, 0.45, d, s + w / 6 - 0.03, 1.8, d + 0.03);
    if (item.tv) tv(B, M, F, 4.7, d / 2, 1.85);
  },
  rug(B, M, F, w, d) { F.box(B, M.rug, -w / 2, 0.004, 0, w / 2, 0.035, d); },
  table(B, M, F, w, d) {
    F.box(B, M.walnut, -w / 2, 2.4, 0, w / 2, 2.5, d);
    legs(B, M.black, F, w, d, 2.4, 0.15, 0.045);
  },
  chair(B, M, F, w, d) {
    legs(B, M.black, F, w, d, 1.5, 0.08, 0.03);
    F.box(B, M.walnut, -w / 2, 1.5, 0, w / 2, 1.6, d);
    F.box(B, M.walnut, -w / 2, 1.6, 0, w / 2, 2.95, 0.08);
  },
};

// Footprints used to stop the walk camera passing through furniture.
export const FURNITURE_BLOCKS = FURNITURE
  .filter((f) => f.type !== 'rug')
  .map((f) => { const [a, b, c, d] = f.px; return [X(a), Z(b), X(c), Z(d)]; });

export function buildFurniture(M) {
  const B = new Batch('furniture');
  for (const item of FURNITURE) {
    const { F, w, d } = frameFor(item);
    BUILDERS[item.type](B, M, F, w, d, item);
  }
  return B.build();
}
