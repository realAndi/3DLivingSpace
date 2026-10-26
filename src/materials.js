import * as THREE from 'three';
import { rng } from './kit.js';
import { canvas, fit, initTextures, load, textureQuality, textureSet } from './textures.js';

// Finish palette sampled from the photos: greige LVP plank floor, white walls,
// light rift-oak cabinets with matte-black bar pulls, white quartz, white
// subway backsplash, large-format warm-gray porcelain in the bath.
//
// Those finishes are drawn in code, with a height picture beside each color
// one: src/textures.js works normal and roughness maps out of the heights.
// Furniture fabrics, leather, walnut, carpet, marble and concrete are CC0
// photo scans (assets/tex/SOURCES.md), loaded when a material is first used.

function hsl(h, s, l, a = 1) { return `hsla(${h},${s}%,${l}%,${a})`; }

function speckle(g, w, h, rand, count, alpha) {
  for (let i = 0; i < count; i++) {
    const v = rand() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * rand()})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
}

// Low quality keeps code-drawn color maps at half size.
const sized = ({ color, ...rest }, q) => ({ color: q === 'low' ? fit(color, Math.max(color.width, color.height) / 2) : color, ...rest });

// Roughness ramp through two (height, roughness) points, as textureSet's
// `rough: [at black, at white]`.
function through(h0, r0, h1, r1) {
  const b = (r1 - r0) / (h1 - h0);
  return [r0 - b * h0, r0 + b * (1 - h0)];
}

// 7" x 48" planks running east-west, as in the living room photo. The
// defaults are the greige LVP; hue, sat and lit pick another stain. The
// height picture has the plank joints and the embossed grain.
function woodFloor({ hue: H0 = 30, sat: S0 = 16, lit: L0 = 55, seed = 11 } = {}) {
  const W = 2048, H = 1024, rows = 7, plankPx = 1024; // 8' x 4'1" of floor
  const rand = rng(seed);
  const [c, g] = canvas(W, H);
  const [bc, bg] = canvas(W, H);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, W, H);
  const rowH = H / rows;
  for (let r = 0; r < rows; r++) {
    const y0 = r * rowH;
    const offset = Math.floor(rand() * plankPx);
    for (let k = -1; k < W / plankPx + 1; k++) {
      const x0 = offset + k * plankPx;
      const hue = H0 + rand() * 4, sat = S0 + rand() * 6, lit = L0 + rand() * 6;
      const draw = (dx) => {
        g.save(); bg.save();
        for (const x of [g, bg]) { x.beginPath(); x.rect(x0 + dx, y0, plankPx, rowH); x.clip(); }
        g.fillStyle = hsl(hue, sat, lit); g.fillRect(x0 + dx, y0, plankPx, rowH);
        // Long soft color bands, then fine grain lines.
        for (let b = 0; b < 6; b++) {
          g.fillStyle = hsl(hue, sat, lit + (rand() - 0.5) * 7, 0.22);
          g.fillRect(x0 + dx, y0 + rand() * rowH, plankPx, 4 + rand() * 16);
        }
        for (let l = 0; l < 46; l++) {
          const yy = y0 + rand() * rowH, amp = 1 + rand() * 5, freq = 0.002 + rand() * 0.006, ph = rand() * 6.28;
          const dark = rand() < 0.75, alpha = dark ? 0.08 + rand() * 0.12 : 0.12;
          const line = new Path2D();
          for (let x = 0; x <= plankPx; x += 16) {
            const y = yy + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 3.1 + ph) * amp * 0.3;
            x === 0 ? line.moveTo(x0 + dx + x, y) : line.lineTo(x0 + dx + x, y);
          }
          g.strokeStyle = dark ? hsl(hue - 4, sat + 6, lit - 18, alpha) : hsl(hue, sat, lit + 14, 0.12);
          g.lineWidth = 0.6 + rand() * 1.6;
          g.stroke(line);
          // The emboss follows the printed grain: dark lines sink, light ones rise.
          bg.strokeStyle = dark ? `rgba(0,0,0,${alpha * 0.9})` : 'rgba(255,255,255,0.08)';
          bg.lineWidth = g.lineWidth + 1;
          bg.stroke(line);
        }
        if (rand() < 0.35) {
          const kx = x0 + dx + 80 + rand() * (plankPx - 160), ky = y0 + rowH * (0.3 + rand() * 0.4);
          for (let ring = 6; ring > 0; ring--) {
            g.strokeStyle = hsl(hue - 6, sat + 8, lit - 12 - ring * 2, 0.18);
            g.beginPath(); g.ellipse(kx, ky, ring * 7, ring * 2.4, 0, 0, Math.PI * 2); g.stroke();
          }
        }
        g.restore(); bg.restore();
        // Plank end joint.
        g.fillStyle = 'rgba(55,42,32,0.55)'; g.fillRect(x0 + dx, y0, 2, rowH);
        bg.fillStyle = '#3a3a3a'; bg.fillRect(x0 + dx, y0, 3, rowH);
      };
      draw(0);
      if (x0 + plankPx > W) draw(-W);
      if (x0 < 0) draw(W);
    }
    // Long-edge joint with a soft micro-bevel.
    g.fillStyle = 'rgba(50,38,30,0.5)'; g.fillRect(0, y0, W, 2);
    g.fillStyle = 'rgba(255,245,230,0.08)'; g.fillRect(0, y0 + 2, W, 2);
    bg.fillStyle = '#383838'; bg.fillRect(0, y0, W, 3);
    bg.fillStyle = '#5c5c5c'; bg.fillRect(0, y0 + 3, W, 2);
  }
  speckle(g, W, H, rand, 30000, 0.05);
  return { color: c, height: bc };
}

// Large-format porcelain. Sizes in feet; `bond` offsets alternate rows. The
// height picture sinks the grout and rounds the `bevel` edges.
function tiles({ tileW, tileH, cols, rows, base, grout, bond = 0.5, pxPerFt = 128, mottle = 4, seed = 3, bevel = 0, veins = 0 }) {
  const W = Math.round(cols * tileW * pxPerFt), H = Math.round(rows * tileH * pxPerFt);
  const rand = rng(seed);
  const [c, g] = canvas(W, H);
  const [bc, bg] = canvas(W, H);
  g.fillStyle = grout; g.fillRect(0, 0, W, H);
  bg.fillStyle = '#303030'; bg.fillRect(0, 0, W, H);
  const gw = Math.max(2, pxPerFt * 0.012); // thin grout line, about 1/8"
  const tw = tileW * pxPerFt, th = tileH * pxPerFt;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bond * tw;
    for (let k = 0; k < cols; k++) {
      const x = k * tw + off, y = r * th;
      const [h, s, l] = base;
      const lit = l + (rand() - 0.5) * mottle;
      const fill = (dx) => {
        g.save();
        g.beginPath(); g.rect(x + dx + gw / 2, y + gw / 2, tw - gw, th - gw); g.clip();
        g.fillStyle = hsl(h, s, lit);
        g.fillRect(x + dx + gw / 2, y + gw / 2, tw - gw, th - gw);
        for (let m = 0; m < 14; m++) {
          g.fillStyle = hsl(h, s, lit + (rand() - 0.5) * 5, 0.14);
          const rx = x + dx + rand() * tw, ry = y + rand() * th;
          g.beginPath(); g.ellipse(rx, ry, 20 + rand() * 80, 10 + rand() * 40, rand() * 3, 0, Math.PI * 2); g.fill();
        }
        // Faint natural-stone veins drifting across the tile.
        for (let v = 0; v < (veins ? 3 : 0); v++) {
          g.strokeStyle = hsl(h, s, lit - 14 - rand() * 10, veins * (0.4 + rand() * 0.6));
          g.lineWidth = 0.6 + rand() * 1.8;
          g.beginPath();
          let vx = x + dx + rand() * tw, vy = y + rand() * th;
          g.moveTo(vx, vy);
          for (let k = 0; k < 5; k++) { vx += (rand() - 0.3) * tw * 0.35; vy += (rand() - 0.5) * th * 0.3; g.lineTo(vx, vy); }
          g.stroke();
        }
        if (bevel) {
          g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x + dx + gw / 2, y + gw / 2, tw - gw, bevel);
          g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(x + dx + gw / 2, y + th - gw / 2 - bevel, tw - gw, bevel);
        }
        g.restore();
        // Height: the face, stepped up from the grout through the bevel.
        const steps = Math.max(1, bevel);
        for (let i = 0; i < steps; i++) {
          const v = 0x60 + Math.round((0x9a - 0x60) * Math.sin(((i + 1) / steps) * Math.PI / 2));
          bg.fillStyle = `rgb(${v},${v},${v})`;
          bg.fillRect(x + dx + gw / 2 + i, y + gw / 2 + i, tw - gw - 2 * i, th - gw - 2 * i);
        }
      };
      g.save(); g.beginPath(); g.rect(0, y, W, th); g.clip();
      bg.save(); bg.beginPath(); bg.rect(0, y, W, th); bg.clip();
      fill(0);
      if (x + tw > W) fill(-W); // wrap so the texture tiles seamlessly
      bg.restore(); g.restore();
    }
  }
  speckle(g, W, H, rand, Math.round(W * H / 60), 0.04);
  return { color: c, height: bc };
}

// Rift-cut light oak with a fine vertical grain (UV v = height). The open
// grain (the darker strands) sits a touch lower and rougher.
function oak({ base = [33, 40, 63], seed = 5 } = {}) {
  const W = 512, H = 1024; // 2' x 4'
  const rand = rng(seed);
  const [c, g] = canvas(W, H);
  const [bc, bg] = canvas(W, H);
  const [h, s, l] = base;
  g.fillStyle = hsl(h, s, l); g.fillRect(0, 0, W, H);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    const x = rand() * W, w = 0.5 + rand() * 2.2;
    const dark = rand() < 0.7;
    const lit = dark ? l - 10 - rand() * 10 : l + 8, alpha = dark ? 0.16 + rand() * 0.2 : 0.2;
    g.fillStyle = dark ? hsl(h - 3, s + 6, lit, alpha) : hsl(h + 2, s - 5, lit, alpha);
    bg.fillStyle = dark ? `rgba(0,0,0,${alpha * 1.4})` : `rgba(255,255,255,${alpha * 0.5})`;
    // A wandering edge, pulled back to where it started so the grain tiles
    // seamlessly up a tall panel.
    const strand = new Path2D();
    let xx = x;
    const walk = [];
    for (let y = 0; y <= H; y += 32) { xx += (rand() - 0.5) * 1.2; walk.push([xx, y]); }
    const drift = xx - x;
    strand.moveTo(x, 0);
    for (const [px, y] of walk) strand.lineTo(px - (drift * y) / H, y);
    strand.lineTo(x + w, H);
    for (let y = H; y >= 0; y -= 32) strand.lineTo(x + w + (rand() - 0.5) * 0.8, y);
    g.fill(strand);
    bg.fill(strand);
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = hsl(h, s, l + (rand() - 0.5) * 10, 0.12);
    g.fillRect(rand() * W, 0, 6 + rand() * 30, H);
  }
  speckle(g, W, H, rand, 6000, 0.05);
  return { color: c, height: bc };
}

// White quartz: fine aggregate and the faintest veining.
function stone({ base = '#f1efeb', veins = 0.08, seed = 9 } = {}) {
  const S = 1024;
  const rand = rng(seed);
  const [c, g] = canvas(S, S);
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  speckle(g, S, S, rand, 18000, 0.035);
  g.filter = 'blur(1.2px)';
  for (let v = 0; v < 9; v++) {
    g.strokeStyle = `rgba(120,118,115,${veins * (0.4 + rand())})`;
    g.lineWidth = 0.8 + rand() * 3.5;
    g.beginPath();
    let x = rand() * S, y = rand() * S;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      const nx = x + (rand() - 0.3) * 420, ny = y + (rand() - 0.5) * 260;
      g.bezierCurveTo(x + rand() * 120, y + rand() * 120, nx - rand() * 120, ny - rand() * 120, nx, ny);
      x = nx; y = ny;
    }
    g.stroke();
  }
  g.filter = 'none';
  return { color: c };
}

// Exterior deck: 5½" boards with ¼" gaps running east-west.
function deck({ seed = 81 } = {}) {
  const W = 1024, boards = 16, boardPx = 61.33, gap = 2.67; // 128 px/ft: 8' x 8'
  const H = Math.round(boards * (boardPx + gap));
  const rand = rng(seed);
  const [c, g] = canvas(W, H);
  const [bc, bg] = canvas(W, H);
  g.fillStyle = '#2c2723'; g.fillRect(0, 0, W, H);
  bg.fillStyle = '#202020'; bg.fillRect(0, 0, W, H);
  for (let r = 0; r < boards; r++) {
    const y0 = r * (boardPx + gap) + gap / 2;
    // Boards 4' or 8' long (both divide the tile), joints staggered by row.
    const len = rand() < 0.5 ? 512 : 1024, off = Math.floor(rand() * len);
    for (let x0 = off - len; x0 < W; x0 += len) {
      const hue = 26 + rand() * 6, sat = 22 + rand() * 8, lit = 40 + rand() * 9;
      const grain = Array.from({ length: 22 }, () => ({
        y: y0 + rand() * boardPx, dy: (rand() - 0.5) * 4, width: 0.6 + rand() * 1.4,
        color: hsl(hue, sat, lit + (rand() < 0.6 ? -10 : 8), 0.12 + rand() * 0.12),
      }));
      const draw = (dx) => {
        g.save();
        g.beginPath(); g.rect(x0 + dx + 1, y0, len - 2, boardPx); g.clip();
        g.fillStyle = hsl(hue, sat, lit); g.fillRect(x0 + dx, y0, len, boardPx);
        for (const l of grain) {
          g.strokeStyle = l.color; g.lineWidth = l.width;
          g.beginPath(); g.moveTo(x0 + dx, l.y); g.lineTo(x0 + dx + len, l.y + l.dy); g.stroke();
        }
        g.restore();
        bg.fillStyle = '#a0a0a0'; bg.fillRect(x0 + dx + 1, y0, len - 2, boardPx);
        // Weathered grain: the darker lines are raised ridges worn between.
        bg.save(); bg.beginPath(); bg.rect(x0 + dx + 1, y0, len - 2, boardPx); bg.clip();
        for (const l of grain) {
          bg.strokeStyle = 'rgba(0,0,0,0.2)'; bg.lineWidth = l.width + 1;
          bg.beginPath(); bg.moveTo(x0 + dx, l.y); bg.lineTo(x0 + dx + len, l.y + l.dy); bg.stroke();
        }
        bg.restore();
      };
      draw(0);
      if (x0 + len > W) draw(-W);
      if (x0 < 0) draw(W);
    }
  }
  speckle(g, W, H, rand, 20000, 0.05);
  return { color: c, height: bc };
}

// Brushed stainless: fine streaks along u, as a height picture (no color).
function brushed({ seed = 91 } = {}) {
  const W = 512, H = 512; // 1' x 1'
  const rand = rng(seed);
  const [c, g] = canvas(W, H);
  g.fillStyle = '#808080'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    const v = rand() < 0.5 ? 0 : 255, y = rand() * H, x = rand() * W, len = 40 + rand() * 420;
    g.fillStyle = `rgba(${v},${v},${v},${0.04 + rand() * 0.12})`;
    g.fillRect(x, y, len, 0.6 + rand() * 0.8);
    if (x + len > W) g.fillRect(x - W, y, len, 0.6 + rand() * 0.8);
  }
  return { height: c };
}

// ---------------------------------------------------------------------------
// Wall paint: one shared material per color.
const paints = new Map();
export function paint(hex) {
  const key = typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '#f2f1ee';
  if (!paints.has(key)) paints.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(key), roughness: 0.92, metalness: 0 }));
  return paints.get(key);
}

// The material for a unit floor kind (src/unit.js FLOORS). `tile` is the
// unit's tile finish, for tile floors.
const FLOOR_KEYS = { wood: 'floor', 'wood-dark': 'floorDark', stone: 'stoneFloor', carpet: 'carpet', concrete: 'concrete', deck: 'deck' };
export function floorMaterial(M, kind, { tile = 'warm-gray' } = {}) {
  if (kind === 'tile') return tileMaterial(M, tile, 'floor');
  return M[FLOOR_KEYS[kind] ?? 'floor'];
}

// Porcelain tile in one of the unit's tile finishes, for floors or walls.
const TILE_KEYS = { 'warm-gray': ['tileFloor', 'tileWall'], white: ['tileFloorWhite', 'tileWallWhite'], charcoal: ['tileFloorCharcoal', 'tileWallCharcoal'] };
export function tileMaterial(M, finish = 'warm-gray', where = 'floor') {
  const keys = TILE_KEYS[finish] ?? TILE_KEYS['warm-gray'];
  return M[keys[where === 'wall' ? 1 : 0]];
}

// Textured materials are made on first use, so a phone only draws and loads
// the textures a unit needs.
function lazy(M, key, make) {
  Object.defineProperty(M, key, {
    configurable: true, enumerable: true,
    get() {
      const value = make();
      Object.defineProperty(M, key, { value, writable: true, configurable: true, enumerable: true });
      return value;
    },
  });
}

// Textures shared by several materials, made when the first of them is.
function once(make) {
  let value = null;
  return () => (value ??= make());
}

// Gray tone maps (fabric, leather, carpet) average about this much in linear
// light, so their materials' colors are divided by it: a gray sofa stays the
// same gray, now with a weave.
const TONE = 0.6;
const toned = (hex) => new THREE.Color(hex).multiplyScalar(1 / TONE);

// A material of `base`'s kind (same textures) in another color, cached. For
// tinting fabric, leather or wood pieces: tone-mapped bases keep their weave.
const tints = new WeakMap();
export function tinted(base, hex) {
  if (!tints.has(base)) tints.set(base, new Map());
  const cache = tints.get(base);
  if (!cache.has(hex)) {
    const m = base.clone();
    m.color = base.userData.toned ? toned(hex) : new THREE.Color(hex);
    cache.set(hex, m);
  }
  return cache.get(hex);
}

export function createMaterials(renderer, { onChange } = {}) {
  initTextures(renderer, { onChange });
  const std = (color, roughness = 0.8, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra });
  const pbr = (set, extra = {}) => new THREE.MeshStandardMaterial({ ...set, ...extra });
  // Fabric-like: a gray tone map tinted by the material color.
  const cloth = (set, hex, extra = {}) => Object.assign(pbr(set, { color: toned(hex), ...extra }), { userData: { toned: true } });

  // Code-drawn sets. Grout, joints and the open grain are rougher than the
  // faces, so reflections break up the way they do on the real finishes.
  const wood = (opts) => textureSet({
    feet: [8, 4.083], now: true, relief: 0.012, rough: through(0.22, 1, 0.5, 0.6), roughAt: 0.6,
    make: (q) => sized(woodFloor(opts), q),
  });
  // Tiles keep their full size on low quality too: halved, the grout lines fade.
  const tile = (opts, face) => {
    const feet = [opts.cols * opts.tileW, opts.rows * opts.tileH];
    return textureSet({ feet, now: true, relief: 0.015, rough: through(0.19, 1, 0.6, face), roughAt: face, make: () => tiles(opts) });
  };
  const deckSet = () => textureSet({ feet: [8, 8], now: true, relief: 0.03, rough: through(0.13, 1, 0.63, 0.85), roughAt: 0.85, make: (q) => sized(deck(), q) });

  // Photo sets (assets/tex/), loaded on first use.
  const files = (names) => async (q) => {
    const pics = await Promise.all(Object.values(names).map((n) => load(n, q)));
    return Object.fromEntries(Object.keys(names).map((k, i) => [k, pics[i]]));
  };
  // A gray picture that is both the tone and the height (woven things).
  const weave = (name) => async (q) => { const p = await load(name, q); return { color: p, height: p }; };

  const M = {
    wall: std(0xf2f1ee, 0.92),
    ceiling: std(0xf6f5f2, 0.95),
    wallTop: std(0x4c4a47, 0.9),
    wallCap: new THREE.MeshBasicMaterial({ color: 0x4c4a47, side: THREE.BackSide }),
    slab: std(0xc9c5bf, 0.95),
    trim: std(0xf7f6f3, 0.42),
    door: std(0xf5f4f1, 0.38),
    windowFrame: std(0xf8f8f6, 0.32),
    black: std(0x1c1c1c, 0.45, { metalness: 0.25 }),
    blackGlass: std(0x0b0c0d, 0.07),
    toeKick: std(0x2d2a27, 0.85),
    porcelain: std(0xfbfbf9, 0.12),
    ceramic: std(0xefebe4, 0.22),
    appliance: std(0xf1f1ef, 0.3),
    glass: new THREE.MeshStandardMaterial({ color: 0xd4e6ea, roughness: 0.02, transparent: true, opacity: 0.1, depthWrite: false }),
    showerGlass: new THREE.MeshStandardMaterial({ color: 0xe1eeee, roughness: 0.02, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
    mirror: new THREE.MeshStandardMaterial({ color: 0xe6eaee, metalness: 1, roughness: 0.04 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xdfe2e5, metalness: 1, roughness: 0.08 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc39c5c, metalness: 1, roughness: 0.32 }),
    led: new THREE.MeshBasicMaterial({ color: 0xfff6e6 }),
    canLight: std(0xffffff, 0.3, { emissive: 0xfff3dc, emissiveIntensity: 0.55 }),
    vent: std(0xe2e1de, 0.6),
    plate: std(0xf5f5f2, 0.4),
    curtain: std(0xf4f2ee, 0.95, { side: THREE.DoubleSide }),

    // Staging furniture
    customPiece: std(0xc9c2b6, 0.8),
    lampShade: std(0xf6f1e6, 0.9, { emissive: 0xfff1d6, emissiveIntensity: 0.25 }),
    screen: std(0x111213, 0.15),
    plant: std(0x5f7a52, 0.9),
    pot: std(0xe4dfd6, 0.7),
  };

  // Floors, tile and kitchen finishes (drawn in code).
  lazy(M, 'floor', () => pbr(wood(), { roughness: 0.86 }));
  lazy(M, 'floorDark', () => pbr(wood({ hue: 24, sat: 26, lit: 27, seed: 13 }), { roughness: 0.84 }));
  lazy(M, 'tileFloor', () => pbr(tile({ tileW: 4, tileH: 2, cols: 2, rows: 2, base: [36, 9, 82], grout: '#c3beb6', seed: 21 }, 0.37), { roughness: 0.95 }));
  lazy(M, 'tileWall', () => pbr(tile({ tileW: 4, tileH: 2, cols: 2, rows: 3, base: [30, 5, 73], grout: '#d3d0cb', seed: 23, mottle: 3 }, 0.32), { roughness: 0.95 }));
  lazy(M, 'subway', () => pbr(tile({ tileW: 1, tileH: 0.25, cols: 2, rows: 4, base: [40, 12, 95], grout: '#d5d2cc', pxPerFt: 256, mottle: 1.5, seed: 31, bevel: 3 }, 0.2), { roughness: 0.9 }));
  lazy(M, 'oak', () => pbr(textureSet({ feet: [2, 4], now: true, relief: 0.004, rough: through(0.3, 1, 0.5, 0.92), roughAt: 0.93, make: (q) => sized(oak(), q) }), { roughness: 0.66 }));
  lazy(M, 'quartz', () => pbr(textureSet({ feet: [4, 4], now: true, make: (q) => sized(stone({ veins: 0.05 }), q) }), { roughness: 0.16 }));
  lazy(M, 'stoneFloor', () => pbr(tile({ tileW: 2, tileH: 2, cols: 2, rows: 2, base: [34, 20, 64], grout: '#a89f92', bond: 0, mottle: 9, seed: 51, veins: 0.22 }, 0.46), { roughness: 0.92 }));
  lazy(M, 'deck', () => pbr(deckSet(), { roughness: 0.96 }));
  // Tile finishes besides the warm gray.
  lazy(M, 'tileFloorWhite', () => pbr(tile({ tileW: 4, tileH: 2, cols: 2, rows: 2, base: [40, 8, 90], grout: '#cfcbc4', seed: 25, mottle: 2 }, 0.32), { roughness: 0.95 }));
  lazy(M, 'tileFloorCharcoal', () => pbr(tile({ tileW: 4, tileH: 2, cols: 2, rows: 2, base: [30, 4, 30], grout: '#5c5955', seed: 27, mottle: 3 }, 0.4), { roughness: 0.95 }));
  lazy(M, 'tileWallWhite', () => pbr(tile({ tileW: 4, tileH: 2, cols: 2, rows: 3, base: [40, 6, 93], grout: '#d9d6d0', seed: 29, mottle: 1.5 }, 0.27), { roughness: 0.95 }));
  lazy(M, 'tileWallCharcoal', () => pbr(tile({ tileW: 4, tileH: 2, cols: 2, rows: 3, base: [30, 4, 32], grout: '#4e4b48', seed: 33, mottle: 3 }, 0.32), { roughness: 0.95 }));

  // Brushed stainless: streaks in the roughness and a hint of them in the
  // normals. Steel and brushed steel share them; steel is the glossier.
  const streaks = once(() => textureSet({ feet: [1, 1], color: false, relief: 0.0004, rough: [1.25, 0.55], roughAt: 0.9, make: () => brushed() }));
  // On high quality the highlights stretch along the grain (anisotropic
  // reflection); phones keep the cheaper standard shader.
  const metal = (extra) => (textureQuality() === 'high'
    ? new THREE.MeshPhysicalMaterial({ ...streaks(), metalness: 1, anisotropy: 0.5, ...extra })
    : pbr(streaks(), { metalness: 1, ...extra }));
  lazy(M, 'steel', () => metal({ color: 0xc7c9cb, roughness: 0.32 }));
  lazy(M, 'steelBrushed', () => metal({ color: 0xb4b6b8, roughness: 0.46 }));

  // Photo-scanned finishes.
  lazy(M, 'marble', () => pbr(textureSet({ feet: [4, 4], placeholder: '#e6e8ea', make: files({ color: 'marble-color' }) }), { roughness: 0.14 }));
  lazy(M, 'concrete', () => pbr(textureSet({ feet: [8, 8], placeholder: '#a7a39c', relief: 0.003, detail: 0.5, rough: through(0.3, 1, 0.7, 0.8), roughAt: 0.9, make: files({ color: 'concrete-color', height: 'concrete-height' }) }), { roughness: 0.72 }));
  lazy(M, 'walnut', () => pbr(textureSet({ feet: [5.9, 5.9], placeholder: '#6b4b34', relief: 0.0008, detail: 0.5, rough: through(0.3, 0.94, 0.7, 0.84), roughAt: 0.89, make: files({ color: 'walnut-color', height: 'walnut-height' }) }), { roughness: 0.6 }));
  lazy(M, 'carpet', () => cloth(textureSet({ feet: [5.6, 5.6], placeholder: '#c6c6c6', relief: 0.004, detail: 0.5, tone: [0.67, 0.85], make: files({ height: 'carpet-height' }) }), 0xb3aa9e, { roughness: 1 }));
  lazy(M, 'rug', () => cloth(textureSet({ feet: [1.2, 1.2], placeholder: '#cccccc', relief: 0.012, detail: 0.5, make: weave('rug-tone') }), 0xd8d1c4, { roughness: 1 }));

  // Upholstery, bedding and leather, tinted gray tones.
  const upholstery = once(() => textureSet({ feet: [1, 1], placeholder: '#cccccc', relief: 0.002, detail: 0.5, make: weave('fabric-tone') }));
  const bedding = once(() => textureSet({ feet: [0.8, 0.8], placeholder: '#d1d1d1', relief: 0.001, detail: 0.5, make: weave('linen-tone') }));
  lazy(M, 'fabric', () => cloth(upholstery(), 0x8e8984, { roughness: 0.97 }));
  lazy(M, 'fabricDark', () => cloth(upholstery(), 0x5f5b56, { roughness: 0.97 }));
  lazy(M, 'cushion', () => cloth(upholstery(), 0xd9d3c8, { roughness: 0.97 }));
  lazy(M, 'headboard', () => cloth(upholstery(), 0xb8ab98, { roughness: 0.95 }));
  lazy(M, 'linen', () => cloth(bedding(), 0xf3f1ec, { roughness: 0.95 }));
  lazy(M, 'duvet', () => cloth(bedding(), 0xe9e5dd, { roughness: 0.95 }));
  lazy(M, 'leather', () => cloth(textureSet({ feet: [0.8, 0.8], placeholder: '#cccccc', relief: 0.002, detail: 0.5, tone: [0.6, 0.96], rough: true, roughAt: 0.8, make: files({ height: 'leather-height', rough: 'leather-rough' }) }), 0x6a4430, { roughness: 0.62 }));
  return M;
}
