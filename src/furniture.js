import * as THREE from 'three';
import { Batch, Frame, rng } from './kit.js';
import { catalogByType, SWATCHES } from './catalog.js';
import { plantLeafY, laptopLid, smallPlantLeaves, curtainFolds } from './parts.js';

// 3D models for placed furniture: the catalog pieces, and custom assets built
// from primitives (see src/design.js for their format). Pieces collide by the
// parts in src/parts.js, which follow these builders: change both together,
// and keep every piece inside its footprint (only a TV may overhang it).
//
// Pieces you can use (a catalog `act`, or an asset with a `light`) say how in
// their group's userData: act, state, setState(v), tick(dt) for a fan, and
// emitter for a lamp. What moves or lights up (a curtain panel, a microwave
// door, fan blades, a shade, a screen) is its own child mesh, so setState only
// moves it or changes one value on a material the piece has to itself.
export { CATALOG, catalogByType, SWATCHES, isFlat, footprint, bounds, nearPiece } from './catalog.js';

const IN = 1 / 12, DEG = Math.PI / 180;

const colorCache = new Map();
function swatchMaterial(M, key) {
  if (!key) return null;
  if (key === 'oak') return M.oak;
  if (key === 'walnut') return M.walnut;
  const hex = swatchHex(key);
  if (hex == null) return null;
  if (!colorCache.has(key)) colorCache.set(key, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85 }));
  return colorCache.get(key);
}
// The swatch as a plain color, for fabric and glass made in that color.
function swatchHex(key) {
  if (!key) return null;
  return SWATCHES.find((x) => x.key === key)?.hex ?? (/^#[0-9a-f]{6}$/.test(key) ? parseInt(key.slice(1), 16) : null);
}

// Finishes only furniture uses, made on first use and kept per material set
// (as in src/fixtures.js).
const variants = new WeakMap();
function cached(M, key, make) {
  let m = variants.get(M);
  if (!m) variants.set(M, (m = new Map()));
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
}
const std = (color, roughness, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra });
const FINISHES = {
  brass: () => std(0xb39463, 0.32, { metalness: 1 }),
  ceramic: () => std(0xdcd6cb, 0.45),
  stoneware: () => std(0xcdc3b3, 0.6),
  aluminum: () => std(0xc5c7c9, 0.32, { metalness: 0.8 }),
  fanBody: () => std(0xeeece7, 0.45),
  lining: () => std(0xdcdcd9, 0.5),
  paper: () => std(0xf4f1ea, 0.9),
  cassette: () => std(0xf1f0ec, 0.45),
  carafe: () => new THREE.MeshStandardMaterial({ color: 0xdfe8ea, roughness: 0.05, transparent: true, opacity: 0.22, depthWrite: false }),
};
const finish = (M, key) => cached(M, key, FINISHES[key]);

// Curtain and shade fabric in a color, seen from both sides.
const fabric = (M, hex) => cached(M, `fabric:${hex}`, () => std(hex, 0.95, { side: THREE.DoubleSide }));
const LINEN = 0xf4f2ee, SHADE = 0xf6f1e6;

// Materials only one piece uses (a lamp's glow, a TV's picture), so turning
// it on never lights another piece. Kept per piece: rebuilding a piece (every
// step of a resize) reuses them instead of making more.
const own = (X, key, make) => cached(X.M, `own:${X.uid}:${key}`, make);

const WARM = 0xffdcb0;  // a warm white bulb
const GLOW = 1;         // emissive intensity of a lit shade or bulb
function glow(X, key, hex, side = THREE.FrontSide) {
  return own(X, `${key}:${hex}`, () => std(hex, 0.9, { side, emissive: new THREE.Color(WARM).multiply(new THREE.Color(hex)), emissiveIntensity: 0 }));
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
// A lamp's glow parts (finish 'glow') keep their own color and light up with
// it; its bulb (`light`, inches) is where the light comes from.
function buildAsset(B, asset, item, colorOverride, X) {
  const sx = (item.w * 12) / asset.w, sy = (item.h * 12) / asset.h, sz = (item.d * 12) / asset.d;
  const scale = new THREE.Matrix4().makeScale(sx / 12, sy / 12, sz / 12);
  const lamp = Array.isArray(asset.light), G = new Batch('glow'), glows = new Map(), shapes = new Set();
  B.push(scale); G.push(scale);
  for (const p of asset.parts) {
    const g = UNIT_GEO[p.shape]();
    g.scale(...p.size);
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...p.rot.map((d) => d * DEG), 'XYZ')));
    g.translate(...p.at);
    if (lamp && p.finish === 'glow') {
      if (!glows.has(p.color)) glows.set(p.color, glow(X, 'asset', parseInt(p.color.slice(1), 16)));
      G.add(g, glows.get(p.color));
      shapes.add(p.shape);
    } else B.add(g, colorOverride ?? partMaterial(p.color, p.finish));
  }
  B.pop(); G.pop();
  if (!lamp) return;
  if (glows.size) part(X, G, null, { shadows: false });
  const shape = asset.place === 'ceiling' ? 'down' : shapes.has('cylinder') || shapes.has('cone') ? 'shade' : 'bare';
  light(X, [...glows.values()], asset.light.map((v, i) => (v * [sx, sy, sz][i]) / 12), 1, shape);
}

// ---------------------------------------------------------------------------
// Parts that move or light up, and what using them does (C1 in the brief).

// A part built from its own Batch and added as a child of the piece, its
// origin moved to `pivot` ([x, y, z] in the piece's frame, feet) so turning or
// scaling it is one transform.
function part(X, B, pivot = null, opts) {
  const g = B.build(opts);
  if (pivot) {
    for (const m of g.children) m.geometry.translate(-pivot[0], -pivot[1], -pivot[2]);
    g.position.set(...pivot);
  }
  X.kids.push(g);
  return g;
}

// A lamp: its glow materials light while it's on; the light comes from pos.
function light(X, mats, pos, power, shape) {
  X.use = {
    act: 'light', state: false,
    set: (on) => { for (const m of mats) m.emissiveIntensity = on ? GLOW : 0; },
    emitter: { pos, color: WARM, power, shape },
  };
}

// A fabric shade (open top and bottom) and its bulb, lit while the lamp is on.
// They cast no shadows, so a light inside them isn't boxed in.
function shadeLamp(X, { x, z, y, h, r0, r1, hex, bulb, power }) {
  const G = new Batch('glow'), m = glow(X, 'shade', hex, THREE.DoubleSide);
  const g = new THREE.CylinderGeometry(r1, r0, h, 32, 1, true);
  g.translate(x, y + h / 2, z);
  G.add(g, m);
  sphere(G, m, x, bulb, z, Math.min(r0, r1) * 0.2);
  part(X, G, null, { shadows: false });
  light(X, [m], [x, y + h * 0.45, z], power, 'shade');
}

// A screen: black glass while off, its picture lit while on.
function screenMat(X, picture) {
  return own(X, `screen:${picture}`, () => std(0x0b0c0d, 0.08, {
    emissive: 0xffffff, emissiveMap: pictureTexture(X.M, picture), emissiveIntensity: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  }));
}
function screen(X, mats) {
  X.use = { act: 'screen', state: false, set: (on) => { for (const m of mats) m.emissiveIntensity = on ? 1 : 0; } };
}
// A flat screen facing the front, from (s0, y0) to (s1, y1), at depth t.
function screenPlane(X, F, s0, y0, s1, y1, t, picture) {
  const S = new Batch('screen'), m = screenMat(X, picture), g = new THREE.PlaneGeometry(s1 - s0, y1 - y0);
  const [x, z] = F.p((s0 + s1) / 2, t);
  g.translate(x, (y0 + y1) / 2, z);
  S.add(g, m);
  part(X, S);
  screen(X, [m]);
}

// ---------------------------------------------------------------------------
// Shapes

function sphere(B, mat, x, y, z, r) {
  const g = new THREE.SphereGeometry(r, 12, 8);
  g.translate(x, y, z);
  return B.add(g, mat);
}

// A turned shape standing at (x, y, z), from a profile of [r, y] points
// (bottom to top) as fractions of its radius r and height h.
function lathe(B, mat, profile, r, h, x, y, z, seg = 28) {
  const g = new THREE.LatheGeometry(profile.map(([a, b]) => new THREE.Vector2(a * r, b * h)), seg);
  g.translate(x, y, z);
  return B.add(g, mat);
}
const JAR = [[0, 0], [0.62, 0], [0.68, 0.04], [0.9, 0.2], [1, 0.42], [0.93, 0.66], [0.66, 0.86], [0.34, 0.96], [0.36, 1], [0, 1]];
const VASE = [[0, 0], [0.6, 0], [0.68, 0.02], [0.9, 0.14], [1, 0.32], [0.95, 0.52], [0.7, 0.72], [0.42, 0.85], [0.36, 0.93], [0.42, 1], [0.34, 1], [0.29, 0.94], [0, 0.9]];
const PLATE = [[0, 0.12], [0.55, 0], [0.6, 0], [0.64, 0.2], [0.7, 0.38], [0.97, 0.9], [1, 1], [0.95, 1], [0.68, 0.5], [0.62, 0.35], [0, 0.35]];
const BOWL = [[0, 0.04], [0.42, 0], [0.48, 0], [0.52, 0.08], [0.78, 0.4], [0.95, 0.8], [1, 1], [0.95, 1], [0.88, 0.78], [0.7, 0.42], [0.45, 0.14], [0, 0.12]];
const DOME = [[0.96, 0], [1, 0], [0.99, 0.1], [0.93, 0.36], [0.8, 0.6], [0.6, 0.8], [0.36, 0.93], [0.16, 0.99], [0, 1]];
const MOTOR = [[0, 0], [0.45, 0], [0.8, 0.08], [1, 0.35], [1, 0.6], [0.85, 0.85], [0.55, 1], [0, 1]];
const CARAFE = [[0, 0], [0.85, 0], [1, 0.08], [1, 0.45], [0.8, 0.72], [0.62, 0.86], [0.68, 1]];

// A frame's four sides around a rectangle on the wall, fw wide, t0 to t1 deep.
function frame(B, F, mat, s0, y0, s1, y1, t0, t1, fw) {
  F.box(B, mat, s0, y1 - fw, t0, s1, y1, t1);
  F.box(B, mat, s0, y0, t0, s1, y0 + fw, t1);
  F.box(B, mat, s0, y0 + fw, t0, s0 + fw, y1 - fw, t1);
  F.box(B, mat, s1 - fw, y0 + fw, t0, s1, y1 - fw, t1);
}

// A curtain panel hanging in soft folds: a sheet from s0 to s1 and y0 to y1,
// its folds swinging amp either side of tc (opening a little toward the hem).
// Coordinates in the piece's frame, with zc the frame's z at t = 0.
function foldedPanel(s0, s1, y0, y1, tc, amp, zc) {
  const folds = Math.max(2, Math.round(Math.abs(s1 - s0) / (5 * IN))), cols = folds * 8, rows = 3;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= rows; j++) {
    const v = j / rows, a = amp * (1.15 - 0.15 * v);
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      pos.push(s0 + (s1 - s0) * u, y0 + (y1 - y0) * v, zc + tc + a * Math.sin(u * folds * 2 * Math.PI));
      uv.push(u, v);
    }
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = j * (cols + 1) + i, c = a + cols + 1;
    idx.push(a, a + 1, c + 1, a, c + 1, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A seed from a piece's uid, so its books and its print stay the same.
function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Pictures drawn in code: screens, prints and book spines. Small, and made
// once per material set.

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function canvasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function grain(g, W, H, rand, alpha = 0.035) {
  for (let i = 0; i < (W * H) / 30; i++) {
    const v = rand() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * rand()})`;
    g.fillRect(rand() * W, rand() * H, 1.5, 1.5);
  }
}
// A ridge of hills from x = 0 to W over a base line, filled down to `floor`.
function ridge(g, W, base, amp, floor, color, rand, step = 12) {
  const ph = rand() * 6, f1 = 0.006 + rand() * 0.006, f2 = 0.02 + rand() * 0.02;
  g.fillStyle = color;
  g.beginPath(); g.moveTo(0, floor);
  for (let x = 0; x <= W + step; x += step) g.lineTo(x, base - amp * (0.55 + 0.35 * Math.sin(x * f1 + ph) + 0.12 * Math.sin(x * f2 + ph * 2)));
  g.lineTo(W + step, floor); g.closePath(); g.fill();
}

const PICTURES = {
  // A lake under mountains at dusk, for TVs.
  tv(g, W, H) {
    const rand = rng(7), hz = H * 0.6;
    const sky = g.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, '#4f74a0'); sky.addColorStop(0.55, '#a7b8cb'); sky.addColorStop(1, '#f3c89c');
    g.fillStyle = sky; g.fillRect(0, 0, W, hz);
    const sx = W * 0.64, sun = g.createRadialGradient(sx, hz - H * 0.05, 0, sx, hz - H * 0.05, H * 0.55);
    sun.addColorStop(0, 'rgba(255,240,210,1)'); sun.addColorStop(0.08, 'rgba(255,224,178,0.75)'); sun.addColorStop(1, 'rgba(255,214,170,0)');
    g.fillStyle = sun; g.fillRect(0, 0, W, hz);
    ridge(g, W, hz, H * 0.26, hz, '#8d9cb2', rand);
    ridge(g, W, hz, H * 0.16, hz, '#64748c', rand);
    ridge(g, W, hz + 2, H * 0.08, hz + 2, '#3f4c5c', rand, 8);
    const lake = g.createLinearGradient(0, hz, 0, H);
    lake.addColorStop(0, '#e2bd98'); lake.addColorStop(0.35, '#8494ab'); lake.addColorStop(1, '#344558');
    g.fillStyle = lake; g.fillRect(0, hz + 2, W, H - hz);
    for (let i = 0; i < 26; i++) {
      const y = hz + 4 + rand() * (H - hz) * 0.7, w = 10 + rand() * 60;
      g.fillStyle = `rgba(255,232,200,${0.25 * (1 - (y - hz) / (H - hz))})`;
      g.fillRect(sx - w / 2 + (rand() - 0.5) * 30, y, w, 1.5);
    }
    ridge(g, W * 0.45, H * 0.95, H * 0.12, H, '#22303a', rand, 6);
  },
  // A calm desktop, for laptops.
  desk(g, W, H) {
    const rand = rng(13);
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#2d4a5e'); bg.addColorStop(0.55, '#6d9a9b'); bg.addColorStop(1, '#e8c7a2');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = `rgba(255,255,255,${0.06 + rand() * 0.06})`;
      g.beginPath(); g.moveTo(0, H);
      const y0 = H * (0.45 + i * 0.12);
      g.bezierCurveTo(W * 0.3, y0 - H * 0.25, W * 0.6, y0 + H * 0.15, W, y0 - H * 0.1);
      g.lineTo(W, H); g.closePath(); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.28)'; g.fillRect(0, 0, W, H * 0.035);
    g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillRect(W * 0.3, H * 0.9, W * 0.4, H * 0.07);
    const icons = ['#e8735a', '#f2c14e', '#5aa36f', '#4b8fd6', '#9b6fd0', '#e0e0e0', '#3d3d3d'];
    icons.forEach((c, i) => { g.fillStyle = c; g.fillRect(W * 0.315 + i * W * 0.054, H * 0.91, W * 0.04, H * 0.05); });
  },
};
const PICTURE_SIZE = { tv: [512, 288], desk: [384, 240] };
function pictureTexture(M, key) {
  return cached(M, `picture:${key}`, () => {
    const [c, g] = canvas(...PICTURE_SIZE[key]);
    PICTURES[key](g, c.width, c.height);
    return canvasTexture(c);
  });
}

// Prints for wall art: a few calm abstract compositions in muted colors,
// each drawn for a landscape, portrait or square print.
const INK = { cream: '#efe8db', sand: '#e0d2bb', clay: '#c27d5c', ochre: '#cfa25a', sage: '#8e9b83', slate: '#5e6c77', ink: '#33312e', blush: '#e6c8b6', moss: '#6e795b' };
const ART = [
  // Sun over hills.
  (g, W, H, rand) => {
    g.fillStyle = INK.cream; g.fillRect(0, 0, W, H);
    g.fillStyle = INK.clay; g.beginPath(); g.arc(W * 0.6, H * 0.4, Math.min(W, H) * 0.2, 0, Math.PI * 2); g.fill();
    ridge(g, W, H * 0.8, H * 0.2, H, INK.sage, rand, 6);
    ridge(g, W, H * 0.95, H * 0.16, H, INK.slate, rand, 6);
  },
  // Soft fields of color.
  (g, W, H) => {
    g.fillStyle = '#d9cdb9'; g.fillRect(0, 0, W, H);
    g.filter = 'blur(3px)';
    g.fillStyle = '#c9a26a'; g.fillRect(W * 0.1, H * 0.08, W * 0.8, H * 0.4);
    g.fillStyle = '#a5614a'; g.fillRect(W * 0.1, H * 0.54, W * 0.8, H * 0.36);
    g.filter = 'none';
  },
  // Nested arches.
  (g, W, H) => {
    g.fillStyle = INK.cream; g.fillRect(0, 0, W, H);
    const R = Math.min(W * 0.4, H * 0.62), cx = W / 2, cy = H * 0.82;
    [INK.clay, INK.sand, INK.sage, INK.ochre, INK.blush].forEach((c, i) => {
      g.fillStyle = c; g.beginPath(); g.arc(cx, cy, R * (1 - i * 0.19), Math.PI, 0); g.fill();
    });
    g.fillStyle = INK.ink; g.fillRect(W * 0.08, cy, W * 0.84, Math.max(2, H * 0.012));
  },
  // Cut-paper shapes.
  (g, W, H, rand) => {
    g.fillStyle = '#f1ebe0'; g.fillRect(0, 0, W, H);
    [[0.32, 0.36, INK.sage], [0.66, 0.58, INK.ochre], [0.42, 0.74, INK.ink]].forEach(([fx, fy, c], k) => {
      const cx = W * fx, cy = H * fy, r = Math.min(W, H) * (0.2 - k * 0.04), n = 7, pts = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, rr = r * (0.75 + rand() * 0.45); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.85]); }
      g.fillStyle = c; g.beginPath();
      const mid = (i) => [(pts[i % n][0] + pts[(i + 1) % n][0]) / 2, (pts[i % n][1] + pts[(i + 1) % n][1]) / 2];
      g.moveTo(...mid(0));
      for (let i = 1; i <= n; i++) g.quadraticCurveTo(...pts[i % n], ...mid(i));
      g.fill();
    });
  },
  // One line and a dot.
  (g, W, H, rand) => {
    g.fillStyle = '#f3eee5'; g.fillRect(0, 0, W, H);
    g.fillStyle = INK.clay; g.beginPath(); g.arc(W * 0.7, H * 0.3, Math.min(W, H) * 0.07, 0, Math.PI * 2); g.fill();
    g.strokeStyle = INK.ink; g.lineWidth = Math.max(2, W * 0.008); g.lineCap = 'round';
    g.beginPath(); g.moveTo(W * 0.15, H * 0.7);
    for (let i = 0; i < 4; i++) g.bezierCurveTo(W * (0.15 + rand() * 0.7), H * (0.2 + rand() * 0.6), W * (0.15 + rand() * 0.7), H * (0.2 + rand() * 0.6), W * (0.2 + i * 0.2), H * (0.45 + rand() * 0.35));
    g.stroke();
  },
  // A horizon at dusk.
  (g, W, H) => {
    const sky = g.createLinearGradient(0, 0, 0, H * 0.62);
    sky.addColorStop(0, '#d9c6b8'); sky.addColorStop(1, '#efd9bf');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.fillStyle = INK.ochre; g.beginPath(); g.arc(W * 0.38, H * 0.62, Math.min(W, H) * 0.1, Math.PI, 0); g.fill();
    const sea = g.createLinearGradient(0, H * 0.62, 0, H);
    sea.addColorStop(0, '#7d8c96'); sea.addColorStop(1, '#46535e');
    g.fillStyle = sea; g.fillRect(0, H * 0.62, W, H * 0.38);
  },
];
function artMaterial(M, n, aspect) {
  const shape = aspect > 1.15 ? 'wide' : aspect < 0.87 ? 'tall' : 'square';
  return cached(M, `art:${n}:${shape}`, () => {
    const [c, g] = canvas(...{ wide: [384, 256], tall: [256, 384], square: [320, 320] }[shape]);
    const rand = rng(31 + n);
    ART[n](g, c.width, c.height, rand);
    grain(g, c.width, c.height, rand);
    return std(0xffffff, 0.85, { map: canvasTexture(c), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  });
}

// Book spines in muted cloth colors, with the cream of the pages at the right.
const SPINES = ['#7b4e3b', '#34445a', '#8a8968', '#b8a27b', '#5c6a5b', '#a6634d', '#d6cdb9', '#2f2f30'];
const SPINE_W = 56;
function bookMaterial(M) {
  return cached(M, 'books', () => {
    const [c, g] = canvas(512, 128), rand = rng(17);
    SPINES.forEach((col, i) => {
      const x = i * SPINE_W;
      g.fillStyle = col; g.fillRect(x, 0, SPINE_W, 128);
      const shade = g.createLinearGradient(x, 0, x + SPINE_W, 0);
      shade.addColorStop(0, 'rgba(0,0,0,0.18)'); shade.addColorStop(0.3, 'rgba(255,255,255,0.05)'); shade.addColorStop(1, 'rgba(0,0,0,0.2)');
      g.fillStyle = shade; g.fillRect(x, 0, SPINE_W, 128);
      const light = i === 6 ? 'rgba(60,50,40,0.5)' : 'rgba(236,222,190,0.55)';
      g.fillStyle = light;
      if (i % 2 === 0) { g.fillRect(x + 6, 12, SPINE_W - 12, 2); g.fillRect(x + 6, 114, SPINE_W - 12, 2); }
      g.fillRect(x + SPINE_W * 0.3, 34 + (i % 3) * 6, SPINE_W * 0.4, 26 + rand() * 18);
    });
    g.fillStyle = '#ece4d1'; g.fillRect(SPINES.length * SPINE_W, 0, 512 - SPINES.length * SPINE_W, 128);
    return std(0xffffff, 0.8, { map: canvasTexture(c) });
  });
}
// A book standing on its bottom edge, spine to the front: the spine shows
// colored cell k of the strip, its covers that color, the rest the pages.
function bookGeometry(x0, x1, y1, z0, z1, k) {
  const g = new THREE.BoxGeometry(x1 - x0, y1, z1 - z0);
  g.translate((x0 + x1) / 2, y1 / 2, (z0 + z1) / 2);
  const uv = g.attributes.uv, u0 = (k * SPINE_W + 1) / 512, u1 = ((k + 1) * SPINE_W - 1) / 512, page = (SPINES.length * SPINE_W + 30) / 512;
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const at = f * 4 + i, u = uv.getX(at), v = uv.getY(at);
    if (f === 4) uv.setXY(at, u0 + u * (u1 - u0), 0.02 + v * 0.96);       // spine
    else if (f < 2) uv.setXY(at, u0 + 2 / 512, 0.3);                      // covers
    else uv.setXY(at, page, 0.5);                                          // pages
  }
  return g;
}

// ---------------------------------------------------------------------------
// Builders work in the piece's frame: s across (centered), t from the back (0)
// to the front (d), y up; sizes in feet. `m` is the piece's main material, X
// the piece itself (its uid, swatch color, and where moving parts go).
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
  // With a TV: a pedestal, the panel, and its screen on the front.
  tvstand(B, M, F, w, d, h, m, X) {
    const main = m ?? M.walnut;
    F.box(B, main, -w / 2, 0.4, 0, w / 2, h, d - 0.03);
    legs(B, M.black, F, w, d, 0.4, 0.1, 0.035);
    const n = w > 4 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const s0 = -w / 2 + (k * w) / n;
      F.box(B, main, s0 + 0.03, 0.45, d - 0.03, s0 + w / n - 0.03, h - 0.05, d);
    }
    if (X.tv) {
      const tw = 4.03, y = h, y0 = y + 0.22, y1 = y0 + tw * 0.5625, bz = 0.03;
      F.box(B, M.black, -0.35, y, d / 2 - 0.25, 0.35, y + 0.04, d / 2 + 0.25);
      F.box(B, M.black, -0.05, y, d / 2 - 0.05, 0.05, y + 0.25, d / 2 + 0.05);
      F.box(B, M.black, -tw / 2, y0, d / 2 - 0.04, tw / 2, y1, d / 2 + 0.035);
      screenPlane(X, F, -tw / 2 + bz, y0 + bz * 1.3, tw / 2 - bz, y1 - bz, d / 2 + 0.038, 'tv');
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
  // Base, pole and a shade (m colors it), lit with a 100 W-like bulb.
  lamp(B, M, F, w, d, h, m, X) {
    const [x, z] = F.p(0, d / 2), r = Math.min(w, d);
    B.cyl(M.black, x, 0, z, r * 0.4, 0.05, 24);
    B.cyl(M.black, x, 0.05, z, 0.03, h - 1.0, 8);
    shadeLamp(X, { x, z, y: h - 1.15, h: 1.15, r0: r * 0.5, r1: r * 0.36, hex: X.hex ?? SHADE, bulb: h - 0.95 + r * 0.07, power: 1.5 });
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

  // -------------------------------------------------------------------------
  // On tables, counters, shelves and dressers.

  // A ceramic jar (m colors it), a brass neck and a linen drum shade.
  'table-lamp'(B, M, F, w, d, h, m, X) {
    const [x, z] = F.p(0, d / 2), r = Math.min(w, d) / 2;
    const sh = h * 0.42, sy = h - sh, bh = h * 0.52, br = Math.min(r * 0.5, bh * 0.32);
    lathe(B, m ?? finish(M, 'ceramic'), JAR, br, bh, x, 0, z);
    B.cyl(finish(M, 'brass'), x, bh, z, r * 0.06, sy + sh * 0.3 - bh, 10);
    shadeLamp(X, { x, z, y: sy, h: sh, r0: r, r1: r * 0.82, hex: SHADE, bulb: sy + sh * 0.3 + r * 0.16, power: 1 });
  },
  // A row of books, spines to the front in muted colors, some taller than
  // others; the row is the same for the same piece every time.
  books(B, M, F, w, d, h, m, X) {
    const rand = rng(seedOf(X.uid)), gap = 0.03 * IN, list = [];
    for (let sum = 0; sum < w;) { const th = (0.75 + rand() * 0.85) * IN; list.push(th); sum += th + gap; }
    const k = (w - gap * (list.length - 1)) / list.reduce((a, b) => a + b, 0);
    const tall = Math.floor(rand() * list.length), mat = bookMaterial(M);
    let s = -w / 2, last = -1;
    list.forEach((th, i) => {
      let c = Math.floor(rand() * SPINES.length);
      if (c === last) c = (c + 1) % SPINES.length;
      last = c;
      const bh = i === tall ? h : h * (0.8 + rand() * 0.18), bd = d * (0.72 + rand() * 0.28);
      const [x0, z1] = F.p(s, d), [x1] = F.p(s + th * k, d);
      B.add(bookGeometry(x0, x1, bh, z1 - bd, z1, c), mat);
      s += th * k + gap;
    });
  },
  // A turned stoneware vase (m colors it).
  vase(B, M, F, w, d, h, m) {
    const [x, z] = F.p(0, d / 2);
    lathe(B, m ?? finish(M, 'stoneware'), VASE, Math.min(w, d) / 2, h, x, 0, z, 24);
  },
  // A small pot (m colors it) and a mound of leaves.
  'plant-small'(B, M, F, w, d, h, m) {
    const [x, z] = F.p(0, d / 2), r = Math.min(w, d) / 2, rp = r * 0.62;
    B.cyl(m ?? M.pot, x, 0, z, rp * 0.8, h * 0.4, 24, rp);
    for (const [dx, y, dz, rk] of smallPlantLeaves(r, h)) {
      const leaf = new THREE.IcosahedronGeometry(rk, 1);
      leaf.translate(x + dx, y, z + dz);
      B.add(leaf, M.plant);
    }
  },
  // A place setting: dinner plate, salad plate and a bowl (m colors them).
  plates(B, M, F, w, d, h, m) {
    const [x, z] = F.p(0, d / 2), R = Math.min(w, d) / 2, ware = m ?? M.plate;
    lathe(B, ware, PLATE, R, h * 0.3, x, 0, z, 28);
    lathe(B, ware, PLATE, R * 0.78, h * 0.25, x, h * 0.105, z, 24);
    lathe(B, ware, BOWL, R * 0.55, h * 0.8075, x, h * 0.1925, z, 24);
  },
  // Open, its lid standing as far back as the footprint lets it (see
  // laptopLid in src/parts.js); m colors the case.
  laptop(B, M, F, w, d, h, m, X) {
    const { bt, lt, tilt, D, hinge } = laptopLid(d, h), body = m ?? finish(M, 'aluminum');
    F.box(B, body, -w / 2, 0, hinge, w / 2, bt, hinge + D);
    F.box(B, M.black, -w / 2 + 0.8 * IN, bt - 0.02 * IN, hinge + 0.5 * IN, w / 2 - 0.8 * IN, bt + 0.03 * IN, hinge + D * 0.55);
    const lid = new THREE.Matrix4().makeTranslation(0, bt, hinge - d / 2).multiply(new THREE.Matrix4().makeRotationX(-tilt));
    B.push(lid);
    B.box(body, -w / 2, 0, -lt, w / 2, D, -0.04 * IN);
    B.box(M.black, -w / 2 + 0.06 * IN, 0.06 * IN, -0.04 * IN, w / 2 - 0.06 * IN, D - 0.06 * IN, 0);
    B.pop();
    const S = new Batch('screen'), sm = screenMat(X, 'desk'), y0 = 0.55 * IN, y1 = D - 0.3 * IN;
    const g = new THREE.PlaneGeometry(w - 0.7 * IN, y1 - y0);
    g.translate(0, (y0 + y1) / 2, 0.02 * IN);
    S.push(lid).add(g, sm).pop();
    part(X, S);
    screen(X, [sm]);
  },
  // Steel (m colors it) with a light cavity, a glass turntable, the controls
  // on the right and the door hinged on the left.
  microwave(B, M, F, w, d, h, m, X) {
    const body = m ?? M.steel, pw = Math.min(4.6 * IN, w * 0.24), st = 0.5 * IN;
    const ft = d - 0.5 * IN, fb = ft - 0.9 * IN, c0 = -w / 2 + st, c1 = w / 2 - pw;
    F.box(B, body, -w / 2, h - st, 0, w / 2, h, fb);
    F.box(B, body, -w / 2, 0, 0, w / 2, st, fb);
    F.box(B, body, -w / 2, st, 0, c0, h - st, fb);
    F.box(B, body, c1, st, 0, w / 2, h - st, fb);
    F.box(B, body, c0, st, 0, c1, h - st, st);
    F.box(B, M.blackGlass, c1, 0, fb, w / 2, h, ft);
    const lining = finish(M, 'lining'), e = 0.05 * IN;
    F.box(B, lining, c0, st, st, c1, st + e, fb);
    F.box(B, lining, c0, h - st - e, st, c1, h - st, fb);
    F.box(B, lining, c0, st, st, c0 + e, h - st, fb);
    F.box(B, lining, c1 - e, st, st, c1, h - st, fb);
    F.box(B, lining, c0, st, st, c1, h - st, st + e);
    const [tx, tz] = F.p((c0 + c1) / 2, (st + fb) / 2);
    B.cyl(lining, tx, st + e, tz, Math.min(c1 - c0, fb - st) * 0.42, 0.2 * IN, 32);
    // The door, turning about its back left corner.
    const D = new Batch('door'), dr = c1 - 0.04 * IN;
    F.box(D, body, -w / 2, 0, fb, dr, h, ft - 0.04 * IN);
    F.box(D, M.blackGlass, -w / 2 + 1.3 * IN, 1.3 * IN, ft - 0.3 * IN, dr - 2.4 * IN, h - 1.3 * IN, ft);
    F.box(D, body, dr - 1.0 * IN, h * 0.2, ft - 0.04 * IN, dr - 0.4 * IN, h * 0.8, d);
    const [px, pz] = F.p(-w / 2, fb);
    const door = part(X, D, [px, 0, pz]);
    X.use = { act: 'door', state: 0, set: (v) => { door.rotation.y = -v * 100 * DEG; } };
  },
  // A drip coffee maker: black body (m colors it), steel lid, glass carafe.
  'coffee-maker'(B, M, F, w, d, h, m) {
    const body = m ?? M.black, tw = d * 0.42, hh = Math.min(3.2 * IN, h * 0.24), pb = 0.9 * IN;
    F.box(B, body, -w / 2, 0, 0, w / 2, pb, d);
    F.box(B, body, -w / 2, pb, 0, w / 2, h - 0.3 * IN, tw);
    F.box(B, body, -w / 2, h - hh, tw, w / 2, h - 0.3 * IN, d);
    F.box(B, M.steelBrushed, -w / 2, h - 0.3 * IN, 0, w / 2, h, d);
    const tc = d * 0.71, rc = Math.min(w / 2 - 0.6 * IN, d - tc - 0.2 * IN), cy = pb + 0.12 * IN, ch = h - hh - 0.25 * IN - cy;
    const [x, z] = F.p(0, tc);
    B.cyl(M.black, x, pb, z, rc * 0.95, 0.12 * IN, 24);
    lathe(B, finish(M, 'carafe'), CARAFE, rc, ch, x, cy, z);
    B.cyl(M.black, x, cy + 0.15 * IN, z, rc * 0.92, ch * 0.4, 24);
    B.cyl(M.black, x, cy + ch * 0.86, z, rc * 0.7, ch * 0.14, 24);
    F.box(B, M.black, rc * 0.9, cy + ch * 0.32, tc - 0.3 * IN, rc + 0.5 * IN, cy + ch * 0.8, tc + 0.3 * IN);
  },

  // -------------------------------------------------------------------------
  // On the walls: t = 0 is the wall.

  // A framed print (m colors the frame), its picture picked by the uid.
  'wall-art'(B, M, F, w, d, h, m, X) {
    const fw = Math.min(1 * IN, w * 0.05, h * 0.05), inset = 0.3 * IN, mg = Math.min(w, h) * 0.1;
    frame(B, F, m ?? M.black, -w / 2, 0, w / 2, h, 0, d, fw);
    F.box(B, finish(M, 'paper'), -w / 2 + fw, fw, 0, w / 2 - fw, h - fw, d - inset);
    const s0 = -w / 2 + fw + mg, s1 = w / 2 - fw - mg, y0 = fw + mg, y1 = h - fw - mg, seed = seedOf(X.uid);
    const g = new THREE.PlaneGeometry(s1 - s0, y1 - y0);
    if (seed & 16) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); }
    const [x, z] = F.p(0, d - inset + 0.03 * IN);
    g.translate(x, (y0 + y1) / 2, z);
    B.add(g, artMaterial(M, seed % ART.length, (s1 - s0) / (y1 - y0)));
  },
  // A slim frame (m colors it) around the glass.
  mirror(B, M, F, w, d, h, m) {
    const fw = Math.min(0.9 * IN, w * 0.05, h * 0.05);
    frame(B, F, m ?? M.black, -w / 2, 0, w / 2, h, 0, d, fw);
    F.box(B, M.mirror, -w / 2 + fw, fw, 0, w / 2 - fw, h - fw, d - 0.25 * IN);
  },
  // A floating shelf (m colors it).
  'wall-shelf'(B, M, F, w, d, h, m) {
    F.box(B, m ?? M.walnut, -w / 2, 0, 0, w / 2, h, d);
  },
  // A slim panel (m colors it) on a wall mount, its screen on the front.
  'wall-tv'(B, M, F, w, d, h, m, X) {
    const t0 = d - Math.min(1.1 * IN, d * 0.6), bz = Math.min(0.35 * IN, w * 0.01);
    F.box(B, M.black, -w * 0.22, h * 0.25, 0, w * 0.22, h * 0.7, t0);
    F.box(B, m ?? M.black, -w / 2, 0, t0, w / 2, h, d - 0.04 * IN);
    screenPlane(X, F, -w / 2 + bz, bz * 1.4, w / 2 - bz, h - bz, d - 0.01 * IN, 'tv');
  },
  // A brass plate on the wall, an arm out and up into a drum shade (m colors it).
  sconce(B, M, F, w, d, h, m, X) {
    const r = Math.min(w, d) / 2, sh = h * 0.55, sy = h - sh, tc = d - r, ay = sy - 0.5 * IN, pw = Math.min(0.9 * IN, w * 0.15), metal = finish(M, 'brass');
    F.box(B, metal, -pw, Math.max(0, ay - 1.6 * IN), 0, pw, ay + 2.6 * IN, 0.5 * IN);
    F.rodT(B, metal, 0, ay, 0.5 * IN, tc, 0.28 * IN);
    const [x, z] = F.p(0, tc);
    B.cyl(metal, x, ay - 0.28 * IN, z, 0.6 * IN, sy + 1.2 * IN - (ay - 0.28 * IN), 12);
    shadeLamp(X, { x, z, y: sy, h: sh, r0: r, r1: r, hex: X.hex ?? SHADE, bulb: sy + 1.2 * IN + r * 0.2, power: 0.5 });
  },
  // A rod with finials (black), on two brackets, over two panels hanging in
  // folds (m colors them), clear of the baseboard and window stool at the
  // bottom. Open, the panels gather at the ends; closed, they meet.
  curtains(B, M, F, w, d, h, m, X) {
    const fr = Math.min(1.2 * IN, d * 0.2), rt = Math.min(3.4 * IN, d - fr), ry = h - fr, rr = 0.55 * IN;
    F.rodS(B, M.black, -w / 2 + fr, w / 2 - fr, ry, rt, rr);
    for (const s of [-w / 2 + fr, w / 2 - fr]) { const [x, z] = F.p(s, rt); sphere(B, M.black, x, ry, z, fr); }
    for (const s of [-w / 2 + 6 * IN, w / 2 - 6 * IN]) {
      F.rodT(B, M.black, s, ry, 0, rt, 0.3 * IN);
      F.box(B, M.black, s - 0.5 * IN, ry - fr, 0, s + 0.5 * IN, ry + fr, 0.3 * IN);
    }
    const { amp, tc } = curtainFolds(d), top = ry - rr - 0.6 * IN, edge = 2 * fr, half = w / 2 - edge;
    const cloth = fabric(M, X.hex ?? LINEN), [, zc] = F.p(0, 0);
    const panel = (s0, s1, pivot) => {
      const P = new Batch('panel');
      P.add(foldedPanel(s0, s1, 0, top, tc, amp, zc), cloth);
      return part(X, P, [pivot, 0, zc + tc]);
    };
    const left = panel(-half, 0, -half), right = panel(0, half, half);
    const gather = Math.min(0.6, Math.max(0.12, (9 * IN) / half));
    X.use = { act: 'curtain', state: 1, set: (v) => { left.scale.x = right.scale.x = 1 - v * (1 - gather); } };
  },
  // A roller shade: the cassette at the top (white), the fabric (m colors it)
  // and its hem bar. Open, it is rolled up into the cassette.
  blinds(B, M, F, w, d, h, m, X) {
    const ch = Math.min(3 * IN, h * 0.1), bh = 0.75 * IN, tf = d * 0.55, L = h - ch - bh, white = finish(M, 'cassette');
    F.box(B, white, -w / 2, h - ch, 0, w / 2, h, d);
    const S = new Batch('shade'), H = new Batch('hem');
    F.box(S, fabric(M, X.hex ?? 0xddd4c5), -w / 2 + 0.4 * IN, bh, tf - 0.04 * IN, w / 2 - 0.4 * IN, h - ch, tf + 0.04 * IN);
    F.box(H, white, -w / 2 + 0.3 * IN, 0, tf - 0.3 * IN, w / 2 - 0.3 * IN, bh, tf + 0.3 * IN);
    const roll = part(X, S, [0, h - ch, 0]), hem = part(X, H);
    X.use = { act: 'curtain', state: 1, set: (v) => { roll.scale.y = 1 - v * 0.985; hem.position.y = v * L * 0.985; } };
  },

  // -------------------------------------------------------------------------
  // From the ceiling: y = h is the ceiling.

  // A canopy, a cord and a dome shade (m colors it, black by default), white
  // inside; inside and the bulb glow while it's on, lighting the table below.
  pendant(B, M, F, w, d, h, m, X) {
    const [x, z] = F.p(0, d / 2), r = Math.min(w, d) / 2, body = m ?? M.black;
    const sh = Math.min(h * 0.6, r * 1.15), cap = Math.min(1.5 * IN, h * 0.05), cy = sh * 0.97 + cap, can = Math.min(2.5 * IN, r);
    lathe(B, body, DOME, r, sh, x, 0, z, 32);
    B.cyl(body, x, sh * 0.97, z, r * 0.15, cap, 16);
    B.cyl(M.black, x, cy, z, 0.12 * IN, Math.max(0.01, h - 1 * IN - cy), 6);
    B.cyl(body, x, h - 1 * IN, z, can, 1 * IN, 24);
    const G = new Batch('glow'), g = glow(X, 'inside', 0xf3efe8, THREE.DoubleSide);
    lathe(G, g, DOME.slice(1).map(([a, b]) => [a * 0.96, b * 0.97]), r, sh, x, 0, z, 32);
    sphere(G, g, x, sh * 0.42, z, r * 0.17);
    part(X, G, null, { shadows: false });
    light(X, [g], [x, sh * 0.3, z], 1, 'down');
  },
  // A canopy, downrod and motor (m colors them, white by default) and five
  // walnut blades that spin while it's on, easing up to speed and down.
  'ceiling-fan'(B, M, F, w, d, h, m, X) {
    const [x, z] = F.p(0, d / 2), R = Math.min(w, d) / 2, k = Math.min(1, h / (14 * IN)), body = m ?? finish(M, 'fanBody');
    const ch = 2.2 * IN * k, mt = 6.5 * IN * k, mb = 1.5 * IN * k, yb = 3.8 * IN * k;
    B.cyl(body, x, h - ch, z, 2.6 * IN, ch, 24, 3 * IN);
    B.cyl(body, x, mt, z, 0.45 * IN, Math.max(0.01, h - ch - mt), 10);
    lathe(B, body, MOTOR, 4.6 * IN, mt - mb, x, mb, z, 32);
    B.cyl(body, x, 0, z, 1.4 * IN, mb, 20, 2.4 * IN);
    const S = new Batch('blades'), bw = Math.min(5 * IN, R * 0.3), r0 = 5.5 * IN, r1 = Math.sqrt(R * R - (bw / 2) ** 2);
    for (let i = 0; i < 5; i++) {
      S.push(new THREE.Matrix4().makeTranslation(x, yb, z).multiply(new THREE.Matrix4().makeRotationY((i / 5) * Math.PI * 2)).multiply(new THREE.Matrix4().makeRotationX(12 * DEG)));
      S.box(M.walnut, r0, -0.18 * IN, -bw / 2, r1, 0.18 * IN, bw / 2);
      S.box(M.black, 3.5 * IN, -0.5 * IN, -0.6 * IN, r0 + 3 * IN, -0.18 * IN, 0.6 * IN);
      S.pop();
    }
    const blades = part(X, S, [x, 0, z]);
    let on = false, speed = 0;
    X.use = {
      act: 'fan', state: false,
      set: (v) => { on = !!v; },
      // Turning the way a fan does in summer (counterclockwise from below).
      tick: (dt) => {
        if (!on && speed < 0.05) { speed = 0; return false; }
        const step = Math.min(dt, 0.1);
        speed += ((on ? 9 : 0) - speed) * Math.min(1, step * 0.9);
        blades.rotation.y = (blades.rotation.y - speed * step) % (Math.PI * 2);
        return true;
      },
    };
  },
};

// What a piece does when used (C1 in the brief): userData.act, state,
// setState(v) and, as it applies, tick(dt) and emitter. setState shows the
// state at once; animators call it every frame with in-between values.
function usable(g, use) {
  const u = g.userData;
  u.act = use.act;
  u.setState = (v) => { u.state = v; use.set(v); };
  u.setState(use.state);
  if (use.tick) u.tick = use.tick;
  if (use.emitter) u.emitter = use.emitter;
}

// One placed piece, as a group positioned and turned in the room.
// item: { uid, type, name, w, d, h (feet), x, z (center, feet), y (underside above the floor, feet), rot (degrees clockwise on the plan), color }
export function buildPiece(M, item, assets = {}) {
  const B = new Batch(`piece-${item.uid}`);
  const X = { M, uid: String(item.uid), hex: swatchHex(item.color), kids: [], use: null };
  const asset = item.type === 'asset' ? assets[item.asset] : null;
  if (asset) buildAsset(B, asset, item, swatchMaterial(M, item.color), X);
  else {
    const def = catalogByType[item.type] ?? catalogByType.box;
    const F = new Frame(0, -item.d / 2, [1, 0], [0, 1]);
    X.tv = def.tv;
    (BUILDERS[def.build ?? def.type] ?? BUILDERS.box)(B, M, F, item.w, item.d, item.h, swatchMaterial(M, item.color), X);
  }
  const g = B.build();
  for (const k of X.kids) g.add(k);
  g.position.set(item.x, item.y ?? 0, item.z);
  g.rotation.y = -THREE.MathUtils.degToRad(item.rot);
  g.traverse((o) => { if (o.isMesh) o.userData.pieceId = item.uid; });
  g.userData.pieceId = item.uid;
  if (X.use) usable(g, X.use);
  return g;
}
