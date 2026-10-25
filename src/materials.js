import * as THREE from 'three';
import { rng } from './kit.js';

// Finish palette sampled from the photos: greige LVP plank floor, white walls,
// light rift-oak cabinets with matte-black bar pulls, white quartz, white
// subway backsplash, large-format warm-gray porcelain in the bath.

let anisotropy = 8;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

// UVs are in feet, so `repeat` turns feet into texture tiles.
function texture(c, feetU, feetV, { color = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / feetU, 1 / feetV);
  t.anisotropy = anisotropy;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hsl(h, s, l, a = 1) { return `hsla(${h},${s}%,${l}%,${a})`; }

function speckle(g, w, h, rand, count, alpha) {
  for (let i = 0; i < count; i++) {
    const v = rand() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * rand()})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
}

// 7" x 48" planks running east-west, as in the living room photo.
function woodFloor() {
  const W = 2048, H = 1024, rows = 7, plankPx = 1024; // 8' x 4'1" of floor
  const rand = rng(11);
  const [c, g] = canvas(W, H);
  const [bc, bg] = canvas(W, H);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, W, H);
  const rowH = H / rows;
  for (let r = 0; r < rows; r++) {
    const y0 = r * rowH;
    const offset = Math.floor(rand() * plankPx);
    for (let k = -1; k < W / plankPx + 1; k++) {
      const x0 = offset + k * plankPx;
      const hue = 30 + rand() * 4, sat = 16 + rand() * 6, lit = 55 + rand() * 6;
      const draw = (dx) => {
        g.save();
        g.beginPath(); g.rect(x0 + dx, y0, plankPx, rowH); g.clip();
        g.fillStyle = hsl(hue, sat, lit); g.fillRect(x0 + dx, y0, plankPx, rowH);
        // Long soft color bands, then fine grain lines.
        for (let b = 0; b < 6; b++) {
          g.fillStyle = hsl(hue, sat, lit + (rand() - 0.5) * 7, 0.22);
          g.fillRect(x0 + dx, y0 + rand() * rowH, plankPx, 4 + rand() * 16);
        }
        for (let l = 0; l < 46; l++) {
          const yy = y0 + rand() * rowH, amp = 1 + rand() * 5, freq = 0.002 + rand() * 0.006, ph = rand() * 6.28;
          g.strokeStyle = rand() < 0.75 ? hsl(hue - 4, sat + 6, lit - 18, 0.08 + rand() * 0.12) : hsl(hue, sat, lit + 14, 0.12);
          g.lineWidth = 0.6 + rand() * 1.6;
          g.beginPath();
          for (let x = 0; x <= plankPx; x += 16) {
            const y = yy + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 3.1 + ph) * amp * 0.3;
            x === 0 ? g.moveTo(x0 + dx + x, y) : g.lineTo(x0 + dx + x, y);
          }
          g.stroke();
        }
        if (rand() < 0.35) {
          const kx = x0 + dx + 80 + rand() * (plankPx - 160), ky = y0 + rowH * (0.3 + rand() * 0.4);
          for (let ring = 6; ring > 0; ring--) {
            g.strokeStyle = hsl(hue - 6, sat + 8, lit - 12 - ring * 2, 0.18);
            g.beginPath(); g.ellipse(kx, ky, ring * 7, ring * 2.4, 0, 0, Math.PI * 2); g.stroke();
          }
        }
        g.restore();
        // Plank end joint.
        g.fillStyle = 'rgba(55,42,32,0.55)'; g.fillRect(x0 + dx, y0, 2, rowH);
        bg.fillStyle = '#3a3a3a'; bg.fillRect(x0 + dx, y0, 2, rowH);
      };
      draw(0);
      if (x0 + plankPx > W) draw(-W);
      if (x0 < 0) draw(W);
    }
    // Long-edge joint with a soft micro-bevel.
    g.fillStyle = 'rgba(50,38,30,0.5)'; g.fillRect(0, y0, W, 2);
    g.fillStyle = 'rgba(255,245,230,0.08)'; g.fillRect(0, y0 + 2, W, 2);
    bg.fillStyle = '#383838'; bg.fillRect(0, y0, W, 3);
  }
  speckle(g, W, H, rand, 30000, 0.05);
  const map = texture(c, 8, 4.083);
  const bump = texture(bc, 8, 4.083, { color: false });
  return { map, bump };
}

// Large-format porcelain. Sizes in feet; `bond` offsets alternate rows.
function tiles({ tileW, tileH, cols, rows, base, grout, bond = 0.5, pxPerFt = 128, mottle = 4, seed = 3, bevel = 0 }) {
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
        if (bevel) {
          g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x + dx + gw / 2, y + gw / 2, tw - gw, bevel);
          g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(x + dx + gw / 2, y + th - gw / 2 - bevel, tw - gw, bevel);
        }
        g.restore();
        bg.fillStyle = '#9a9a9a'; bg.fillRect(x + dx + gw / 2, y + gw / 2, tw - gw, th - gw);
      };
      g.save(); g.beginPath(); g.rect(0, y, W, th); g.clip();
      bg.save(); bg.beginPath(); bg.rect(0, y, W, th); bg.clip();
      fill(0);
      if (x + tw > W) fill(-W); // wrap so the texture tiles seamlessly
      bg.restore(); g.restore();
    }
  }
  speckle(g, W, H, rand, Math.round(W * H / 60), 0.04);
  return { map: texture(c, cols * tileW, rows * tileH), bump: texture(bc, cols * tileW, rows * tileH, { color: false }) };
}

// Rift-cut light oak with a fine vertical grain (UV v = height).
function oak({ base = [33, 40, 63], seed = 5 } = {}) {
  const W = 512, H = 1024; // 2' x 4'
  const rand = rng(seed);
  const [c, g] = canvas(W, H);
  const [h, s, l] = base;
  g.fillStyle = hsl(h, s, l); g.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    const x = rand() * W, w = 0.5 + rand() * 2.2;
    g.fillStyle = rand() < 0.7 ? hsl(h - 3, s + 6, l - 10 - rand() * 10, 0.16 + rand() * 0.2) : hsl(h + 2, s - 5, l + 8, 0.2);
    g.beginPath();
    let xx = x;
    g.moveTo(xx, 0);
    for (let y = 0; y <= H; y += 32) { xx += (rand() - 0.5) * 1.2; g.lineTo(xx, y); }
    g.lineTo(xx + w, H);
    for (let y = H; y >= 0; y -= 32) g.lineTo(x + w + (rand() - 0.5) * 0.8, y);
    g.fill();
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = hsl(h, s, l + (rand() - 0.5) * 10, 0.12);
    g.fillRect(rand() * W, 0, 6 + rand() * 30, H);
  }
  speckle(g, W, H, rand, 6000, 0.05);
  return texture(c, 2, 4);
}

// White quartz / marble-look stone. `veins` controls how strong the veining is.
function stone({ base = '#f1efeb', veins = 0.08, seed = 9, size = 4 } = {}) {
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
  return texture(c, size, size);
}

export function createMaterials(renderer) {
  anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const std = (color, roughness = 0.8, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra });

  const wood = woodFloor();
  const bathFloor = tiles({ tileW: 4, tileH: 2, cols: 2, rows: 2, base: [36, 9, 82], grout: '#c3beb6', seed: 21 });
  const bathWall = tiles({ tileW: 4, tileH: 2, cols: 2, rows: 3, base: [30, 5, 73], grout: '#d3d0cb', seed: 23, mottle: 3 });
  const subway = tiles({ tileW: 1, tileH: 0.25, cols: 2, rows: 4, base: [40, 12, 95], grout: '#d5d2cc', pxPerFt: 256, mottle: 1.5, seed: 31, bevel: 3 });

  const M = {
    wall: std(0xf2f1ee, 0.92),
    ceiling: std(0xf6f5f2, 0.95),
    wallTop: std(0x4c4a47, 0.9),
    wallCap: new THREE.MeshBasicMaterial({ color: 0x4c4a47, side: THREE.BackSide }),
    slab: std(0xc9c5bf, 0.95),
    trim: std(0xf7f6f3, 0.42),
    door: std(0xf5f4f1, 0.38),
    windowFrame: std(0xf8f8f6, 0.32),
    floor: new THREE.MeshStandardMaterial({ map: wood.map, bumpMap: wood.bump, bumpScale: 0.7, roughness: 0.52 }),
    tileFloor: new THREE.MeshStandardMaterial({ map: bathFloor.map, bumpMap: bathFloor.bump, bumpScale: 0.6, roughness: 0.35 }),
    tileWall: new THREE.MeshStandardMaterial({ map: bathWall.map, bumpMap: bathWall.bump, bumpScale: 0.6, roughness: 0.3 }),
    subway: new THREE.MeshStandardMaterial({ map: subway.map, bumpMap: subway.bump, bumpScale: 0.8, roughness: 0.18 }),
    oak: new THREE.MeshStandardMaterial({ map: oak(), roughness: 0.62 }),
    quartz: new THREE.MeshStandardMaterial({ map: stone({ veins: 0.05 }), roughness: 0.16 }),
    marble: new THREE.MeshStandardMaterial({ map: stone({ veins: 0.32, seed: 4, size: 3 }), roughness: 0.14 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xc7c9cb, metalness: 1, roughness: 0.3 }),
    steelBrushed: new THREE.MeshStandardMaterial({ color: 0xb4b6b8, metalness: 1, roughness: 0.42 }),
    black: std(0x1c1c1c, 0.45, { metalness: 0.25 }),
    blackGlass: std(0x0b0c0d, 0.07),
    toeKick: std(0x2d2a27, 0.85),
    porcelain: std(0xfbfbf9, 0.12),
    appliance: std(0xf1f1ef, 0.3),
    glass: new THREE.MeshStandardMaterial({ color: 0xd4e6ea, roughness: 0.02, transparent: true, opacity: 0.1, depthWrite: false }),
    showerGlass: new THREE.MeshStandardMaterial({ color: 0xe1eeee, roughness: 0.02, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
    mirror: new THREE.MeshStandardMaterial({ color: 0xe6eaee, metalness: 1, roughness: 0.04 }),
    led: new THREE.MeshBasicMaterial({ color: 0xfff6e6 }),
    canLight: std(0xffffff, 0.3, { emissive: 0xfff3dc, emissiveIntensity: 0.55 }),
    vent: std(0xe2e1de, 0.6),
    plate: std(0xf5f5f2, 0.4),
    curtain: std(0xf4f2ee, 0.95, { side: THREE.DoubleSide }),

    // Staging furniture
    linen: std(0xf3f1ec, 0.95),
    duvet: std(0xe9e5dd, 0.95),
    headboard: std(0xb8ab98, 0.95),
    fabric: std(0x8e8984, 0.97),
    fabricDark: std(0x5f5b56, 0.97),
    cushion: std(0xd9d3c8, 0.97),
    walnut: new THREE.MeshStandardMaterial({ map: oak({ base: [26, 34, 36], seed: 12 }), roughness: 0.55 }),
    rug: std(0xd8d1c4, 1.0),
    customPiece: std(0xc9c2b6, 0.8),
    lampShade: std(0xf6f1e6, 0.9, { emissive: 0xfff1d6, emissiveIntensity: 0.25 }),
    screen: std(0x111213, 0.15),
    plant: std(0x5f7a52, 0.9),
    pot: std(0xe4dfd6, 0.7),
  };
  return M;
}
