import * as THREE from 'three';
import { Batch, rng } from './kit.js';

// What you see out the windows in walk mode: the unit's own building below and
// above it, brick mid-rises across the street, low flat-roofed houses and trees
// beyond, a few towers far off, and the sky. Laid out around the unit's
// outline (U.bounds) and its floor (U.level), from a seed taken from the unit,
// so a unit always looks out on the same street. The time of day
// (src/lighting.js) colors the sky and lights windows across the street at
// night, through setOutdoor.

const FLOOR_TO_FLOOR = 13.3;   // the street sits this far below per floor up

// Night windows: lit ones in warm and cool whites, the rest dark.
const LIT = ['#ffd9a0', '#ffe7c2', '#ffcf8a', '#fff1dc', '#dfe8ff'];

function canvasTexture(c, repeat) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  return t;
}

// A brick facade, and its night glow: the same windows, about a third lit.
function facadeTexture({ brick, mortar, glass, frame, floors = 3, cols = 4, seed = 1, ac = true }) {
  const S = 512; // 32' x 32'
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const n = document.createElement('canvas');
  n.width = n.height = 128;
  const ng = n.getContext('2d');
  ng.fillStyle = '#000'; ng.fillRect(0, 0, 128, 128);
  const rand = rng(seed), lit = rng(seed + 101);
  g.fillStyle = mortar; g.fillRect(0, 0, S, S);
  const bh = 6, bw = 16;
  for (let y = 0; y < S; y += bh) {
    const off = (y / bh) % 2 ? bw / 2 : 0;
    for (let x = -bw; x < S; x += bw) {
      const l = (rand() - 0.5) * 14;
      g.fillStyle = `hsl(${brick[0] + (rand() - 0.5) * 6},${brick[1]}%,${brick[2] + l}%)`;
      g.fillRect(x + off + 1, y + 1, bw - 1, bh - 1);
    }
  }
  const fh = S / floors, cw = S / cols;
  for (let f = 0; f < floors; f++) for (let k = 0; k < cols; k++) {
    const x = k * cw + cw * 0.22, y = f * fh + fh * 0.22, w = cw * 0.56, h = fh * 0.52;
    g.fillStyle = frame; g.fillRect(x - 3, y - 3, w + 6, h + 6);
    g.fillStyle = glass; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, y, w, h * 0.35);
    g.fillStyle = frame; g.fillRect(x + w / 2 - 2, y, 4, h);
    if (ac && rand() < 0.3) { g.fillStyle = '#d9d7d2'; g.fillRect(x + w * 0.1, y + h * 0.62, w * 0.42, h * 0.3); }
    if (lit() < 0.42) {
      ng.globalAlpha = 0.45 + lit() * 0.55;
      ng.fillStyle = LIT[Math.floor(lit() * LIT.length)];
      ng.fillRect(x / 4, y / 4, w / 4, h / 4);
    }
  }
  return { map: canvasTexture(c, [1 / 32, 1 / 32]), glow: canvasTexture(n, [1 / 32, 1 / 32]) };
}

function towerTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  const n = document.createElement('canvas');
  n.width = 256; n.height = 512;
  const ng = n.getContext('2d');
  ng.fillStyle = '#000'; ng.fillRect(0, 0, 256, 512);
  const rand = rng(77), lit = rng(78);
  g.fillStyle = '#c9b48f'; g.fillRect(0, 0, 256, 512);
  for (let y = 4; y < 512; y += 16) for (let x = 6; x < 256; x += 21) {
    g.fillStyle = rand() < 0.1 ? '#8c99a3' : '#5f6d78';
    g.fillRect(x, y, 13, 9);
    if (lit() < 0.3) {
      ng.globalAlpha = 0.4 + lit() * 0.6;
      ng.fillStyle = LIT[Math.floor(lit() * LIT.length)];
      ng.fillRect(x, y, 13, 9);
    }
  }
  return { map: canvasTexture(c, [1 / 60, 1 / 120]), glow: canvasTexture(n, [1 / 60, 1 / 120]) };
}

// The sky: a gradient up from the horizon, the sun's disc and glow, and the
// moon. Colors and directions come from setOutdoor.
function skyDome() {
  const geo = new THREE.SphereGeometry(4500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x5f97d0) }, horizon: { value: new THREE.Color(0xdde9f1) }, ground: { value: new THREE.Color(0xb9b8b2) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(0xfff0dc) }, sunAmt: { value: 0 },
      moonDir: { value: new THREE.Vector3(0, 1, 0) }, moonAmt: { value: 0 },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vDir;
      uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunAmt; uniform vec3 moonDir; uniform float moonAmt;
      void main(){ vec3 d = normalize(vDir); float h = d.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, min(1.0, -h * 6.0));
        float s = max(dot(d, sunDir), 0.0), up = step(-0.01, h);
        c += sunColor * sunAmt * up * (0.18 * pow(s, 10.0) + 0.45 * pow(s, 160.0) + 2.0 * smoothstep(0.99985, 0.99992, s));
        float m = max(dot(d, moonDir), 0.0);
        c += vec3(0.2, 0.24, 0.32) * moonAmt * up * 0.18 * pow(m, 30.0);
        c = mix(c, vec3(0.82, 0.84, 0.88), moonAmt * up * smoothstep(0.99978, 0.99986, m));
        gl_FragColor = vec4(c, 1.0); }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}

// Materials and textures don't depend on the unit: made once, kept across rebuilds.
let shared = null;
function materials() {
  if (shared) return shared;
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.9, ...o });
  // Lit windows are an emissive map from the start, so night only turns it up.
  const lit = ({ map, glow }, o = {}) => std({ map, emissiveMap: glow, emissive: 0xffffff, emissiveIntensity: 0, ...o });
  shared = {
    bricks: [
      lit(facadeTexture({ brick: [12, 52, 42], mortar: '#b9a99a', glass: '#3c4650', frame: '#e9e6df', seed: 3 })),
      lit(facadeTexture({ brick: [18, 48, 46], mortar: '#c4b5a5', glass: '#46505a', frame: '#d8d3c8', floors: 3, cols: 5, seed: 8 })),
      lit(facadeTexture({ brick: [8, 40, 36], mortar: '#a8988a', glass: '#323a42', frame: '#cfc9be', seed: 13, ac: false })),
    ],
    roof: std({ color: 0x9a9893 }),
    roofLight: std({ color: 0xc9c7c1 }),
    siding: [0xd7d2c6, 0xc4c8c9, 0xe3ddcf, 0xb9aea0, 0xd0c3b0].map((c) => std({ color: c })),
    ownFacade: std({ color: 0xc8c2b8 }),
    trees: [std({ color: 0x6f8a4c }), std({ color: 0x8a9a52 })],
    trunk: std({ color: 0x5b4a3a }),
    ground: std({ color: 0x8e8c86 }),
    tower: lit(towerTexture(), { roughness: 0.7 }),
    sky: skyDome(),
  };
  return shared;
}

// The time of day outside: the sky's colors, the directions to the sun and
// moon (unit vectors) and how much of each shows, and how dark it is (0 day,
// 1 night) for the lit windows.
export function setOutdoor({ top, horizon, ground, sunDir, sunColor, sunAmt, moonDir, moonAmt, night }) {
  const S = materials(), u = S.sky.material.uniforms;
  u.top.value.copy(top); u.horizon.value.copy(horizon); u.ground.value.copy(ground);
  u.sunDir.value.copy(sunDir); u.sunColor.value.copy(sunColor); u.sunAmt.value = sunAmt;
  u.moonDir.value.copy(moonDir); u.moonAmt.value = moonAmt;
  for (const m of S.bricks) m.emissiveIntensity = night * 1.6;
  S.tower.emissiveIntensity = night * 1.3;
}

// A number from the unit's outline and floor, so the same unit gets the same street.
function seedOf(U) {
  const b = U.bounds;
  let h = 2166136261;
  for (const v of [b.x0, b.z0, b.x1, b.z1, U.level].map((n) => Math.round(n * 4))) {
    h ^= v & 0xffff; h = Math.imul(h, 16777619);
    h ^= v >>> 16; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Which sides of the outline have windows or glass doors to the outside.
function glassSides(U) {
  const sides = { north: false, south: false, east: false, west: false };
  for (const o of U.openings ?? []) {
    if (o.rooms?.[1] || !(o.kind === 'window' || o.type === 'slider')) continue;
    const [nx, nz] = o.n;
    if (Math.abs(nx) >= Math.abs(nz)) sides[nx > 0 ? 'east' : 'west'] = true;
    else sides[nz > 0 ? 'south' : 'north'] = true;
  }
  return sides;
}

export function buildSurroundings(U) {
  const S = materials();
  const rand = rng(seedOf(U));
  const B = new Batch('city');
  const { x0, z0, x1, z1 } = U.bounds;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const ceiling = Math.max(U.heights?.ceiling ?? 9, ...(U.rooms ?? []).map((r) => r.ceiling ?? 0));
  const GROUND = -Math.max(2, ((U.level ?? 1) - 1) * FLOOR_TO_FLOOR);

  const building = (mat, bx0, bz0, bx1, bz1, top, roofMat = S.roof) => {
    B.box(mat, bx0, GROUND, bz0, bx1, top, bz1);
    B.box(roofMat, bx0 - 0.3, top, bz0 - 0.3, bx1 + 0.3, top + 1.2, bz1 + 0.3);
  };

  // Our own building, flush with the unit's outside walls on the sides it
  // looks out from and running on past it on the others.
  const glass = glassSides(U);
  const any = Object.values(glass).some(Boolean);
  const reach = (side) => (any && glass[side] ? 0 : 30 + rand() * 50);
  const own = { x0: x0 - reach('west'), z0: z0 - reach('north'), x1: x1 + reach('east'), z1: z1 + reach('south') };
  B.box(S.ownFacade, own.x0, GROUND, own.z0, own.x1, -0.62, own.z1);
  const above = ceiling + 1.6;
  B.box(S.ownFacade, own.x0, above, own.z0, own.x1, above + 10.4 + Math.floor(rand() * 2) * 10.4, own.z1);

  // Brick mid-rises across the street, a few on every side, some lower than
  // the unit so the view clears them.
  const near = [];
  const street = () => 34 + rand() * 26;
  const sides = [
    { axis: 'z', sign: -1, edge: own.z0, lo: own.x0, hi: own.x1 },
    { axis: 'z', sign: 1, edge: own.z1, lo: own.x0, hi: own.x1 },
    { axis: 'x', sign: -1, edge: own.x0, lo: own.z0, hi: own.z1 },
    { axis: 'x', sign: 1, edge: own.x1, lo: own.z0, hi: own.z1 },
  ];
  for (const s of sides) {
    let along = s.lo - 60 - rand() * 30;
    const end = s.hi + 60;
    while (along < end) {
      const len = 40 + rand() * 50, depth = 34 + rand() * 40, gap = street();
      if (rand() < 0.8) {
        const top = Math.min(-2 + rand() * 28, 30) + (rand() < 0.25 ? -14 : 0);
        const a0 = along, a1 = along + len, d0 = s.edge + s.sign * gap, d1 = d0 + s.sign * depth;
        const r = s.axis === 'z'
          ? [a0, Math.min(d0, d1), a1, Math.max(d0, d1)]
          : [Math.min(d0, d1), a0, Math.max(d0, d1), a1];
        building(S.bricks[Math.floor(rand() * 3)], ...r, top, rand() < 0.3 ? S.roofLight : S.roof);
        near.push(r);
        // Rooftop boxes: stair and elevator bulkheads.
        if (rand() < 0.5) {
          const bx = r[0] + (r[2] - r[0]) * (0.2 + rand() * 0.5), bz = r[1] + (r[3] - r[1]) * (0.2 + rand() * 0.5);
          B.box(S.roofLight, bx, top + 1.2, bz, bx + 8, top + 4.5 + rand() * 3, bz + 8);
        }
      }
      along += len + 12 + rand() * 20;
    }
  }

  // Low flat-roofed houses and street trees, in a ring beyond.
  const clear = { x0: own.x0 - 140, z0: own.z0 - 140, x1: own.x1 + 140, z1: own.z1 + 140 };
  const inside = (x, z, r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
  const R = 520;
  for (let gx = cx - R; gx < cx + R; gx += 52) for (let gz = cz - R; gz < cz + R; gz += 46) {
    const hx0 = gx + rand() * 6, hz0 = gz + rand() * 6, hx1 = hx0 + 30 + rand() * 10, hz1 = hz0 + 34;
    if (rand() < 0.22) continue;
    if (inside(hx0, hz0, clear) || inside(hx1, hz1, clear) || inside(hx0, hz1, clear) || inside(hx1, hz0, clear)) continue;
    const top = GROUND + 22 + rand() * 12;
    building(S.siding[Math.floor(rand() * S.siding.length)], hx0, hz0, hx1, hz1, top, rand() < 0.5 ? S.roofLight : S.roof);
  }
  const crown = new THREE.IcosahedronGeometry(1, 1);
  for (let i = 0; i < 110; i++) {
    const a = rand() * Math.PI * 2, d = 120 + rand() * 420;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d, r = 8 + rand() * 9;
    if (inside(x, z, { x0: own.x0 - 20, z0: own.z0 - 20, x1: own.x1 + 20, z1: own.z1 + 20 })) continue;
    if (near.some((n) => x > n[0] - r && x < n[2] + r && z > n[1] - r && z < n[3] + r)) continue;
    const g = crown.clone().scale(r, r, r).translate(x, GROUND + 18 + r, z);
    B.add(g, S.trees[i % 2]);
    B.cyl(S.trunk, x, GROUND, z, 1.2, 20, 6);
  }
  crown.dispose();

  // A few towers half a mile off.
  const towers = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < towers; i++) {
    const a = rand() * Math.PI * 2, d = 2200 + rand() * 500;
    const tx = cx + Math.cos(a) * d, tz = cz + Math.sin(a) * d;
    const w = 60 + rand() * 60, dp = 60 + rand() * 60, top = 220 + rand() * 90;
    B.box(S.tower, tx - w / 2, GROUND, tz - dp / 2, tx + w / 2, top, tz + dp / 2);
    B.box(S.roof, tx - w / 2 + 5, top, tz - dp / 2 + 5, tx + w / 2 - 5, top + 12, tz + dp / 2 - 5);
  }

  B.box(S.ground, cx - 3000, GROUND - 1, cz - 3000, cx + 3000, GROUND, cz + 3000);

  const group = B.build({ shadows: false, receive: false });
  const built = [...group.children];
  group.add(S.sky);
  S.sky.position.set(cx, 0, cz);
  group.userData.dispose = () => {
    for (const m of built) m.geometry.dispose();
    if (S.sky.parent === group) group.remove(S.sky);
  };
  group.dispose = group.userData.dispose;
  return group;
}
