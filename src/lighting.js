import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pointInPoly } from './geometry.js';
import { setOutdoor } from './surroundings.js';

// Light: the sun and sky at the viewer's time of day, and the lights indoors.
//
// The sun follows the clock (or a time the viewer picks) at 40°N, turned by the
// unit's `north`, and sets the sky, the fill light and the exposure. Dollhouse
// lifts a low sun so the model stays readable; Plan keeps one even daylight
// whatever the time, since it is for laying things out.
//
// Indoors, each room's recessed cans (U.lights) switch together, from a plate
// beside the room's door or from the lights panel, and lamps (furniture whose
// group has userData.emitter) switch one by one. Lights are "auto", on while
// it's dark outside, until someone flips them. Per viewer, never saved.
//
// Real lights are few and fixed: a pool of spot lights made once and parked at
// zero when unused, because three recompiles every shader when the number of
// lights changes. The room you're in gets them first, then the nearest rooms;
// they move only when that room changes or a light is switched. Everything
// else that is on is faked: glowing can lenses, a halo on the ceiling around
// each lit can, and a warm pool on the floor, all from one small texture over
// the plan that is baked per room, so no glow comes through a wall.

const DEG = Math.PI / 180;
const LAT = 40 * DEG;            // no location: a mid-latitude city
const WARM = 0xffdcb0;           // indoor bulbs
const CAN_CD = 110;              // one can, in the pool's units (feet, decay 2)
const LAMP_CD = 70;              // one 60 W-equivalent lamp (C1 power 1)
const PLATE_Y = 4;               // switch plates' centers, 48" up
const SWINGS = new Set(['door', 'entry', 'double']);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const col = (hex) => new THREE.Color(hex);

// ---------------------------------------------------------------------------
// The sun

// Minutes after local midnight.
export const clockMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;

// The sun at local clock time `minutes` on `date`'s day, at LAT: elevation and
// azimuth (clockwise from true north), in degrees. The time zone's own meridian
// stands in for the longitude; summer time and the equation of time come off
// the clock.
export function sunAt(date, minutes) {
  const y = date.getFullYear();
  const day = Math.round((new Date(y, date.getMonth(), date.getDate()) - new Date(y, 0, 1)) / 864e5);
  const g = ((2 * Math.PI) / 365) * (day + (minutes / 60 - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const summer = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset()) - date.getTimezoneOffset();
  const H = ((minutes - summer + eqTime) / 4 - 180) * DEG;
  const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(decl) * Math.cos(LAT) - Math.sin(LAT) * Math.cos(H));
  return { el: el / DEG, az: ((az / DEG) + 360) % 360 };
}

// A direction on the plan from a plan bearing (degrees clockwise from the top)
// and an elevation.
function planDir(out, bearing, el) {
  return out.set(Math.sin(bearing * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), -Math.cos(bearing * DEG) * Math.cos(el * DEG));
}

// How each view is lit by day and by night. Plan is always the same daylight.
const LOOK = {
  dollhouse: { sun: 2.3, hemi: 1.35, env: 0.45, moon: 0.6, hemiNight: 0.7, envNight: 0.1, exposureNight: 1.0, floorGlow: 1.25 },
  walk: { sun: 3.2, hemi: 1.25, env: 0.6, moon: 0.1, hemiNight: 0.07, envNight: 0.035, exposureNight: 1.2, floorGlow: 1.0 },
};
const PLAN = { az: 200, el: 72, sun: 1.7, hemi: 1.6, env: 0.4 };

const C = {
  sunDay: col(0xfff0dc), sunLow: col(0xffbe82), moon: col(0xa3b5dc),
  hemiSky: col(0xf5f7fa), hemiGround: col(0xcdbfae), hemiSkyNight: col(0x3a4c7c), hemiGroundNight: col(0x1c1b20), dusk: col(0xffc4a0),
  topDay: col(0x5f97d0), topDusk: col(0x2c3f72), topNight: col(0x070c1d),
  horizonDay: col(0xdde9f1), horizonGold: col(0xf2d4b4), horizonDusk: col(0xe7a07c), horizonNight: col(0x182340),
  groundDay: col(0xb9b8b2), groundNight: col(0x0b0c10),
  bounceDown: col(0xa89580), bounceUp: col(0xf0d2ac),
};

// ---------------------------------------------------------------------------
// Where a room's light switch goes: beside the room's door on the latch side,
// inside the room, 48" up. Swinging doors first, then other doors, then open
// doorways; if nothing fits inside (a closet whose doors fill its wall), the
// same spot just outside it. Returns { x, z, n: [x, z] facing out of the wall } or null.
function switchSpot(U, room) {
  const rank = (o) => (o.type === 'entry' ? 0 : SWINGS.has(o.type) ? 1 : o.kind === 'door' ? 2 : 3);
  const ops = U.openings.filter((o) => o.kind !== 'window' && o.rooms.includes(room.id))
    .sort((p, q) => rank(p) - rank(q) || q.width - p.width);
  for (const inside of [true, false]) {
    for (const o of ops) {
      const target = inside ? room.id : o.rooms.find((id) => id !== room.id);
      if (!target || U.roomById[target]?.outdoor) continue;
      // Room A (rooms[0]) faces the wall at t = 0 from the -n side; room B at t1 from +n.
      const a = o.rooms[0] === target, face = a ? 0 : o.t1, sgn = a ? -1 : 1;
      const ends = o.hinge === 'b' ? ['a', 'b'] : ['b', 'a'];
      for (const end of ends) {
        const s = end === 'b' ? o.b + 0.55 : o.a - 0.55;
        const spot = fitSwitch(U, o, s, face, sgn, target);
        if (spot) return spot;
      }
    }
  }
  return null;
}

function fitSwitch(U, o, s, face, sgn, target) {
  const at = (ds, t) => o.world(s + ds, face + sgn * t);
  // Room in front of it, wall behind it, at the plate's middle and both edges.
  for (const ds of [-0.16, 0, 0.16]) {
    if (U.roomAt(...at(ds, 0.12))?.id !== target) return null;
    const wall = U.wallAt(...at(ds, -0.12));
    if (!wall?.some(([y0, y1]) => y0 < PLATE_Y - 0.3 && y1 > PLATE_Y + 0.3)) return null;
  }
  // Clear of other doors and windows, and of tall built-ins.
  const [px, pz] = at(0, 0);
  for (const q of U.openings) {
    if (q === o) continue;
    const dx = px - q.p[0], dz = pz - q.p[1];
    const qs = dx * q.u[0] + dz * q.u[1], qt = dx * q.n[0] + dz * q.n[1];
    if (qs > q.a - 0.45 && qs < q.b + 0.45 && qt > -0.35 && qt < q.t1 + 0.35) return null;
  }
  const [fx, fz] = at(0, 0.15);
  if (U.fixtures.some((f) => f.h > PLATE_Y - 0.4 && pointInPoly(fx, fz, f.poly))) return null;
  // The wall's real face: walk out from inside the wall until it ends.
  let t = -0.2;
  while (t < 0.3 && U.isWallAt(...at(0, t))) t += 1 / 96;
  const [x, z] = at(0, t);
  return { x, z, n: [o.n[0] * sgn, o.n[1] * sgn] };
}

// Split cans into k groups of neighbors, along the way they spread most.
function clusters(cans, k) {
  if (k >= cans.length) return cans.map((c) => [c]);
  const xs = cans.map((c) => c.x), zs = cans.map((c) => c.z);
  const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs);
  const sorted = [...cans].sort((p, q) => (alongX ? p.x - q.x : p.z - q.z));
  return Array.from({ length: k }, (_, i) => sorted.slice(Math.round((i * sorted.length) / k), Math.round(((i + 1) * sorted.length) / k)));
}

// ---------------------------------------------------------------------------
export function createLighting({ renderer, scene, M, coarse, invalidate }) {
  const group = new THREE.Group();
  group.name = 'lighting';
  // Lights sit in a group nothing ever hides: a hidden light changes the
  // light count, which recompiles every shader. Meshes go in `parts`.
  const lights = new THREE.Group();
  const parts = new THREE.Group();
  group.add(lights, parts);

  const hemi = new THREE.HemisphereLight(0xf5f7fa, 0xcdbfae, 1.3);
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(coarse ? 1536 : 2048, coarse ? 1536 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  lights.add(hemi, sun, sun.target);
  const pool = Array.from({ length: coarse ? 3 : 6 }, () => {
    const s = new THREE.SpotLight(WARM, 0, 0, 1, 0.7, 2);
    lights.add(s, s.target);
    return s;
  });

  // Unit-wide state
  let U = null, mode = 'dollhouse';
  const center = new THREE.Vector3(15, 0, 10);
  let sunDist = 90;
  let rooms = [];            // per U.rooms index: { room, cans, texels, focus helpers }
  let switches = [];         // C3: { room, name, objects, pos }, plus lever state
  let built = [];            // meshes and geometry to dispose on the next unit
  let ring = null, lens = null, plate = null, levers = null, floorGlow = null, ceilGlow = null, glowTex = null, glowBox = null;

  // Viewer state: per room and per lamp, true / false, or absent for auto.
  const roomOn = new Map();
  const lampOn = new Map();
  const lamps = new Map();   // uid -> { group, emitter, bulb and room now, where its group last was, shown }
  let lampList = [];
  let timeNow = true, minutes = clockMinutes(), lastMinute = -1;
  let elevation = 45, night = false;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());

  let dirty = true, focus = -1, moveWait = 0, bounce = 0;
  const focusPt = new THREE.Vector3();
  const v = new THREE.Vector3(), dir = new THREE.Vector3(), m4 = new THREE.Matrix4(), rot = new THREE.Matrix4();
  const sky = { top: new THREE.Color(), horizon: new THREE.Color(), ground: new THREE.Color(), sunDir: new THREE.Vector3(), sunColor: new THREE.Color(), sunAmt: 0, moonDir: new THREE.Vector3(), moonAmt: 0, night: 0 };
  const sunColor = new THREE.Color();

  // ---------------------------------------------------------------- materials
  // Can lenses glow by a per-vertex amount, so one mesh holds every room's.
  const lensMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, emissive: 0xfff3dc, emissiveIntensity: 2.4 });
  lensMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow;');
  };
  lensMat.customProgramCacheKey = () => 'lighting-lens';

  // The fakes: a texture over the plan, red for the floor pools, green for the
  // ceiling halos. The floor brightens what is there (dst × (1 + glow)); the
  // ceiling adds its halo.
  const glowShader = (channel, blending) => new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, box: { value: new THREE.Vector4(0, 0, 1, 1) }, color: { value: new THREE.Color(0xffd6ae) }, gain: { value: 1 } },
    vertexShader: 'varying vec2 vXZ; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vXZ = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform sampler2D map; uniform vec4 box; uniform vec3 color; uniform float gain; varying vec2 vXZ;
      void main(){ float g = texture2D(map, (vXZ - box.xy) / box.zw).${channel} * 4.0; gl_FragColor = vec4(color * min(g * gain, 1.6), 1.0); }`,
    transparent: true, depthWrite: false, ...blending,
  });
  const floorMat = glowShader('r', { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor });
  const ceilMat = glowShader('g', { blending: THREE.AdditiveBlending });
  ceilMat.uniforms.color.value.set(0xffe2bd);
  const hidden = new THREE.MeshBasicMaterial();

  // ---------------------------------------------------------------- state
  const isRoomOn = (id) => roomOn.get(id) ?? night;
  const isLampOn = (uid) => lampOn.get(uid) ?? night;

  // Show every room's and lamp's state: lenses, switch levers, lamp shades.
  function showStates() {
    if (lens) {
      const a = lens.geometry.attributes.glow;
      for (const R of rooms) for (const c of R.cans) a.array.fill(isRoomOn(R.room.id) ? 1 : 0, c.v0, c.v1);
      a.needsUpdate = true;
    }
    for (const s of switches) s.target = isRoomOn(s.room) ? 1 : 0;
    for (const [uid, L] of lamps) {
      const on = isLampOn(uid);
      if (L.shown !== on) { L.shown = on; L.group.userData.setState?.(on); }
    }
    dirty = true;
  }

  function setRoom(id, on) {
    if (on == null) roomOn.delete(id); else roomOn.set(id, !!on);
    showStates();
    emit();
    invalidate();
  }

  function setLamp(uid, on) {
    if (on == null) lampOn.delete(uid); else lampOn.set(uid, !!on);
    showStates();
    emit();
    invalidate();
  }

  // ---------------------------------------------------------------- time and sky
  function applyTime() {
    const { el, az } = sunAt(new Date(), minutes);
    elevation = el;
    const wasNight = night;
    night = el < 0;
    applyLook(az);
    if (night !== wasNight) showStates();
    emit();
  }

  let sunAz = 180;
  function applyLook(az = sunAz) {
    sunAz = az;
    const e = elevation, north = U?.north ?? 0;
    // Outside, every view: the sky through the windows, the lit windows across the street.
    const sunUp = smooth(-1, 6, e), day = smooth(-9, 10, e), gold = 1 - smooth(3, 26, e);
    const dusk = smooth(-11, -3, e) * (1 - smooth(1, 14, e));
    planDir(sky.sunDir, az + north, e);
    planDir(sky.moonDir, az + north + 180, 38);
    sunColor.lerpColors(C.sunDay, C.sunLow, gold);
    sky.top.lerpColors(C.topNight, C.topDusk, smooth(-15, -4, e)).lerp(C.topDay, smooth(-4, 10, e));
    sky.horizon.lerpColors(C.horizonNight, C.horizonDay, smooth(-10, 6, e)).lerp(C.horizonGold, gold * sunUp * 0.45).lerp(C.horizonDusk, dusk * 0.8);
    sky.ground.lerpColors(C.groundNight, C.groundDay, smooth(-10, 4, e));
    sky.sunColor.copy(sunColor);
    sky.sunAmt = smooth(-2, 1, e);
    sky.moonAmt = 1 - smooth(-8, -2, e);
    sky.night = 1 - smooth(-6, 4, e);
    setOutdoor(sky);

    if (mode === 'plan') {
      sun.color.copy(C.sunDay);
      planDir(dir, PLAN.az, PLAN.el);
      sun.intensity = PLAN.sun;
      hemi.color.copy(C.hemiSky); hemi.groundColor.copy(C.hemiGround); hemi.intensity = PLAN.hemi;
      scene.environmentIntensity = PLAN.env;
      renderer.toneMappingExposure = 1;
    } else {
      const L = LOOK[mode];
      const sunI = L.sun * sunUp * (0.6 + 0.4 * smooth(4, 30, e)), moonI = L.moon * (1 - smooth(-10, -3, e));
      if (sunI >= moonI) {
        // Dollhouse lifts a low sun so walls don't throw the rooms into shadow.
        // Its color warms less too: the model is for seeing the rooms.
        planDir(dir, az + north, mode === 'dollhouse' ? 26 + Math.max(0, e) * 0.78 : Math.max(e, 0.5));
        if (mode === 'dollhouse') sun.color.lerpColors(C.sunDay, C.sunLow, gold * 0.3); else sun.color.copy(sunColor);
        sun.intensity = sunI;
      } else {
        dir.copy(sky.moonDir);
        sun.color.copy(C.moon);
        sun.intensity = moonI;
      }
      hemi.color.lerpColors(C.hemiSkyNight, C.hemiSky, day).lerp(C.dusk, dusk * 0.3);
      hemi.groundColor.lerpColors(C.hemiGroundNight, C.hemiGround, day);
      hemi.intensity = THREE.MathUtils.lerp(L.hemiNight, L.hemi, day);
      // In Walk after dark, the lit room you stand in fills with light bounced
      // off its floor and walls: warm from below, onto the ceiling.
      const b = mode === 'walk' ? bounce * (1 - day) : 0;
      if (b > 0) {
        const total = hemi.intensity + b * 0.6;
        hemi.color.lerp(C.bounceDown, (b * 0.6) / total);
        hemi.groundColor.lerp(C.bounceUp, (b * 0.6) / total);
        hemi.intensity = total;
      }
      scene.environmentIntensity = THREE.MathUtils.lerp(L.envNight, L.env, day);
      renderer.toneMappingExposure = THREE.MathUtils.lerp(L.exposureNight, 1, day);
    }
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(dir, sunDist);
    // No point redrawing the shadow of a light that isn't there.
    sun.shadow.autoUpdate = sun.intensity > 0.02;
  }

  function setTime(t) {
    timeNow = !!t?.now;
    minutes = timeNow ? clockMinutes() : clamp(Number(t?.minutes) || 0, 0, 1440);
    lastMinute = Math.floor(Date.now() / 60000);
    applyTime();
    invalidate();
  }

  // ---------------------------------------------------------------- the unit
  function dispose() {
    for (const o of built) {
      parts.remove(o);
      if (o.geometry !== proxyGeo) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    }
    built = [];
    glowTex?.dispose();
    ring = lens = plate = levers = floorGlow = ceilGlow = glowTex = null;
    switches = [];
    rooms = [];
  }
  const proxyGeo = new THREE.BoxGeometry(0.45, 0.62, 0.2);
  const add = (o) => { parts.add(o); built.push(o); return o; };

  function setUnit(next) {
    dispose();
    U = next;
    const b = U.bounds;
    center.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
    const R = Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2 + 4.4;
    Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: Math.max(220, R * 8) });
    sun.shadow.camera.updateProjectionMatrix();
    sunDist = Math.max(90, R * 3.3);
    if (!U.empty) {
      rooms = U.rooms.map((room) => ({ room, cans: [], texels: null }));
      buildCans();
      buildSwitches();
      buildGlow();
    }
    focus = -1;
    applyTime();
    showStates();
    applyMode();
    emit();
  }

  // Each can: a trim ring flush with the ceiling and a lens inside it.
  function buildCans() {
    const index = new Map(U.rooms.map((r, i) => [r, i]));
    const rings = [], lenses = [];
    let vert = 0;
    for (const [x, z] of U.lights) {
      let room = U.roomAt(x, z);
      if (room?.outdoor || (!room && U.isWallAt(x, z))) continue;
      // A can in a doorway belongs to the nearest room.
      if (!room) room = U.rooms.filter((r) => !r.outdoor).sort((p, q) => Math.hypot(p.at[0] - x, p.at[1] - z) - Math.hypot(q.at[0] - x, q.at[1] - z))[0];
      if (!room) continue;
      const h = room.ceiling;
      rings.push(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 32).translate(x, h - 0.01, z));
      const g = new THREE.CircleGeometry(0.23, 24).rotateX(Math.PI / 2).translate(x, h - 0.024, z);
      const n = g.attributes.position.count;
      g.setAttribute('glow', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
      lenses.push(g);
      rooms[index.get(room)].cans.push({ x, y: h - 0.05, z, v0: vert, v1: vert + n, covered: false });
      vert += n;
    }
    if (!lenses.length) return;
    ring = add(new THREE.Mesh(mergeGeometries(rings), M.trim));
    ring.name = 'can-trims';
    lens = add(new THREE.Mesh(mergeGeometries(lenses), lensMat));
    lens.name = 'can-lenses';
    [...rings, ...lenses].forEach((g) => g.dispose());
  }

  // A plate by each room's door, a lever that flips, and an invisible box
  // around it that taps and the crosshair can hit (userData.switchRoom).
  function buildSwitches() {
    const plates = [], spots = [];
    for (const R of rooms) {
      if (!R.cans.length) continue;
      const spot = switchSpot(U, R.room);
      if (!spot) continue;
      const [ix, iz] = spot.n;
      // Basis: x along the wall, y up, z out of it.
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(iz, 0, -ix), new THREE.Vector3(0, 1, 0), new THREE.Vector3(ix, 0, iz));
      const at = new THREE.Matrix4().copy(basis).setPosition(spot.x, PLATE_Y, spot.z);
      plates.push(new THREE.BoxGeometry(0.23, 0.375, 0.02).translate(0, 0, 0.01).applyMatrix4(at));
      const proxy = add(new THREE.Mesh(proxyGeo, hidden));
      proxy.visible = false;
      proxy.applyMatrix4(at);
      proxy.userData.switchRoom = R.room.id;
      spots.push({ R, at, proxy });
    }
    if (!spots.length) return;
    plate = add(new THREE.Mesh(mergeGeometries(plates), M.plate));
    plate.name = 'switch-plates';
    plates.forEach((g) => g.dispose());
    // Levers pivot at the plate's face: up is on.
    const lever = new THREE.BoxGeometry(0.035, 0.035, 0.09).translate(0, 0, 0.045);
    levers = add(new THREE.InstancedMesh(lever, M.plate, spots.length));
    levers.name = 'switch-levers';
    switches = spots.map(({ R, at, proxy }, i) => {
      const s = {
        room: R.room.id, name: R.room.name, objects: [proxy], pos: [at.elements[12], PLATE_Y, at.elements[14]],
        at: at.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.02)), i, angle: isRoomOn(R.room.id) ? 1 : 0, target: 0,
      };
      s.target = s.angle;
      placeLever(s);
      return s;
    });
  }

  function placeLever(s) {
    rot.makeRotationX((0.5 - s.angle) * 1.1);
    m4.multiplyMatrices(s.at, rot);
    levers.setMatrixAt(s.i, m4);
    levers.instanceMatrix.needsUpdate = true;
  }

  // The glow texture over the plan, which room each texel is in, which rooms
  // are open to each other (texels side by side, no wall between), and the
  // floor and ceiling shapes that show it.
  function buildGlow() {
    const b = U.bounds;
    const w = b.x1 - b.x0 + 1, d = b.z1 - b.z0 + 1;
    const res = Math.max(0.25, Math.max(w, d) / 256);
    const nx = Math.ceil(w / res), nz = Math.ceil(d / res);
    glowBox = { x0: b.x0 - 0.5, z0: b.z0 - 0.5, res, nx, nz };
    glowTex = new THREE.DataTexture(new Uint8Array(nx * nz * 4), nx, nz, THREE.RGBAFormat);
    glowTex.magFilter = glowTex.minFilter = THREE.LinearFilter;
    const index = new Map(U.rooms.map((r, i) => [r.id, i]));
    const cell = new Int16Array(nx * nz).fill(-1);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const r = U.roomAt(glowBox.x0 + (i + 0.5) * res, glowBox.z0 + (j + 0.5) * res);
      if (r && !r.outdoor) cell[j * nx + i] = index.get(r.id);
    }
    const lists = rooms.map(() => []);
    rooms.forEach((R) => { R.open = new Set(); });
    for (let t = 0; t < cell.length; t++) {
      const a = cell[t];
      if (a < 0) continue;
      lists[a].push(t);
      for (const n of [(t + 1) % nx ? t + 1 : -1, t + nx < cell.length ? t + nx : -1]) {
        const c = n < 0 ? -1 : cell[n];
        if (c >= 0 && c !== a) { rooms[a].open.add(c); rooms[c].open.add(a); }
      }
    }
    rooms.forEach((R, i) => { R.texels = Int32Array.from(lists[i]); });
    const floors = [], ceils = [];
    for (const r of U.rooms) {
      if (r.outdoor) continue;
      // Just above a rug on the floor, just below the ceiling facing down.
      const up = new THREE.Shape(r.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
      const down = new THREE.Shape(r.poly.map(([x, z]) => new THREE.Vector2(x, z)));
      floors.push(new THREE.ShapeGeometry(up).rotateX(-Math.PI / 2).translate(0, 0.045, 0));
      ceils.push(new THREE.ShapeGeometry(down).rotateX(Math.PI / 2).translate(0, r.ceiling - 0.012, 0));
    }
    for (const mat of [floorMat, ceilMat]) {
      mat.uniforms.map.value = glowTex;
      mat.uniforms.box.value.set(glowBox.x0, glowBox.z0, nx * res, nz * res);
    }
    floorGlow = add(new THREE.Mesh(mergeGeometries(floors), floorMat));
    ceilGlow = add(new THREE.Mesh(mergeGeometries(ceils), ceilMat));
    floorGlow.name = 'light-pools'; ceilGlow.name = 'light-halos';
    floorGlow.frustumCulled = ceilGlow.frustumCulled = false;
    floorGlow.renderOrder = ceilGlow.renderOrder = 2;
    [...floors, ...ceils].forEach((g) => g.dispose());
  }

  // ---------------------------------------------------------------- lamps (C1)
  function addLamp(uid, g) {
    let emitter = g.userData.emitter;
    if (!emitter) {
      // No emitter yet (an older floor lamp): a bulb 85% of the way up its middle.
      g.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(g);
      emitter = { pos: [0, (box.max.y - g.position.y) * 0.85, 0], color: WARM, power: 1, shape: 'shade' };
    }
    lamps.set(uid, { group: g, emitter, px: NaN, py: 0, pz: 0, ry: 0, shown: null, x: 0, y: 0, z: 0, room: -1, covered: false });
    lampList = [...lamps.values()];
    showStates();
    invalidate();
  }
  function removeLamp(uid) {
    if (!lamps.delete(uid)) return;
    lampList = [...lamps.values()];
    dirty = true;
    invalidate();
  }

  // Where a lamp's bulb is now, and which room it's in.
  function placeLamp(L) {
    const g = L.group;
    g.updateWorldMatrix(true, false);
    v.fromArray(L.emitter.pos).applyMatrix4(g.matrixWorld);
    L.x = v.x; L.y = v.y; L.z = v.z;
    L.px = g.position.x; L.py = g.position.y; L.pz = g.position.z; L.ry = g.rotation.y;
    const r = U?.roomAt(L.x, L.z);
    L.room = r ? U.rooms.indexOf(r) : -1;
  }

  // ---------------------------------------------------------------- the pool
  // Which lit sources get the real lights: the room in focus first (in Walk,
  // its cans one by one or in a few groups; its lamps each), then the other
  // rooms nearest it, a light per room for their cans and one per lamp. In
  // Dollhouse every room's cans share one light. The rest are faked.
  function assign() {
    for (const L of lamps.values()) placeLamp(L);
    const lit = rooms.map((R, i) => ({
      i, cans: isRoomOn(R.room.id) ? R.cans : [],
      lamps: [...lamps.entries()].filter(([uid, L]) => L.room === i && isLampOn(uid)).map(([, L]) => L),
    })).filter((r) => r.cans.length || r.lamps.length);
    for (const R of rooms) for (const c of R.cans) c.covered = false;
    for (const L of lamps.values()) L.covered = false;
    const dist = (r) => {
      if (r.i === focus) return -1;
      const [x0, z0, x1, z1] = rooms[r.i].room.bbox;
      return Math.hypot(Math.max(x0 - focusPt.x, 0, focusPt.x - x1), Math.max(z0 - focusPt.z, 0, focusPt.z - z1));
    };
    lit.sort((p, q) => dist(p) - dist(q));
    const N = mode === 'plan' ? 0 : pool.length, units = [];
    const take = (u) => { if (units.length < N) { units.push(u); u.members.forEach((m) => { m.covered = true; }); } };
    const near = (L) => Math.hypot(L.x - focusPt.x, L.z - focusPt.z);
    for (const r of lit) {
      if (units.length >= N) break;
      const lampsHere = [...r.lamps].sort((p, q) => near(p) - near(q));
      if (r.i === focus && mode === 'walk') {
        const forLamps = Math.min(lampsHere.length, Math.max(0, N - units.length - (r.cans.length ? 1 : 0)));
        lampsHere.slice(0, forLamps).forEach((L) => take(lampLight(L)));
        if (r.cans.length) {
          const k = clamp(N - units.length - (N >= 6 ? 2 : 0), 1, r.cans.length);
          clusters(r.cans, k).forEach((c) => take(canLight(c)));
        }
        lampsHere.slice(forLamps).forEach((L) => take(lampLight(L)));
      } else {
        if (r.cans.length) take(canLight(r.cans));
        lampsHere.forEach((L) => take(lampLight(L)));
      }
    }
    pool.forEach((s, k) => {
      const u = units[k];
      if (!u) { s.intensity = 0; return; }
      s.position.set(u.x, u.y, u.z);
      s.target.position.set(u.x, u.y + u.dir * 4, u.z);
      s.target.updateMatrixWorld();
      s.color.set(u.color);
      s.intensity = u.cd;
      s.angle = u.angle;
      s.penumbra = u.penumbra;
      s.distance = u.dist;
    });
    // How brightly the room in focus is lit, for its bounced light.
    const here = lit.find((r) => r.i === focus);
    const power = here ? here.cans.length + here.lamps.reduce((sum, L) => sum + (L.emitter.power ?? 1), 0) : 0;
    const next = here ? clamp(Math.sqrt((power * 20) / Math.max(20, rooms[focus].room.area)), 0, 1) : 0;
    if (next !== bounce) { bounce = next; applyLook(); }
    bake();
  }

  // One can, or several sharing a light: raised by half their spread so the
  // pool spreads as theirs would, rather than one hot spot in the middle.
  function canLight(cans) {
    let x = 0, z = 0, y = Infinity;
    for (const c of cans) { x += c.x / cans.length; z += c.z / cans.length; y = Math.min(y, c.y); }
    const spread = Math.max(0, ...cans.map((c) => Math.hypot(c.x - x, c.z - z)));
    const lift = spread * 0.5, k = (y + lift) / y;
    return {
      x, y: y + lift, z, dir: -1, color: WARM, cd: CAN_CD * (1 + 0.6 * (cans.length - 1)) * k * k, members: cans,
      angle: Math.min(80, 52 + Math.atan(spread / Math.max(1, y)) / DEG) * DEG, penumbra: 0.8, dist: (y + lift) * 1.7 + spread,
    };
  }
  function lampLight(L) {
    const e = L.emitter, shape = e.shape ?? 'shade';
    const up = shape === 'up';
    return {
      x: L.x, y: L.y, z: L.z, dir: up ? 1 : -1, color: e.color ?? WARM, cd: LAMP_CD * (e.power ?? 1), members: [L],
      angle: (shape === 'down' ? 62 : shape === 'up' ? 72 : 88) * DEG, penumbra: shape === 'down' ? 0.6 : 0.9, dist: 18,
    };
  }

  // The fakes, per room: a pool on the floor under every lit source without a
  // real light, a halo on the ceiling around every lit can (and above lamps
  // whose light goes up). Light reaches the room it's in and the rooms open
  // to it, never through a wall.
  function bake() {
    if (!glowTex) return;
    const data = glowTex.image.data, { x0, z0, res, nx } = glowBox;
    data.fill(0);
    let any = false, anyCeil = false;
    const srcs = rooms.map((R, i) => {
      const src = [];
      if (isRoomOn(R.room.id)) for (const c of R.cans) src.push({ x: c.x, z: c.z, h: c.y, floor: c.covered ? 0 : 1, cone: true, halo: 1, haloR: 0.75, wide: 0.3 });
      for (const [uid, L] of lamps) {
        if (L.room !== i || !isLampOn(uid)) continue;
        const shape = L.emitter.shape ?? 'shade', p = L.emitter.power ?? 1, hc = Math.max(0.5, R.room.ceiling - L.y);
        src.push({
          x: L.x, z: L.z, h: Math.max(0.5, L.y), floor: L.covered ? 0 : p * (shape === 'up' ? 0.3 : 0.75), cone: false,
          halo: p * (shape === 'up' ? 0.9 : shape === 'shade' ? 0.45 : 0.1), haloR: hc * 0.8, wide: 0,
        });
      }
      return src;
    });
    const cos70 = Math.cos(72 * DEG), cos40 = Math.cos(38 * DEG);
    rooms.forEach((R, i) => {
      const src = [...srcs[i]];
      for (const j of R.open ?? []) src.push(...srcs[j]);
      if (!src.length) return;
      for (const t of R.texels) {
        const x = x0 + ((t % nx) + 0.5) * res, z = z0 + (Math.floor(t / nx) + 0.5) * res;
        let f = 0, c = 0;
        for (const s of src) {
          const r2 = (x - s.x) ** 2 + (z - s.z) ** 2;
          if (s.floor) {
            const d2 = s.h * s.h + r2, k = (s.h * s.h * s.h) / (d2 * Math.sqrt(d2));
            f += s.floor * k * (s.cone ? smooth(cos70, cos40, s.h / Math.sqrt(d2)) : 1);
          }
          if (s.halo) c += s.halo * Math.exp(-r2 / (s.haloR * s.haloR)) + s.wide * Math.exp(-r2 / 5);
        }
        if (f > 0.004) { data[t * 4] = Math.min(255, f * 63.75); any = true; }
        if (c > 0.004) { data[t * 4 + 1] = Math.min(255, c * 63.75); anyCeil = true; }
      }
    });
    glowTex.needsUpdate = true;
    floorGlow.userData.any = any;
    ceilGlow.userData.any = anyCeil;
    applyMode();
  }

  // ---------------------------------------------------------------- views
  // Cans and halos only under a ceiling (Walk); switches wherever walls show.
  function applyMode() {
    const inside = mode === 'walk';
    if (lens) lens.visible = ring.visible = inside;
    if (levers) levers.visible = plate.visible = mode !== 'plan';
    if (floorGlow) {
      floorGlow.visible = mode !== 'plan' && !!floorGlow.userData.any;
      floorMat.uniforms.gain.value = LOOK[mode]?.floorGlow ?? 0;
    }
    if (ceilGlow) ceilGlow.visible = inside && !!ceilGlow.userData.any;
  }

  function setMode(m) {
    mode = LOOK[m] || m === 'plan' ? m : 'dollhouse';
    focus = -1;
    applyLook();
    applyMode();
    dirty = true;
    emit();
    invalidate();
  }

  // The room in focus: where you stand in Walk, the room in the middle of the
  // view in Dollhouse (or the nearest one).
  function focusRoom(camera) {
    if (mode === 'walk') {
      focusPt.set(camera.position.x, 0, camera.position.z);
    } else {
      camera.getWorldDirection(dir);
      if (dir.y > -0.05) return focus;
      focusPt.copy(camera.position).addScaledVector(dir, -camera.position.y / dir.y);
    }
    const r = U.roomAt(focusPt.x, focusPt.z);
    if (r) return U.rooms.indexOf(r);
    if (mode === 'walk') return focus;
    let best = -1, bd = Infinity;
    U.rooms.forEach((q, i) => {
      if (q.outdoor) return;
      const dd = Math.hypot(q.at[0] - focusPt.x, q.at[1] - focusPt.z);
      if (dd < bd) { bd = dd; best = i; }
    });
    return best;
  }

  // Once a frame, before rendering. True when something changed on screen.
  function update(camera, dt) {
    let changed = false;
    if (timeNow) {
      const m = Math.floor(Date.now() / 60000);
      if (m !== lastMinute) { lastMinute = m; minutes = clockMinutes(); applyTime(); changed = true; }
    }
    if (!U || U.empty) return changed;
    if (mode !== 'plan') {
      const f = focusRoom(camera);
      if (f !== focus) { focus = f; dirty = true; }
      // A lamp that is on and moving: follow it, a few times a second.
      moveWait -= dt;
      if (moveWait <= 0) {
        for (let i = 0; i < lampList.length; i++) {
          const L = lampList[i], g = L.group;
          if (L.shown && (g.position.x !== L.px || g.position.y !== L.py || g.position.z !== L.pz || g.rotation.y !== L.ry)) { dirty = true; moveWait = 0.12; break; }
        }
      }
    }
    if (dirty) { dirty = false; assign(); changed = true; }
    for (let i = 0; i < switches.length; i++) {
      const s = switches[i];
      if (s.angle === s.target) continue;
      s.angle = s.target > s.angle ? Math.min(s.target, s.angle + dt * 9) : Math.max(s.target, s.angle - dt * 9);
      placeLever(s);
      changed = true;
    }
    return changed;
  }

  return {
    group,
    get switches() { return switches; },
    // Rooms with ceiling lights, in the unit's order, for the lights panel.
    get rooms() { return rooms.filter((R) => R.cans.length).map((R) => ({ id: R.room.id, name: R.room.name, on: isRoomOn(R.room.id), auto: !roomOn.has(R.room.id) })); },
    get night() { return night; },
    get time() { return { now: timeNow, minutes, elevation }; },
    get mode() { return mode; },
    setUnit,
    isRoomOn,
    setRoom,
    toggleRoom: (id) => setRoom(id, !isRoomOn(id)),
    // Every room at once: true, false, or null for auto.
    setAll(on) {
      for (const R of rooms) if (R.cans.length) { if (on == null) roomOn.delete(R.room.id); else roomOn.set(R.room.id, !!on); }
      showStates();
      emit();
      invalidate();
    },
    addLamp, removeLamp, setLamp, isLampOn,
    setTime, setMode, update,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
