import * as THREE from 'three';
import { Batch, Frame } from './kit.js';
import { X, Z, HEIGHT } from './plan.js';

// Primary bath: the plan draws a corner shower and a toilet on the west wall,
// but the photos show a full-width walk-in shower with a fixed glass panel on
// the west, the vanity on the south wall and the toilet beside it against the
// east (door) wall. The model follows the photos inside the plan's walls.
const P = { x0: X(446), x1: X(595), z0: Z(79), z1: Z(247), ceiling: HEIGHT.ceiling };
const SHOWER_X = 16.6;
const WAINSCOT = 4.0;

// Hall bath: not photographed, so it follows the plan with the same finishes.
const H2 = { x0: X(258), x1: X(440), z0: Z(513), z1: Z(699), tubX0: X(440), tubX1: X(504), tubZ0: Z(570) };

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// Black-framed rounded mirror on a wall frame, centered at s, bottom at y0.
function mirror(B, M, F, s, y0, w, h, r = 0.28) {
  B.push(F.matrixAt(s, y0 + h / 2, 0.012));
  const outer = roundedRect(w, h, r);
  outer.holes.push(roundedRect(w - 0.09, h - 0.09, r - 0.04));
  B.add(new THREE.ExtrudeGeometry(outer, { depth: 0.07, bevelEnabled: false, curveSegments: 10 }), M.black);
  const glass = new THREE.ShapeGeometry(roundedRect(w - 0.08, h - 0.08, r - 0.04), 10);
  glass.translate(0, 0, 0.035);
  B.add(glass, M.mirror);
  B.pop();
}

function bar(B, M, F, s, y, w) {
  F.box(B, M.black, s - w / 2, y, 0, s + w / 2, y + 0.09, 0.14);
  F.box(B, M.led, s - w / 2 + 0.05, y - 0.008, 0.03, s + w / 2 - 0.05, y, 0.12);
  F.box(B, M.black, s - 0.22, y - 0.12, 0, s + 0.22, y + 0.2, 0.05);
}

// Vanity against a wall frame, centered on s; doors, false front, stone top, undermount bowl, faucet.
function vanity(B, M, F, s, w, d) {
  const s0 = s - w / 2, s1 = s + w / 2, top = 2.72;
  F.box(B, M.toeKick, s0 + 0.08, 0, 0, s1 - 0.08, 0.3, d - 0.2);
  F.box(B, M.oak, s0, 0.3, 0, s1, top, d - 0.06);
  F.box(B, M.oak, s0 + 0.01, top - 0.42, d - 0.06, s1 - 0.01, top - 0.01, d);
  const mid = (s0 + s1) / 2;
  F.box(B, M.oak, s0 + 0.01, 0.31, d - 0.06, mid - 0.006, top - 0.44, d);
  F.box(B, M.oak, mid + 0.006, 0.31, d - 0.06, s1 - 0.01, top - 0.44, d);
  for (const ps of [mid - 0.12, mid + 0.12]) {
    F.box(B, M.black, ps - 0.017, top - 1.2, d + 0.07, ps + 0.017, top - 0.7, d + 0.1);
    F.box(B, M.black, ps - 0.01, top - 1.15, d, ps + 0.01, top - 1.12, d + 0.07);
    F.box(B, M.black, ps - 0.01, top - 0.78, d, ps + 0.01, top - 0.75, d + 0.07);
  }
  // Top with an opening for the bowl.
  const bw = Math.min(1.4, w - 0.6), b0 = s - bw / 2, b1 = s + bw / 2, t0 = 0.45, t1 = d - 0.22;
  const ty0 = top, ty1 = top + 0.12, od = d + 0.04;
  F.box(B, M.marble, s0 - 0.02, ty0, 0, b0, ty1, od);
  F.box(B, M.marble, b1, ty0, 0, s1 + 0.02, ty1, od);
  F.box(B, M.marble, b0, ty0, 0, b1, ty1, t0);
  F.box(B, M.marble, b0, ty0, t1, b1, ty1, od);
  const by = ty0 - 0.45;
  F.box(B, M.porcelain, b0, by, t0, b1, by + 0.03, t1);
  F.box(B, M.porcelain, b0, by, t0, b0 + 0.03, ty0, t1);
  F.box(B, M.porcelain, b1 - 0.03, by, t0, b1, ty0, t1);
  F.box(B, M.porcelain, b0, by, t0, b1, ty0, t0 + 0.03);
  F.box(B, M.porcelain, b0, by, t1 - 0.03, b1, ty0, t1);
  // Square single-lever faucet.
  F.box(B, M.black, s - 0.05, ty1, 0.15, s + 0.05, ty1 + 0.55, 0.27);
  F.box(B, M.black, s - 0.05, ty1 + 0.45, 0.27, s + 0.05, ty1 + 0.55, 0.62);
  F.box(B, M.black, s - 0.025, ty1 + 0.55, 0.18, s + 0.025, ty1 + 0.62, 0.36);
}

// Elongated toilet, tank against the wall frame's face, centered on s.
function toilet(B, M, F, s) {
  B.push(F.matrixAt(s, 0, 0));
  B.box(M.porcelain, -0.82, 1.38, 0.03, 0.82, 2.42, 0.72);
  B.box(M.porcelain, -0.86, 2.42, 0.0, 0.86, 2.52, 0.76);
  B.box(M.porcelain, -0.36, 0.95, 0.6, 0.36, 1.42, 1.05);
  const ped = new THREE.CylinderGeometry(0.42, 0.34, 0.95, 28);
  ped.scale(1, 1, 1.35); ped.translate(0, 0.475, 1.28);
  B.add(ped, M.porcelain);
  const bowl = new THREE.CylinderGeometry(0.62, 0.46, 0.45, 32);
  bowl.scale(1, 1, 1.32); bowl.translate(0, 1.15, 1.5);
  B.add(bowl, M.porcelain);
  const seat = new THREE.CylinderGeometry(0.64, 0.64, 0.06, 32);
  seat.scale(1, 1, 1.32); seat.translate(0, 1.4, 1.52);
  B.add(seat, M.porcelain);
  const lid = new THREE.CylinderGeometry(0.6, 0.6, 0.05, 32);
  lid.scale(1, 1, 1.3); lid.translate(0, 1.455, 1.5);
  B.add(lid, M.porcelain);
  B.box(M.steel, 0.55, 2.3, 0.73, 0.68, 2.36, 0.8);
  B.pop();
}

function exhaustFan(B, M, x, z, y) {
  B.box(M.vent, x - 0.4, y - 0.03, z - 0.4, x + 0.4, y, z + 0.4);
  for (let i = 0; i < 7; i++) B.box(M.toeKick, x - 0.32, y - 0.035, z - 0.3 + i * 0.09, x + 0.32, y - 0.03, z - 0.27 + i * 0.09);
}

function primaryBath(M, B, glass) {
  const { x0, x1, z0, z1, ceiling } = P;
  // Large-format tile: full height in the shower, wainscot behind the vanity.
  B.box(M.tileWall, x0, 0, z0, x0 + 0.03, ceiling, z1);
  B.box(M.tileWall, x0, 0, z0, SHOWER_X, ceiling, z0 + 0.03);
  B.box(M.tileWall, x0, 0, z1 - 0.03, SHOWER_X, ceiling, z1);
  B.box(M.tileWall, SHOWER_X, 0, z1 - 0.03, x1, WAINSCOT, z1);
  B.box(M.marble, 16.27, 0, z0, SHOWER_X, 0.33, z1);
  // Fixed glass panel from the south wall, entry on the north side.
  glass.box(M.showerGlass, 16.42, 0.33, 3.6, 16.45, 6.9, z1 - 0.04);
  for (const z of [4.15, 6.4]) B.box(M.black, 16.38, 0.33, z, 16.49, 0.5, z + 0.18);
  B.box(M.black, 16.38, 6.62, z1 - 0.25, 16.49, 6.84, z1 - 0.03);
  // Shower head and valve on the south wall inside the shower.
  B.rod(M.black, [14.9, 6.55, z1 - 0.03], [14.9, 6.75, z1 - 0.45], 0.035);
  B.cyl(M.black, 14.9, 6.68, z1 - 0.55, 0.19, 0.07, 28);
  B.cyl(M.black, 14.9, 4.0, z1 - 0.05, 0.2, 0.02, 28);
  const valve = new THREE.CylinderGeometry(0.2, 0.2, 0.04, 28);
  valve.rotateX(Math.PI / 2); valve.translate(14.9, 4.0, z1 - 0.05);
  B.add(valve, M.black);
  B.box(M.black, 14.88, 3.98, z1 - 0.25, 15.2, 4.03, z1 - 0.2);
  B.box(M.steelBrushed, 14.95, 0.0, 3.6, 15.35, 0.006, 4.0);

  // Vanity on the south wall, toilet beside it on the east wall.
  const south = new Frame(x1, z1, [-1, 0], [0, -1]);
  const vs = x1 - 17.68;
  vanity(B, M, south, vs, 2.0, 1.67);
  mirror(B, M, south, vs, 3.95, 1.85, 2.6);
  bar(B, M, south, vs, 6.85, 2.0);
  const east = new Frame(x1, z0, [0, 1], [-1, 0]);
  toilet(B, M, east, 4.7 - z0);
  B.box(M.black, x1 - 0.32, 2.3, 3.92, x1, 2.36, 3.96);
  B.box(M.black, x1 - 0.32, 2.27, 3.92, x1 - 0.02, 2.39, 3.95);
  B.box(M.plate, x1 - 0.015, 3.8, 3.86, x1, 4.2, 4.12);
  B.box(M.blackGlass, x1 - 0.02, 3.85, 4.2, x1, 4.3, 4.45);
  exhaustFan(B, M, 17.4, 2.6, ceiling);
}

function hallBath(M, B) {
  const { x0, z1, tubX0, tubX1, tubZ0 } = H2;
  const west = new Frame(x0, z1, [0, -1], [1, 0]);
  const vs = z1 - (Z(515) + Z(592)) / 2;
  vanity(B, M, west, vs, 3.0, 1.75);
  mirror(B, M, west, vs, 3.95, 2.4, 2.7, 0.3);
  bar(B, M, west, vs, 6.85, 2.4);
  toilet(B, M, west, z1 - Z(664));

  // Alcove tub with a tiled surround and a shower head on the north wall.
  const ty = 1.45;
  B.box(M.porcelain, tubX0, 0, tubZ0, tubX1, 0.32, z1);
  B.box(M.porcelain, tubX0, 0, tubZ0, tubX0 + 0.24, ty, z1);
  B.box(M.porcelain, tubX1 - 0.2, 0, tubZ0, tubX1, ty, z1);
  B.box(M.porcelain, tubX0, 0, tubZ0, tubX1, ty, tubZ0 + 0.32);
  B.box(M.porcelain, tubX0, 0, z1 - 0.2, tubX1, ty, z1);
  B.box(M.tileWall, tubX0, ty, tubZ0, tubX1, 7.6, tubZ0 + 0.03);
  B.box(M.tileWall, tubX1 - 0.03, ty, tubZ0, tubX1, 7.6, z1);
  B.box(M.tileWall, tubX0, ty, z1 - 0.03, tubX1, 7.6, z1);
  const cx = (tubX0 + tubX1) / 2;
  B.rod(M.black, [cx, 1.85, tubZ0 + 0.03], [cx, 1.85, tubZ0 + 0.42], 0.04);
  B.cyl(M.black, cx, 3.5, tubZ0 + 0.05, 0.2, 0.02);
  B.rod(M.black, [cx, 6.4, tubZ0 + 0.03], [cx, 6.6, tubZ0 + 0.45], 0.035);
  B.cyl(M.black, cx, 6.53, tubZ0 + 0.55, 0.17, 0.07, 24);
  // Curtain rod and a gathered curtain at the south end.
  B.rod(M.steel, [tubX0 + 0.08, 7.0, tubZ0], [tubX0 + 0.08, 7.0, z1], 0.03);
  const len = 1.2, cg = new THREE.PlaneGeometry(len, 5.3, 30, 1);
  const pos = cg.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 18) * 0.07);
  cg.computeVertexNormals();
  cg.rotateY(Math.PI / 2);
  cg.translate(tubX0 + 0.08, 1.62 + 5.3 / 2, z1 - len / 2 - 0.05);
  B.add(cg, M.curtain);
  exhaustFan(B, M, X(340), Z(560), HEIGHT.ceiling);
}

function closets(M, B) {
  const shelf = (x0, z0, x1, z1) => B.box(M.trim, x0, 5.45, z0, x1, 5.5, z1);
  // Bedroom 2 reach-in (doors on the west, back wall on the east).
  shelf(X(435) - 1.2, Z(79), X(435), Z(247));
  B.rod(M.steel, [X(435) - 0.65, 5.2, Z(79)], [X(435) - 0.65, 5.2, Z(247)], 0.04);
  // Coat closet.
  shelf(X(450), Z(556) - 1.2, X(504), Z(556));
  B.rod(M.steel, [X(450), 5.2, Z(556) - 0.65], [X(504), 5.2, Z(556) - 0.65], 0.04);
  // Walk-in: west wall, south wall, and the north nook.
  shelf(X(528), Z(257), X(528) + 1.2, Z(366));
  B.rod(M.steel, [X(528) + 0.6, 5.2, Z(257)], [X(528) + 0.6, 5.2, Z(366)], 0.04);
  shelf(X(528) + 1.2, Z(366) - 1.2, X(661), Z(366));
  B.rod(M.steel, [X(528) + 1.2, 5.2, Z(366) - 0.6], [X(661), 5.2, Z(366) - 0.6], 0.04);
  shelf(X(605), Z(190), X(661), Z(190) + 1.2);
  B.rod(M.steel, [X(605), 5.2, Z(190) + 0.6], [X(661), 5.2, Z(190) + 0.6], 0.04);
}

function laundry(M, B) {
  // Stacked washer/dryer facing the hall, and the water heater drawn as a circle on the plan.
  const F = new Frame((X(395) + X(447)) / 2, Z(270), [1, 0], [0, 1]);
  const d = Z(325) - Z(270);
  F.box(B, M.appliance, -1.0, 0.04, 0, 1.0, 6.55, d);
  F.box(B, M.steelBrushed, -1.0, 3.27, d - 0.01, 1.0, 3.31, d + 0.005);
  for (const y of [2.95, 6.22]) F.box(B, M.vent, -0.98, y, d, 0.98, y + 0.28, d + 0.02);
  for (const y of [1.5, 4.8]) {
    const [x, z] = F.p(0, d);
    const ring = new THREE.CylinderGeometry(0.66, 0.66, 0.06, 40);
    ring.rotateX(Math.PI / 2); ring.translate(x, y, z + 0.03);
    B.add(ring, M.steelBrushed);
    const door = new THREE.CylinderGeometry(0.52, 0.52, 0.07, 40);
    door.rotateX(Math.PI / 2); door.translate(x, y, z + 0.04);
    B.add(door, M.blackGlass);
  }
  const hx = X(492), hz = Z(295);
  B.cyl(M.appliance, hx, 0, hz, 0.86, 5.0, 40);
  B.cyl(M.steelBrushed, hx, 5.0, hz, 0.86, 0.12, 40, 0.7);
  for (const dx of [-0.3, 0.3]) B.cyl(M.steelBrushed, hx + dx, 5.12, hz, 0.05, HEIGHT.ceiling - 5.12, 10);
}

export function buildBaths(M) {
  const B = new Batch('baths');
  const glass = new Batch('bath-glass');
  primaryBath(M, B, glass);
  hallBath(M, B);
  closets(M, B);
  laundry(M, B);
  return { solid: B.build(), glass: glass.build({ shadows: false }) };
}
