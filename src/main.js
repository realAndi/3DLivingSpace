import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createMaterials } from './materials.js';
import { bindTextureControl } from './textures.js';
import { buildArchitecture } from './architecture.js';
import { buildFixtures } from './fixtures.js';
import { LayoutEditor } from './layout.js';
import { TapeMeasure } from './measure.js';
import { UnitSession } from './sync.js';
import { buildSurroundings } from './surroundings.js';
import { createLighting } from './lighting.js';
import { createLightPanel } from './lightpanel.js';
import { actOf } from './catalog.js';
import { WalkControls } from './walk.js';
import { Interactions } from './interact.js';
import { createSuggestions } from './suggestions.js';
import { buildUnit, cleanUnit, emptyUnit } from './unit.js';
import { pointInPoly, distToSegment, parseFeetInches } from './geometry.js';
import * as units from './units.js';
import { fmtLen, fmtDims, fmtArea } from './units.js';

// The app: one unit on screen, built from its spec (src/unit.js), in three
// views (Dollhouse, Plan, Walk), with the furniture planner, the tape measure
// and the panel around it. The unit is rebuilt whenever it changes on the
// server, so Claude building it through MCP shows up live.

const DEG = Math.PI / 180;
const EYE = 5.2;
// The example unit's size. The camera numbers below were tuned on it; other
// units scale them by how much bigger or smaller they are.
const REF = { long: 37.33, short: 25.46 };
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const stage = $('#stage'), canvas = $('#scene'), panel = $('#panel');
const coarse = matchMedia('(pointer: coarse)').matches;
// No browser context menu on the app (right-drag pans the views); text fields
// keep theirs, for copying links by hand.
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest?.('input, textarea, [contenteditable]')) e.preventDefault();
});
// Phones held upright and narrow windows: the panel is a bottom sheet. Phones
// held sideways keep a slim side panel, since a sheet would cover the view.
const sheetMQ = matchMedia('(max-width: 899px) and (orientation: portrait), (max-width: 899px) and (min-height: 560px)');
const narrow = () => sheetMQ.matches;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const make = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let needsRender = true;
function invalidate() { needsRender = true; }

function fail(message) {
  $('#loading').classList.remove('done');
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

// Textures fill in as their pictures arrive; texture quality is in Tools.
const M = createMaterials(renderer, { onChange: invalidate });
bindTextureControl($('#textureControl'), $('#textureNote'));

// The unit on screen: its built data U, and the meshes made from it. All of it
// is replaced when the unit changes (see showUnit).
let U = buildUnit(emptyUnit(), { checks: false });
let arch = null, fixtures = null, city = null, doors = [];
let shownSpec = null;
const built = new THREE.Group();
built.name = 'unit';
// Pieces placed with the furniture planner (src/layout.js) live in this group.
const furniture = new THREE.Group();
furniture.name = 'furniture';
scene.add(built, furniture);

const CENTER = new THREE.Vector3(15, 0, 10);
let SIZE = { w: 30, d: 20, k: 1 };

// An empty unit shows a faint grid of feet, a plot waiting to be built on.
const plot = new THREE.GridHelper(30, 30, 0xffffff, 0xffffff);
plot.material.transparent = true;
plot.material.opacity = 0.5;
plot.material.depthWrite = false;
plot.visible = false;
scene.add(plot);

// Lights: the sun and sky at the viewer's time of day, room lights and lamps
// (src/lighting.js). Its group holds the lights themselves: never hide it.
const lighting = createLighting({ renderer, scene, M, coarse, invalidate });
scene.add(lighting.group);

// The floor plan picture under the tracing (only the example has one).
let planOverlay = null;
const planTextures = new Map();
function buildPlanOverlay() {
  if (planOverlay) {
    scene.remove(planOverlay);
    planOverlay.geometry.dispose();
    planOverlay.material.dispose();
    planOverlay = null;
  }
  const pi = U.planImage;
  $('#overlayToggle').hidden = !pi;
  if (!pi) { $('#optOverlay').checked = false; return; }
  if (!planTextures.has(pi.src)) {
    const tex = new THREE.TextureLoader().load(pi.src, () => invalidate());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    planTextures.set(pi.src, tex);
  }
  planOverlay = new THREE.Mesh(
    new THREE.PlaneGeometry(pi.w, pi.h).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: planTextures.get(pi.src), transparent: true, opacity: 0.6, depthTest: false, toneMapped: false }),
  );
  planOverlay.position.set(pi.x + pi.w / 2, U.heights.ceiling + 0.2, pi.z + pi.h / 2);
  planOverlay.renderOrder = 10;
  planOverlay.visible = mode === 'plan' && $('#optOverlay').checked;
  scene.add(planOverlay);
}

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

doll.addEventListener('change', () => invalidate());
// Plan turned east-up (a phone held upright) makes OrbitControls report a
// change on every update though nothing moves; Plan renders when its camera
// really did (see planMoved), so an idle plan stops drawing.
const planWas = { p: new THREE.Vector3(), q: new THREE.Quaternion(), zoom: 0 };
function planMoved() {
  const moved = planWas.p.distanceToSquared(planCam.position) > 1e-10 || 1 - Math.abs(planWas.q.dot(planCam.quaternion)) > 1e-10 || Math.abs(planWas.zoom - planCam.zoom) > 1e-7;
  planWas.p.copy(planCam.position); planWas.q.copy(planCam.quaternion); planWas.zoom = planCam.zoom;
  return moved;
}

// Framing follows the unit's size: where it sits, how far the cameras stand
// back and how far Plan zooms in. (The sun's shadow camera: lighting.setUnit.)
function measureUnit() {
  const b = U.bounds;
  CENTER.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  SIZE = { w, d, k: Math.max(Math.max(w, d) / REF.long, Math.min(w, d) / REF.short) };
  const R = Math.hypot(w, d) / 2 + 4.4;
  doll.maxDistance = 160 * Math.max(1, SIZE.k);
  plan.maxZoom = clamp(9 * SIZE.k, 4, 40);
  planCam.far = Math.max(400, 200 + R * 2);
  planCam.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Walking: collisions against walls (minus doorways), built-ins, furniture and shut doors.
const inRect = (x, z, [x0, z0, x1, z1], r = 0) => x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r;
function nearPoly(x, z, poly, r) {
  if (!poly?.length) return false;
  if (pointInPoly(x, z, poly)) return true;
  for (let i = 0; i < poly.length; i++) if (distToSegment(x, z, poly[i], poly[(i + 1) % poly.length]) < r) return true;
  return false;
}
function isBlocked(x, z, r) {
  if (!U.insideUnit(x, z)) return true;
  if (U.obstacles.some((b) => inRect(x, z, b, r))) return true;
  if (furniture.visible && layout.blocks(x, z, r * 0.6)) return true;
  if (suggest.blocks(x, z, r * 0.6)) return true;
  return doors.some((d) => d.angle < 20 && nearPoly(x, z, d.closedPoly, r));
}

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function aim(clientX, clientY, cam) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
}
const pickables = () => [
  arch?.walls, arch?.floors, arch?.trim, fixtures?.solid, furniture.visible ? furniture : null, ...doors.map((d) => d.pivot),
  ...(fixtures?.movers ?? []).flatMap((m) => m.objects.filter((o) => o.visible)),
].filter(Boolean);

// ---------------------------------------------------------------------------
// Things you can use (src/interact.js): hinged doors, the doors and drawers of
// the kitchen, baths and laundry, lamps, TVs, curtains, fans, light switches.
// A tap or click on one uses it in every view; in Walk, E uses the one at the
// crosshair (or else the nearest one ahead). A small prompt says what either
// would do. Made before Walk and the furniture editor so its taps come first.
const things = new Interactions({
  canvas, stage, prompt: $('#usePrompt'), invalidate,
  view: () => ({
    mode, camera: activeCam(), locked: walk.locked, coarse, cover: covered,
    busy: tape.active || layout.dragging != null,
    clipY: cutaway && mode === 'dollhouse' ? clipPlane.constant : Infinity,
  }),
  pieces: () => (furniture.visible ? { items: layout.items, assets: layout.assets } : null),
});

function pickWalk(cx, cy) {
  if (tape.active || things.tapped) return null;
  const thing = things.at(cx, cy);
  if (thing) return { type: 'use', key: thing.key };
  aim(cx, cy, walkCam);
  const h = ray.intersectObjects(pickables(), true)[0];
  if (!h) return null;
  const key = things.keyAt(h);
  if (key) return { type: 'use', key };
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
  onUse: (key) => things.use(key),
  onInteract: () => interact(),
  onUserMove: () => { dismissHint(); invalidate(); },
  // A click while measuring places a point instead of grabbing the mouse, and
  // a click on something you can use uses it.
  canLock: () => !tape.active && !layout.dragging && !things.pressing,
  onLockChange: (locked) => { if (locked) dismissHint(); else if (mode === 'walk') showHint(); invalidate(); },
});
walk.attachJoystick($('#joystick'), $('#joystick .knob'));
// Where Walk starts: the unit's start, the living room's view, or the middle.
function startPose() {
  const v = U.start ?? Object.values(U.views)[0] ?? { x: CENTER.x, z: CENTER.z, yaw: 0 };
  return { x: v.x, y: EYE, z: v.z, yaw: v.yaw, pitch: -4 };
}
walk.setPose(startPose());

// ---------------------------------------------------------------------------
// Doors and the rest: E, Open all / Close all.
// E in Walk: the thing at the crosshair (the middle of the view), or else the
// nearest one ahead within reach.
function interact() {
  if (mode !== 'walk' || tape.active) return;
  const t = things.aimed();
  if (t) things.use(t.key);
}
function toggleDoor(id) { things.use(`door:${id}`); }
$('#openDoors').addEventListener('click', () => things.setAll('door:', true));
$('#closeDoors').addEventListener('click', () => things.setAll('door:', false));

// ---------------------------------------------------------------------------
// Theme
const token = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let colors = {};
const accentMat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, toneMapped: false });
const highlightFill = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
function readTheme() {
  colors = { bg: token('--bg'), ink: token('--ink'), ink2: token('--ink-2'), surface: token('--surface'), surface2: token('--surface-2'), rule: token('--rule'), oak: token('--oak') };
  bgColor.set(colors.bg);
  plot.material.color.set(colors.rule);
  accentMat.color.set(colors.oak);
  highlightFill.color.set(colors.oak);
  invalidate();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
readTheme();

// ---------------------------------------------------------------------------
// Rooms: list, labels, focus. Sizes go through the display units (src/units.js).

// A room's size: as printed on the plan when the plan prints one, else the
// clear floor inside its walls (overall, for rooms that aren't rectangles).
function roomSize(r) {
  if (r.planSize) {
    if (units.getUnits() === 'ftin') return { text: r.planSize, plan: true };
    const parts = r.planSize.split(/\s*[x×X]\s*/).map(parseFeetInches);
    return { text: parts.length === 2 && parts.every((v) => v !== null) ? fmtDims(...parts) : r.planSize, plan: true };
  }
  const [a, b] = [r.w, r.d].sort((p, q) => p - q);
  return { text: `${fmtDims(a, b)}${r.rect ? '' : ' overall'}`, plan: false };
}

const roomList = $('#roomList');
function renderRooms() {
  roomList.textContent = '';
  for (const r of U.rooms) {
    const size = roomSize(r);
    const b = make('button', 'room-btn');
    b.dataset.room = r.id;
    b.append(make('span', 'room-name', r.name), make('span', 'room-area', fmtArea(r.area)), make('span', 'room-dims', size.text));
    if (size.plan) b.append(make('span', 'src', 'Plan'));
    const li = make('li');
    li.append(b);
    roomList.append(li);
  }
  const fromPlan = U.rooms.some((r) => r.planSize);
  $('#roomsNote').hidden = U.empty;
  $('#roomsNote').innerHTML = fromPlan
    ? 'Sizes marked <b>Plan</b> are printed on the floor plan. The rest are measured inside the walls, face to face.'
    : 'Sizes are measured inside the walls, face to face.';
}
roomList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-room]');
  if (b) focusRoom(b.dataset.room);
});

const labelLayer = $('#labels');
let labels = [];
function renderLabels() {
  labelLayer.textContent = '';
  labels = [];
  for (const r of U.rooms) {
    const el = make('div', `room-label${r.minor ? ' minor' : ''}`);
    el.append(make('b', null, r.name));
    // Rooms that aren't rectangles show their area, as one size can't describe them.
    if (!r.minor) el.append(make('span', null, r.rect || r.planSize ? roomSize(r).text : fmtArea(r.area)));
    labelLayer.append(el);
    labels.push({ el, x: r.at[0], z: r.at[1], minor: r.minor });
  }
  for (const l of U.labels) {
    const el = make('div', 'room-label zone');
    el.append(make('b', null, l.text));
    labelLayer.append(el);
    labels.push({ el, x: l.at[0], z: l.at[1], minor: false, zone: true });
  }
}

let showLabels = true;
const v3 = new THREE.Vector3();
function project(x, y, z, cam) {
  v3.set(x, y, z).project(cam);
  return { x: ((v3.x + 1) / 2) * stage.clientWidth, y: ((1 - v3.y) / 2) * stage.clientHeight, behind: v3.z > 1 };
}
function updateLabels() {
  const visible = showLabels && mode !== 'walk';
  labelLayer.hidden = !visible;
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
    const p = project(l.x, mode === 'dollhouse' ? U.heights.ceiling + 0.4 : 0.2, l.z, cam);
    l.el.hidden = p.behind;
    l.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
  }
}

// Room highlight
let highlight = null;
function highlightRoom(r) {
  clearHighlight();
  const shape = new THREE.Shape(r.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, 0.05, 0), highlightFill);
  mesh.renderOrder = 5;
  scene.add(mesh);
  highlight = { mesh, t: 0 };
}
function clearHighlight() {
  if (!highlight) return;
  scene.remove(highlight.mesh);
  highlight.mesh.geometry.dispose();
  highlight = null;
}
function stepHighlight(dt) {
  if (!highlight) return false;
  highlight.t += dt;
  const t = highlight.t;
  highlightFill.opacity = t < 0.3 ? (t / 0.3) * 0.35 : Math.max(0, 0.35 * (1 - (t - 1.6) / 1.0));
  if (t > 2.6) clearHighlight();
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
  const r = U.roomById[id];
  if (!r) return;
  roomList.querySelectorAll('[data-room]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.room === id)));
  const cx = (r.bbox[0] + r.bbox[2]) / 2, cz = (r.bbox[1] + r.bbox[3]) / 2;
  const target = new THREE.Vector3(cx, 0, cz);
  if (mode === 'walk') {
    const v = U.views[id] ?? { x: r.at[0], z: r.at[1], yaw: walk.yaw };
    walk.setPose({ x: v.x, y: EYE, z: v.z, yaw: v.yaw, pitch: -4 }, { animate: true, duration: 1.1 });
  } else if (mode === 'plan') {
    const viewH = planCam.top - planCam.bottom;
    const zoom = clamp(viewH / (Math.max(r.w, r.d) * 2.4), 1, Math.min(5, plan.maxZoom));
    tweenOrbit(plan, planCam, target, new THREE.Vector3(cx, planCam.position.y, cz), zoom);
    highlightRoom(r);
  } else {
    const dir = dollCam.position.clone().sub(doll.target).normalize();
    const dist = clamp(Math.max(r.w, r.d) * 2.2 + 10, 16, 70);
    tweenOrbit(doll, dollCam, target, target.clone().add(dir.multiplyScalar(dist)));
    highlightRoom(r);
  }
  if (narrow()) setSheet(false);
}

// ---------------------------------------------------------------------------
// Furniture planner
const layout = new LayoutEditor({
  M, scene, root: furniture, canvas, stage, accentMat, invalidate, U,
  getCamera: () => activeCam(),
  getMode: () => mode,
  occluders: () => [arch?.walls, fixtures?.solid, ...doors.map((d) => d.pivot)].filter(Boolean),
  // What dragged pieces land on and hang from, and what the Dollhouse's cutaway hides.
  walls: () => arch?.walls ?? null,
  builtIns: () => fixtures?.solid ?? null,
  clipping: () => renderer.clippingPlanes,
  onSelect: (id) => { stage.classList.toggle('piece-active', id != null); if (id != null) dismissHint(); },
  onOps: (ops) => session.queue(ops),
  onAdded: () => { if (narrow()) setSheet(false); },
  // Lamps light the room when on (src/lighting.js), and pieces you can switch
  // or open (lamps, TVs, curtains, fans) join the things you can use.
  onMount: (item, g) => { if (actOf(item, layout.assets) === 'light') lighting.addLamp(item.uid, g); things.addPiece(item, g); },
  onUnmount: (uid) => { things.removePiece(uid); lighting.removeLamp(uid); },
  onEdit: () => {
    openTab('t-furniture');
    $('#pieceEditor').scrollIntoView({ block: 'nearest' });
  },
  onFocusPiece: focusPiece,
});

// Frame a piece: Plan and Dollhouse glide over to it, Walk turns to face it.
// `close` comes in near enough to see it from an overview, and in Dollhouse
// looks down at it from the middle of its room, so its room's walls don't hide it.
function focusPiece(item, { close = false } = {}) {
  if (!item) return;
  if (narrow()) setSheet(false);
  const t = new THREE.Vector3(item.x, 0, item.z);
  if (mode === 'plan') {
    const zoom = close ? clamp(planCam.zoom, Math.min(2.2, plan.maxZoom), plan.maxZoom) : undefined;
    tweenOrbit(plan, planCam, t, new THREE.Vector3(item.x, planCam.position.y, item.z), zoom);
  } else if (mode === 'dollhouse') {
    const back = dollCam.position.clone().sub(doll.target);
    if (close) {
      const r = U.roomAt(item.x, item.z);
      const side = r ? new THREE.Vector2((r.bbox[0] + r.bbox[2]) / 2 - item.x, (r.bbox[1] + r.bbox[3]) / 2 - item.z) : new THREE.Vector2();
      if (side.length() < 0.5) side.set(back.x, back.z);
      side.normalize();
      const up = 55 * DEG, dist = Math.min(back.length(), 34 * Math.max(1, SIZE.k));
      back.set(side.x * Math.cos(up), Math.sin(up), side.y * Math.cos(up)).multiplyScalar(dist);
    }
    tweenOrbit(doll, dollCam, t, t.clone().add(back));
  } else if (mode === 'walk') {
    const dx = item.x - walk.x, dz = item.z - walk.z, mid = (item.y ?? 0) + item.h / 2;
    const pitch = clamp(Math.atan2(mid - walk.y, Math.max(0.5, Math.hypot(dx, dz))) / DEG, -50, 30);
    walk.setPose({ x: walk.x, y: walk.y, z: walk.z, yaw: Math.atan2(dx, -dz) / DEG, pitch }, { animate: true, duration: 0.7 });
  }
  invalidate();
}

// ---------------------------------------------------------------------------
// Tape measure (every view)
// Its labels get their own layer: room labels hide in Walk, measurements don't.
const tapeLayer = document.createElement('div');
tapeLayer.className = 'edit-layer';
stage.append(tapeLayer);
const tape = new TapeMeasure({
  scene, canvas, stage, layer: tapeLayer, invalidate, U,
  material: accentMat,
  floors: () => arch?.floors ?? null,
  getCamera: () => activeCam(),
  getMode: () => mode,
  targets: () => pickables(),
  onChange: () => renderTapeUI(),
});
const tapeBtn = $('#tapeBtn'), tapeBar = $('#tapeBar');
function setMeasuring(on) {
  tape.setActive(on);
  layout.enabled = !on && !suggest.active;
  if (on) { layout.select(null); dismissHint(); if (narrow()) setSheet(false); }
}
function renderTapeUI() {
  tapeBtn.setAttribute('aria-pressed', String(tape.active));
  tapeBar.hidden = !tape.active && !tape.count;
  stage.classList.toggle('measuring', tape.active);
  $('#tapeText').textContent = tape.active
    ? (tape.start ? 'Tap the second point' : coarse ? 'Tap two points to measure' : 'Click two points to measure')
    : `${tape.count} measurement${tape.count === 1 ? '' : 's'}`;
  $('#tapeDone').textContent = tape.active ? 'Done' : 'Measure';
  $('#measureBtn').setAttribute('aria-pressed', String(tape.active));
}
tapeBtn.addEventListener('click', () => setMeasuring(!tape.active));
$('#measureBtn').addEventListener('click', () => setMeasuring(!tape.active));
$('#tapeDone').addEventListener('click', () => setMeasuring(!tape.active));
$('#tapeClear').addEventListener('click', () => { tape.clear(); renderTapeUI(); });
$('#clearMeasure').addEventListener('click', () => { tape.clear(); renderTapeUI(); });
canvas.addEventListener('pointerup', () => { if (tape.active) queueMicrotask(renderTapeUI); });

// The lights panel: time of day and each room's lights (src/lightpanel.js).
createLightPanel({ lighting, button: $('#lightsBtn'), pop: $('#lightsPop'), getMode: () => mode, onOpen: () => { if (narrow()) setSheet(false); } });

// Taps in Dollhouse / Plan: measure, use things, double-tap to walk in.
let down = null;
let lastTap = { t: 0, x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => {
  if (mode === 'walk' || down || tape.active) return;
  down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  dismissHint();
});
const endTap = (e) => {
  if (mode === 'walk' || !down || e.pointerId !== down.id) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const held = performance.now() - down.t;
  down = null;
  if (e.type === 'pointercancel' || moved > 7 || held > 500 || things.tapped) return;
  aim(e.clientX, e.clientY, activeCam());
  const h = ray.intersectObjects(pickables(), true)[0];
  const key = things.keyAt(h);
  if (key) { things.use(key); return; }
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
  walk.setPose({ x, y: EYE, z, yaw, pitch: -4 });
  setMode('walk');
}

// ---------------------------------------------------------------------------
// The unit itself: build it, and rebuild it when it changes.
function disposeUnit() {
  for (const d of doors) built.remove(d.pivot);
  built.clear();
  arch?.dispose?.();
  fixtures?.dispose?.();
  arch = fixtures = null;
  doors = [];
  if (city) { scene.remove(city); city.dispose?.(); city = null; }
}

// `fresh` frames the cameras on it (another unit opened). Otherwise they move
// only when the unit gets its first rooms or its size changes a lot.
function showUnit(spec, { fresh = false } = {}) {
  const clean = cleanUnit(spec ?? {}).unit;
  const key = JSON.stringify(clean);
  if (key === shownSpec && arch) return;
  let next;
  try { next = buildUnit(clean, { checks: false }); } catch (err) { console.error(err); layout.toast('This unit couldn\'t be built.'); return; }
  const before = { empty: !arch || U.empty, k: SIZE.k, x: CENTER.x, z: CENTER.z };
  disposeUnit();
  U = next;
  shownSpec = key;
  try {
    arch = buildArchitecture(M, U);
    fixtures = buildFixtures(M, U);
  } catch (err) {
    console.error(err);
    layout.toast('Part of this unit couldn\'t be drawn.');
  }
  if (arch) {
    built.add(arch.walls, arch.cutCaps, arch.tops, arch.floors, arch.ceilings, arch.trim, arch.glass);
    doors = arch.doors ?? [];
    doors.forEach((d) => built.add(d.pivot));
  }
  if (fixtures) built.add(fixtures.solid, fixtures.glass, fixtures.soffit, fixtures.movable);
  if (!U.empty) {
    city = buildSurroundings(U);
    scene.add(city);
  }
  built.visible = !U.empty;
  plot.visible = U.empty;
  plot.position.set((U.bounds.x0 + U.bounds.x1) / 2, 0, (U.bounds.z0 + U.bounds.z1) / 2);
  measureUnit();
  lighting.setUnit(U);
  layout.setUnit(U);
  tape.setUnit(U);
  things.setUnit(U, { doors, movers: fixtures?.movers ?? [] });
  things.connectLighting(lighting);
  clearHighlight();
  buildPlanOverlay();
  renderRooms();
  renderLabels();
  renderUnitInfo();
  renderMeasured();

  const moved = Math.hypot(CENTER.x - before.x, CENTER.z - before.z) > 0.25 * REF.long * SIZE.k;
  const resized = Math.abs(SIZE.k - before.k) / Math.max(before.k, 0.1) > 0.25;
  if (fresh || (before.empty && !U.empty) || moved || resized) {
    const animate = !fresh && mode === 'dollhouse' && !U.empty;
    applyViewOffset();
    fitPlan();
    homeDollhouse(animate);
    homePlan(false);
    walk.setPose(startPose());
  } else if (mode === 'walk' && isBlocked(walk.x, walk.z, 0.2)) {
    walk.setPose(startPose());
  }
  applyModeVisibility();
  lighting.setMode(mode ?? 'dollhouse');
  invalidate();
}

// ---------------------------------------------------------------------------
// Units on the server: opening, saving, sharing, view-only, your own version
let loadedHome = false;
const session = new UnitSession({
  onLoad: (doc, ss) => {
    // Measurements stay when the same unit comes back (your own copy of it).
    const was = shownSpec;
    suggest.reset();
    showUnit(doc?.unit ?? null, { fresh: true });
    if (shownSpec !== was) tape.clear();
    renderTapeUI();
    layout.load(doc ?? { items: [], assets: [] }, { readOnly: ss.role !== 'owner' });
    renderSession(ss);
    if (ss.role === 'home') setSheet(narrow());
    else if (narrow()) setSheet(false);
    // The same unit leaving (or reaching) the home page's welcome sheet on a
    // phone: frame it for the screen it now has.
    const home = ss.role === 'home';
    if (shownSpec === was && home !== loadedHome && narrow()) {
      applyViewOffset();
      fitPlan();
      homeDollhouse(ready.shown);
      homePlan(false);
    }
    loadedHome = home;
  },
  onRemote: (doc, ss) => {
    if (doc.unitRev !== ss.unitRev) showUnit(doc.unit);
    layout.applyRemote(doc, ss.pendingUids());
    suggest.layoutChanged();
  },
  onState: (ss) => renderSession(ss),
});

// Suggestions from copies of this unit, previewed one at a time in place of
// the real furniture; and a copy suggesting its own layout back (src/suggestions.js).
const suggest = createSuggestions({
  M, scene, layout, session, accent: accentMat, invalidate, focus: (item) => focusPiece(item, { close: true }),
  getU: () => U,
  openTab: (id) => openTab(id),
  closeSheet: () => { if (narrow()) setSheet(false); },
  onPreview: (on) => {
    furniture.visible = $('#optFurniture').checked && !on;
    layout.enabled = !on && !tape.active;
    if (on) { layout.select(null); dismissHint(); if (narrow()) setSheet(false); }
    stage.classList.toggle('previewing', on);
    invalidate();
  },
});

const BUILD_PROMPT = 'Build my apartment in 3D Living Space from the floor plan and photos I\'m sharing. Work to scale: get the scale from the room sizes printed on the plan, trace each room as the clear floor inside its walls, then add every door (with the way it swings), the windows, the kitchen cabinets and appliances, the bathroom fixtures, closets and laundry, and the finishes you can see in the photos. Fix every problem the tools report, then tell me what you couldn\'t see and what you assumed.';
const FURNISH_PROMPT = 'Furnish my unit in 3D Living Space. First ask me how I live and what style I like. Then place furniture that fits: keep 36" walkways, don\'t block any door swings, and check every room\'s clearances before you finish.';
$('#buildPromptText').textContent = BUILD_PROMPT;
$('#furnishPromptText').textContent = FURNISH_PROMPT;

const ui = {
  title: $('#designTitle'), author: $('#designAuthor'), status: $('#saveStatus'), line: $('#designLine'), lede: $('#lede'),
  chip: $('#viewChip'), chipText: $('#viewChipText'), notice: $('#viewNotice'), noticeText: $('#viewNoticeText'),
  card: $('#cardPreview'), viewLink: $('#viewLink'), homeStatus: $('#homeStatus'),
};

const STATUS = {
  loading: 'Opening…',
  missing: 'This unit doesn\'t exist.',
  offline: 'Can\'t reach the server, so nothing will be saved.',
};
const unitName = (ss) => ss.title || (ss.isExample ? 'The example unit' : 'Untitled unit');

// The eyebrow and lede: what kind of unit this is.
function renderUnitInfo() {
  const s = U.spec;
  const eyebrow = $('#eyebrow');
  eyebrow.textContent = '';
  const parts = [];
  if (U.empty) parts.push('New unit', 'Nothing built yet');
  else {
    const beds = s.beds ?? U.rooms.filter((r) => r.kind === 'bedroom').length;
    const baths = s.baths ?? U.rooms.filter((r) => r.kind === 'bath').length;
    parts.push(beds ? `${beds} Bed` : 'Studio');
    if (baths) parts.push(`${baths} Bath`);
    parts.push(fmtArea(s.sqft ?? U.area));
  }
  for (const p of parts) eyebrow.append(make('span', null, p));
  $('#cutLabel').textContent = `Cut walls at ${fmtLen(4.5)}`;
}

let codeFor = null;  // the unit whose edit code state the Share tab shows
function renderSession(ss) {
  const role = ss.role, home = role === 'home', mine = role === 'owner', visitor = role === 'viewer';
  document.body.dataset.role = role;
  $('#welcome').hidden = !home;
  $('#unitView').hidden = home;
  panel.classList.toggle('welcome-mode', home);
  stage.classList.toggle('home', home);
  stage.classList.toggle('visitor', visitor);
  const empty = U.empty && (mine || visitor);
  const nothing = ['loading', 'missing', 'offline'].includes(role);
  stage.classList.toggle('empty', empty || nothing);
  plot.visible = empty;
  $('#eyebrow').hidden = nothing;
  if (empty && tape.active) setMeasuring(false);

  // Title block
  ui.line.textContent = ['loading', 'missing', 'offline'].includes(role) ? '' : `${unitName(ss)}${ss.author ? ` · by ${ss.author}` : ''}`;
  ui.lede.textContent = role === 'missing' ? 'This unit doesn\'t exist. The link may have been mistyped.'
    : role === 'offline' ? 'Can\'t reach the server right now.'
      : empty ? (mine ? 'Nothing built yet. Build it with Claude from your floor plan and photos.' : 'Its owner hasn\'t built it yet.')
        : mine ? 'Your unit. Furnish it, measure it, walk through it, and share it.'
          : ss.isExample ? 'A to-scale model of a 2 bed, 2 bath apartment. Make your own version to furnish it, or build your own unit with Claude.'
            : 'A to-scale model of an apartment. Look around, then make your own version to furnish it your way.';
  if (document.activeElement !== ui.title) ui.title.value = ss.title;
  if (document.activeElement !== ui.author) ui.author.value = ss.author;
  ui.status.dataset.state = ss.status;
  ui.status.textContent = STATUS[role]
    ?? (visitor ? 'View only. Make your own version to change it.'
      : ss.status === 'saving' ? 'Saving…' : ss.status === 'error' ? (ss.error || 'Not saved.') : 'Saved. Changes save as you go.');

  // Visitors get a clear way to make their own.
  ui.chip.hidden = !visitor || empty;
  const who = ss.author ? `${ss.author}'s` : 'someone\'s';
  ui.chipText.textContent = ss.isExample ? 'The example unit' : ss.title ? `${ss.title}${ss.author ? ` · by ${ss.author}` : ''}` : ss.author ? `${who} unit` : '';
  ui.notice.hidden = !visitor || empty;
  ui.noticeText.textContent = ss.isExample ? 'This is the example unit. Make your own version to furnish it, or create a unit of your own.' : `This is ${who} unit. Make your own version to move things around, add pieces, or furnish it with Claude.`;
  $('#shareNoticeText').textContent = ui.noticeText.textContent;
  $('#addGroup').hidden = !mine || U.empty;
  $('#layoutTools').hidden = !mine;
  $('#furnishEmpty').hidden = !U.empty || !(mine || visitor);
  $('#layoutGroup').hidden = U.empty && !layout.items.length;

  // Empty unit, missing unit, no connection
  $('#emptyPanel').hidden = !empty;
  $('#emptyStage').hidden = !empty;
  const noticeRole = role === 'missing' || role === 'offline';
  $('#stageNotice').hidden = !noticeRole;
  if (noticeRole) {
    $('#noticeTitle').textContent = role === 'missing' ? 'This unit doesn\'t exist' : 'Can\'t reach the server';
    $('#noticeText').textContent = role === 'missing' ? 'The link may have been mistyped, or the unit was removed.' : 'Check your connection, then try again.';
    $('#noticeRetry').hidden = role !== 'offline';
    $('#noticeCreate').hidden = role !== 'missing';
  }

  // Links
  $('#shareGroup').hidden = !ss.id;
  if (ss.id) {
    ui.viewLink.value = ss.viewUrl();
    const src = `api/units/${ss.id}/card.png?v=${ss.version}`;
    if (ui.card.getAttribute('src') !== src) ui.card.src = src;
  }
  const mcp = ss.mcpUrl() ?? '';
  $$('.mcp-url').forEach((i) => { i.value = mcp; });
  // The edit code: visitors to a unit (not the example) can unlock it; its
  // owner sees whether a code is set.
  $('#chipEdit').hidden = ss.isExample;
  ui.chip.classList.toggle('with-edit', !ss.isExample);
  $('#unlockGroup').hidden = ss.isExample;
  if (mine && codeFor !== ss.id) { codeFor = ss.id; renderCode(null); ss.hasCode().then((set) => { if (codeFor === ss.id) renderCode(set); }); }
  if (!mine) codeFor = null;

  // Your units, here and on the home page
  const list = ss.ownedUnits();
  renderUnitList($('#myUnits'), list, ss.id);
  $('#myUnitsEmpty').hidden = list.length > 0;
  renderUnitList($('#homeUnits'), list, null);
  $('#homeUnitsGroup').hidden = !list.length;
  $$('[data-go="create"], [data-go="example"], [data-go="fork"]').forEach((b) => { b.disabled = ss.busy; });
  ui.homeStatus.dataset.state = ss.error && home ? 'error' : '';
  ui.homeStatus.textContent = home ? (ss.busy ? 'Making your unit…' : ss.error ?? '') : '';

  document.title = home ? '3D Living Space' : ss.id ? `${unitName(ss)} · 3D Living Space` : '3D Living Space';
  suggest.sync(ss);
  ready.session = role !== 'loading';
  invalidate();
}

function renderUnitList(ul, list, current) {
  ul.textContent = '';
  for (const u of list) {
    const b = make('button', 'piece-row');
    b.dataset.unit = u.id;
    b.setAttribute('aria-current', String(u.id === current));
    b.append(make('span', null, u.title || 'Untitled unit'), make('small', null, u.at ? new Date(u.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''));
    const li = make('li');
    li.append(b);
    ul.append(li);
  }
}
for (const ul of [$('#myUnits'), $('#homeUnits')]) {
  ul.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unit]');
    if (b && b.dataset.unit !== session.id) session.open(b.dataset.unit, { push: true });
    else if (b && narrow()) setSheet(false);
  });
}

let infoTimer = 0;
for (const input of [ui.title, ui.author]) {
  input.addEventListener('input', () => {
    clearTimeout(infoTimer);
    infoTimer = setTimeout(() => session.setInfo({ title: ui.title.value.trim(), author: ui.author.value.trim() }), 400);
  });
}

// Buttons that go somewhere: a new unit, a copy of the example, your own
// version of this one, home, or another try at the server.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-go]');
  if (!b) return;
  const go = b.dataset.go;
  if (go === 'home') { if (session.role === 'home') setSheet(narrow()); else session.home({ push: true }); return; }
  if (go === 'retry') { session.retry(); return; }
  if (session.busy) return;
  const doc = go === 'create' ? await session.create()
    : go === 'example' ? await session.create({ from: 'example' })
      : await session.fork();
  if (doc) {
    layout.toast(go === 'create' ? 'Your new unit is ready. Build it with Claude.' : 'This copy is yours. Changes save as you go.');
    if (go === 'create' && narrow()) setSheet(false);
  } else if (session.error) layout.toast(session.error);
});
$('#homeLink').addEventListener('click', (e) => { e.preventDefault(); if (session.role !== 'home') session.home({ push: true }); });

// ---------------------------------------------------------------------------
// Edit codes: set one here, then on another device open the unit's link, tap
// Edit and enter it (src/sync.js unlock, server/service.js).
function renderCode(set) {
  $('#codeRemove').hidden = !set;
  $('#codeSave').textContent = set ? 'Save new code' : 'Save code';
  $('#codeNote').textContent = set
    ? 'A code is set. On your phone or another computer, open this unit\'s link, tap Edit and enter it. Saving a new code replaces it.'
    : 'Set an edit code. Then on your phone or another computer, open this unit\'s link, tap Edit and enter it. Make it hard to guess, or tap Suggest.';
}
function codeStatus(el, text, error = false) {
  el.textContent = text;
  el.dataset.state = error ? 'error' : '';
}
// Eight letters and digits that can't be misread (no 0/o, 1/l/i).
function suggestCode() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789', s = [...crypto.getRandomValues(new Uint8Array(8))].map((v) => A[v % A.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
$('#codeSuggest').addEventListener('click', () => {
  const input = $('#codeInput');
  input.value = suggestCode();
  input.focus();
  input.select();
  codeStatus($('#codeStatus'), '');
});
$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#codeInput'), code = input.value.trim();
  if (!code) { input.focus(); return; }
  codeStatus($('#codeStatus'), 'Saving…');
  const err = await session.setCode(code);
  if (err) { codeStatus($('#codeStatus'), err, true); return; }
  renderCode(true);
  codeStatus($('#codeStatus'), `Saved. On your other device, open this unit's link, tap Edit and enter ${code}.`);
});
$('#codeRemove').addEventListener('click', async () => {
  const err = await session.setCode(null);
  if (err) { codeStatus($('#codeStatus'), err, true); return; }
  renderCode(false);
  $('#codeInput').value = '';
  codeStatus($('#codeStatus'), 'Removed. No code opens this unit now.');
});
$('#chipEdit').addEventListener('click', () => {
  openTab('t-share');
  const input = $('#unlockCode');
  input.scrollIntoView({ block: 'center' });
  input.focus();
});
$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#unlockCode'), code = input.value.trim();
  if (!code) { input.focus(); return; }
  codeStatus($('#unlockStatus'), 'Checking…');
  const err = await session.unlock(code);
  if (err) { codeStatus($('#unlockStatus'), err, true); return; }
  input.value = '';
  codeStatus($('#unlockStatus'), '');
  input.blur();
  layout.toast('It\'s yours on this device too. Changes save as you go.');
});

async function copy(text, done) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    layout.toast(done);
  } catch {
    window.prompt('Copy this', text);
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const what = b.dataset.copy;
  if (what === 'mcp') copy(session.mcpUrl(), 'MCP URL copied. Keep it to yourself and your own Claude.');
  else if (what === 'edit') copy(session.editUrl(), 'Edit link copied. Keep it private.');
  else if (what === 'prompt-build') copy(BUILD_PROMPT, 'Prompt copied. Paste it into Claude with your plan and photos.');
  else if (what === 'prompt-furnish') copy(FURNISH_PROMPT, 'Prompt copied');
});
$('#copyView').addEventListener('click', async () => {
  const url = session.viewUrl();
  if (!url) return;
  if (navigator.share && coarse) {
    try { await navigator.share({ title: session.title || '3D Living Space', text: 'Have a look around, then make your own version.', url }); return; } catch (err) { if (err?.name === 'AbortError') return; }
  }
  copy(url, 'Link copied');
});

// ---------------------------------------------------------------------------
// Display units
// Look speed in Walk (Tools), per browser: a multiplier on mouse and touch looking.
const LOOK_KEY = 'livingspace.lookSpeed.v1';
const lookInput = $('#lookSpeed'), lookValue = $('#lookSpeedValue');
function setLookSpeed(v, save = true) {
  const x = Math.min(3, Math.max(0.25, Number(v) || 1));
  walk.lookScale = x;
  lookInput.value = String(x);
  lookValue.textContent = `${x.toFixed(x < 1 ? 2 : 1)}×`;
  if (save) { try { localStorage.setItem(LOOK_KEY, String(x)); } catch { /* storage off */ } }
}
{
  let saved = null;
  try { saved = localStorage.getItem(LOOK_KEY); } catch { /* storage off */ }
  setLookSpeed(saved ?? 1, false);
}
lookInput.addEventListener('input', () => setLookSpeed(lookInput.value));
$('#lookSpeedReset').addEventListener('click', () => setLookSpeed(1));

const unitsControl = $('#unitsControl');
function renderUnitsControl() {
  unitsControl.querySelectorAll('[data-units]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.units === units.getUnits())));
}
unitsControl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-units]');
  if (b) units.setUnits(b.dataset.units);
});
units.onUnitsChange(() => {
  renderUnitsControl();
  renderRooms();
  renderLabels();
  renderUnitInfo();
  renderMeasured();
  layout.refreshUnits();
  tape.refreshLabels();
  invalidate();
});
renderUnitsControl();

// How the example was measured (it, and copies of it, carry its plan picture).
function renderMeasured() {
  const show = !!U.planImage;
  $('#measuredGroup').hidden = !show;
  if (!show) return;
  // Short lengths read in inches in the original look.
  const short = (ft) => (units.getUnits() === 'ftin' ? `${Math.round(ft * 12)}"` : fmtLen(ft));
  $('#measuredNotes').innerHTML = [
    `<b>Walls and openings</b> are traced from the leasing plan at 25.86 px per foot, which reproduces both bedrooms' printed sizes within ${short(2 / 12)}.`,
    `<b>Two tape measurements</b> from the living room's window wall (to the side of the fridge, ${fmtLen(112 / 12)}, and to the bedroom door, about ${fmtLen(129.5 / 12)}) both came out about ${short(4 / 12)} longer than the drawing, so that wall sits ${short(4 / 12)} further out than the plan draws it.`,
    `<b>Ceiling height ${fmtLen(9)}</b> comes from solving where each photo was taken, using wall corners and floor and ceiling lines that the plan locates.`,
    `<b>Living room window</b> is a ${fmtLen(83 / 12)} opening centered on the wall, measured from the photo. The plan symbol draws it about ${fmtLen(9)}. Sills sit about ${short(23 / 12)} up and heads line up with the ${fmtLen(8)} doors.`,
    '<b>Kitchen</b> follows the photo: fridge, base cabinet, and range along the back wall; sink and dishwasher on the side wall facing the dining area.',
    '<b>Primary bath</b> follows the photos (walk-in shower with a glass panel, vanity and toilet side by side). The plan shows a corner shower.',
    '<b>Bath 2 and Bedroom 2</b> weren\'t photographed, so they follow the plan with matching finishes.',
  ].map((t) => `<li>${t}</li>`).join('');
}

// ---------------------------------------------------------------------------
// Minimap (walk view)
const mm = $('#minimap');
const mctx = mm.getContext('2d');
let mmT = null;
function drawMinimap() {
  if (mode !== 'walk' || mm.hidden) return;
  const dpr = Math.min(devicePixelRatio, 2), W = mm.clientWidth, H = mm.clientHeight;
  if (!W || !H) return;
  if (mm.width !== Math.round(W * dpr)) { mm.width = Math.round(W * dpr); mm.height = Math.round(H * dpr); }
  const b = U.bounds, pad = 10, fw = b.x1 - b.x0, fh = b.z1 - b.z0;
  const s = Math.min((W - 2 * pad) / fw, (H - 2 * pad) / fh);
  const ox = (W - fw * s) / 2 - b.x0 * s, oz = (H - fh * s) / 2 - b.z0 * s;
  mmT = { s, ox, oz };
  const g = mctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = colors.surface2;
  for (const r of U.rooms) {
    g.beginPath();
    r.poly.forEach(([x, z], i) => (i ? g.lineTo(ox + x * s, oz + z * s) : g.moveTo(ox + x * s, oz + z * s)));
    g.closePath(); g.fill();
  }
  g.fillStyle = colors.ink;
  for (const [x0, z0, x1, z1] of U.wallRects) g.fillRect(ox + x0 * s, oz + z0 * s, (x1 - x0) * s, (z1 - z0) * s);
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
  walk.setPose({ x, y: EYE, z, yaw: walk.yaw, pitch: walk.pitch }, { animate: true, duration: 0.7 });
  invalidate();
});

// Scale bar (plan view): feet, or meters in centimeters mode.
const scalebar = $('#scalebar');
function updateScalebar() {
  if (mode !== 'plan') return;
  const ppf = stage.clientHeight / ((planCam.top - planCam.bottom) / planCam.zoom);
  const step = units.scaleStep(56 / ppf);
  scalebar.querySelector('span').style.width = `${step.ft * ppf}px`;
  scalebar.querySelector('b').textContent = step.label;
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
  walk: coarse ? 'Drag to look · Use the pad to move · Tap the floor to walk there · Tap a door, drawer or lamp to use it' : 'Click to look around · WASD or arrows to move · E opens, shuts or switches what you face',
};
const hint = $('#hint');
let hintTimer = 0;
function showHint() {
  if (layout?.selected != null) return;
  hint.textContent = HINTS[mode];
  hint.classList.remove('gone');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(dismissHint, 7000);
}
function dismissHint() { hint.classList.add('gone'); }

// What shows in each view: ceilings, soffits and the street only from inside.
function applyModeVisibility() {
  const inside = mode === 'walk';
  const cut = cutaway && mode === 'dollhouse';
  renderer.clippingPlanes = cut ? [clipPlane] : [];
  if (arch) {
    arch.ceilings.visible = inside;
    arch.cutCaps.visible = cut;
    arch.tops.visible = mode !== 'walk' && !cut;
  }
  if (fixtures?.soffit) fixtures.soffit.visible = inside;
  if (city) city.visible = inside;
  scene.background = inside ? null : bgColor;
  if (planOverlay) planOverlay.visible = mode === 'plan' && $('#optOverlay').checked;
}

function setMode(m, { keepHash = false } = {}) {
  if (!['dollhouse', 'plan', 'walk'].includes(m)) m = 'dollhouse';
  mode = m;
  doll.enabled = m === 'dollhouse';
  plan.enabled = m === 'plan';
  walk.enabled = m === 'walk';
  const inside = m === 'walk';
  applyModeVisibility();
  layout.setView(m);
  suggest.setView(m);
  lighting.setMode(m);
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#minimap').hidden = !inside;
  $('#joystick').hidden = !(inside && coarse);
  scalebar.hidden = m !== 'plan';
  if (inside) fitWalkFov();
  if (!keepHash) history.replaceState(history.state, '', `${location.pathname}${location.search}#${m}`);
  tape.cancel();
  showHint();
  invalidate();
}
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// The part of the stage the panel and the top bar cover. On phones that is the
// sheet's peek, or the open welcome sheet on the home page, which leaves the
// example in view above it.
const SHEET_PEEK = 112;
const shortScreen = () => stage.clientHeight < 560 && !narrow();
function covered() {
  // Phones held sideways: the view buttons take a good share of the height.
  if (!narrow()) return { top: shortScreen() ? 52 : 0, bottom: 0 };
  const sheet = session?.role === 'home' && panel.classList.contains('open') ? panel.offsetHeight : SHEET_PEEK;
  return { top: 44, bottom: sheet };
}
function applyViewOffset() {
  const w = stage.clientWidth, h = Math.max(1, stage.clientHeight);
  // Keep the dollhouse clear of the phone's top bar and bottom sheet.
  const c = covered();
  if (c.top || c.bottom) dollCam.setViewOffset(w, h, 0, (c.bottom - c.top) / 2, w, h); else dollCam.clearViewOffset();
  dollCam.updateProjectionMatrix();
}

// How far back a camera looking along `dir` must stand to see the whole unit,
// walls up to the ceiling included, in a view of the given tangents.
function fitDistance(dir, tanH, tanV) {
  const b = U.bounds, H = Math.max(U.heights.ceiling, ...U.rooms.map((r) => r.ceiling));
  const f = dir.clone().negate();
  const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  const u = new THREE.Vector3().crossVectors(r, f);
  const v = new THREE.Vector3();
  let D = 0;
  for (const x of [b.x0, b.x1]) for (const y of [0, H]) for (const z of [b.z0, b.z1]) {
    v.set(x - CENTER.x, y, z - CENTER.z);
    D = Math.max(D, v.dot(dir) + Math.abs(v.dot(r)) / tanH, v.dot(dir) + Math.abs(v.dot(u)) / tanV);
  }
  return D;
}

function homeDollhouse(animate = true) {
  const c = covered();
  const h = Math.max(1, stage.clientHeight), visH = Math.max(1, h - c.top - c.bottom);
  const tall = stage.clientWidth / (narrow() ? visH : h) < 0.85;
  const k = SIZE.k;
  const tanV = Math.tan((dollCam.fov / 2) * DEG), tanH = tanV * dollCam.aspect;
  // Portrait screens look along the unit's long side so it fills the screen height.
  let dist = tall ? Math.max(48 * k, (17 * k) / tanH) : Math.max(62 * k, (25 * k) / tanH);
  // Under a tall sheet, back off until the unit fits in the strip above it.
  if (c.bottom > 200) dist = Math.max(dist, (17.5 * k) / (tanV * (visH / h)));
  else if (!narrow() && c.top) dist *= h / visH;
  const d = tall ? [0.62, 0.86, 0.12] : [0.3, 0.9, 0.42];
  const dir = new THREE.Vector3(...(SIZE.w >= SIZE.d ? d : [d[2], d[1], d[0]])).normalize();
  // Small units with tall walls need more room than their footprint suggests.
  // (The example crops its wall tops a little, as it always has; so may they.)
  dist = Math.max(dist, 0.9 * fitDistance(dir, tanH, tanV * (visH / h)));
  const pos = CENTER.clone().add(dir.multiplyScalar(dist));
  if (animate) tweenOrbit(doll, dollCam, CENTER, pos);
  else { orbitTween = null; doll.target.copy(CENTER); dollCam.position.copy(pos); doll.update(); }
}
function homePlan(animate = true) {
  const pos = new THREE.Vector3(CENTER.x, planCam.position.y, CENTER.z);
  if (animate) tweenOrbit(plan, planCam, CENTER, pos, 1);
  else { plan.target.copy(CENTER); planCam.position.copy(pos); planCam.zoom = 1; planCam.updateProjectionMatrix(); plan.update(); }
}
$('#recenter').addEventListener('click', () => {
  if (mode === 'dollhouse') homeDollhouse();
  else if (mode === 'plan') homePlan();
  else walk.setPose(startPose(), { animate: true });
  invalidate();
});

// ---------------------------------------------------------------------------
// Panel: tabs, toggles, bottom sheet
function openTab(id) {
  document.querySelectorAll('.tab').forEach((x) => {
    const on = x.id === id;
    x.setAttribute('aria-selected', String(on));
    $(`#${x.getAttribute('aria-controls')}`).hidden = !on;
  });
  if (narrow()) setSheet(true);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => openTab(t.id)));

$('#optFurniture').addEventListener('change', (e) => {
  // A suggestion's preview stands in for the furniture while it's open.
  furniture.visible = e.target.checked && !suggest.active;
  suggest.root.visible = e.target.checked;
  layout.select(null);
  invalidate();
});
$('#optLabels').addEventListener('change', (e) => { showLabels = e.target.checked; invalidate(); });
$('#optCutaway').addEventListener('change', (e) => {
  cutaway = e.target.checked;
  if (cutaway && mode !== 'dollhouse') setMode('dollhouse');
  applyModeVisibility();
  invalidate();
});
$('#optOverlay').addEventListener('change', (e) => {
  if (e.target.checked && mode !== 'plan') setMode('plan');
  applyModeVisibility();
  invalidate();
});

const handle = $('#sheetHandle');
function setSheet(open) {
  const was = panel.classList.contains('open');
  panel.classList.toggle('open', open);
  handle.setAttribute('aria-expanded', String(open));
  handle.setAttribute('aria-label', open ? 'Hide details' : 'Show details');
  // A closed sheet peeks at its title, not wherever it was scrolled to.
  if (!open) $('#welcome').scrollTop = 0;
  // On the home page the example re-frames into whatever the sheet leaves free.
  if (was !== open && session?.role === 'home' && narrow()) {
    applyViewOffset();
    fitPlan();
    homeDollhouse(ready.shown);
    invalidate();
  }
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
  for (const el of [handle, $('#titleBlock'), $('#welcomeHead')]) {
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
// Plan fills the free part of the stage. When the screen and the unit are
// shaped differently (a tall phone, a wide unit) it turns so east is up.
let planTurned = null;
function fitPlan() {
  const w = stage.clientWidth, h = Math.max(1, stage.clientHeight), a = w / h;
  const c = covered();
  const top = narrow() ? 64 : 70, bottom = narrow() ? Math.max(130, c.bottom + 18) : 40;
  const usable = Math.max(120, h - top - bottom);
  const turned = (w / usable < 0.85) !== (SIZE.d > SIZE.w);
  planTurned = turned;
  planCam.up.set(...(turned ? [1, 0, 0] : [0, 0, -1]));
  planCam.lookAt(plan.target);
  const [fw, fh] = turned ? [SIZE.d + 3, SIZE.w + 3] : [SIZE.w + 3, SIZE.d + 3];
  // Under the tall welcome sheet only the height is squeezed; otherwise the
  // original framing (a little room to spare either way).
  const vh = c.bottom > 200 ? Math.max(fh * (h / usable), (fw / a) * 1.08) : Math.max(fh, fw / a) * (h / usable);
  const shift = ((bottom - top) / 2) * (vh / h);
  Object.assign(planCam, { top: vh / 2 - shift, bottom: -vh / 2 - shift, left: (-vh * a) / 2, right: (vh * a) / 2 });
  planCam.updateProjectionMatrix();
}
let lastShape = null;
function resize() {
  const w = stage.clientWidth, h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  dollCam.aspect = walkCam.aspect = w / h;
  applyViewOffset();
  fitWalkFov();
  const turnedBefore = planTurned;
  fitPlan();
  // Re-frame the overviews when a phone turns between portrait and landscape.
  const shape = `${w / h < 0.85}:${narrow()}`;
  if (lastShape !== null && (lastShape !== shape || turnedBefore !== planTurned)) { homeDollhouse(false); homePlan(false); }
  lastShape = shape;
  invalidate();
}
new ResizeObserver(resize).observe(stage);
sheetMQ.addEventListener('change', () => { if (!narrow()) panel.classList.remove('open'); resize(); });

// ---------------------------------------------------------------------------
// Render loop (renders only when something changed)
const ready = { shown: false, session: false };
let lastTime = performance.now();
function frame(now = performance.now()) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  let changed = needsRender;
  changed = stepOrbitTween(dt) || changed;
  if (mode === 'dollhouse') changed = doll.update() || changed;
  else if (mode === 'plan') { plan.update(); changed = planMoved() || changed; }
  else changed = walk.update(dt) || changed;
  changed = things.step(dt) || changed;
  changed = stepHighlight(dt) || changed;
  changed = lighting.update(activeCam(), dt) || changed;
  // The prompt for what you can use follows the view either way.
  if (!changed) { things.update(now); return; }
  needsRender = false;
  renderer.render(scene, activeCam());
  updateLabels();
  layout.updateOverlay(activeCam());
  tape.update(activeCam());
  drawMinimap();
  updateScalebar();
  things.update(now);
  if (!ready.shown && ready.session) {
    ready.shown = true;
    $('#loading').classList.add('done');
    window.app.ready = true;
  }
}

// Start in the view named by the link (#dollhouse, #plan, #walk).
function openFromHash() {
  const h = location.hash.slice(1);
  if (/^(dollhouse|plan|walk)$/.test(h)) { if (h !== mode) setMode(h, { keepHash: true }); }
  else if (!mode) setMode('dollhouse', { keepHash: true });
}
resize();
openFromHash();
addEventListener('hashchange', openFromHash);
if (!narrow()) setSheet(false);
renderTapeUI();

// Small hook for scripted screenshots and tests.
window.app = {
  ready: false,
  setMode, focusRoom, toggleDoor, invalidate, walk, setSheet, layout, session, tape, units, lighting, things, interact, suggest,
  get doors() { return doors; },
  get movers() { return fixtures?.movers ?? []; },
  get U() { return U; },
  // GPU memory and draw counts, to check that rebuilds don't leak.
  get stats() { return { ...renderer.info.memory, calls: renderer.info.render.calls }; },
  // Screen position of a world point in the current view.
  project(x, y, z) {
    const p = project(x, y, z, activeCam());
    const r = canvas.getBoundingClientRect();
    return [p.x + r.left, p.y + r.top];
  },
  get mode() { return mode; },
};
session.start();
requestAnimationFrame(frame);
