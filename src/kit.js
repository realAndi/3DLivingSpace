import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export { pointInPoly, polygonArea } from './geometry.js';

// Box-project UVs in feet so tiled textures stay continuous across pieces.
export function worldUV(g) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, p.getX(i), -p.getZ(i));
    else if (ax >= az) uv.setXY(i, p.getZ(i) * -Math.sign(n.getX(i)), p.getY(i));
    else uv.setXY(i, p.getX(i) * Math.sign(n.getZ(i)), p.getY(i));
  }
  uv.needsUpdate = true;
  return g;
}

// A mirrored transform turns faces inside out; swap two corners of every triangle.
function flipWinding(g) {
  for (const attr of Object.values(g.attributes)) {
    const a = attr.array, k = attr.itemSize;
    for (let t = 0; t < attr.count; t += 3) {
      for (let c = 0; c < k; c++) {
        const i1 = (t + 1) * k + c, i2 = (t + 2) * k + c;
        const tmp = a[i1]; a[i1] = a[i2]; a[i2] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

export function boxGeo(x0, y0, z0, x1, y1, z1) {
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), d = Math.abs(z1 - z0);
  const g = new THREE.BoxGeometry(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.userData.worldUV = true;
  return g;
}

// Collects geometry per material, then merges it into one mesh per material.
export class Batch {
  constructor(name) {
    this.name = name;
    this.parts = new Map();
    this.stack = [new THREE.Matrix4()];
  }
  get matrix() { return this.stack[this.stack.length - 1]; }
  push(m) { this.stack.push(this.matrix.clone().multiply(m)); return this; }
  pop() { this.stack.pop(); return this; }

  add(geo, mat) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g === geo) g = geo.clone();
    g.applyMatrix4(this.matrix);
    if (this.matrix.determinant() < 0) flipWinding(g);
    if (geo.userData.worldUV) worldUV(g);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(g);
    return this;
  }

  box(mat, x0, y0, z0, x1, y1, z1) {
    return this.add(boxGeo(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)), mat);
  }

  // Vertical cylinder standing on (x, y, z).
  cyl(mat, x, y, z, r, h, seg = 24, r2 = r) {
    const g = new THREE.CylinderGeometry(r2, r, h, seg);
    g.translate(x, y + h / 2, z);
    return this.add(g, mat);
  }

  // Cylinder between two points.
  rod(mat, a, b, r, seg = 12) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    g.applyQuaternion(q);
    g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    return this.add(g, mat);
  }

  build({ shadows = true, receive = true } = {}) {
    const group = new THREE.Group();
    group.name = this.name;
    for (const [mat, geos] of this.parts) {
      const merged = mergeGeometries(geos, false);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = shadows && !mat.transparent;
      mesh.receiveShadow = receive;
      group.add(mesh);
      geos.forEach((g) => g.dispose());
    }
    this.parts.clear();
    return group;
  }
}

// A local frame against a wall: s runs along the wall, t runs out from the wall
// face into the room, y is up. Both directions are axis-aligned, so every local
// box maps to a world box.
export class Frame {
  constructor(ox, oz, u, n) { this.ox = ox; this.oz = oz; this.u = u; this.n = n; }
  p(s, t) { return [this.ox + s * this.u[0] + t * this.n[0], this.oz + s * this.u[1] + t * this.n[1]]; }
  box(batch, mat, s0, y0, t0, s1, y1, t1) {
    const a = this.p(s0, t0), b = this.p(s1, t1);
    batch.box(mat, a[0], y0, a[1], b[0], y1, b[1]);
  }
  // Rod along the frame's t axis (pointing out of the wall).
  rodT(batch, mat, s, y, t0, t1, r) {
    const a = this.p(s, t0), b = this.p(s, t1);
    batch.rod(mat, [a[0], y, a[1]], [b[0], y, b[1]], r);
  }
  rodS(batch, mat, s0, s1, y, t, r) {
    const a = this.p(s0, t), b = this.p(s1, t);
    batch.rod(mat, [a[0], y, a[1]], [b[0], y, b[1]], r);
  }
  // Matrix taking local (x along u, y up, z along n) to world, for non-box parts.
  matrixAt(s, y, t) {
    const [x, z] = this.p(s, t);
    return new THREE.Matrix4().makeBasis(
      new THREE.Vector3(this.u[0], 0, this.u[1]),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(this.n[0], 0, this.n[1]),
    ).setPosition(x, y, z);
  }
}

export const DIRS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

// Feet to a 9' 10½" style string.
export function feetInches(ft, { precision = 1 } = {}) {
  const total = Math.round((ft * 12) / precision) * precision;
  const f = Math.floor(total / 12);
  const i = total - f * 12;
  return `${f}' ${Number.isInteger(i) ? i : i.toFixed(1)}"`;
}


export function centroid(poly) {
  let x = 0, z = 0;
  poly.forEach((p) => { x += p[0]; z += p[1]; });
  return [x / poly.length, z / poly.length];
}


// Seeded random numbers so the generated textures and city look the same every load.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
