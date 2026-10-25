import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createMaterials } from './materials.js';
import { buildArchitecture, openings } from './architecture.js';
import { buildKitchen, KITCHEN_BLOCKS } from './kitchen.js';
import { buildBaths, BATH_BLOCKS } from './baths.js';
import { buildFurniture, FURNITURE_BLOCKS } from './furniture.js';
import { buildSurroundings } from './surroundings.js';
import { WalkControls } from './walk.js';
import { ROOMS, ZONES, PHOTOS, PLAN_IMAGE, HEIGHT, UNIT, WALLS, ROOM_VIEWS, X, Z } from './plan.js';
import { polygonArea, pointInPoly } from './kit.js';

const DEG = Math.PI / 180;
const $ = (s) => document.querySelector(s);
const stage = $('#stage'), canvas = $('#scene'), panel = $('#panel');
const coarse = matchMedia('(pointer: coarse)').matches;
const narrow = () => matchMedia('(max-width: 899px)').matches;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let needsRender = true;
function invalidate() { needsRender = true; }

function fail(message) {
  $('#loading').innerHTML = `<div class="error">${message}</div>`;
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  fail('This page needs WebGL, and it is turned off or unavailable in this browser. Try a current version of Safari, Chrome, Firefox, or Edge.');
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.75 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ---------------------------------------------------------------------------
// Scene
const scene = new THREE.Scene();
const bgColor = new THREE.Color();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const M = createMaterials(renderer);
const arch = buildArchitecture(M);
const kitchen = buildKitchen(M);
const baths = buildBaths(M);
const furniture = buildFurniture(M);
const city = buildSurroundings();
const doors = arch.doors;
doors.forEach((d) => { d.openTo = d.angle > 10 ? d.angle : d.id === 'wic' ? 80 : 90; });

const unit = new THREE.Group();
arch.ceilings.add(kitchen.soffit);
unit.add(arch.walls, arch.cutCaps, arch.tops, arch.floors, arch.ceilings, arch.trim, kitchen.solid, baths.solid, furniture, arch.glass, baths.glass);
doors.forEach((d) => unit.add(d.pivot));
scene.add(unit, city);

const fp = UNIT.footprint;
const CENTER = new THREE.Vector3((fp.x0 + fp.x1) / 2, 0, (fp.z0 + fp.z1) / 2);

// Lights
const hemi = new THREE.HemisphereLight(0xf5f7fa, 0xcdbfae, 1.3);
const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(coarse ? 1536 : 2048, coarse ? 1536 : 2048);
Object.assign(sun.shadow.camera, { left: -27, right: 27, top: 27, bottom: -27, near: 1, far: 220 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
sun.target.position.copy(CENTER);
scene.add(hemi, sun, sun.target);
const LIGHTING = {
  dollhouse: { az: 155, el: 58, sun: 2.3, hemi: 1.35, env: 0.45 },
  plan: { az: 200, el: 72, sun: 1.7, hemi: 1.6, env: 0.4 },
  walk: { az: 105, el: 24, sun: 3.2, hemi: 1.25, env: 0.6 },
};
function setLighting(m) {
  const L = LIGHTING[m], r = 90;
  sun.position.set(CENTER.x + Math.sin(L.az * DEG) * Math.cos(L.el * DEG) * r, Math.sin(L.el * DEG) * r, CENTER.z - Math.cos(L.az * DEG) * Math.cos(L.el * DEG) * r);
  sun.intensity = L.sun; hemi.intensity = L.hemi; scene.environmentIntensity = L.env;
}

// Leasing plan overlay (plan view).
const planTex = new THREE.TextureLoader().load(PLAN_IMAGE.src, () => invalidate());
planTex.colorSpace = THREE.SRGBColorSpace;
planTex.anisotropy = 4;
const planOverlay = new THREE.Mesh(
  new THREE.PlaneGeometry(PLAN_IMAGE.w / PLAN_IMAGE.pxPerFt, PLAN_IMAGE.h / PLAN_IMAGE.pxPerFt).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ map: planTex, transparent: true, opacity: 0.6, depthTest: false, toneMapped: false }),
);
planOverlay.position.set(X(PLAN_IMAGE.w / 2), HEIGHT.ceiling + 0.2, Z(PLAN_IMAGE.h / 2));
planOverlay.renderOrder = 10;
planOverlay.visible = false;
scene.add(planOverlay);

// ---------------------------------------------------------------------------
// Cameras and controls
const dollCam = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);
const walkCam = new THREE.PerspectiveCamera(70, 1, 0.08, 9500);
const planCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
planCam.up.set(0, 0, -1);
planCam.position.set(CENTER.x, 120, CENTER.z);
planCam.lookAt(CENTER);

const doll = new OrbitControls(dollCam, canvas);
Object.assign(doll, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: 80 * DEG, minDistance: 8, maxDistance: 160, screenSpacePanning: true });
doll.target.copy(CENTER);

const plan = new OrbitControls(planCam, canvas);
Object.assign(plan, { enableRotate: false, enableDamping: true, dampingFactor: 0.1, screenSpacePanning: true, minZoom: 0.6, maxZoom: 9, zoomToCursor: true });
plan.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
plan.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
plan.target.copy(CENTER);

for (const c of [doll, plan]) c.addEventListener('change', () => invalidate());

// ---------------------------------------------------------------------------
// Walking: collisions against walls (minus doorways), built-ins, furniture and shut doors.
const doorways = openings.filter((o) => o.type !== 'window');
const wallPieces = [];
for (const w of WALLS) {
  let parts = [w.axis === 'x' ? [w.x0, w.x1] : [w.z0, w.z1]];
  for (const o of doorways) {
    if (o.wall !== w.id) continue;
    parts = parts.flatMap(([p, q]) => (o.b <= p || o.a >= q ? [[p, q]] : [...(o.a > p ? [[p, o.a]] : []), ...(o.b < q ? [[o.b, q]] : [])]));
  }
  for (const [p, q] of parts) wallPieces.push(w.axis === 'x' ? [p, w.z0, q, w.z1] : [w.x0, p, w.x1, q]);
}
const STATIC_BLOCKS = [...wallPieces, ...KITCHEN_BLOCKS, ...BATH_BLOCKS];
const thresholds = doorways.map((o) => (o.w.axis === 'x' ? [o.a, o.w.z0, o.b, o.w.z1] : [o.w.x0, o.a, o.w.x1, o.b]));
const inRect = (x, z, [x0, z0, x1, z1], r = 0) => x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r;
const insideUnit = (x, z) => ROOMS.some((r) => pointInPoly(x, z, r.poly)) || thresholds.some((t) => inRect(x, z, t));
function isBlocked(x, z, r) {
  if (!insideUnit(x, z)) return true;
  if (STATIC_BLOCKS.some((b) => inRect(x, z, b, r))) return true;
  if (furniture.visible && FURNITURE_BLOCKS.some((b) => inRect(x, z, b, r * 0.6))) return true;
  return doors.some((d) => d.angle < 20 && inRect(x, z, d.closedRect, r));
}

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function aim(clientX, clientY, cam) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
}
const pickables = () => [arch.walls, arch.floors, arch.trim, kitchen.solid, baths.solid, furniture.visible ? furniture : null, ...doors.map((d) => d.pivot)].filter(Boolean);

function pickWalk(cx, cy) {
  aim(cx, cy, walkCam);
  const h = ray.intersectObjects(pickables(), true)[0];
  if (!h) return null;
  if (h.object.userData.doorId) return { type: 'door', id: h.object.userData.doorId };
  const p = h.point.clone();
  if (h.face && Math.abs(h.face.normal.y) < 0.5) {
    const back = new THREE.Vector3(walk.x - p.x, 0, walk.z - p.z);
    if (back.length() > 1e-3) p.add(back.normalize().multiplyScalar(1.0));
  }
  return { type: 'floor', point: p };
}

const walk = new WalkControls(walkCam, canvas, {
  isBlocked,
  pick: pickWalk,
  onTapDoor: (id) => toggleDoor(id),
  onUserMove: () => { if (photo) exitPhoto({ keepView: true }); dismissHint(); invalidate(); },
});
walk.attachJoystick($('#joystick'), $('#joystick .knob'));
const ENTRY_POSE = { x: X(285), y: HEIGHT.eye, z: Z(450), yaw: 90, pitch: -4 };
walk.setPose(ENTRY_POSE);

// ---------------------------------------------------------------------------
// Doors
function toggleDoor(id) {
  const d = doors.find((x) => x.id === id);
  if (!d) return;
  d.target = d.target > 10 ? 0 : d.openTo;
  invalidate();
}
function animateDoors(dt) {
  let moving = false;
  for (const d of doors) {
    const diff = d.target - d.angle;
    if (Math.abs(diff) < 0.05) continue;
    d.angle += Math.sign(diff) * Math.min(Math.abs(diff), Math.max(30, Math.abs(diff) * 5) * dt);
    d.apply();
    moving = true;
  }
  return moving;
}
$('#openDoors').addEventListener('click', () => { doors.forEach((d) => { d.target = d.openTo; }); invalidate(); });
$('#closeDoors').addEventListener('click', () => { doors.forEach((d) => { d.target = 0; }); invalidate(); });

// ---------------------------------------------------------------------------
// Theme
const token = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let colors = {};
const accentMat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, toneMapped: false });
const highlightFill = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
function readTheme() {
  colors = { bg: token('--bg'), ink: token('--ink'), ink2: token('--ink-2'), surface: token('--surface'), surface2: token('--surface-2'), rule: token('--rule'), oak: token('--oak') };
  bgColor.set(colors.bg);
  accentMat.color.set(colors.oak);
  highlightFill.color.set(colors.oak);
  invalidate();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
readTheme();

// ---------------------------------------------------------------------------
// Rooms: list, labels, focus
const fmt = (ft) => { const t = Math.round(ft * 12); return `${Math.floor(t / 12)}'${t % 12}"`; };
const ROOM_ORDER = ['living', 'primary', 'bed2', 'bath1', 'bath2', 'hall', 'wic', 'laundry', 'closet2', 'coat'];
const MINOR = new Set(['wic', 'laundry', 'closet2', 'coat']);
const roomInfo = Object.fromEntries(ROOMS.map((r) => {
  const xs = r.poly.map((p) => p[0]), zs = r.poly.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...zs) - Math.min(...zs);
  const area = Math.abs(polygonArea(r.poly));
  const dims = r.dims ?? (r.poly.length === 4 ? `${fmt(Math.min(w, d))} × ${fmt(Math.max(w, d))}` : `${Math.round(area)} sq ft`);
  return [r.id, { room: r, w, d, area, dims, fromPlan: !!r.dims, center: [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...zs) + Math.min(...zs)) / 2] }];
}));

const roomList = $('#roomList');
for (const id of ROOM_ORDER) {
  const info = roomInfo[id];
  const li = document.createElement('li');
  li.innerHTML = `<button class="room-btn" data-room="${id}">
    <span class="room-name">${info.room.name}</span><span class="room-area">${Math.round(info.area)} sq ft</span>
    <span class="room-dims">${info.dims}</span>${info.fromPlan ? '<span class="src">Plan</span>' : ''}</button>`;
  roomList.append(li);
}
roomList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-room]');
  if (b) focusRoom(b.dataset.room);
});

const labelLayer = $('#labels');
const labels = [];
for (const id of ROOM_ORDER) {
  const info = roomInfo[id];
  const el = document.createElement('div');
  el.className = `room-label${MINOR.has(id) ? ' minor' : ''}`;
  el.innerHTML = MINOR.has(id) ? `<b>${info.room.name}</b>` : `<b>${info.room.name}</b><span>${info.dims}</span>`;
  labelLayer.append(el);
  labels.push({ el, x: info.room.at[0], z: info.room.at[1], minor: MINOR.has(id) });
}
for (const zn of ZONES) {
  const el = document.createElement('div');
  el.className = 'room-label zone';
  el.innerHTML = `<b>${zn.name}</b>`;
  labelLayer.append(el);
  labels.push({ el, x: zn.at[0], z: zn.at[1], minor: false, zone: true });
}
let showLabels = true;
const v3 = new THREE.Vector3();
function project(x, y, z, cam) {
  v3.set(x, y, z).project(cam);
  return { x: ((v3.x + 1) / 2) * stage.clientWidth, y: ((1 - v3.y) / 2) * stage.clientHeight, behind: v3.z > 1 };
}
function updateLabels() {
  const visible = showLabels && mode !== 'walk';
  labelLayer.hidden = !visible && !measures.length && !measurePreview;
  const cam = activeCam();
  const ppf = mode === 'plan'
    ? stage.clientHeight / ((planCam.top - planCam.bottom) / planCam.zoom)
    : stage.clientHeight / 2 / Math.tan((dollCam.fov / 2) * DEG) / dollCam.position.distanceTo(doll.target);
  labelLayer.classList.toggle('compact', ppf < 12);
  for (const l of labels) {
    const show = visible && !(l.minor && (mode === 'dollhouse' || ppf < 22)) && !(l.zone && ppf < 12);
    l.el.hidden = !show;
    if (!show) continue;
    // Dollhouse labels float at wall-top height so walls never hide them.
    const p = project(l.x, mode === 'dollhouse' ? HEIGHT.ceiling + 0.4 : 0.2, l.z, cam);
    l.el.hidden = p.behind;
    l.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
  }
  for (const m of measures) placeMeasureLabel(m, cam);
  if (measurePreview) placeMeasureLabel(measurePreview, cam);
}

// Room highlight
let highlight = null;
function highlightRoom(r) {
  if (highlight) scene.remove(highlight.mesh);
  const shape = new THREE.Shape(r.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, 0.05, 0), highlightFill);
  mesh.renderOrder = 5;
  scene.add(mesh);
  highlight = { mesh, t: 0 };
}
function stepHighlight(dt) {
  if (!highlight) return false;
  highlight.t += dt;
  const t = highlight.t;
  highlightFill.opacity = t < 0.3 ? (t / 0.3) * 0.35 : Math.max(0, 0.35 * (1 - (t - 1.6) / 1.0));
  if (t > 2.6) { scene.remove(highlight.mesh); highlight.mesh.geometry.dispose(); highlight = null; }
  return true;
}

// Smooth orbit / plan moves
let orbitTween = null;
function tweenOrbit(controls, cam, toTarget, toPos, toZoom, duration = 0.9) {
  orbitTween = { controls, cam, fromT: controls.target.clone(), toT: toTarget.clone(), fromP: cam.position.clone(), toP: toPos.clone(), fromZ: cam.zoom, toZ: toZoom ?? cam.zoom, t: 0, duration };
}
function stepOrbitTween(dt) {
  if (!orbitTween) return false;
  const o = orbitTween;
  o.t = Math.min(1, o.t + dt / o.duration);
  const e = o.t < 0.5 ? 4 * o.t ** 3 : 1 - (-2 * o.t + 2) ** 3 / 2;
  o.controls.target.lerpVectors(o.fromT, o.toT, e);
  o.cam.position.lerpVectors(o.fromP, o.toP, e);
  o.cam.zoom = o.fromZ + (o.toZ - o.fromZ) * e;
  o.cam.updateProjectionMatrix();
  o.controls.update();
  if (o.t >= 1) orbitTween = null;
  return true;
}

function focusRoom(id) {
  const info = roomInfo[id];
  roomList.querySelectorAll('[data-room]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.room === id)));
  const [cx, cz] = info.center;
  const target = new THREE.Vector3(cx, 0, cz);
  if (mode === 'walk') {
    const v = ROOM_VIEWS[id];
    exitPhoto({ keepView: true });
    walk.setPose({ x: X(v.at[0]), y: HEIGHT.eye, z: Z(v.at[1]), yaw: v.yaw, pitch: -4 }, { animate: true, duration: 1.1 });
  } else if (mode === 'plan') {
    const viewH = planCam.top - planCam.bottom;
    const zoom = clamp(viewH / (Math.max(info.w, info.d) * 2.4), 1, 5);
    tweenOrbit(plan, planCam, target, new THREE.Vector3(cx, planCam.position.y, cz), zoom);
    highlightRoom(info.room);
  } else {
    const dir = dollCam.position.clone().sub(doll.target).normalize();
    const dist = clamp(Math.max(info.w, info.d) * 2.2 + 10, 16, 70);
    tweenOrbit(doll, dollCam, target, target.clone().add(dir.multiplyScalar(dist)));
    highlightRoom(info.room);
  }
  if (narrow()) setSheet(false);
}

// ---------------------------------------------------------------------------
// Photo matching
let photo = null;
let furnitureBeforePhoto = null;
const overlay = $('#photoOverlay');
const fade = $('#photoFade');
const photoList = $('#photoList');
for (const p of PHOTOS) {
  const b = document.createElement('button');
  b.className = 'photo-btn';
  b.dataset.photo = p.id;
  b.innerHTML = `<img src="${p.thumb}" alt="" loading="lazy" style="aspect-ratio:${p.aspect}"><b>${p.title}</b><small>${p.caption}</small>`;
  photoList.append(b);
}
photoList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-photo]');
  if (b) showPhoto(b.dataset.photo);
});
fade.addEventListener('input', () => { overlay.style.opacity = String(fade.value / 100); });
$('#photoDone').addEventListener('click', () => exitPhoto({ keepView: false }));

function fitPhoto() {
  if (!photo) return;
  const w = stage.clientWidth, h = stage.clientHeight, pa = photo.aspect;
  const [ow, oh] = w / h > pa ? [h * pa, h] : [w, w / pa];
  walkCam.fov = (2 * Math.atan(Math.tan((photo.vfov / 2) * DEG) * (h / oh))) / DEG;
  walkCam.updateProjectionMatrix();
  Object.assign(overlay.style, { width: `${ow}px`, height: `${oh}px`, left: `${(w - ow) / 2}px`, top: `${(h - oh) / 2}px` });
}

function showPhoto(id, { opacity = 50, instant = false } = {}) {
  const p = PHOTOS.find((x) => x.id === id);
  if (!p) return;
  if (mode !== 'walk') setMode('walk', { keepHash: true });
  photo = p;
  if (furnitureBeforePhoto === null) furnitureBeforePhoto = furniture.visible;
  furniture.visible = false;
  overlay.src = p.src;
  overlay.hidden = false;
  fade.value = opacity;
  overlay.style.opacity = String(opacity / 100);
  $('#photoTitle').textContent = p.title;
  $('#photoCaption').textContent = p.caption;
  $('#photoBar').hidden = false;
  stage.classList.add('photo-active');
  photoList.querySelectorAll('[data-photo]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.photo === id)));
  walk.setPose({ ...p.cam }, { animate: !instant, duration: 1.1 });
  fitPhoto();
  if (narrow()) panel.classList.add('hidden-sheet');
  setSheet(false);
  history.replaceState(null, '', `#photo-${id}`);
  invalidate();
}

function exitPhoto({ keepView } = {}) {
  if (!photo) return;
  photo = null;
  overlay.hidden = true;
  $('#photoBar').hidden = true;
  stage.classList.remove('photo-active');
  panel.classList.remove('hidden-sheet');
  photoList.querySelectorAll('[data-photo]').forEach((b) => b.setAttribute('aria-current', 'false'));
  if (furnitureBeforePhoto !== null) furniture.visible = furnitureBeforePhoto && $('#optFurniture').checked;
  furnitureBeforePhoto = null;
  if (!keepView) fitWalkFov();
  else fitWalkFov();
  history.replaceState(null, '', `#${mode}`);
  invalidate();
}

// ---------------------------------------------------------------------------
// Measuring
let measuring = false;
let measureStart = null;
let measurePreview = null;
const measures = [];
const measureBtn = $('#measureBtn');
measureBtn.addEventListener('click', () => setMeasuring(!measuring));
$('#clearMeasure').addEventListener('click', () => {
  measures.splice(0).forEach(disposeMeasure);
  clearPreview();
  measureStart = null;
  invalidate();
});
function setMeasuring(on) {
  measuring = on;
  measureBtn.setAttribute('aria-pressed', String(on));
  measureBtn.textContent = on ? 'Measuring: tap two points' : 'Measure a distance';
  stage.classList.toggle('measuring', on);
  if (on && mode === 'walk') setMode('plan');
  if (!on) { clearPreview(); measureStart = null; }
  if (on && narrow()) setSheet(false);
  invalidate();
}

// Snap to wall faces within 4" and square up nearly-straight measurements.
function snapPoint(p, from) {
  const s = 0.35;
  for (const w of WALLS) {
    if (p.z > w.z0 - 0.1 && p.z < w.z1 + 0.1) { if (Math.abs(p.x - w.x0) < s) p.x = w.x0; else if (Math.abs(p.x - w.x1) < s) p.x = w.x1; }
    if (p.x > w.x0 - 0.1 && p.x < w.x1 + 0.1) { if (Math.abs(p.z - w.z0) < s) p.z = w.z0; else if (Math.abs(p.z - w.z1) < s) p.z = w.z1; }
  }
  if (from) {
    if (Math.abs(p.x - from.x) < 0.4) p.x = from.x;
    if (Math.abs(p.z - from.z) < 0.4) p.z = from.z;
  }
  return p;
}
function floorPoint(cx, cy, from) {
  aim(cx, cy, activeCam());
  const h = ray.intersectObject(arch.floors, true)[0];
  if (!h) return null;
  return snapPoint(new THREE.Vector3(h.point.x, 0.07, h.point.z), from);
}
function makeMeasure(a, b) {
  const group = new THREE.Group();
  const len = a.distanceTo(b);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(Math.max(len, 0.01), 0.02, 0.08), accentMat);
  bar.position.copy(a).add(b).multiplyScalar(0.5);
  bar.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
  group.add(bar);
  for (const p of [a, b]) {
    const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 20), accentMat);
    dot.position.copy(p);
    group.add(dot);
  }
  group.traverse((o) => { o.renderOrder = 30; });
  scene.add(group);
  const el = document.createElement('div');
  el.className = 'measure-label';
  el.textContent = fmt(len).replace(`'`, `' `);
  labelLayer.append(el);
  return { group, el, a: a.clone(), b: b.clone(), len };
}
function disposeMeasure(m) {
  scene.remove(m.group);
  m.group.traverse((o) => o.geometry?.dispose());
  m.el.remove();
}
function clearPreview() { if (measurePreview) { disposeMeasure(measurePreview); measurePreview = null; } }
function placeMeasureLabel(m, cam) {
  const p = project((m.a.x + m.b.x) / 2, 0.1, (m.a.z + m.b.z) / 2, cam);
  m.el.hidden = p.behind || mode === 'walk' || m.len < 0.05;
  m.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -150%)`;
}
function addMeasurePoint(p) {
  if (!measureStart) {
    measureStart = p;
    clearPreview();
    measurePreview = makeMeasure(p, p.clone().add(new THREE.Vector3(0.001, 0, 0)));
  } else {
    clearPreview();
    if (p.distanceTo(measureStart) > 0.05) measures.push(makeMeasure(measureStart, p));
    measureStart = null;
  }
  invalidate();
}

// Taps in Dollhouse / Plan: measure, swing doors, double-tap to walk in.
let down = null;
let lastTap = { t: 0, x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => {
  if (mode === 'walk' || down) return;
  down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  dismissHint();
});
canvas.addEventListener('pointermove', (e) => {
  if (mode === 'walk' || !measuring || !measureStart || e.pointerType !== 'mouse') return;
  const p = floorPoint(e.clientX, e.clientY, measureStart);
  if (!p) return;
  clearPreview();
  measurePreview = makeMeasure(measureStart, p);
  invalidate();
});
const endTap = (e) => {
  if (mode === 'walk' || !down || e.pointerId !== down.id) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const held = performance.now() - down.t;
  down = null;
  if (e.type === 'pointercancel' || moved > 7 || held > 500) return;
  if (measuring) {
    const p = floorPoint(e.clientX, e.clientY, measureStart);
    if (p) addMeasurePoint(p);
    return;
  }
  aim(e.clientX, e.clientY, activeCam());
  const h = ray.intersectObjects(pickables(), true)[0];
  if (h?.object.userData.doorId) { toggleDoor(h.object.userData.doorId); return; }
  const now = performance.now();
  if (h && now - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 36) {
    lastTap.t = 0;
    walkInAt(h.point);
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
};
canvas.addEventListener('pointerup', endTap);
canvas.addEventListener('pointercancel', endTap);

function walkInAt(point) {
  let x = point.x, z = point.z;
  // Step out of furniture or fixtures to the nearest open spot.
  if (isBlocked(x, z, walk.radius)) {
    let found = false;
    for (let r = 0.5; r < 6 && !found; r += 0.5) for (let a = 0; a < 360 && !found; a += 30) {
      const nx = x + Math.cos(a * DEG) * r, nz = z + Math.sin(a * DEG) * r;
      if (!isBlocked(nx, nz, walk.radius)) { x = nx; z = nz; found = true; }
    }
    if (!found) return;
  }
  let yaw = 0;
  if (mode === 'dollhouse') {
    const d = doll.target.clone().sub(dollCam.position);
    yaw = Math.atan2(d.x, -d.z) / DEG;
  }
  walk.setPose({ x, y: HEIGHT.eye, z, yaw, pitch: -4 });
  setMode('walk');
}

// ---------------------------------------------------------------------------
// Minimap (walk view)
const mm = $('#minimap');
const mctx = mm.getContext('2d');
let mmT = null;
function drawMinimap() {
  if (mode !== 'walk' || mm.hidden) return;
  const dpr = Math.min(devicePixelRatio, 2), W = mm.clientWidth, H = mm.clientHeight;
  if (mm.width !== Math.round(W * dpr)) { mm.width = Math.round(W * dpr); mm.height = Math.round(H * dpr); }
  const pad = 10, fw = fp.x1 - fp.x0, fh = fp.z1 - fp.z0;
  const s = Math.min((W - 2 * pad) / fw, (H - 2 * pad) / fh);
  const ox = (W - fw * s) / 2 - fp.x0 * s, oz = (H - fh * s) / 2 - fp.z0 * s;
  mmT = { s, ox, oz };
  const g = mctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = colors.surface2;
  for (const r of ROOMS) {
    g.beginPath();
    r.poly.forEach(([x, z], i) => (i ? g.lineTo(ox + x * s, oz + z * s) : g.moveTo(ox + x * s, oz + z * s)));
    g.closePath(); g.fill();
  }
  g.fillStyle = colors.ink;
  for (const [x0, z0, x1, z1] of wallPieces) g.fillRect(ox + x0 * s, oz + z0 * s, (x1 - x0) * s, (z1 - z0) * s);
  const cx = ox + walk.x * s, cz = oz + walk.z * s;
  const half = (Math.atan(Math.tan((walkCam.fov / 2) * DEG) * walkCam.aspect)) / DEG;
  const a0 = (walk.yaw - 90 - half) * DEG, a1 = (walk.yaw - 90 + half) * DEG;
  g.fillStyle = colors.oak;
  g.globalAlpha = 0.28;
  g.beginPath(); g.moveTo(cx, cz); g.arc(cx, cz, 26, a0, a1); g.closePath(); g.fill();
  g.globalAlpha = 1;
  g.beginPath(); g.arc(cx, cz, 4.5, 0, Math.PI * 2); g.fill();
  g.strokeStyle = colors.surface; g.lineWidth = 1.5; g.stroke();
}
mm.addEventListener('pointerdown', (e) => {
  if (!mmT) return;
  e.stopPropagation();
  const r = mm.getBoundingClientRect();
  const x = (e.clientX - r.left - mmT.ox) / mmT.s, z = (e.clientY - r.top - mmT.oz) / mmT.s;
  if (isBlocked(x, z, walk.radius)) return;
  exitPhoto({ keepView: true });
  walk.setPose({ x, y: HEIGHT.eye, z, yaw: walk.yaw, pitch: walk.pitch }, { animate: true, duration: 0.7 });
  invalidate();
});

// Scale bar (plan view)
const scalebar = $('#scalebar');
function updateScalebar() {
  if (mode !== 'plan') return;
  const ppf = stage.clientHeight / ((planCam.top - planCam.bottom) / planCam.zoom);
  const L = [1, 2, 5, 10, 20].find((l) => l * ppf >= 56) ?? 20;
  scalebar.querySelector('span').style.width = `${L * ppf}px`;
  scalebar.querySelector('b').textContent = `${L} ft`;
}

// ---------------------------------------------------------------------------
// Modes
let mode = null;
let cutaway = false;
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 4.5);
const activeCam = () => (mode === 'walk' ? walkCam : mode === 'plan' ? planCam : dollCam);

const HINTS = {
  dollhouse: coarse ? 'Drag to orbit · Pinch to zoom · Double-tap a room to walk in' : 'Drag to orbit · Right-drag to pan · Scroll to zoom · Double-click a room to walk in',
  plan: coarse ? 'Drag to pan · Pinch to zoom · Double-tap to walk in' : 'Drag to pan · Scroll to zoom · Double-click to walk in',
  walk: coarse ? 'Drag to look · Use the pad to move · Tap the floor to walk there' : 'Drag to look · WASD or arrows to move · Click the floor to walk there · Click a door to swing it',
};
const hint = $('#hint');
let hintTimer = 0;
function showHint() {
  hint.textContent = HINTS[mode];
  hint.classList.remove('gone');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(dismissHint, 7000);
}
function dismissHint() { hint.classList.add('gone'); }

function applyClipping() {
  const on = cutaway && mode === 'dollhouse';
  renderer.clippingPlanes = on ? [clipPlane] : [];
  arch.cutCaps.visible = on;
  arch.tops.visible = mode !== 'walk' && !on;
}

function setMode(m, { keepHash = false } = {}) {
  if (!['dollhouse', 'plan', 'walk'].includes(m)) m = 'dollhouse';
  if (m !== 'walk') exitPhoto({ keepView: true });
  mode = m;
  doll.enabled = m === 'dollhouse';
  plan.enabled = m === 'plan';
  walk.enabled = m === 'walk';
  const inside = m === 'walk';
  arch.ceilings.visible = inside;
  city.visible = inside;
  scene.background = inside ? null : bgColor;
  planOverlay.visible = m === 'plan' && $('#optOverlay').checked;
  applyClipping();
  setLighting(m);
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#minimap').hidden = !inside;
  $('#joystick').hidden = !(inside && coarse);
  scalebar.hidden = m !== 'plan';
  if (inside && measuring) setMeasuring(false);
  if (inside) fitWalkFov();
  if (!keepHash) history.replaceState(null, '', `#${m}`);
  showHint();
  invalidate();
}
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function homeDollhouse(animate = true) {
  const hfov = 2 * Math.atan(Math.tan((dollCam.fov / 2) * DEG) * dollCam.aspect);
  // Portrait phones look along the unit's long side so it fills the screen height.
  const dist = portrait() ? Math.max(48, 17 / Math.tan(hfov / 2)) : Math.max(62, 25 / Math.tan(hfov / 2));
  const dir = (portrait() ? new THREE.Vector3(0.62, 0.86, 0.12) : new THREE.Vector3(0.3, 0.9, 0.42)).normalize();
  const pos = CENTER.clone().add(dir.multiplyScalar(dist));
  if (animate) tweenOrbit(doll, dollCam, CENTER, pos);
  else { doll.target.copy(CENTER); dollCam.position.copy(pos); doll.update(); }
}
function homePlan(animate = true) {
  const pos = new THREE.Vector3(CENTER.x, planCam.position.y, CENTER.z);
  if (animate) tweenOrbit(plan, planCam, CENTER, pos, 1);
  else { plan.target.copy(CENTER); planCam.position.copy(pos); planCam.zoom = 1; planCam.updateProjectionMatrix(); plan.update(); }
}
$('#recenter').addEventListener('click', () => {
  if (mode === 'dollhouse') homeDollhouse();
  else if (mode === 'plan') homePlan();
  else { exitPhoto({ keepView: false }); walk.setPose(ENTRY_POSE, { animate: true }); }
  invalidate();
});

// ---------------------------------------------------------------------------
// Panel: tabs, toggles, bottom sheet
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => {
    const on = x === t;
    x.setAttribute('aria-selected', String(on));
    $(`#${x.getAttribute('aria-controls')}`).hidden = !on;
  });
  if (narrow()) setSheet(true);
}));

$('#optFurniture').addEventListener('change', (e) => {
  if (photo) furnitureBeforePhoto = e.target.checked;
  else furniture.visible = e.target.checked;
  invalidate();
});
$('#optLabels').addEventListener('change', (e) => { showLabels = e.target.checked; invalidate(); });
$('#optCutaway').addEventListener('change', (e) => {
  cutaway = e.target.checked;
  if (cutaway && mode !== 'dollhouse') setMode('dollhouse');
  applyClipping();
  invalidate();
});
$('#optOverlay').addEventListener('change', (e) => {
  if (e.target.checked && mode !== 'plan') setMode('plan');
  planOverlay.visible = mode === 'plan' && e.target.checked;
  invalidate();
});

const handle = $('#sheetHandle');
function setSheet(open) {
  panel.classList.toggle('open', open);
  handle.setAttribute('aria-expanded', String(open));
  handle.setAttribute('aria-label', open ? 'Hide details' : 'Show details');
}
handle.addEventListener('click', () => setSheet(!panel.classList.contains('open')));
{
  // Swipe the sheet open or closed from its handle and title.
  let y0 = null;
  const start = (e) => { if (narrow()) y0 = e.clientY; };
  const end = (e) => {
    if (y0 === null) return;
    const dy = e.clientY - y0;
    y0 = null;
    if (dy < -24) setSheet(true);
    else if (dy > 24) setSheet(false);
  };
  for (const el of [handle, $('.title-block')]) {
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', end);
  }
}

// ---------------------------------------------------------------------------
// Sizing
function fitWalkFov() {
  const a = stage.clientWidth / Math.max(1, stage.clientHeight);
  walkCam.fov = clamp((2 * Math.atan(Math.tan(41 * DEG) / a)) / DEG, 52, 96);
  walkCam.updateProjectionMatrix();
}
const portrait = () => stage.clientWidth / Math.max(1, stage.clientHeight) < 0.85;
function fitPlan() {
  const w = stage.clientWidth, h = Math.max(1, stage.clientHeight), a = w / h;
  const top = narrow() ? 64 : 70, bottom = narrow() ? 130 : 40;
  const usable = Math.max(120, h - top - bottom);
  // Portrait phones: put plan east at the top so the long side runs up the screen.
  planCam.up.set(...(portrait() ? [1, 0, 0] : [0, 0, -1]));
  planCam.lookAt(plan.target);
  const [fw, fh] = portrait() ? [fp.z1 - fp.z0 + 3, fp.x1 - fp.x0 + 3] : [fp.x1 - fp.x0 + 3, fp.z1 - fp.z0 + 3];
  const vh = Math.max(fh, fw / a) * (h / usable);
  const shift = ((bottom - top) / 2) * (vh / h);
  Object.assign(planCam, { top: vh / 2 - shift, bottom: -vh / 2 - shift, left: (-vh * a) / 2, right: (vh * a) / 2 });
  planCam.updateProjectionMatrix();
}
function resize() {
  const w = stage.clientWidth, h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  dollCam.aspect = walkCam.aspect = w / h;
  // Keep the dollhouse clear of the phone's top bar and bottom sheet.
  if (narrow()) dollCam.setViewOffset(w, h, 0, 34, w, h); else dollCam.clearViewOffset();
  dollCam.updateProjectionMatrix();
  if (photo) fitPhoto(); else fitWalkFov();
  fitPlan();
  // Re-frame the overviews when a phone turns between portrait and landscape.
  if (lastPortrait !== null && lastPortrait !== portrait()) { homeDollhouse(false); homePlan(false); }
  lastPortrait = portrait();
  invalidate();
}
let lastPortrait = null;
new ResizeObserver(resize).observe(stage);
resize();

// ---------------------------------------------------------------------------
// Render loop (renders only when something changed)
let shown = false;
let lastTime = performance.now();
function frame(now = performance.now()) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  let changed = needsRender;
  changed = stepOrbitTween(dt) || changed;
  if (mode === 'dollhouse') changed = doll.update() || changed;
  else if (mode === 'plan') changed = plan.update() || changed;
  else changed = walk.update(dt) || changed;
  changed = animateDoors(dt) || changed;
  changed = stepHighlight(dt) || changed;
  if (!changed) return;
  needsRender = false;
  renderer.render(scene, activeCam());
  updateLabels();
  drawMinimap();
  updateScalebar();
  if (!shown) { shown = true; $('#loading').classList.add('done'); window.app.ready = true; }
}

// Start in the view named by the link (#dollhouse, #plan, #walk, #photo-kitchen).
homeDollhouse(false);
homePlan(false);
function openFromHash(instant) {
  const h = location.hash.slice(1);
  if (h.startsWith('photo-')) showPhoto(h.slice(6), { instant });
  else if (h !== mode) setMode(h || 'dollhouse');
}
openFromHash(true);
addEventListener('hashchange', () => openFromHash(false));
if (!narrow()) setSheet(false);

// Small hook for scripted screenshots and debugging.
window.app = {
  ready: false,
  setMode, showPhoto, exitPhoto, focusRoom, toggleDoor, invalidate,
  walk, doors, setSheet,
  setFade(v) { fade.value = v; overlay.style.opacity = String(v / 100); },
  setPhotoCam(cam) {
    if (!photo) return;
    if (cam.vfov) { photo.vfov = cam.vfov; fitPhoto(); }
    Object.assign(photo.cam, cam);
    walk.setPose({ ...photo.cam });
    renderer.render(scene, walkCam);
  },
  // Normal-shaded, texture-free render used to fit photo poses by edge alignment.
  flat(on) {
    const normal = new THREE.MeshNormalMaterial();
    unit.traverse((o) => {
      if (!o.isMesh) return;
      if (on) { o.userData.mat ??= o.material; o.material = o.material.transparent ? o.material : normal; }
      else if (o.userData.mat) o.material = o.userData.mat;
    });
    city.visible = !on && mode === 'walk';
    scene.background = on ? new THREE.Color(0x000000) : (mode === 'walk' ? null : bgColor);
    invalidate();
  },
  get mode() { return mode; },
};
requestAnimationFrame(frame);
