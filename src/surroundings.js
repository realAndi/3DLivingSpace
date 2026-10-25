import * as THREE from 'three';
import { Batch, rng } from './kit.js';

// What you see out the windows in walk mode, sketched from the photos:
// brick mid-rises close by to the north-east, low flat-roofed houses and trees
// to the east, and two residential towers far off to the east-south-east.
// The unit sits on an upper floor, so the street is ~40' below.

const GROUND = -40;

function facadeTexture({ brick, mortar, glass, frame, floors = 3, cols = 4, seed = 1, ac = true }) {
  const S = 512; // 32' x 32'
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rand = rng(seed);
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
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 32, 1 / 32);
  return t;
}

function towerTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  const rand = rng(77);
  g.fillStyle = '#c9b48f'; g.fillRect(0, 0, 256, 512);
  for (let y = 4; y < 512; y += 16) for (let x = 6; x < 256; x += 21) {
    g.fillStyle = rand() < 0.1 ? '#8c99a3' : '#5f6d78';
    g.fillRect(x, y, 13, 9);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 60, 1 / 120);
  return t;
}

function skyDome() {
  const geo = new THREE.SphereGeometry(4500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x5f97d0) }, horizon: { value: new THREE.Color(0xdde9f1) }, ground: { value: new THREE.Color(0xb9b8b2) } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vDir;
      void main(){ float h = vDir.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, min(1.0, -h * 6.0));
      gl_FragColor = vec4(c, 1.0); }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}

export function buildSurroundings() {
  const rand = rng(42);
  const B = new Batch('city');
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.9, ...o });
  const brickA = std({ map: facadeTexture({ brick: [12, 52, 42], mortar: '#b9a99a', glass: '#3c4650', frame: '#e9e6df', seed: 3 }) });
  const brickB = std({ map: facadeTexture({ brick: [18, 48, 46], mortar: '#c4b5a5', glass: '#46505a', frame: '#d8d3c8', floors: 3, cols: 5, seed: 8 }) });
  const brickC = std({ map: facadeTexture({ brick: [8, 40, 36], mortar: '#a8988a', glass: '#323a42', frame: '#cfc9be', seed: 13, ac: false }) });
  const roof = std({ color: 0x9a9893 });
  const roofLight = std({ color: 0xc9c7c1 });
  const siding = [0xd7d2c6, 0xc4c8c9, 0xe3ddcf, 0xb9aea0, 0xd0c3b0].map((c) => std({ color: c }));
  const ownFacade = std({ color: 0xc8c2b8 });
  const treeMat = std({ color: 0x6f8a4c });
  const treeMat2 = std({ color: 0x8a9a52 });
  const trunk = std({ color: 0x5b4a3a });
  const groundMat = std({ color: 0x8e8c86 });
  const tower = std({ map: towerTexture(), roughness: 0.7 });

  const building = (mat, x0, z0, x1, z1, top, roofMat = roof) => {
    B.box(mat, x0, GROUND, z0, x1, top, z1);
    B.box(roofMat, x0 - 0.3, top, z0 - 0.3, x1 + 0.3, top + 1.2, z1 + 0.3);
  };

  // Our own building around and below the unit, flush with its outside walls.
  B.box(ownFacade, -80, GROUND, -0.01, 35.3, -0.62, 90);
  B.box(ownFacade, 35.3, GROUND, 11.45, 37.33, -0.62, 90);
  B.box(ownFacade, -80, 10.6, -0.01, 37.33, 21, 90);

  // Brick mid-rises: close to the north-east, one taller block further back.
  building(brickA, 46, -46, 92, 6, 4);
  B.box(roofLight, 70, 5.2, -30, 78, 8, -22);
  building(brickB, 58, -150, 140, -78, 24);
  for (let x = 60; x < 138; x += 4) B.box(roof, x, 25, -79.5, x + 0.3, 29, -79.2);
  building(brickC, -34, -128, 42, -58, 16);
  building(brickA, 150, -60, 205, 10, -8);

  // Low flat-roofed houses and street trees to the east.
  for (let gx = 0; gx < 9; gx++) for (let gz = 0; gz < 9; gz++) {
    const x0 = 70 + gx * 52 + rand() * 6, z0 = -150 + gz * 46 + rand() * 6;
    if (x0 < 130 && z0 < 20) continue;
    const top = GROUND + 22 + rand() * 12;
    building(siding[(gx * 3 + gz) % siding.length], x0, z0, x0 + 30 + rand() * 10, z0 + 34, top, rand() < 0.5 ? roofLight : roof);
  }
  for (let i = 0; i < 70; i++) {
    const x = 60 + rand() * 480, z = -160 + rand() * 420, r = 8 + rand() * 9;
    const crown = new THREE.IcosahedronGeometry(r, 1);
    crown.translate(x, GROUND + 18 + r, z);
    B.add(crown, rand() < 0.5 ? treeMat : treeMat2);
    B.cyl(trunk, x, GROUND, z, 1.2, 20, 6);
  }

  // Two towers about half a mile away, east-south-east of the living window.
  B.box(tower, 2440, GROUND, 380, 2560, 290, 500);
  B.box(roof, 2445, 290, 385, 2555, 302, 495);
  B.box(tower, 2560, GROUND, 290, 2620, 250, 350);

  B.box(groundMat, -3000, GROUND - 1, -3000, 3000, GROUND, 3000);

  const group = B.build({ shadows: false, receive: false });
  group.add(skyDome());
  return group;
}
