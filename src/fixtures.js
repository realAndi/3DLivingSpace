import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Batch, Frame } from './kit.js';
import { paint, textureMaterial } from './materials.js';
import { isTexRef } from './recipes.js';

// Built-in fixtures (kitchens, baths, laundry, storage and the rest) from a
// built unit's U.fixtures; see FIXTURES and SEGMENTS in src/unit.js.
//
// Each one is built in its own frame, the same as furniture: s across
// (-w/2..w/2, +s to your right as you face its front), t from its back (0) to
// its front (d), y up; then placed at (x, 0, z) turned by its rotation.
// Proportions and details come from the example unit's kitchen and bath
// photos.
//
// Their doors and drawers open (see "Moving parts" below): cabinets are
// hollow behind them, with shelves; ovens have racks, the dishwasher a tub
// and racks, the fridge a lit liner that shows while it is open.

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

// Kitchen dimensions, in feet.
const TOE = 0.33, TOE_IN = 0.25;  // toe kick height and recess
const SLAB = 0.104;               // counter thickness (1¼")
const DOOR = 0.06;                // door and drawer fronts
const UPPER_D = 1.0;              // wall cabinet depth
const FRIDGE_H = 5.83;
const TALL = new Set(['fridge', 'pantry', 'oven']);
const COUNTER = new Set(['base', 'drawers', 'sink', 'dishwasher', 'cooktop', 'filler', 'corner', 'open']);

// ---------------------------------------------------------------------------
// Finishes: the unit's choices as materials. Textured ones are tints of the
// shared materials (same maps), cached per material set.

const variants = new WeakMap();
function cached(M, key, make) {
  let m = variants.get(M);
  if (!m) variants.set(M, (m = new Map()));
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
}
const std = (color, roughness, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra });
const tint = (M, key, base, color, extra = {}) => cached(M, key, () => Object.assign(base.clone(), extra, { color: new THREE.Color(color) }));

const CABINET_PAINT = { white: 0xf2f0eb, gray: 0x8b8e90, navy: 0x27354a, sage: 0x97a389, black: 0x252525 };
// `textures` are the unit's own (src/recipes.js), named as "tex:<id>".
function cabinetMat(M, key, textures) {
  if (isTexRef(key)) return textureMaterial(M, textures, key) ?? M.oak;
  if (key === 'oak' || !key) return M.oak;
  if (key === 'walnut') return M.walnut;
  if (key === 'ash') return M.ash;
  const hex = CABINET_PAINT[key] ?? (/^#[0-9a-f]{6}$/i.test(key) ? parseInt(key.slice(1), 16) : null);
  if (hex === null) return M.oak;
  return cached(M, `cab:${hex}`, () => std(hex, 0.5));
}

const STONES = new Set(['marble', 'granite', 'soapstone', 'terrazzo', 'travertine']);
function counterMat(M, key, textures) {
  if (isTexRef(key)) return textureMaterial(M, textures, key) ?? M.quartz;
  if (STONES.has(key)) return M[key];
  if (key === 'black') return tint(M, 'counter:black', M.quartz, 0x2c2c2d, { roughness: 0.2 });
  if (key === 'wood') return tint(M, 'counter:wood', M.oak, 0xd8c8b8, { roughness: 0.5 });
  if (key === 'concrete') return tint(M, 'counter:concrete', M.quartz, 0x9e9b96, { roughness: 0.75 });
  return M.quartz;
}

function tileMat(M, key, textures) {
  if (isTexRef(key)) return textureMaterial(M, textures, key) ?? M.tileWall;
  if (key === 'marble' || key === 'zellige' || key === 'terrazzo') return M[key];
  // White brightens the warm gray porcelain past 1 (linear), so its grout fades too.
  if (key === 'white') return tint(M, 'tile:white', M.tileWall, new THREE.Color().setRGB(1.6, 1.58, 1.55));
  if (key === 'charcoal') return tint(M, 'tile:charcoal', M.tileWall, 0x4b4b4b);
  return M.tileWall;
}

function applianceMats(M, key) {
  if (key === 'white') return { body: M.appliance, trim: cached(M, 'appliance:white-trim', () => std(0xdcdcd9, 0.35)) };
  if (key === 'black') {
    return {
      body: cached(M, 'appliance:black', () => std(0x2b2c2e, 0.32, { metalness: 0.6 })),
      trim: cached(M, 'appliance:black-trim', () => std(0x3c3d3f, 0.45, { metalness: 0.6 })),
    };
  }
  return { body: M.steel, trim: M.steelBrushed };
}

function hardwareMat(M, key) {
  if (key === 'steel') return M.steel;
  if (key === 'brass') return cached(M, 'hardware:brass', () => std(0xc39c5c, 0.32, { metalness: 1 }));
  return M.black;
}

// The backsplash's material and how far it stands off the wall.
function backsplashOf(X, key) {
  const { M } = X;
  if (isTexRef(key)) return [textureMaterial(M, X.textures, key) ?? M.subway, 0.03];
  if (key === 'stone') return [X.counter, 0.05];
  if (key === 'marble') return [M.marble, 0.05];
  if (key === 'zellige') return [M.zellige, 0.04];
  if (key === 'hex') return [M.floorHex, 0.03];
  if (key === 'herringbone') return [M.herringboneTile, 0.03];
  return [M.subway, 0.03];
}

// ---------------------------------------------------------------------------
// Moving parts: doors that swing, doors that drop open, drawers that slide.
// A leaf is drawn like everything else, through the fixture's frame, but into
// a batch of its own, and moves on a bone at its hinge. buildMovers() merges
// every leaf of the unit per material into one skinned mesh, so they draw as
// one call per material however many there are, and a door opens by turning
// its bone. Each mover is what one tap or E works: a cabinet's pair of doors,
// a drawer, the fridge's French doors.

// A moving part of the fixture being built, named for the prompt ('fridge', 'drawer').
function mover(X, name) {
  const m = { name, fixture: X.fixtureId, leaves: [], inside: null, normal: null };
  X.movers.push(m);
  return m;
}

// A leaf of mover m that moves about the point (s, y, t) of frame F; `motion`
// gives, from the frame's directions in the world, the axis it turns about
// and how far (radians), or the way and distance it slides. Draw it through
// L.B (or pass L where a helper takes X). L.part() draws a box that is also
// part of what you click the leaf by (the first is its face: where it is, for
// what's near); L.reach() adds to that without drawing.
function leaf(X, m, F, s, y, t, motion) {
  const world = X.B.matrix.clone();
  const dir = ([a, b]) => new THREE.Vector3(a, 0, b).transformDirection(world);
  const u = dir(F.u), n = dir(F.n);
  const [px, pz] = F.p(s, t);
  const B = new Batch('leaf');
  B.stack = [world];
  const L = {
    ...X, B, F, world, u, n, pivot: new THREE.Vector3(px, y, pz).applyMatrix4(world), box: null, ...motion(u, n),
    reach(s0, y0, t0, s1, y1, t1) {
      const b = L.box ??= [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      [Math.min(s0, s1), Math.min(y0, y1), Math.min(t0, t1)].forEach((v, i) => { b[i] = Math.min(b[i], v); });
      [Math.max(s0, s1), Math.max(y0, y1), Math.max(t0, t1)].forEach((v, i) => { b[i + 3] = Math.max(b[i + 3], v); });
      return L;
    },
    part(mat, s0, y0, t0, s1, y1, t1) {
      F.box(B, mat, s0, y0, t0, s1, y1, t1);
      L.face ??= [Math.min(s0, s1), Math.min(y0, y1), Math.min(t0, t1), Math.max(s0, s1), Math.max(y0, y1), Math.max(t0, t1)];
      return L.reach(s0, y0, t0, s1, y1, t1);
    },
  };
  m.normal ??= n;
  m.leaves.push(L);
  return L;
}

// A door hinged on a vertical line at (s, t), its leaf running from there
// toward +s (side 1) or -s (side -1); it opens 90° out toward the front.
// (Turning about +y takes a direction e toward (e.z, -e.x).)
const swing = (X, m, F, s, t, side, deg = 90) => leaf(X, m, F, s, 0, t, (u, n) => {
  const e = u.clone().multiplyScalar(side);
  return { axis: new THREE.Vector3(0, Math.sign(e.z * n.x - e.x * n.z) || 1, 0), angle: deg * DEG };
});
// A door hinged along its bottom edge at height y on face t: it drops open to level.
const drop = (X, m, F, y, t, deg = 90) => leaf(X, m, F, 0, y, t, (u, n) => ({ axis: new THREE.Vector3().crossVectors(UP, n), angle: deg * DEG }));
// A drawer on face t, sliding straight out `out` feet.
const slide = (X, m, F, y, t, out) => leaf(X, m, F, 0, y, t, (u, n) => ({ slide: n.clone().multiplyScalar(out) }));

// A leaf's place at t (0 shut, 1 open).
function pose(L, t) {
  if (L.slide) L.bone.position.copy(L.pivot).addScaledVector(L.slide, t);
  else L.bone.quaternion.setFromAxisAngle(L.axis, L.angle * t);
}

// What's only seen while mover m is open (a fridge's lit liner): a batch
// drawn in the fixture's frame, built into a group that shows while it's open.
function inside(X, m) {
  if (!m.inside) { m.inside = new Batch('inside'); m.inside.stack = [X.B.matrix.clone()]; }
  return m.inside;
}

// Binds every vertex of g to bone i.
function bindTo(g, i) {
  const n = g.attributes.position.count, index = new Uint16Array(n * 4), weight = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) { index[k * 4] = i; weight[k * 4] = 1; }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
}

const CLICK = new THREE.MeshBasicMaterial({ visible: false });

// Every leaf merged per material into skinned meshes, one bone each; an
// unseen box on each bone to click it by; and the movers as the rest of the
// app sees them: { key, fixture, name, objects, pos, normal, open, setOpen(t) }.
function buildMovers(list) {
  const group = new THREE.Group();
  group.name = 'fixture-movers';
  const bones = [], parts = new Map(), unit = new THREE.BoxGeometry(1, 1, 1), basis = new THREE.Matrix4(), side = new THREE.Vector3();
  const counts = new Map();
  const movers = list.filter((m) => m.leaves.length).map((m) => {
    const n = counts.get(m.fixture) ?? 0;
    counts.set(m.fixture, n + 1);
    const objects = [], pos = new THREE.Vector3();
    for (const L of m.leaves) {
      const bone = new THREE.Bone();
      bone.position.copy(L.pivot);
      group.add(bone);
      L.bone = bone;
      const i = bones.push(bone) - 1;
      for (const [mat, geos] of L.B.parts) {
        geos.forEach((g) => bindTo(g, i));
        if (!parts.has(mat)) parts.set(mat, []);
        parts.get(mat).push(...geos);
      }
      L.B.parts.clear();
      if (!L.box) continue;
      const [s0, y0, t0, s1, y1, t1] = L.box, [cx, cz] = L.F.p((s0 + s1) / 2, (t0 + t1) / 2);
      const c = new THREE.Vector3(cx, (y0 + y1) / 2, cz).applyMatrix4(L.world);
      const box = new THREE.Mesh(unit, CLICK);
      box.quaternion.setFromRotationMatrix(basis.makeBasis(L.u, UP, side.crossVectors(L.u, UP)));
      box.scale.set(s1 - s0, y1 - y0, t1 - t0);
      box.position.copy(c).sub(L.pivot);
      box.castShadow = box.receiveShadow = false;
      bone.add(box);
      objects.push(box);
      // Where it is: the middle of its face (a drawer's front, not its box).
      const [a0, b0, , a1, b1, f1] = L.face ?? L.box, [fx, fz] = L.F.p((a0 + a1) / 2, f1);
      pos.add(new THREE.Vector3(fx, (b0 + b1) / 2, fz).applyMatrix4(L.world));
    }
    pos.divideScalar(Math.max(1, objects.length));
    let shown = null;
    if (m.inside) {
      shown = m.inside.build({ shadows: false });
      shown.visible = false;
      group.add(shown);
      objects.push(shown);
    }
    const mv = {
      key: `fix:${m.fixture}:${n}`, fixture: m.fixture, name: m.name, objects,
      pos: [pos.x, pos.y, pos.z], normal: [m.normal.x, m.normal.y, m.normal.z], open: 0,
      setOpen(t) {
        mv.open = t;
        for (const L of m.leaves) pose(L, t);
        if (shown) shown.visible = t > 0.002;
      },
    };
    return mv;
  });
  group.updateMatrixWorld(true);
  const skeleton = bones.length ? new THREE.Skeleton(bones) : null;
  for (const [mat, geos] of parts) {
    const geo = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.SkinnedMesh(geo, mat);
    mesh.name = 'leaves';
    mesh.bind(skeleton, new THREE.Matrix4());
    // Bounds that hold every leaf however far it opens, so they are never culled wrongly.
    geo.computeBoundingSphere();
    mesh.boundingSphere = geo.boundingSphere.clone();
    mesh.boundingSphere.radius += 3.5;
    mesh.castShadow = !mat.transparent;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, movers, skeleton };
}

// ---------------------------------------------------------------------------
// Shared parts. X is the build context: batches, materials, the fixture.

function pullV(X, F, s, y0, len, t) {
  const { B, hw } = X;
  F.box(B, hw, s - 0.017, y0, t + 0.075, s + 0.017, y0 + len, t + 0.11);
  F.box(B, hw, s - 0.012, y0 + 0.04, t, s + 0.012, y0 + 0.075, t + 0.08);
  F.box(B, hw, s - 0.012, y0 + len - 0.075, t, s + 0.012, y0 + len - 0.04, t + 0.08);
}

function pullH(X, F, s, y, len, t) {
  const { B, hw } = X;
  F.box(B, hw, s - len / 2, y - 0.017, t + 0.075, s + len / 2, y + 0.017, t + 0.11);
  F.box(B, hw, s - len / 2 + 0.04, y - 0.012, t, s - len / 2 + 0.075, y + 0.012, t + 0.08);
  F.box(B, hw, s + len / 2 - 0.075, y - 0.012, t, s + len / 2 - 0.04, y + 0.012, t + 0.08);
}

// Slab doors across [s0, s1] and [y0, y1] on face t, hinged at their outer
// edges (a pair opens together). Pulls near the top (base), bottom (uppers)
// or at a given height.
function doors(X, F, mat, s0, s1, y0, y1, t, count, { pullsAt = 'top', hingeLeft = true, name = 'cabinet' } = {}) {
  const g = 0.012, m = mover(X, name);
  const len = Math.min(0.55, (y1 - y0) * 0.6);
  const py = typeof pullsAt === 'number' ? pullsAt - len / 2 : pullsAt === 'top' ? Math.max(y0 + 0.05, y1 - 0.72) : y0 + 0.17;
  if (count === 1) {
    const L = swing(X, m, F, hingeLeft ? s0 + g : s1 - g, t + DOOR, hingeLeft ? 1 : -1);
    L.part(mat, s0 + g, y0 + g, t, s1 - g, y1 - g, t + DOOR);
    pullV(L, F, hingeLeft ? s1 - 0.14 : s0 + 0.14, py, len, t + DOOR);
    return;
  }
  const mid = (s0 + s1) / 2;
  const a = swing(X, m, F, s0 + g, t + DOOR, 1), b = swing(X, m, F, s1 - g, t + DOOR, -1);
  a.part(mat, s0 + g, y0 + g, t, mid - g / 2, y1 - g, t + DOOR);
  b.part(mat, mid + g / 2, y0 + g, t, s1 - g, y1 - g, t + DOOR);
  seam(b, F, mat, mid - g / 2, mid + g / 2, y0 + g, y1 - g, t);
  pullV(a, F, mid - 0.14, py, len, t + DOOR);
  pullV(b, F, mid + 0.14, py, len, t + DOOR);
}

// A drawer in a cabinet over [s0, s1]: its front on face t over [y0, y1], a
// pull at height py, and the box behind it, sliding out most of its depth.
function drawer(X, F, mat, s0, s1, y0, y1, t, py, name = 'drawer') {
  const L = slide(X, mover(X, name), F, (y0 + y1) / 2, t, Math.min(1.5, (t - 0.2) * 0.8));
  L.part(mat, s0 + 0.012, y0, t, s1 - 0.012, y1, t + DOOR);
  pullH(L, F, (s0 + s1) / 2, py, Math.min(0.62, (s1 - s0) * 0.5), t + DOOR);
  const a = s0 + 0.09, b = s1 - 0.09, lo = y0 + 0.06, hi = y1 - 0.12, back = 0.16, w = 0.035;
  if (hi - lo < 0.15 || t - back < 0.4) return;
  F.box(L.B, mat, a, lo, back, b, lo + w, t);
  F.box(L.B, mat, a, lo, back, a + w, hi, t);
  F.box(L.B, mat, b - w, lo, back, b, hi, t);
  F.box(L.B, mat, a, lo, back, b, hi, back + w);
  L.reach(a, lo, back, b, hi, t);
}

// A strip on the back of a pair's right leaf, behind the gap between the
// leaves [s0, s1], so the gap shows a face as it did before cabinets were
// hollow, not the dark inside (and a click in the gap still finds the pair).
function seam(L, F, mat, s0, s1, y0, y1, t) {
  F.box(L.B, mat, s0 - 0.03, y0, t - 0.004, s1, y1, t);
  L.reach(s0, y0, t, s1, y1, t);
}

const doorCount = (w) => (w > 1.75 ? 2 : 1);

function toeKick(X, F, s0, s1, cd) {
  F.box(X.B, X.M.toeKick, s0, 0, 0, s1, TOE, cd - TOE_IN);
}

// A cabinet box from y0 to y1, hollow behind the fronts that open: `bays`
// lists their [y0, y1] spans, each an open-fronted compartment with a panel
// between it and the next; the rest is solid. With `open` (a sink's bowl hangs
// in it) one hollow from the bottom panel up, with a rail across the front
// from that height. From outside it is the same box either way.
function carcass(X, F, mat, s0, s1, y0, y1, depth, { bays = null, open = null } = {}) {
  const th = 0.05, box = [s0, y0, 0, s1, y1, depth], walls = [s0 + th, s1 - th, th];
  if (open !== null) {
    hollow(X.B, mat, F, box, walls, [[y0 + th, y1]]);
    F.box(X.B, mat, s0 + th, Math.max(open, y0 + th), depth - 0.06, s1 - th, y1, depth);
    return;
  }
  if (!bays?.length) { F.box(X.B, mat, s0, y0, 0, s1, y1, depth); return; }
  hollow(X.B, mat, F, box, walls, bays.map(([p, q]) => [p + (p - y0 < 1e-6 ? th : th / 2), q - (y1 - q < 1e-6 ? th : th / 2)]));
}

// The box [s0, s1] × [y0, y1] × [t0, t1] with open-fronted cavities across
// [a, b] from `back` to its front, one per [lo, hi] in `spans` (bottom up).
// From outside it is the same box.
function hollow(B, mat, F, [s0, y0, t0, s1, y1, t1], [a, b, back], spans) {
  if (back > t0 + 1e-6) F.box(B, mat, s0, y0, t0, s1, y1, back);
  F.box(B, mat, s0, y0, back, a, y1, t1);
  F.box(B, mat, b, y0, back, s1, y1, t1);
  let y = y0;
  for (const [lo, hi] of spans) {
    if (lo > y + 1e-6) F.box(B, mat, a, y, back, b, lo, t1);
    y = Math.max(y, hi);
  }
  if (y1 > y + 1e-6) F.box(B, mat, a, y, back, b, y1, t1);
}

// Thin panels lining a cavity [a, b] × [lo, hi] from `back` to `front`, in
// another material than the box around it (an oven's dark enamel).
function liner(B, mat, F, a, lo, back, b, hi, front, th = 0.012) {
  F.box(B, mat, a, lo, back, b, hi, back + th);
  F.box(B, mat, a, lo, back, a + th, hi, front);
  F.box(B, mat, b - th, lo, back, b, hi, front);
  F.box(B, mat, a, lo, back, b, lo + th, front);
  F.box(B, mat, a, hi - th, back, b, hi, front);
}

// A wire rack across [a, b] from t0 to t1 at height y; with `rim`, a basket
// that tall (a dishwasher's).
function rack(B, mat, F, a, b, t0, t1, y, rim = 0) {
  const r = 0.012, n = Math.max(3, Math.round((b - a) / 0.2));
  for (const yy of rim ? [y, y + rim] : [y]) {
    for (const t of [t0, t1]) F.box(B, mat, a, yy - r, t - r, b, yy + r, t + r);
    for (const s of [a, b]) F.box(B, mat, s - r, yy - r, t0, s + r, yy + r, t1);
  }
  for (let k = 1; k < n; k++) { const s = a + ((b - a) * k) / n; F.box(B, mat, s - r / 2, y - r / 2, t0, s + r / 2, y + r / 2, t1); }
  if (rim) for (const s of [a, b]) for (const t of [t0, t1]) F.box(B, mat, s - r, y, t - r, s + r, y + rim, t + r);
}

// Shelves inside a compartment over [s0, s1] × [y0, y1] (its walls' outer
// edges), set back a little from its front at `depth`.
function innerShelves(X, F, mat, s0, s1, y0, y1, depth, n = Math.round((y1 - y0) / 1.3)) {
  for (let k = 1; k <= n; k++) {
    const y = y0 + ((y1 - y0) * k) / (n + 1);
    F.box(X.B, mat, s0 + 0.05, y - 0.025, 0.05, s1 - 0.05, y + 0.025, depth - 0.08);
  }
}

function base(X, F, s0, s1, cd, cTop, { count = doorCount(s1 - s0), drawer: drawers = false, falseFront = false, hingeLeft = true, open = null } = {}) {
  const { B, cab } = X;
  const top = drawers || falseFront ? cTop - 0.52 : cTop;
  toeKick(X, F, s0, s1, cd);
  carcass(X, F, cab, s0, s1, TOE, cTop, cd - 0.005, open !== null ? { open } : { bays: drawers ? [[TOE, top], [top, cTop]] : [[TOE, top]] });
  if (drawers) drawer(X, F, cab, s0, s1, top, cTop - 0.012, cd, top + 0.26);
  else if (falseFront) F.box(B, cab, s0 + 0.012, top, cd, s1 - 0.012, cTop - 0.012, cd + DOOR);
  if (open === null) innerShelves(X, F, cab, s0, s1, TOE, top, cd, 1);
  doors(X, F, cab, s0, s1, TOE, top, cd, count, { hingeLeft });
}

function drawerStack(X, F, s0, s1, cd, cTop) {
  const { cab } = X;
  toeKick(X, F, s0, s1, cd);
  const ys = [TOE, TOE + (cTop - 0.52 - TOE) / 2, cTop - 0.52, cTop];
  carcass(X, F, cab, s0, s1, TOE, cTop, cd - 0.005, { bays: [0, 1, 2].map((k) => [ys[k], ys[k + 1]]) });
  for (let k = 0; k < 3; k++) {
    const y0 = ys[k], y1 = ys[k + 1];
    drawer(X, F, cab, s0, s1, y0 + 0.012, y1 - 0.012, cd, k === 2 ? (y0 + y1) / 2 : y1 - 0.24);
  }
}

function upper(X, F, s0, s1, y0, y1, count, { depth = UPPER_D, hingeLeft = true } = {}) {
  carcass(X, F, X.cab, s0, s1, y0, y1, depth - 0.005, { bays: [[y0, y1]] });
  innerShelves(X, F, X.cab, s0, s1, y0, y1, depth - 0.005, y1 - y0 > 2.4 ? 2 : 1);
  doors(X, F, X.cab, s0, s1, y0, y1, depth, count, { pullsAt: 'bottom', hingeLeft });
}

// Wall cabinets over [a, b], split into cabinets up to 3' wide. A blind end is
// where another run's uppers meet this one: a plain box as deep as theirs.
function upperSpan(X, F, a, b, y0, y1, { depth = UPPER_D, blindLeft = false, blindRight = false } = {}) {
  if (blindLeft) { F.box(X.B, X.cab, a, y0, 0, Math.min(b, a + depth), y1, depth); a += depth; }
  if (blindRight) { F.box(X.B, X.cab, Math.max(a, b - depth), y0, 0, b, y1, depth); b -= depth; }
  if (b - a < 0.35) { if (b > a) F.box(X.B, X.cab, a, y0, 0, b, y1, depth + DOOR); return; }
  const n = Math.max(1, Math.ceil((b - a) / 3 - 0.01)), cw = (b - a) / n;
  for (let k = 0; k < n; k++) {
    upper(X, F, a + k * cw, a + (k + 1) * cw, y0, y1, doorCount(cw), { depth, hingeLeft: !(blindRight && k === n - 1) });
  }
}

// A slab over [s0, s1] × [t0, t1] with rectangular holes (sinks).
function slab(B, mat, F, s0, s1, t0, t1, y0, y1, holes = []) {
  let s = s0;
  for (const h of holes.filter((o) => o.s1 > s0 && o.s0 < s1).sort((p, q) => p.s0 - q.s0)) {
    if (h.s0 > s) F.box(B, mat, s, y0, t0, h.s0, y1, t1);
    F.box(B, mat, Math.max(s, h.s0), y0, t0, h.s1, y1, h.t0);
    F.box(B, mat, Math.max(s, h.s0), y0, h.t1, h.s1, y1, t1);
    s = Math.max(s, h.s1);
  }
  if (s1 > s) F.box(B, mat, s, y0, t0, s1, y1, t1);
}

// Undermount bowl below a counter opening.
function sinkBowl(X, F, s0, s1, t0, t1, top) {
  const { B, M } = X, y1 = top + 0.02, y0 = y1 - 0.75, w = 0.02;
  F.box(B, M.steelBrushed, s0, y0, t0, s1, y0 + w, t1);
  F.box(B, M.steelBrushed, s0, y0, t0, s0 + w, y1, t1);
  F.box(B, M.steelBrushed, s1 - w, y0, t0, s1, y1, t1);
  F.box(B, M.steelBrushed, s0, y0, t0, s1, y1, t0 + w);
  F.box(B, M.steelBrushed, s0, y0, t1 - w, s1, y1, t1);
  const [x, z] = F.p((s0 + s1) / 2, (t0 + t1) / 2 + 0.2);
  B.cyl(M.black, x, y0 + w, z, 0.13, 0.005);
}

// Pull-down gooseneck faucet standing on the counter at (s, t), spout toward +t.
function faucet(X, F, s, t, y) {
  const { B, hw } = X;
  B.push(F.matrixAt(s, y, t));
  B.cyl(hw, 0, 0, 0, 0.075, 0.18, 20);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.15, 0), new THREE.Vector3(0, 0.95, 0), new THREE.Vector3(0, 1.22, 0.18),
    new THREE.Vector3(0, 1.12, 0.48), new THREE.Vector3(0, 0.85, 0.58),
  ]);
  B.add(new THREE.TubeGeometry(curve, 40, 0.035, 10), hw);
  B.cyl(hw, 0, 0.62, 0.58, 0.045, 0.24, 16);
  B.rod(hw, [0.07, 0.45, 0], [0.24, 0.62, 0.02], 0.022);
  B.pop();
}

function outlet(X, F, s, y, t) {
  F.box(X.B, X.M.plate, s - 0.12, y - 0.19, t, s + 0.12, y + 0.19, t + 0.015);
}

// ---------------------------------------------------------------------------
// Kitchen appliances. cd is the cabinet depth (door faces), ct the counter top.

function dishwasher(X, F, s0, s1, cd, cTop) {
  const { B, M } = X, { body, trim } = X.app;
  // The tub, open behind the door: a stainless liner and two racks.
  const a = s0 + 0.1, b = s1 - 0.1, lo = TOE + 0.05, hi = cTop - 0.1, back = 0.12, front = cd - 0.1;
  hollow(B, M.toeKick, F, [s0, 0, 0, s1, cTop, front], [a, b, back], [[lo, hi]]);
  liner(B, M.steelBrushed, F, a, lo, back, b, hi, front);
  rack(B, M.vent, F, a + 0.04, b - 0.04, back + 0.06, front - 0.04, lo + 0.18, 0.3);
  rack(B, M.vent, F, a + 0.04, b - 0.04, back + 0.06, front - 0.04, lo + (hi - lo) * 0.56, 0.24);
  // The door drops open from its bottom edge.
  const L = drop(X, mover(X, 'dishwasher'), F, TOE - 0.05, cd + 0.02);
  L.part(body, s0 + 0.01, TOE - 0.05, cd - 0.1, s1 - 0.01, cTop - 0.012, cd + 0.02);
  F.box(L.B, trim, s0 + 0.01, cTop - 0.22, cd + 0.02, s1 - 0.01, cTop - 0.012, cd + 0.04);
  F.rodS(L.B, body, s0 + 0.18, s1 - 0.18, cTop - 0.36, cd + 0.16, 0.035);
  for (const s of [s0 + 0.22, s1 - 0.22]) F.rodT(L.B, body, s, cTop - 0.36, cd + 0.02, cd + 0.16, 0.02);
  F.box(B, M.black, s0 + 0.05, 0.02, cd - TOE_IN - 0.02, s1 - 0.05, TOE - 0.05, cd - TOE_IN);
}

function range(X, F, s0, s1, cd, ct) {
  const { B, M } = X, { body, trim } = X.app, d = cd, c = (s0 + s1) / 2;
  // The body, with the oven behind its door: dark enamel and two racks.
  const a = s0 + 0.14, b = s1 - 0.14, lo = 0.74, hi = ct - 0.58, back = 0.35;
  hollow(B, body, F, [s0 + 0.01, 0.05, 0.1, s1 - 0.01, ct - 0.07, d + 0.1], [a, b, back], [[lo, hi]]);
  liner(B, M.black, F, a, lo, back, b, hi, d + 0.1);
  for (const k of [0.3, 0.62]) rack(B, M.steelBrushed, F, a + 0.02, b - 0.02, back + 0.05, d, lo + (hi - lo) * k);
  // Storage drawer, oven door with window and bar handle (it drops open).
  F.box(B, body, s0 + 0.02, 0.08, d + 0.1, s1 - 0.02, 0.6, d + 0.15);
  F.box(B, M.toeKick, s0 + 0.02, 0.0, d - 0.1, s1 - 0.02, 0.08, d + 0.1);
  const L = drop(X, mover(X, 'oven'), F, 0.64, d + 0.16);
  L.part(body, s0 + 0.02, 0.64, d + 0.1, s1 - 0.02, ct - 0.48, d + 0.16);
  F.box(L.B, M.blackGlass, s0 + 0.32, 1.02, d + 0.16, s1 - 0.32, ct - 0.95, d + 0.165);
  F.rodS(L.B, body, s0 + 0.2, s1 - 0.2, ct - 0.64, d + 0.3, 0.035);
  for (const s of [s0 + 0.24, s1 - 0.24]) F.rodT(L.B, body, s, ct - 0.64, d + 0.16, d + 0.3, 0.02);
  // Front control strip with five knobs and a small display.
  F.box(B, trim, s0 + 0.02, ct - 0.42, d + 0.1, s1 - 0.02, ct - 0.07, d + 0.2);
  F.box(B, M.blackGlass, c - 0.25, ct - 0.34, d + 0.2, c + 0.25, ct - 0.15, d + 0.205);
  for (const s of [s0 + 0.25, s0 + 0.55, s1 - 0.55, s1 - 0.25, c + 0.42]) F.rodT(B, body, s, ct - 0.24, d + 0.2, d + 0.3, 0.075);
  // Cooktop and cast-iron grates.
  F.box(B, M.blackGlass, s0 + 0.02, ct - 0.07, 0.15, s1 - 0.02, ct - 0.03, d + 0.2);
  const gy = ct - 0.03, gt0 = 0.25, gt1 = d + 0.1;
  for (const [a, b] of [[s0 + 0.06, c - 0.02], [c + 0.02, s1 - 0.06]]) {
    for (const s of [a, b - 0.05, (a + b) / 2 - 0.025]) F.box(B, M.black, s, gy, gt0, s + 0.05, gy + 0.07, gt1);
    for (const t of [gt0, gt1 - 0.05, (gt0 + gt1) / 2 - 0.025]) F.box(B, M.black, a, gy, t, b, gy + 0.07, t + 0.05);
  }
  for (const [s, t, r] of [[s0 + 0.62, 0.35, 0.2], [s1 - 0.62, 0.35, 0.2], [s0 + 0.62, 0.775, 0.16], [s1 - 0.62, 0.775, 0.22], [c, 0.56, 0.14]]) {
    const [x, z] = F.p(s, t * d);
    B.cyl(M.black, x, gy - 0.02, z, r, 0.05);
  }
}

// Glass cooktop dropped into the counter.
function cooktop(X, F, s0, s1, cd, ct) {
  const { B, M } = X, a = s0 + 0.12, b = s1 - 0.12, t0 = 0.22, t1 = cd - 0.05, c = (a + b) / 2;
  F.box(B, M.blackGlass, a, ct - 0.02, t0, b, ct + 0.012, t1);
  const ring = cached(M, 'cooktop:ring', () => std(0x55575a, 0.35));
  for (const [s, t, r] of [[a + (b - a) * 0.25, 0.3, 0.3], [b - (b - a) * 0.25, 0.3, 0.24], [a + (b - a) * 0.25, 0.72, 0.22], [b - (b - a) * 0.25, 0.72, 0.3]]) {
    const [x, z] = F.p(s, t0 + (t1 - t0) * t);
    B.cyl(ring, x, ct + 0.012, z, Math.min(r, (b - a) / 4 - 0.03), 0.003, 32);
    B.cyl(M.blackGlass, x, ct + 0.012, z, Math.min(r, (b - a) / 4 - 0.03) - 0.025, 0.004, 32);
  }
  F.box(B, ring, c - 0.3, ct + 0.012, t1 - 0.2, c + 0.3, ct + 0.015, t1 - 0.08);
}

function microwave(X, F, s0, s1, y0) {
  const { B, M } = X, { body, trim } = X.app, h = 1.38, d = 1.3;
  // The body, with its cavity behind the door: a light liner and a turntable.
  const a = s0 + 0.14, b = s1 - 0.62, lo = y0 + 0.16, hi = y0 + h - 0.16, back = 0.2;
  hollow(B, body, F, [s0 + 0.01, y0, 0, s1 - 0.01, y0 + h, d], [a, b, back], [[lo, hi]]);
  liner(B, M.appliance, F, a, lo, back, b, hi, d);
  const [x, z] = F.p((a + b) / 2, (back + d) / 2);
  B.cyl(M.porcelain, x, lo + 0.012, z, Math.min(b - a, d - back) * 0.42, 0.015, 32);
  // The door (its window and handle) hinged on the left.
  const L = swing(X, mover(X, 'microwave'), F, s0 + 0.08, d + 0.02, 1);
  L.part(M.blackGlass, s0 + 0.08, y0 + 0.12, d, s1 - 0.56, y0 + h - 0.12, d + 0.02);
  F.box(B, M.blackGlass, s1 - 0.46, y0 + 0.3, d, s1 - 0.08, y0 + h - 0.15, d + 0.015);
  F.box(L.B, body, s1 - 0.56, y0 + 0.2, d + 0.02, s1 - 0.5, y0 + h - 0.2, d + 0.12);
  F.box(B, trim, s0 + 0.01, y0 - 0.03, 0.2, s1 - 0.01, y0, d - 0.05);
}

// Slim hood under a cabinet, or a chimney hood up to the ceiling.
function hood(X, F, s0, s1, y, top, chimney) {
  const { B, M } = X, { body, trim } = X.app, c = (s0 + s1) / 2;
  F.box(B, body, s0 + 0.01, y, 0, s1 - 0.01, y + 0.22, 1.65);
  F.box(B, M.vent, s0 + 0.12, y - 0.006, 0.2, s1 - 0.12, y, 1.5);
  F.box(B, trim, c - 0.25, y + 0.05, 1.65, c + 0.25, y + 0.12, 1.66);
  if (!chimney) return;
  frustum(X, F, body, [s0 + 0.01, s1 - 0.01, 0, 1.65], [c - 0.45, c + 0.45, 0, 0.8], y + 0.22, y + 0.72);
  if (top > y + 0.72) F.box(B, body, c - 0.45, y + 0.72, 0, c + 0.45, top, 0.8);
}

// A box tapering from [s0, s1, t0, t1] at y0 to a smaller one at y1.
function frustum(X, F, mat, lo, hi, y0, y1) {
  const g = new THREE.BoxGeometry(1, 1, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const up = p.getY(i) > 0, [s0, s1, t0, t1] = up ? hi : lo;
    const [x, z] = F.p(p.getX(i) > 0 ? s1 : s0, p.getZ(i) > 0 ? t1 : t0);
    p.setXYZ(i, x, up ? y1 : y0, z);
  }
  g.computeVertexNormals();
  X.B.add(g, mat);
}

// Bottom-freezer refrigerator with French doors over a freezer drawer; `front`
// is where its doors end. Inside, a liner that glows while it's open.
function fridge(X, F, s0, s1, H, front) {
  const { B, M } = X, { body, trim } = X.app, k = H / FRIDGE_H;
  const f0 = s0 + 0.13, f1 = s1 - 0.13, split = f0 + (f1 - f0) * 0.42, door0 = front - 0.18, fz = 2.08 * k;
  const a = f0 + 0.09, b = f1 - 0.09, back = 0.32, freezer = [0.36, fz - 0.06], fresh = [fz + 0.06, H - 0.12];
  hollow(B, trim, F, [f0, 0.04, 0.15, f1, H, door0], [a, b, back], [freezer, fresh]);
  F.box(B, M.black, f0 + 0.02, 0.04, door0 - 0.14, f1 - 0.02, 0.25, door0 + 0.01);
  F.box(B, M.black, f0, fz - 0.012, door0, f1, fz + 0.012, door0 + 0.01);
  // French doors on their outer hinges.
  const doorsM = mover(X, 'fridge');
  const left = swing(X, doorsM, F, f0, front, 1), right = swing(X, doorsM, F, f1, front, -1);
  left.part(body, f0, fz + 0.012, door0, split - 0.012, H, front);
  right.part(body, split + 0.012, fz + 0.012, door0, f1, H, front);
  seam(right, F, trim, split - 0.012, split + 0.012, fz + 0.012, H, door0);
  // Ice and water dispenser on the left door.
  const dc = (f0 + split) / 2, dw = Math.min(0.38, (split - f0) / 2 - 0.1);
  F.box(left.B, M.blackGlass, dc - dw, 3.15 * k, front, dc + dw, 4.45 * k, front + 0.01);
  F.box(left.B, M.black, dc - dw + 0.08, 3.25 * k, front - 0.06, dc + dw - 0.08, 3.95 * k, front + 0.01);
  // Long bar handles either side of the seam.
  for (const [L, s] of [[left, split - 0.16], [right, split + 0.16]]) {
    F.box(L.B, body, s - 0.03, 2.25 * k, front + 0.2, s + 0.03, 5.25 * k, front + 0.26);
    F.rodT(L.B, body, s, 2.35 * k, front, front + 0.22, 0.025);
    F.rodT(L.B, body, s, 5.15 * k, front, front + 0.22, 0.025);
  }
  // The freezer drawer, its bar handle and its basket.
  const drawerM = mover(X, 'freezer'), D = slide(X, drawerM, F, fz / 2, front, Math.min(1.6, (door0 - back) * 0.75));
  D.part(body, f0, 0.27, door0, f1, fz - 0.012, front);
  F.box(D.B, body, f0 + 0.32, fz - 0.36, front + 0.2, f1 - 0.32, fz - 0.3, front + 0.26);
  for (const s of [f0 + 0.42, f1 - 0.42]) F.rodT(D.B, body, s, fz - 0.33, front, front + 0.22, 0.025);
  const ba = a + 0.04, bb = b - 0.04, lo = freezer[0] + 0.04, hi = freezer[1] - 0.12, bt = back + 0.08, w = 0.03;
  F.box(D.B, trim, ba, lo, bt, bb, lo + w, door0);
  F.box(D.B, trim, ba, lo, bt, ba + w, hi, door0);
  F.box(D.B, trim, bb - w, lo, bt, bb, hi, door0);
  F.box(D.B, trim, ba, lo, bt, bb, hi, bt + w);
  D.reach(ba, lo, bt, bb, hi, door0);
  // Lit liners, seen only while open: shelves and a crisper above, plain below.
  const glow = cached(M, 'fridge:inside', () => std(0xf4f6f7, 0.45, { emissive: 0xf2f6ff, emissiveIntensity: 0.55 }));
  const up = inside(X, doorsM), [y0, y1] = fresh;
  liner(up, glow, F, a, y0, back, b, y1, door0);
  for (const t of [0.36, 0.62, 0.84]) F.box(up, glow, a, y0 + (y1 - y0) * t - 0.015, back, b, y0 + (y1 - y0) * t + 0.015, door0 - 0.08);
  F.box(up, glow, a, y0, door0 - 0.1, b, y0 + (y1 - y0) * 0.3, door0 - 0.07);
  liner(inside(X, drawerM), glow, F, a, freezer[0], back, b, freezer[1], door0);
}

// Tall pantry cabinet: tall doors below, short ones above, shelves behind them.
function pantry(X, F, s0, s1, cd, H) {
  const { cab } = X, split = Math.min(H - 0.8, Math.max(TOE + 1.5, H - 2.5));
  toeKick(X, F, s0, s1, cd);
  carcass(X, F, cab, s0, s1, TOE, H, cd - 0.005, { bays: [[TOE, split], [split, H]] });
  innerShelves(X, F, cab, s0, s1, TOE, split, cd - 0.005);
  innerShelves(X, F, cab, s0, s1, split, H, cd - 0.005, 1);
  doors(X, F, cab, s0, s1, TOE, split, cd, doorCount(s1 - s0), { pullsAt: Math.min(split - 0.4, 3.5), name: 'pantry' });
  doors(X, F, cab, s0, s1, split, H, cd, doorCount(s1 - s0), { pullsAt: 'bottom', name: 'pantry' });
}

// Tall cabinet with a wall oven at eye height, drawers below and a door above.
function wallOven(X, F, s0, s1, cd, H) {
  const { B, M, cab } = X, { body, trim } = X.app, o0 = 2.55, o1 = Math.min(H - 0.7, 5.0);
  const mid = (TOE + o0) / 2, top = H - o1 > 0.4;
  toeKick(X, F, s0, s1, cd);
  carcass(X, F, cab, s0, s1, TOE, H, cd - 0.005, { bays: [[TOE, mid], [mid, o0], [o0, o1], ...(top ? [[o1, H]] : [])] });
  for (const [y0, y1] of [[TOE, mid], [mid, o0]]) drawer(X, F, cab, s0, s1, y0 + 0.012, y1 - 0.012, cd, y1 - 0.25);
  // The oven: its frame, a dark cavity with racks, and a door that drops open.
  const a = s0 + 0.16, b = s1 - 0.16, lo = o0 + 0.14, hi = o1 - 0.5;
  hollow(B, trim, F, [s0 + 0.04, o0, cd - 0.1, s1 - 0.04, o1, cd + 0.06], [a, b, cd - 0.1], [[lo, hi]]);
  liner(B, M.black, F, a, lo, 0.3, b, hi, cd + 0.06);
  for (const k of [0.3, 0.62]) rack(B, M.steelBrushed, F, a + 0.02, b - 0.02, 0.35, cd, lo + (hi - lo) * k);
  const L = drop(X, mover(X, 'oven'), F, o0 + 0.03, cd + 0.12);
  L.part(body, s0 + 0.06, o0 + 0.03, cd + 0.06, s1 - 0.06, o1 - 0.4, cd + 0.12);
  F.box(L.B, M.blackGlass, s0 + 0.3, o0 + 0.35, cd + 0.12, s1 - 0.3, o1 - 0.85, cd + 0.125);
  F.box(B, M.blackGlass, s0 + 0.06, o1 - 0.36, cd + 0.06, s1 - 0.06, o1 - 0.04, cd + 0.08);
  F.rodS(L.B, body, s0 + 0.2, s1 - 0.2, o1 - 0.6, cd + 0.26, 0.035);
  for (const s of [s0 + 0.24, s1 - 0.24]) F.rodT(L.B, body, s, o1 - 0.6, cd + 0.12, cd + 0.26, 0.02);
  if (top) {
    innerShelves(X, F, cab, s0, s1, o1, H, cd - 0.005, 1);
    doors(X, F, cab, s0, s1, o1, H, cd, doorCount(s1 - s0), { pullsAt: 'bottom' });
  }
}

// ---------------------------------------------------------------------------
// A run of kitchen segments in frame F (backs at t = 0, faces at t = cd).
// r: { segs, d (counter depth), ct, uppers, upperBottom, upperTop, soffit,
//      backsplash, hood, againstBack, ceiling, fridgeH, fridgeFront, tallH, counter }
// Returns the sink openings, for counters built by the caller.
function run(X, F, r) {
  const { B, M } = X, segs = r.segs, n = segs.length;
  const cd = r.d - 0.125, ct = r.ct, cTop = ct - SLAB;
  const kind = (i) => segs[i]?.kind;
  const tallEnd = (i) => kind(i) === 'end' && (TALL.has(kind(i - 1)) || TALL.has(kind(i + 1)));
  const hasCounter = (i) => COUNTER.has(kind(i)) || (kind(i) === 'end' && !tallEnd(i));
  const tallH = (k) => (k === 'fridge' ? r.fridgeH : r.tallH);
  const holes = [];

  segs.forEach((g, i) => {
    const { s0, s1 } = g, w = s1 - s0, c = (s0 + s1) / 2;
    const afterCorner = kind(i - 1) === 'corner', beforeCorner = kind(i + 1) === 'corner';
    switch (g.kind) {
      case 'base':
        base(X, F, s0, s1, cd, cTop, { drawer: g.drawers, hingeLeft: !afterCorner || beforeCorner });
        break;
      case 'drawers':
        drawerStack(X, F, s0, s1, cd, cTop);
        break;
      case 'sink': {
        const bw = Math.min(2.2, w - 0.5), t0 = Math.min(0.38, cd * 0.2), t1 = Math.max(t0 + 0.8, r.d - 0.365);
        base(X, F, s0, s1, cd, cTop, { falseFront: true, open: bw > 0.6 ? cTop - 0.74 : null });
        if (bw > 0.6) {
          holes.push({ s0: c - bw / 2, s1: c + bw / 2, t0, t1 });
          sinkBowl(X, F, c - bw / 2, c + bw / 2, t0, t1, cTop);
          faucet(X, F, c, Math.min(0.2, t0 * 0.55), ct);
        }
        break;
      }
      case 'dishwasher':
        dishwasher(X, F, s0, s1, cd, cTop);
        break;
      case 'range':
        range(X, F, s0, s1, cd, ct);
        above(X, F, s0, s1, r);
        break;
      case 'cooktop':
        base(X, F, s0, s1, cd, cTop, { falseFront: true });
        cooktop(X, F, s0, s1, cd, ct);
        above(X, F, s0, s1, r);
        break;
      case 'fridge':
        fridge(X, F, s0, s1, r.fridgeH, r.fridgeFront);
        if (r.uppers && r.upperTop - (r.fridgeH + 0.17) > 0.5) upper(X, F, s0, s1, r.fridgeH + 0.17, r.upperTop, doorCount(w), { depth: cd });
        break;
      case 'pantry':
        pantry(X, F, s0, s1, cd, r.tallH);
        break;
      case 'oven':
        wallOven(X, F, s0, s1, cd, r.tallH);
        break;
      case 'filler':
        toeKick(X, F, s0, s1, cd);
        F.box(B, X.cab, s0, TOE, 0, s1, cTop, cd + DOOR);
        break;
      case 'corner': {
        // Blind corner: another run's cabinets cover the end it sits at.
        toeKick(X, F, s0, s1, cd);
        const blind = i === 0 ? 'left' : i === n - 1 ? 'right' : null;
        const [a, b] = blind === 'left' ? [s0 + r.d, s1] : blind === 'right' ? [s0, s1 - r.d] : [s0, s1];
        if (blind && w - r.d <= 0.4) { F.box(B, X.cab, s0, TOE, 0, s1, cTop, cd); break; }
        if (a > s0) F.box(B, X.cab, s0, TOE, 0, a, cTop, cd);
        if (b < s1) F.box(B, X.cab, b, TOE, 0, s1, cTop, cd);
        carcass(X, F, X.cab, a, b, TOE, cTop, cd, { bays: [[TOE, cTop]] });
        innerShelves(X, F, X.cab, a, b, TOE, cTop, cd, 1);
        doors(X, F, X.cab, a, b, TOE, cTop, cd, doorCount(b - a), { hingeLeft: blind !== 'right' });
        break;
      }
      case 'end': {
        if (!tallEnd(i)) { F.box(B, X.cab, s0, 0, 0, s1, cTop, r.d); break; }
        const next = TALL.has(kind(i - 1)) ? kind(i - 1) : kind(i + 1);
        const top = r.uppers ? Math.max(r.upperTop, tallH(next)) : tallH(next);
        F.box(B, X.cab, s0, 0, 0, s1, top, next === 'fridge' ? r.fridgeFront - 0.16 : r.d);
        break;
      }
      case 'open':
        // Knee space; a leg panel holds up the counter at the run's ends.
        if (i === 0) F.box(B, X.cab, s0, 0, 0, s0 + 0.06, cTop, r.d);
        if (i === n - 1) F.box(B, X.cab, s1 - 0.06, 0, 0, s1, cTop, r.d);
        break;
    }
  });

  // Contiguous stretches of segments where test(i) holds, as [first, last].
  const spans = (test) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (!test(i)) continue;
      let j = i;
      while (j + 1 < n && test(j + 1)) j++;
      out.push([i, j]);
      i = j;
    }
    return out;
  };

  // One continuous counter over each stretch of counter segments.
  if (r.counter !== false) {
    for (const [i, j] of spans(hasCounter)) slab(B, X.counter, F, segs[i].s0, segs[j].s1, 0, r.d, cTop, ct, holes);
  }

  // Wall cabinets.
  const plainUpper = (i) => segs[i].upper && !TALL.has(kind(i)) && !['range', 'cooktop', 'end'].includes(kind(i));
  if (r.uppers) {
    for (const [i, j] of spans(plainUpper)) {
      upperSpan(X, F, segs[i].s0, segs[j].s1, r.upperBottom, r.upperTop, {
        blindLeft: i === 0 && kind(0) === 'corner', blindRight: j === n - 1 && kind(j) === 'corner',
      });
    }
  }

  // Backsplash behind the counters and the range, up to the uppers.
  if (r.againstBack && r.backsplash && r.backsplash !== 'none') {
    const top = r.uppers ? r.upperBottom : ct + 1.5;
    const [mat, th] = backsplashOf(X, r.backsplash);
    for (const [i, j] of spans((k) => hasCounter(k) || kind(k) === 'range')) F.box(B, mat, segs[i].s0, ct, 0, segs[j].s1, top, th);
  }

  // Outlets on the backsplash, clear of sinks, cooktops and corners.
  if (r.againstBack && r.counter !== false) {
    const t = !r.backsplash || r.backsplash === 'none' ? 0 : backsplashOf(X, r.backsplash)[1];
    for (const [i, j] of spans((k) => hasCounter(k) && !['sink', 'cooktop', 'corner'].includes(kind(k)))) {
      const a = segs[i].s0, b = segs[j].s1, len = b - a;
      if (len < 0.6) continue;
      const m = Math.max(1, Math.floor(len / 4));
      for (let k = 0; k < m; k++) outlet(X, F, a + (len * (k + 0.5)) / m, ct + 0.55, t);
    }
  }

  // Soffit from the top of the uppers to the ceiling, as deep as what's under it.
  if (r.soffit && r.uppers && r.ceiling - r.upperTop > 0.02) {
    const reaches = (i) => plainUpper(i) || TALL.has(kind(i)) || tallEnd(i) || (['range', 'cooktop'].includes(kind(i)) && r.againstBack);
    const depthOf = (i) => (kind(i) === 'fridge' ? cd : kind(i) === 'pantry' || kind(i) === 'oven' ? cd + DOOR : tallEnd(i) ? 0 : UPPER_D);
    for (const [i, j] of spans(reaches)) {
      let depth = 0;
      for (let k = i; k <= j; k++) depth = Math.max(depth, depthOf(k));
      F.box(X.soffit, X.paint, segs[i].s0, r.upperTop, 0, segs[j].s1, r.ceiling, depth + 0.06);
    }
  }
  return holes;
}

// What hangs over a range or cooktop: a microwave or hood, and a cabinet when the run has uppers.
function above(X, F, s0, s1, r) {
  if (!r.againstBack) return;
  const ub = r.upperBottom, ut = r.upperTop, w = s1 - s0;
  if (r.hood === 'microwave') {
    microwave(X, F, s0, s1, ub);
    if (r.uppers && ut - (ub + 1.4) > 0.4) upper(X, F, s0, s1, ub + 1.4, ut, doorCount(w));
  } else if (r.hood === 'hood') {
    if (r.uppers) {
      const y = Math.min(ub + 1.0, ut - 0.9);
      hood(X, F, s0, s1, y, ut, false);
      upper(X, F, s0, s1, y + 0.22, ut, doorCount(w));
    } else hood(X, F, s0, s1, r.ct + 2.5, r.ceiling, true);
  } else if (r.uppers && ut - (ub + 1.4) > 0.4) upper(X, F, s0, s1, ub + 1.4, ut, doorCount(w));
}

function kitchen(X, f, F) {
  const segs = f.segments ?? [{ kind: 'base', s0: -f.w / 2, s1: f.w / 2, upper: false, drawers: false }];
  const alone = f.type !== 'kitchen-run';
  run(X, F, {
    segs, d: f.d,
    ct: f.type === 'fridge' || f.type === 'pantry' ? 3 : f.h,
    uppers: !!f.uppers, upperBottom: f.upperBottom ?? 4.5, upperTop: f.upperTop ?? Math.min(8, X.ceiling),
    soffit: !!f.soffit, backsplash: f.backsplash ?? 'none', hood: f.hood ?? 'microwave',
    againstBack: !!f.against?.back, ceiling: X.ceiling,
    fridgeH: f.type === 'fridge' ? f.h : FRIDGE_H,
    fridgeFront: alone ? f.d : f.d + 0.635,
    tallH: f.type === 'pantry' ? f.h : f.upperTop ?? Math.min(8, X.ceiling),
  });
}

// Cabinets facing the island's back (the kitchen side), a counter that
// overhangs the front for stools, and an optional sink or cooktop.
function island(X, f, F) {
  const { w, d, h } = f, o = f.opts;
  const ov = Math.max(0, Math.min(o.overhang ?? Math.max(0.5, Math.min(1.25, d - 2.0)), d - 1.2));
  const back = d - ov, inset = 0.08, W = Math.max(0.5, w - 2 * inset);
  const mid = [];
  if (o.sink) mid.push({ kind: 'sink', w: 2.75 });
  if (o.cooktop) { if (mid.length) mid.push({ kind: 'base', w: 1.5, drawers: true }); mid.push({ kind: 'cooktop', w: 2.5 }); }
  let midW = mid.reduce((a, g) => a + g.w, 0);
  if (midW > W) { mid.forEach((g) => { g.w *= W / midW; }); midW = W; }
  const fill = (len) => {
    if (len < 0.05) return [];
    if (len < 0.75) return [{ kind: 'filler', w: len }];
    const k = Math.ceil(len / 3 - 0.01);
    return Array.from({ length: k }, () => ({ kind: 'base', w: len / k, drawers: true }));
  };
  const list = [...fill((W - midW) / 2), ...mid, ...fill((W - midW) / 2)];
  let s = -W / 2;
  const segs = list.map((g) => { const seg = { kind: g.kind, s0: s, s1: s + g.w, upper: false, drawers: !!g.drawers }; s += g.w; return seg; });
  // Turned around: G's back is the seating side, its front the island's back.
  const G = new Frame(0, -d / 2 + back, [-1, 0], [0, -1]);
  const holes = run(X, G, {
    segs, d: back, ct: h, uppers: false, againstBack: false, backsplash: 'none', hood: 'none', counter: false,
    ceiling: X.ceiling, fridgeH: FRIDGE_H, fridgeFront: back, tallH: h,
  });
  F.box(X.B, X.cab, -W / 2, 0, back, W / 2, h - SLAB, back + 0.06);
  slab(X.B, X.counter, F, -w / 2, w / 2, 0, d, h - SLAB, h, holes.map((q) => ({ s0: -q.s1, s1: -q.s0, t0: back - q.t1, t1: back - q.t0 })));
}

function upperCabinet(X, f, F) {
  const y0 = Math.min(f.opts.bottom ?? 4.5, X.ceiling - 0.5);
  upperSpan(X, F, -f.w / 2, f.w / 2, y0, Math.min(y0 + f.h, X.ceiling), { depth: f.d });
}

// ---------------------------------------------------------------------------
// Baths

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

// Framed rounded mirror on the wall behind, centered at s, bottom at y0.
function mirror(X, F, s, y0, w, h, r) {
  const { B, M, hw } = X;
  B.push(F.matrixAt(s, y0 + h / 2, 0.012));
  const outer = roundedRect(w, h, r);
  outer.holes.push(roundedRect(w - 0.09, h - 0.09, r - 0.04));
  B.add(new THREE.ExtrudeGeometry(outer, { depth: 0.07, bevelEnabled: false, curveSegments: 10 }), hw);
  const glass = new THREE.ShapeGeometry(roundedRect(w - 0.08, h - 0.08, r - 0.04), 10);
  glass.translate(0, 0, 0.035);
  B.add(glass, M.mirror);
  B.pop();
}

function lightBar(X, F, s, y, w) {
  const { B, M, hw } = X;
  F.box(B, hw, s - w / 2, y, 0, s + w / 2, y + 0.09, 0.14);
  F.box(B, M.led, s - w / 2 + 0.05, y - 0.008, 0.03, s + w / 2 - 0.05, y, 0.12);
  F.box(B, hw, s - 0.22, y - 0.12, 0, s + 0.22, y + 0.2, 0.05);
}

// Cabinet with doors and a false front per sink, a stone top with undermount
// bowls and square single-lever faucets; a mirror and light bar over each sink.
function vanity(X, f, F) {
  const { B, M, hw, cab } = X, { w, d, h } = f, o = f.opts;
  const sinks = o.sinks === 2 && w / 2 >= 1.4 ? 2 : 1, sw = w / sinks, top = h - 0.12;
  F.box(B, M.toeKick, -w / 2 + 0.08, 0, 0, w / 2 - 0.08, 0.3, d - 0.2);
  carcass(X, F, cab, -w / 2, w / 2, 0.3, top, d - 0.06, { open: top - 0.46 });
  const holes = [];
  for (let i = 0; i < sinks; i++) {
    const s0 = -w / 2 + i * sw, s1 = s0 + sw, c = (s0 + s1) / 2;
    F.box(B, cab, s0 + 0.01, top - 0.42, d - 0.06, s1 - 0.01, top - 0.01, d);
    // Doors under the false front, hinged at the sides; each with its pull.
    const m = mover(X, 'vanity'), leaves = [];
    if (sw > 1.6) {
      leaves.push([swing(X, m, F, s0 + 0.01, d, 1).part(cab, s0 + 0.01, 0.31, d - 0.06, c - 0.006, top - 0.44, d), c - 0.12]);
      leaves.push([swing(X, m, F, s1 - 0.01, d, -1).part(cab, c + 0.006, 0.31, d - 0.06, s1 - 0.01, top - 0.44, d), c + 0.12]);
      seam(leaves[1][0], F, cab, c - 0.006, c + 0.006, 0.31, top - 0.44, d - 0.06);
    } else {
      leaves.push([swing(X, m, F, s0 + 0.01, d, 1).part(cab, s0 + 0.01, 0.31, d - 0.06, s1 - 0.01, top - 0.44, d), s1 - 0.14]);
    }
    for (const [L, ps] of leaves) {
      F.box(L.B, hw, ps - 0.017, top - 1.2, d + 0.07, ps + 0.017, top - 0.7, d + 0.1);
      F.box(L.B, hw, ps - 0.01, top - 1.15, d, ps + 0.01, top - 1.12, d + 0.07);
      F.box(L.B, hw, ps - 0.01, top - 0.78, d, ps + 0.01, top - 0.75, d + 0.07);
    }
    // Bowl under an opening in the top, and the faucet behind it.
    const bw = Math.min(1.4, sw - 0.6), b0 = c - bw / 2, b1 = c + bw / 2, t0 = 0.45, t1 = d - 0.22, by = top - 0.45;
    if (bw > 0.5 && t1 - t0 > 0.4) {
      holes.push({ s0: b0, s1: b1, t0, t1 });
      F.box(B, M.porcelain, b0, by, t0, b1, by + 0.03, t1);
      F.box(B, M.porcelain, b0, by, t0, b0 + 0.03, top, t1);
      F.box(B, M.porcelain, b1 - 0.03, by, t0, b1, top, t1);
      F.box(B, M.porcelain, b0, by, t0, b1, top, t0 + 0.03);
      F.box(B, M.porcelain, b0, by, t1 - 0.03, b1, top, t1);
    }
    F.box(B, hw, c - 0.05, h, 0.15, c + 0.05, h + 0.55, 0.27);
    F.box(B, hw, c - 0.05, h + 0.45, 0.27, c + 0.05, h + 0.55, 0.62);
    F.box(B, hw, c - 0.025, h + 0.55, 0.18, c + 0.025, h + 0.62, 0.36);
    if (!f.against?.back) continue;
    const mw = Math.min(sw - 0.15, 2.4), my = h + 1.11, mh = Math.min(mw > 2 ? 2.7 : 2.6, X.ceiling - 0.9 - my);
    if (o.mirror !== false && mh > 1) mirror(X, F, c, my, mw, mh, mw > 2 ? 0.3 : 0.28);
    if (o.light !== false) lightBar(X, F, c, Math.min(my + 2.9, X.ceiling - 0.35), Math.min(sw, 2.4));
  }
  slab(B, M.marble, F, -w / 2 - 0.02, w / 2 + 0.02, 0, d + 0.04, top, h, holes);
}

// Elongated toilet with its tank against the wall, scaled to the fixture.
function toilet(X, f, F) {
  const { B, M } = X;
  B.push(F.matrixAt(0, 0, 0)).push(new THREE.Matrix4().makeScale(f.w / 1.72, f.h / 2.52, f.d / 2.35));
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
  B.box(X.hw, 0.55, 2.3, 0.73, 0.68, 2.36, 0.8);
  B.pop().pop();
}

// A frame on the end wall at s = e·w/2 (e = -1 left, +1 right), t = tc:
// its s runs along the wall, its t out of the wall into the fixture.
const endFrame = (w, d, e, tc) => (e < 0 ? new Frame(-w / 2, -d / 2 + tc, [0, -1], [1, 0]) : new Frame(w / 2, -d / 2 + tc, [0, 1], [-1, 0]));

// A disc on the wall facing out (valves, escutcheons).
function wallDisc(X, W, y, r, out = 0.05) {
  const g = new THREE.CylinderGeometry(r, r, 0.04, 28);
  g.rotateX(Math.PI / 2);
  X.B.push(W.matrixAt(0, y, out)).add(g, X.hw).pop();
}

// Wall-mounted rain head on an arm, and the valve below it, in wall frame W.
function showerHead(X, W, y, valveY, r = 0.19) {
  const { B, hw } = X;
  const [ax, az] = W.p(0, 0.03), [bx, bz] = W.p(0, 0.45), [hx, hz] = W.p(0, 0.55);
  B.rod(hw, [ax, y - 0.13, az], [bx, y + 0.07, bz], 0.035);
  B.cyl(hw, hx, y, hz, r, 0.07, 28);
  wallDisc(X, W, valveY, 0.2);
  W.box(B, hw, -0.02, valveY - 0.02, 0.2, 0.3, valveY + 0.03, 0.25);
}

// Alcove tub; with a shower, tile on the walls around it, a head and valve at
// the drain end and a curtain or glass screen.
function tub(X, f, F) {
  const { B, M, hw } = X, { w, d, h } = f, o = f.opts, a = f.against ?? {};
  const e = a.left || !a.right ? -1 : 1;  // the end with the drain, spout and head
  const end = (side) => (side === e ? 0.32 : 0.2);
  F.box(B, M.porcelain, -w / 2, 0, 0, w / 2, 0.32, d);
  F.box(B, M.porcelain, -w / 2, 0, d - 0.24, w / 2, h, d);
  F.box(B, M.porcelain, -w / 2, 0, 0, w / 2, h, 0.2);
  F.box(B, M.porcelain, -w / 2, 0, 0, -w / 2 + end(-1), h, d);
  F.box(B, M.porcelain, w / 2 - end(1), 0, 0, w / 2, h, d);
  const [dx, dz] = F.p(e * (w / 2 - 0.6), d / 2);
  B.cyl(M.steelBrushed, dx, 0.32, dz, 0.08, 0.006, 20);
  // Spout and valve on the end wall, else on the back wall near that end,
  // else a floor-mounted filler beside the tub.
  const W = (e < 0 ? a.left : a.right) ? endFrame(w, d, e, d / 2) : a.back ? new Frame(e * (w / 2 - 0.75), -d / 2, [1, 0], [0, 1]) : null;
  if (!W) {
    const [fx, fz] = F.p(e * (w / 2 + 0.25), d / 2), [sx, sz] = F.p(e * (w / 2 - 0.2), d / 2);
    B.cyl(hw, fx, 0, fz, 0.04, h + 0.9, 12);
    B.rod(hw, [fx, h + 0.9, fz], [sx, h + 0.75, sz], 0.035);
    return;
  }
  W.rodT(B, hw, 0, h + 0.4, 0.03, 0.42, 0.04);
  if (!o.shower) { wallDisc(X, W, h + 0.9, 0.17); return; }
  const top = Math.min(o.tile_height ?? 7, X.ceiling);
  if (a.back) F.box(B, X.tile, -w / 2, h, 0, w / 2, top, 0.03);
  if (a.left) F.box(B, X.tile, -w / 2, h, 0, -w / 2 + 0.03, top, d);
  if (a.right) F.box(B, X.tile, w / 2 - 0.03, h, 0, w / 2, top, d);
  const headY = Math.min(6.53, X.ceiling - 0.4);
  showerHead(X, W, headY, Math.min(h + 2.05, headY - 1), 0.17);
  const enclosure = o.enclosure ?? 'curtain';
  if (enclosure === 'curtain') {
    const rodY = Math.min(7.0, X.ceiling - 0.3), len = Math.min(1.2, w * 0.4), ch = rodY - 0.08 - (h + 0.17);
    F.rodS(B, M.steel, -w / 2, w / 2, rodY, d - 0.08, 0.03);
    const cg = new THREE.PlaneGeometry(len, ch, 30, 1);
    const pos = cg.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 18) * 0.07);
    cg.computeVertexNormals();
    const [cx, cz] = F.p(-e * (w / 2 - len / 2 - 0.05), d - 0.08);
    cg.translate(cx, h + 0.17 + ch / 2, cz);
    B.add(cg, M.curtain);
  } else if (enclosure === 'glass') {
    const len = Math.min(w * 0.55, 3), tg = d - 0.12, s0 = e * (w / 2 - 0.02), s1 = e * (w / 2 - len), gTop = Math.min(h + 4.8, top);
    F.box(X.glass, M.showerGlass, Math.min(s0, s1), h, tg - 0.015, Math.max(s0, s1), gTop, tg + 0.015);
    F.box(B, hw, Math.min(s0, s0 - e * 0.04), h, tg - 0.03, Math.max(s0, s0 - e * 0.04), gTop, tg + 0.03);
    for (const y of [h + 0.6, gTop - 0.6]) F.box(B, hw, Math.min(s1, s1 + e * 0.12), y, tg - 0.04, Math.max(s1, s1 + e * 0.12), y + 0.25, tg + 0.04);
  }
}

// Walk-in shower: pan and curb, tile on the walls it touches, glass on the
// open sides, a head and valve, and a drain.
function shower(X, f, F) {
  const { B, M, hw } = X, { w, d } = f, o = f.opts, a = f.against ?? {};
  const h = Math.min(f.h, X.ceiling), curb = o.curb !== false, cw = 0.33, ch = curb ? 0.33 : 0;
  const glassType = o.glass ?? 'panel', entry = o.entry ?? 'right';
  const openL = !a.left, openR = !a.right;
  const p0 = openL && curb ? -w / 2 + cw : -w / 2, p1 = openR && curb ? w / 2 - cw : w / 2, pt = curb ? d - cw : d;
  F.box(B, M.tileFloor, p0, 0, 0, p1, 0.03, pt);
  if (curb) {
    F.box(B, M.marble, -w / 2, 0, d - cw, w / 2, ch, d);
    if (openL) F.box(B, M.marble, -w / 2, 0, 0, -w / 2 + cw, ch, d - cw);
    if (openR) F.box(B, M.marble, w / 2 - cw, 0, 0, w / 2, ch, d - cw);
  }
  if (a.back) F.box(B, X.tile, -w / 2, 0, 0, w / 2, h, 0.03);
  if (a.left) F.box(B, X.tile, -w / 2, 0, 0, -w / 2 + 0.03, h, d);
  if (a.right) F.box(B, X.tile, w / 2 - 0.03, 0, 0, w / 2, h, d);
  const [dx, dz] = F.p((p0 + p1) / 2, pt / 2);
  B.cyl(M.steelBrushed, dx, 0.03, dz, 0.2, 0.006, 4);

  // Glass: along the front, and down any open side.
  if (glassType !== 'none') {
    const gTop = Math.min(h, 6.9), tg = curb ? d - cw / 2 : d - 0.1, inset = curb ? cw / 2 : 0.1;
    const sL = openL ? -w / 2 + inset : -w / 2 + 0.04, sR = openR ? w / 2 - inset : w / 2 - 0.04;
    const span = sR - sL, gap = Math.min(Math.max(span * 0.44, 1.75), 2.9);
    const panel = (s0, s1, wall) => {
      if (s1 - s0 < 0.3) return;
      F.box(X.glass, M.showerGlass, s0, ch, tg - 0.015, s1, gTop, tg + 0.015);
      for (const s of [s0 + 0.55, s1 - 0.55]) if (s1 - s0 > 1.3) F.box(B, hw, s - 0.09, ch, tg - 0.055, s + 0.09, ch + 0.17, tg + 0.055);
      if (wall) { const s = wall < 0 ? s0 : s1 - 0.22; F.box(B, hw, s, gTop - 0.28, tg - 0.055, s + 0.22, gTop - 0.06, tg + 0.055); }
    };
    const door = (s0, s1, hingeAt) => {
      F.box(X.glass, M.showerGlass, s0 + 0.01, ch + 0.03, tg - 0.015, s1 - 0.01, gTop, tg + 0.015);
      const hs = hingeAt < 0 ? s0 + 0.04 : s1 - 0.12, hs2 = hingeAt < 0 ? s1 - 0.12 : s0 + 0.06;
      for (const y of [ch + 0.6, gTop - 0.6]) F.box(B, hw, hs, y, tg - 0.04, hs + 0.08, y + 0.2, tg + 0.04);
      F.box(B, hw, hs2, ch + 2.8, tg + 0.015, hs2 + 0.04, ch + 4.3, tg + 0.09);
      F.box(B, hw, hs2, ch + 2.8, tg - 0.09, hs2 + 0.04, ch + 4.3, tg - 0.015);
    };
    const dw = Math.min(Math.max(span * 0.4, 1.75), 2.5);
    if (glassType === 'door') {
      if (entry === 'left') { door(sL, sL + dw, 1); panel(sL + dw, sR, a.right ? 1 : 0); }
      else if (entry === 'center') { const c = (sL + sR) / 2; panel(sL, c - dw / 2, a.left ? -1 : 0); door(c - dw / 2, c + dw / 2, -1); panel(c + dw / 2, sR, a.right ? 1 : 0); }
      else { panel(sL, sR - dw, a.left ? -1 : 0); door(sR - dw, sR, -1); }
    } else if (entry === 'left') panel(sL + gap, sR, a.right ? 1 : 0);
    else if (entry === 'center') { const c = (sL + sR) / 2, g = Math.min(gap, 2.2); panel(sL, c - g / 2, a.left ? -1 : 0); panel(c + g / 2, sR, a.right ? 1 : 0); }
    else panel(sL, sR - gap, a.left ? -1 : 0);
    // Open sides get fixed glass from the wall to the front.
    for (const [open, s] of [[openL, sL], [openR, sR]]) {
      if (!open) continue;
      F.box(X.glass, M.showerGlass, s - 0.015, ch, 0.04, s + 0.015, gTop, tg - 0.015);
      F.box(B, hw, s - 0.03, ch, 0, s + 0.03, gTop, 0.04);
    }
  }

  // Head and valve: on the far end wall of a long shower entered from one
  // end (as in the example's walk-in), otherwise on the back wall.
  const far = entry === 'right' ? -1 : entry === 'left' ? 1 : 0;
  const headY = Math.min(6.68, h - 0.3, X.ceiling - 0.35);
  if (far && w >= d * 1.3 && (far < 0 ? a.left : a.right)) showerHead(X, endFrame(w, d, far, Math.min(d * 0.41, pt - 0.6)), headY, 4.0);
  else showerHead(X, new Frame(far * w * 0.2, -d / 2, [1, 0], [0, 1]), headY, 4.0);
}

// Tile on a wall face, from opts.bottom up to h.
function wallTile(X, f, F) {
  const y0 = Math.min(f.opts.bottom ?? 0, f.h - 0.05);
  F.box(X.B, X.tile, -f.w / 2, y0, 0, f.w / 2, f.h, Math.max(f.d, 0.02));
}

function exhaustFan(X, x, z, y) {
  const { B, M } = X;
  B.box(M.vent, x - 0.4, y - 0.03, z - 0.4, x + 0.4, y, z + 0.4);
  for (let i = 0; i < 7; i++) B.box(M.toeKick, x - 0.32, y - 0.035, z - 0.3 + i * 0.09, x + 0.32, y - 0.03, z - 0.27 + i * 0.09);
}

// ---------------------------------------------------------------------------
// Laundry

// One front-loading unit between y0 and y1: control strip and a round door
// (its chrome ring and all) hinged at the ring's left edge, over the drum's
// dark mouth.
function frontLoader(X, F, w, d, y0, y1, dryer, name) {
  const { B, M } = X, uh = y1 - y0, k = Math.min(uh / 3.23, w / 2), r = 0.66 * k;
  F.box(B, M.vent, -w / 2 + 0.02, y1 - 0.32 * k, d, w / 2 - 0.02, y1 - 0.04 * k, d + 0.02);
  F.box(B, M.blackGlass, w / 2 - 0.55 * k, y1 - 0.26 * k, d + 0.02, w / 2 - 0.12 * k, y1 - 0.1 * k, d + 0.025);
  const [x, z] = F.p(0, d), y = y0 + uh * 0.45;
  const disc = (rad, th, at, mat, batch) => {
    const g = new THREE.CylinderGeometry(rad, rad, th, 40);
    g.rotateX(Math.PI / 2); g.translate(x, y, z + at);
    batch.add(g, mat);
  };
  disc(0.56 * k, 0.004, 0.002, M.black, B);
  const L = swing(X, mover(X, name), F, -r, d + 0.075, 1).reach(-r, y - r, d, r, y + r, d + 0.075);
  disc(r, 0.06, 0.03, M.steelBrushed, L.B);
  disc(0.52 * k, 0.07, 0.04, dryer ? X.laundry : M.blackGlass, L.B);
  if (dryer) disc(0.36 * k, 0.075, 0.04, M.blackGlass, L.B);
}

function washerDryer(X, f, F) {
  const { B, M } = X, { w, d, h } = f, mid = h / 2;
  F.box(B, X.laundry, -w / 2, 0.04, 0, w / 2, h, d);
  F.box(B, M.steelBrushed, -w / 2, mid - 0.02, d - 0.01, w / 2, mid + 0.02, d + 0.005);
  frontLoader(X, F, w, d, 0.04, mid - 0.02, false, 'washer');
  frontLoader(X, F, w, d, mid + 0.02, h, false, 'dryer');
}

function laundryUnit(X, f, F) {
  const { w, d, h } = f;
  F.box(X.B, X.laundry, -w / 2, 0.04, 0, w / 2, h, d);
  F.box(X.B, X.M.black, -w / 2 + 0.05, 0, 0.1, w / 2 - 0.05, 0.04, d - 0.1);
  frontLoader(X, F, w, d, 0.04, h, f.type === 'dryer', f.type === 'dryer' ? 'dryer' : 'washer');
}

function waterHeater(X, f, F) {
  const { B, M } = X, { w, d, h } = f, r = Math.min(w, d) / 2, [x, z] = F.p(0, d / 2);
  B.cyl(M.appliance, x, 0, z, r, h, 40);
  B.cyl(M.steelBrushed, x, h, z, r, 0.12, 40, r * 0.81);
  if (X.ceiling - h > 0.2) for (const ds of [-0.35 * r, 0.35 * r]) { const [px, pz] = F.p(ds, d / 2); B.cyl(M.steelBrushed, px, h + 0.12, pz, 0.05, X.ceiling - h - 0.12, 10); }
}

// Freestanding laundry tub on legs, faucet on the back rim.
function utilitySink(X, f, F) {
  const { B, M } = X, { w, d, h } = f, y0 = Math.max(0.5, h - 1.1), wall = 0.07, tub = M.appliance;
  for (const s of [-w / 2 + 0.1, w / 2 - 0.1]) for (const t of [0.1, d - 0.1]) { const [x, z] = F.p(s, t); B.cyl(tub, x, 0, z, 0.06, y0, 12); }
  F.box(B, tub, -w / 2, y0, 0, w / 2, y0 + 0.08, d);
  F.box(B, tub, -w / 2, y0, 0, -w / 2 + wall, h, d);
  F.box(B, tub, w / 2 - wall, y0, 0, w / 2, h, d);
  F.box(B, tub, -w / 2, y0, 0, w / 2, h, 0.3);
  F.box(B, tub, -w / 2, y0, d - wall, w / 2, h, d);
  faucet(X, F, 0, 0.15, h);
}

// ---------------------------------------------------------------------------
// Storage and the rest

function closet(X, f, F) {
  const { B, M } = X, { w, d, h } = f;
  F.box(B, M.trim, -w / 2, h + 0.25, 0, w / 2, h + 0.3, d);
  F.rodS(B, M.steel, -w / 2, w / 2, h, d * 0.52, 0.04);
  if (f.opts.double) F.rodS(B, M.steel, -w / 2, w / 2, Math.max(1.5, h - 3.3), d * 0.52, 0.04);
}

function shelves(X, f, F) {
  const { B, M } = X, { w, d, h } = f, mat = f.color ? X.cab : M.trim, th = 0.06;
  F.box(B, mat, -w / 2, 0, 0, -w / 2 + th, h, d);
  F.box(B, mat, w / 2 - th, 0, 0, w / 2, h, d);
  F.box(B, mat, -w / 2, 0, 0, w / 2, h, 0.03);
  F.box(B, mat, -w / 2 + th, 0, d - 0.04, w / 2 - th, TOE * 0.6, d);
  const k = Math.max(2, Math.round(h / 1.15));
  for (let i = 0; i <= k; i++) {
    const y = TOE * 0.6 + (i * (h - TOE * 0.6 - th)) / k;
    F.box(B, mat, -w / 2 + th, y, 0, w / 2 - th, y + th, d);
  }
}

function builtIn(X, f, F) {
  const { B, cab } = X, { w, d, h } = f, cd = d - DOOR, top = h - 0.06;
  toeKick(X, F, -w / 2, w / 2, cd);
  F.box(B, cab, -w / 2, top, 0, w / 2, h, d + 0.03);
  const n = Math.max(1, Math.ceil(w / 3 - 0.01)), cw = w / n, split = h > 4.5 ? Math.min(3, h - 1) : null;
  for (let k = 0; k < n; k++) {
    const s0 = -w / 2 + k * cw, s1 = s0 + cw;
    carcass(X, F, cab, s0, s1, TOE, top, cd, { bays: split ? [[TOE, split], [split, top]] : [[TOE, top]] });
    innerShelves(X, F, cab, s0, s1, TOE, split ?? top, cd);
    doors(X, F, cab, s0, s1, TOE, split ?? top, cd, doorCount(cw));
    if (!split) continue;
    innerShelves(X, F, cab, s0, s1, split, top, cd, 1);
    doors(X, F, cab, s0, s1, split, top, cd, doorCount(cw), { pullsAt: 'bottom' });
  }
}

// Painted surround with a stone face, a black firebox, a hearth and a mantel shelf.
function fireplace(X, f, F) {
  const { B, M } = X, { w, d, h } = f, mantel = f.opts.mantel !== false, body = h - (mantel ? 0.2 : 0);
  const face = d - 0.05, sw = Math.max(0.6, Math.min(w - 0.4, Math.max(2.5, w * 0.7))), fw = Math.max(0.3, sw - 0.8), fh = Math.min(2.4, body * 0.6);
  F.box(B, M.marble, -w / 2 - 0.15, 0, 0, w / 2 + 0.15, 0.08, d + 0.5);
  F.box(B, X.paint, -w / 2, 0.08, 0, w / 2, body, face);
  F.box(B, M.marble, -sw / 2, 0.08, face, sw / 2, Math.min(body - 0.15, fh + 0.5), face + 0.04);
  F.box(B, M.black, -fw / 2, 0.08, face + 0.04 - 0.3, fw / 2, 0.08 + fh, face + 0.045);
  F.box(B, M.blackGlass, -fw / 2 + 0.08, 0.16, face + 0.045, fw / 2 - 0.08, fh, face + 0.05);
  if (mantel) F.box(B, M.walnut, -w / 2 - 0.12, body, 0, w / 2 + 0.12, h, d + 0.18);
}

function column(X, f, F) {
  const mat = /^#[0-9a-f]{6}$/i.test(f.color ?? '') ? paint(f.color) : X.paint;
  F.box(X.B, mat, -f.w / 2, 0, 0, f.w / 2, f.h, f.d);
}

// Cast-iron radiator: fins on two feet.
function radiator(X, f, F) {
  const { B } = X, { w, d, h } = f, mat = cached(X.M, 'radiator', () => std(0xeceae6, 0.55)), fin = 0.13, pitch = 0.21;
  const n = Math.max(2, Math.floor((w + pitch - fin) / pitch)), s0 = -((n - 1) * pitch + fin) / 2;
  for (let i = 0; i < n; i++) F.box(B, mat, s0 + i * pitch, 0.35, 0.05, s0 + i * pitch + fin, h, d);
  F.box(B, mat, s0, 0.45, d / 2 - 0.05, -s0, 0.55, d / 2 + 0.05);
  F.box(B, mat, s0, h - 0.15, d / 2 - 0.05, -s0, h - 0.05, d / 2 + 0.05);
  for (const s of [s0 + 0.05, -s0 - 0.17]) F.box(B, mat, s, 0, 0.05, s + 0.12, 0.35, d);
}

// Through-the-wall AC (PTAC) at the floor: louvers on top, a grille below.
function acUnit(X, f, F) {
  const { B, M } = X, { w, d, h } = f, body = cached(M, 'ac', () => std(0xe9e6df, 0.45));
  F.box(B, body, -w / 2, 0, 0, w / 2, h, d);
  for (let i = 0; i < 6; i++) F.box(B, M.toeKick, -w / 2 + 0.15, h, d * 0.35 + i * 0.07, w / 2 - 0.15, h + 0.004, d * 0.35 + i * 0.07 + 0.03);
  const g = Math.max(0.3, h - 0.45), rows = Math.max(3, Math.floor(g / 0.07));
  for (let i = 0; i < rows; i++) F.box(B, M.vent, -w / 2 + 0.1, 0.12 + i * (g / rows), d, w / 2 - 0.5, 0.12 + i * (g / rows) + 0.03, d + 0.01);
  F.box(B, M.blackGlass, w / 2 - 0.4, h - 0.32, d, w / 2 - 0.1, h - 0.12, d + 0.01);
}

// Bar counter: a painted knee wall with a counter slab that overhangs the front.
function barCounter(X, f, F) {
  const { w, d, h } = f, wall = Math.min(0.5, d * 0.6);
  F.box(X.B, X.paint, -w / 2, 0, 0, w / 2, h - SLAB, wall);
  F.box(X.B, X.counter, -w / 2, h - SLAB, 0, w / 2, h, d);
}

const BUILD = {
  'kitchen-run': kitchen, fridge: kitchen, range: kitchen, dishwasher: kitchen, 'sink-cabinet': kitchen, 'base-cabinet': kitchen, pantry: kitchen,
  island, 'upper-cabinet': upperCabinet,
  toilet, vanity, tub, shower, 'wall-tile': wallTile,
  'washer-dryer': washerDryer, washer: laundryUnit, dryer: laundryUnit, 'water-heater': waterHeater, 'utility-sink': utilitySink,
  closet, shelves, 'built-in': builtIn,
  fireplace, column, radiator, 'ac-unit': acUnit, counter: barCounter,
};

// Everything built into the unit, merged per material: `solid` (cabinets,
// appliances, fixtures), `glass` (shower glass, no shadows) and `soffit`
// (painted boxes over the uppers, which belong with the ceilings).
export function buildFixtures(M, U) {
  const B = new Batch('fixtures');
  const glass = new Batch('fixture-glass');
  const soffit = new Batch('fixture-soffit');
  const fin = U.finishes ?? {}, textures = U.textures ?? [];
  const shared = {
    M, B, glass, soffit, textures,
    counter: counterMat(M, fin.counters, textures), app: applianceMats(M, fin.appliances), hw: hardwareMat(M, fin.hardware),
    tile: tileMat(M, fin.tile, textures), paint: paint(fin.walls ?? '#f2f1ee'), movers: [],
  };
  shared.laundry = fin.appliances === 'black' ? shared.app.body : M.appliance;
  const batches = [B, glass, soffit];
  for (const f of U.fixtures ?? []) {
    const build = BUILD[f.type];
    if (!build) continue;
    const room = U.roomById?.[f.room];
    const X = { ...shared, cab: cabinetMat(M, f.color ?? fin.cabinets, textures), ceiling: room?.ceiling ?? U.heights?.ceiling ?? 9, fixtureId: f.id };
    const m = new THREE.Matrix4().makeRotationY(-f.rot * DEG).setPosition(f.x, 0, f.z);
    batches.forEach((b) => b.push(m));
    // One odd fixture shouldn't take the rest of the unit down with it.
    try { build(X, { ...f, opts: f.opts ?? {} }, new Frame(0, -f.d / 2, [1, 0], [0, 1])); } catch (err) { console.error(`fixture ${f.id}`, err); }
    batches.forEach((b) => { b.stack.length = 1; });
  }
  for (const r of U.rooms ?? []) if (r.kind === 'bath') exhaustFan(shared, r.at[0], r.at[1], r.ceiling);
  const moving = buildMovers(shared.movers);
  const out = { solid: B.build(), glass: glass.build({ shadows: false }), soffit: soffit.build(), movable: moving.group, movers: moving.movers };
  out.dispose = () => {
    for (const g of [out.solid, out.glass, out.soffit, out.movable]) g.traverse((o) => o.geometry?.dispose());
    moving.skeleton?.dispose();
  };
  return out;
}
