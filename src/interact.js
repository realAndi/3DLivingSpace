import * as THREE from 'three';
import { catalogByType } from './catalog.js';
import { fixtureParts, pieceParts } from './parts.js';

// Things you can use in 3D: the unit's hinged doors, the doors and drawers of
// its kitchen, baths and laundry (src/fixtures.js), pieces you can switch or
// open (lamps, TVs, curtains, ceiling fans, a microwave's door) and the
// rooms' light switches. Each is an entry { key, name, objects, pos(),
// label(), use() }: `objects` are what you click it by, pos() where it is
// (for what's near and ahead), label() what using it would do ('Open the
// fridge').
//
// Using one says where it's going; step() moves it there a little each
// frame. What the view is on: at() for a point on the screen, aimed() for
// Walk's crosshair (else the nearest thing ahead, as E works), near() for the
// one a phone's prompt offers. Walls, built-ins and furniture hide what's
// behind them; they're tested as boxes and outlines on the plan, not meshes,
// so looking costs little. A small prompt says what E, a tap or a click
// would do.
//
// What's open or on is each viewer's own and never saved.

const DEG = Math.PI / 180;
const REACH = 9;       // feet: E or a click at the crosshair
const AHEAD = 6;       // E with nothing at the crosshair: the nearest thing this close, ahead
const NEAR = 7.5;      // what a phone's prompt offers, this close
const SLACK = 0.25;    // how far inside an occluder a thing may sit (a counter's lip over a door)
const LOOK_MS = 110;   // the prompt looks again at most this often (about 9 times a second)
const CLOSED = new Set(['pocket', 'barn', 'bifold', 'closet-slider']);  // doors that don't open here: always shut
const CENTER = new THREE.Vector2(0, 0);

// Short names for the prompt, by catalog type.
const NOUNS = {
  lamp: 'floor lamp', 'table-lamp': 'lamp', sconce: 'sconce', pendant: 'pendant light',
  'tvstand-tv': 'TV', 'wall-tv': 'TV', laptop: 'laptop', curtains: 'curtains', blinds: 'blinds',
  'ceiling-fan': 'ceiling fan', microwave: 'microwave',
};
// 'Primary Bedroom door' reads 'the primary bedroom door'; 'TV' stays 'TV'.
const lower = (s) => s.replace(/\b[A-Z][a-z]+\b/g, (w) => w.toLowerCase());
function nounOf(item) {
  const def = catalogByType[item.type];
  if (item.name && item.name !== def?.name) return lower(item.name);
  return NOUNS[item.type] ?? lower(def?.name ?? 'light');
}

// Moves v toward `to`: quick at first, easing in at the end (k per second of
// what's left, never slower than `min` per second).
function approach(v, to, dt, k = 5, min = 1 / 3) {
  const d = to - v, s = Math.max(min, Math.abs(d) * k) * dt;
  return Math.abs(d) <= s ? to : v + Math.sign(d) * s;
}

// The key an object belongs to, from it or a parent.
function keyOf(o) {
  for (; o; o = o.parent) if (o.userData.useKey) return o.userData.useKey;
  return null;
}
// On screen: it and every parent visible, and not a piece's selection outline.
function shown(o) {
  for (; o; o = o.parent) if (!o.visible || o.name === 'selection') return false;
  return true;
}
// A thing on screen: any of its objects (or, for unseen click boxes, their parents).
const showing = (e) => e.objects.some((o) => (e.box ? shown(o.parent) : shown(o)));

// Where a ray (origin o, unit direction d) first enters a prism, a convex
// outline on the plan from y0 to y1; Infinity if it misses or starts inside.
function enter(o, d, poly, y0, y1) {
  let t0 = 0, t1 = Infinity, entered = false;
  if (Math.abs(d.y) < 1e-9) { if (o.y < y0 || o.y > y1) return Infinity; } else {
    const a = (y0 - o.y) / d.y, b = (y1 - o.y) / d.y;
    if (Math.min(a, b) > 0) { t0 = Math.min(a, b); entered = true; }
    t1 = Math.max(a, b);
    if (t1 < t0) return Infinity;
  }
  // Each edge keeps the ray on the outline's side of it (the side its middle is on).
  let cx = 0, cz = 0;
  for (const p of poly) { cx += p[0]; cz += p[1]; }
  cx /= poly.length; cz /= poly.length;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    let nx = q[1] - p[1], nz = p[0] - q[0];
    if ((cx - p[0]) * nx + (cz - p[1]) * nz > 0) { nx = -nx; nz = -nz; }
    const s = (o.x - p[0]) * nx + (o.z - p[1]) * nz, den = d.x * nx + d.z * nz;
    if (Math.abs(den) < 1e-12) { if (s > 0) return Infinity; continue; }
    const t = -s / den;
    if (den < 0) { if (t > t0) { t0 = t; entered = true; } } else t1 = Math.min(t1, t);
    if (t1 < t0) return Infinity;
  }
  return entered ? t0 : Infinity;
}

export class Interactions {
  // canvas, stage: the 3D view; prompt: the element that says what using would
  // do; view(): { mode, camera, locked, coarse, busy, clipY, cover() -> { top,
  // bottom } }; pieces(): { items, assets } of the furniture on screen, or null.
  constructor({ canvas, stage, prompt, invalidate, view, pieces }) {
    Object.assign(this, { canvas, stage, prompt, invalidate, view, pieces });
    this.entries = new Map();
    this.onLight = null;       // (uid, on): switch a lamp (main.js: lighting.setLamp)
    this.isLightOn = null;     // (uid) => is that lamp on
    this.tapped = false;       // a tap just used something; the views' own tap handlers skip it
    this.pressing = null;      // a press on a thing that may become a tap (Walk doesn't grab the mouse for it)
    this.U = null;
    this.walls = [];           // occluders: { poly, y0, y1 }
    this.solids = [];          // built-ins' parts: { poly, y0, y1, fixture }
    this.kept = new Map();     // pieces' states while they're rebuilt
    this.ray = new THREE.Raycaster();
    this.pointer = null;       // the mouse over the view: { x, y, down }
    this.shown = { entry: null, how: null, text: '', w: 0, h: 0 };
    this.dirty = true;
    this.last = -Infinity;
    this.seen = new Float64Array(19);  // the camera last looked at: its matrix and projection
    this.moveIt = false;               // the prompt must be placed again (new text, the mouse moved)
    this.flags = '';
    this.#bindPointer();
    prompt.addEventListener('click', () => {
      if (this.shown.how === 'tap' && this.shown.entry) this.use(this.shown.entry.key);
    });
  }

  // ---------------------------------------------------------------- registry
  add(entry) {
    this.remove(entry.key);
    for (const o of entry.objects) o.userData.useKey = entry.key;
    this.entries.set(entry.key, entry);
    this.dirty = true;
    return entry;
  }

  remove(key) {
    const e = this.entries.get(key);
    if (!e) return;
    for (const o of e.objects) if (o.userData.useKey === key) delete o.userData.useKey;
    this.entries.delete(key);
    if (this.shown.entry === e) this.shown.entry = null;
    this.dirty = true;
  }

  removeAll(prefix) {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.remove(key);
  }

  get(key) { return this.entries.get(key) ?? null; }

  // A new unit: its hinged doors (from buildArchitecture), its fixtures'
  // movers (buildFixtures), and what hides things: walls, doors that slide or
  // fold, built-ins.
  setUnit(U, { doors = [], movers = [] } = {}) {
    this.U = U;
    this.removeAll('door:');
    this.removeAll('fix:');
    this.walls = [];
    for (const { rect: [x0, z0, x1, z1], solid } of U.wallBoxes ?? []) {
      for (const [y0, y1] of solid) this.walls.push({ poly: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], y0, y1 });
    }
    for (const o of U.openings ?? []) if (CLOSED.has(o.type) && o.poly) this.walls.push({ poly: o.poly, y0: 0, y1: o.head });
    this.solids = [];
    for (const f of U.fixtures ?? []) {
      const ceiling = U.roomById?.[f.room]?.ceiling ?? U.heights?.ceiling ?? 9;
      try { for (const p of fixtureParts(f, ceiling)) this.solids.push({ ...p, fixture: f.id }); } catch { /* an odd fixture hides nothing */ }
    }
    for (const d of doors) this.#addDoor(d);
    for (const m of movers) this.#addMover(m);
  }

  // A hinged door is where its doorway is, at handle height, open or shut.
  #addDoor(d) {
    const noun = lower(d.name || 'door'), o = this.U.openings?.find((q) => q.id === d.id);
    const at = o ? [o.x, Math.min(3.2, o.head / 2), o.z] : new THREE.Box3().setFromObject(d.pivot).getCenter(new THREE.Vector3()).toArray();
    this.add({
      key: `door:${d.id}`, kind: 'door', name: noun, objects: [d.pivot],
      pos: () => at,
      label: () => `${d.target > 10 ? 'Close' : 'Open'} the ${noun}`,
      use: () => { d.target = d.target > 10 ? 0 : d.openTo; },
      set: (open) => { d.target = open ? d.openTo : 0; },
      step: (dt) => {
        const diff = d.target - d.angle;
        if (Math.abs(diff) < 0.05) return false;
        d.angle += Math.sign(diff) * Math.min(Math.abs(diff), Math.max(30, Math.abs(diff) * 5) * dt);
        d.apply();
        return true;
      },
    });
  }

  // A fixture's door or drawer (C2): { key, fixture, name, objects, pos, normal, open, setOpen }.
  #addMover(m) {
    let to = m.open;
    this.add({
      key: m.key, kind: 'fixture', name: m.name, objects: m.objects, fixture: m.fixture,
      normal: m.normal ? new THREE.Vector3(...m.normal) : null,
      pos: () => m.pos,
      label: () => `${to > 0.5 ? 'Close' : 'Open'} the ${m.name}`,
      use: () => { to = to > 0.5 ? 0 : 1; },
      set: (open) => { to = open ? 1 : 0; },
      step: (dt) => {
        if (m.open === to) return false;
        m.setOpen(approach(m.open, to, dt));
        return true;
      },
    });
  }

  // A placed piece's model (C1), from the furniture editor's onMount. Pieces
  // with nothing to use, or whose builder has no states, are left out.
  addPiece(item, g) {
    const act = g?.userData?.act, set = g?.userData?.setState, uid = item.uid;
    this.remove(`piece:${uid}`);
    if (!act || typeof set !== 'function') return;
    const noun = nounOf(item), kept = this.kept.get(uid);
    this.kept.delete(uid);
    g.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(g), cy = (b.min.y + b.max.y) / 2 - g.position.y;
    const base = {
      key: `piece:${uid}`, kind: 'piece', act, uid, name: noun, objects: [g],
      pos: () => [g.position.x, g.position.y + cy, g.position.z],
    };
    if (act === 'light') {
      let on = !!g.userData.state;
      const lit = () => (this.isLightOn ? !!this.isLightOn(uid) : on);
      const flip = (v) => { on = v; if (this.onLight) this.onLight(uid, v); else set(v); };
      if (kept != null && kept !== lit()) flip(kept);
      this.add({ ...base, state: lit, label: () => `Turn ${lit() ? 'off' : 'on'} the ${noun}`, use: () => flip(!lit()) });
      return;
    }
    if (act === 'screen' || act === 'fan') {
      let on = !!(kept ?? g.userData.state);
      if (kept != null) set(on);
      this.add({
        ...base, state: () => on,
        label: () => `Turn ${on ? 'off' : 'on'} the ${noun}`,
        use: () => { on = !on; set(on); },
        // A fan turns while it's on (and may slow down after).
        step: act === 'fan' ? (dt) => shown(g) && !!g.userData.tick?.(dt) : undefined,
      });
      return;
    }
    // Curtains and blinds (1 open), a microwave's door (1 open): they move there.
    let v = Number(kept ?? g.userData.state ?? (act === 'curtain' ? 1 : 0)) || 0, to = v;
    if (kept != null) set(v);
    const slow = act === 'curtain';
    this.add({
      ...base, state: () => to,
      label: () => `${to > 0.5 ? 'Close' : 'Open'} the ${noun}`,
      use: () => { to = to > 0.5 ? 0 : 1; },
      step: (dt) => {
        if (v === to) return false;
        v = slow ? approach(v, to, dt, 2.5, 0.2) : approach(v, to, dt);
        set(v);
        return true;
      },
    });
  }

  // From the furniture editor's onUnmount: its state is kept, for when it's
  // rebuilt (a new color or size) a moment later.
  removePiece(uid) {
    const e = this.entries.get(`piece:${uid}`);
    if (!e) return;
    this.kept.set(uid, e.state());
    this.remove(e.key);
  }

  // Room light switches (C3): [{ room, name, objects, pos }], and `lights`
  // with isRoomOn(room) and toggleRoom(room). Replaces the switches there were.
  // Their objects may be unseen boxes to click (only their parents need show),
  // facing out of the wall: they're used from the room's side.
  setSwitches(list, lights) {
    this.removeAll('switch:');
    (list ?? []).forEach((sw, i) => {
      const noun = /light/i.test(sw.name ?? '') ? lower(sw.name) : `${lower(sw.name ?? 'room')} lights`;
      const o = sw.objects?.[0];
      o?.updateWorldMatrix(true, false);
      this.add({
        key: `switch:${sw.room}:${i}`, kind: 'switch', name: noun, objects: sw.objects ?? [], box: true,
        normal: o ? new THREE.Vector3().setFromMatrixColumn(o.matrixWorld, 2).normalize() : null,
        pos: () => sw.pos,
        label: () => `Turn ${lights.isRoomOn(sw.room) ? 'off' : 'on'} the ${noun}`,
        use: () => lights.toggleRoom(sw.room),
      });
    });
  }

  // Lamps switch through the lighting (src/lighting.js), and its switches
  // join the things you can use. Call again after lighting.setUnit().
  connectLighting(lighting) {
    this.onLight = (uid, on) => lighting.setLamp(uid, on);
    this.isLightOn = (uid) => lighting.isLampOn(uid);
    this.setSwitches(lighting.switches, lighting);
  }

  // ---------------------------------------------------------------- using
  use(key) {
    const e = this.entries.get(key);
    if (!e) return false;
    e.use();
    this.dirty = true;
    this.invalidate();
    return true;
  }

  // Open (or shut) every entry whose key starts with prefix: 'door:' for Open all.
  setAll(prefix, open) {
    for (const [key, e] of this.entries) if (key.startsWith(prefix)) e.set?.(open);
    this.dirty = true;
    this.invalidate();
  }

  // Moves everything a frame toward where it's going; true if anything moved.
  step(dt) {
    let moved = false;
    for (const e of this.entries.values()) if (e.step?.(dt)) moved = true;
    return moved;
  }

  // ---------------------------------------------------------------- looking
  // What a hit on the unit's meshes belongs to: a thing's own shape, or a
  // hinged door's frame, casing or the wall within 6" of it, so a tap needn't
  // land on the slab.
  keyAt(h) {
    if (!h) return null;
    const key = keyOf(h.object);
    if (key && this.entries.has(key)) return key;
    if (h.object.userData.doorId) return this.entries.has(`door:${h.object.userData.doorId}`) ? `door:${h.object.userData.doorId}` : null;
    if (h.face && Math.abs(h.face.normal.y) > 0.5) return null;
    const p = h.point;
    for (const o of this.U?.openings ?? []) {
      if (!this.entries.has(`door:${o.id}`)) continue;
      const dx = p.x - o.p[0], dz = p.z - o.p[1];
      const s = dx * o.u[0] + dz * o.u[1], t = dx * o.n[0] + dz * o.n[1];
      if (s > o.a - 0.5 && s < o.b + 0.5 && t > -0.4 && t < o.t1 + 0.4 && p.y < o.head + 0.5) return `door:${o.id}`;
    }
    return null;
  }

  // The thing at a point on the screen, or null.
  at(clientX, clientY) {
    const v = this.view(), r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), v.camera);
    return this.#first(v);
  }

  // Walk's crosshair: the thing in the middle of the view within reach, else
  // the nearest one ahead within reach. What E uses.
  aimed() {
    const v = this.view();
    if (v.mode !== 'walk') return null;
    this.ray.setFromCamera(CENTER, v.camera);
    const hit = this.#first(v, REACH);
    if (hit) return hit;
    const eye = v.camera.getWorldPosition(new THREE.Vector3()), fwd = v.camera.getWorldDirection(new THREE.Vector3());
    const f = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / f, fz = fwd.z / f;
    // Nearest first, and what's straight ahead before what's to the side
    // (a doorway you face before the switch beside it): 20° counts as a foot.
    let best = null, bestScore = Infinity;
    for (const e of this.entries.values()) {
      const [x, y, z] = e.pos(), dx = x - eye.x, dz = z - eye.z, d = Math.hypot(dx, dz);
      const off = d > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / d))) / DEG : 0;
      const score = d + (d > 1.5 ? off / 20 : 0);
      if (d > AHEAD || score >= bestScore || (d > 1.5 && off > 55)) continue;
      if (!showing(e) || !this.#seen(eye, new THREE.Vector3(x, y, z), e, v)) continue;
      best = e; bestScore = score;
    }
    return best;
  }

  // What a phone's prompt offers in Walk: the thing within reach nearest the
  // middle of the view.
  near() {
    const v = this.view();
    if (v.mode !== 'walk') return null;
    const cam = v.camera, eye = cam.getWorldPosition(new THREE.Vector3()), fwd = cam.getWorldDirection(new THREE.Vector3());
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    let best = null, bestScore = Infinity;
    for (const e of this.entries.values()) {
      p.fromArray(e.pos());
      const d = p.distanceTo(eye);
      if (d > NEAR || d < 0.2) continue;
      s.copy(p).project(cam);
      if (Math.abs(s.x) > 0.8 || Math.abs(s.y) > 0.8 || s.z > 1) continue;
      const score = Math.acos(Math.max(-1, Math.min(1, p.clone().sub(eye).normalize().dot(fwd)))) / DEG + d * 2;
      if (score >= bestScore || !showing(e) || !this.#seen(eye, p, e, v)) continue;
      best = e; bestScore = score;
    }
    return best;
  }

  // The first thing the ray meets (within reach), unless something hides it.
  // A fixture's doors and drawers are used from in front of them only, not
  // through its back or its counter.
  #first(v, reach = Infinity) {
    const targets = [];
    for (const e of this.entries.values()) for (const o of e.objects) if (e.box ? shown(o.parent) : shown(o)) targets.push(o);
    for (const h of this.ray.intersectObjects(targets, true)) {
      if (h.distance > reach) return null;
      const e = this.entries.get(keyOf(h.object));
      if (!e || h.point.y > v.clipY || (!e.box && !shown(h.object))) continue;
      if (e.normal && this.ray.ray.direction.dot(e.normal) > -0.1) continue;
      return this.#hidden(this.ray.ray.origin, this.ray.ray.direction, h.distance, e, v) ? null : e;
    }
    return null;
  }

  // Can the eye see the point p of thing e?
  #seen(eye, p, e, v) {
    const dir = p.clone().sub(eye), d = dir.length();
    dir.divideScalar(d || 1);
    if (e.normal && dir.dot(e.normal) > -0.1) return false;
    return p.y <= v.clipY && !this.#hidden(eye, dir, d, e, v);
  }

  // Does a wall, built-in or piece stand in front of thing e, `dist` along the ray?
  #hidden(o, d, dist, e, v) {
    const limit = dist - SLACK;
    if (limit <= 0) return false;
    const clip = v.clipY ?? Infinity;
    const hides = (p) => p.y0 < clip && enter(o, d, p.poly, p.y0, Math.min(p.y1, clip)) < limit;
    if (this.walls.some(hides)) return true;
    if (this.solids.some((p) => p.fixture !== e.fixture && hides(p))) return true;
    const f = this.pieces?.();
    if (!f) return false;
    for (const item of f.items) {
      if (item.uid === e.uid) continue;
      let parts;
      try { parts = pieceParts(item, f.assets); } catch { continue; }
      if (parts.some(hides)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- the prompt
  // Every frame: the prompt follows the view, and looks again for what to
  // offer (at most every LOOK_MS) when the view, the mouse or a thing changed.
  update(now) {
    const v = this.view(), m = v.camera.matrixWorld.elements, pm = v.camera.projectionMatrix.elements;
    let moved = false;
    for (let i = 0; i < 16; i++) if (this.seen[i] !== m[i]) { moved = true; this.seen[i] = m[i]; }
    for (const [i, x] of [[16, pm[0]], [17, pm[5]], [18, pm[9]]]) if (this.seen[i] !== x) { moved = true; this.seen[i] = x; }
    const flags = `${v.mode}|${v.locked}|${v.busy}|${v.coarse}|${v.clipY}`;
    if (moved || flags !== this.flags) this.dirty = true;
    this.flags = flags;
    if (this.dirty && now - this.last >= LOOK_MS) {
      this.dirty = false;
      this.last = now;
      this.#choose(v);
    }
    if (moved || this.moveIt) this.#place(v);
    this.moveIt = false;
  }

  #choose(v) {
    let entry = null, how = null;
    if (!v.busy && this.U && !this.U.empty) {
      if (v.mode === 'walk' && v.locked) { entry = this.aimed(); how = 'key'; }
      else if (v.coarse) { if (v.mode === 'walk') { entry = this.near(); how = 'tap'; } }
      else if (this.pointer && !this.pointer.down && !v.locked) { entry = this.at(this.pointer.x, this.pointer.y); how = 'hover'; }
    }
    this.#show(entry, how);
  }

  #show(entry, how) {
    const el = this.prompt, s = this.shown;
    const label = entry?.label() ?? '';
    const text = !entry ? '' : how === 'tap' ? `Tap to ${lower(label)}` : label;
    this.stage.classList.toggle('can-use', how === 'hover' && !!entry);
    if (s.entry === entry && s.how === how && s.text === text) return;
    Object.assign(s, { entry, how, text });
    el.hidden = !entry;
    if (!entry) return;
    el.className = `use-prompt ${how}`;
    el.tabIndex = how === 'tap' ? 0 : -1;
    el.textContent = '';
    if (how === 'key') { const k = document.createElement('kbd'); k.textContent = 'E'; el.append(k); }
    el.append(text);
    s.w = el.offsetWidth;
    s.h = el.offsetHeight;
    this.moveIt = true;
  }

  // Where the prompt sits: under the crosshair, on the thing (a phone's), or
  // beside the mouse.
  #place(v) {
    const s = this.shown;
    if (!s.entry) return;
    const W = this.stage.clientWidth, H = this.stage.clientHeight, r = this.stage.getBoundingClientRect();
    const c = v.cover?.() ?? {}, top = (c.top ?? 0) + 8, bottom = H - (c.bottom ?? 0) - 8;
    let x, y;
    if (s.how === 'key') { x = W / 2 - s.w / 2; y = H / 2 + 20; }
    else if (s.how === 'hover') {
      if (!this.pointer) return;
      x = this.pointer.x - r.left + 14; y = this.pointer.y - r.top + 20;
      if (x + s.w > W - 8) x = this.pointer.x - r.left - 14 - s.w;
      if (y + s.h > bottom) y = this.pointer.y - r.top - 14 - s.h;
    } else {
      const p = new THREE.Vector3().fromArray(s.entry.pos()).project(v.camera);
      if (p.z > 1) { this.prompt.hidden = true; return; }
      this.prompt.hidden = false;
      x = ((p.x + 1) / 2) * W - s.w / 2; y = ((1 - p.y) / 2) * H - s.h / 2;
    }
    x = Math.max(8, Math.min(W - s.w - 8, x));
    y = Math.max(top, Math.min(bottom - s.h, y));
    this.prompt.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ---------------------------------------------------------------- pointer
  #bindPointer() {
    const el = this.canvas;
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.pointer = { x: e.clientX, y: e.clientY, down: e.buttons !== 0 };
      this.dirty = this.moveIt = true;
    });
    el.addEventListener('pointerleave', () => { this.pointer = null; this.dirty = true; });
    // Taps and clicks on things, in every view. In the capture phase and
    // added before the furniture editor's, so a tap on a lamp works for its
    // owner too (who also selects it); a drag still moves it, orbits or looks.
    let press = null;
    el.addEventListener('pointerdown', (e) => {
      press = null;
      if (e.pointerType === 'mouse' && this.pointer) { this.pointer.down = true; this.dirty = true; }
      if (e.button !== 0 || document.pointerLockElement === el || this.view().busy) { this.pressing = null; return; }
      const entry = this.at(e.clientX, e.clientY);
      if (entry) press = { key: entry.key, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
      this.pressing = press;
    }, { capture: true });
    const end = (e) => {
      if (e.pointerType === 'mouse' && this.pointer) { this.pointer.down = false; this.dirty = true; }
      if (!press || e.pointerId !== press.id) return;
      const p = press;
      press = this.pressing = null;
      if (e.type !== 'pointerup' || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 7 || performance.now() - p.t > 500) return;
      this.use(p.key);
      this.tapped = true;
      setTimeout(() => { this.tapped = false; });
    };
    el.addEventListener('pointerup', end, { capture: true });
    el.addEventListener('pointercancel', end, { capture: true });
  }
}
