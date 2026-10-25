import * as THREE from 'three';
import { CATALOG, catalogByType, SWATCHES, buildPiece, bounds, nearPiece, isFlat } from './furniture.js';
import { clearances, problems, blockersFor, trimRects, collides, pushOut, slideTo } from './fit.js';
import { cleanItem, randomId } from './design.js';
import { fmtLen, fmtSize, fmtRug, toInput, fromInput, inputUnit, getUnits } from './units.js';

// Furniture on screen: add pieces from the catalog (or the unit's own custom
// pieces), drag them into place, turn, resize and recolor them. While a piece
// is selected, lines show its clearance to the nearest wall, counter or other
// piece on each side, and the editor says what is wrong with where it sits.
// Every change goes out through onOps as pieces added, changed or removed; the
// unit session saves them. Units that aren't yours open read-only.
//
// `U` is the built unit (src/unit.js): walls and fixtures to keep clear of,
// and where the floor is. setUnit() swaps it when the unit is rebuilt.
//
// With "Pieces can't overlap" on (the default, kept per browser) a piece slides
// along whatever it meets and stops flush against walls, their trim, built-ins
// and other pieces; turning or resizing it into something pushes it clear, or
// is refused when there's no room. Arrow keys and the piece bar's nudge pad move
// it in small steps, in screen directions.

const snap = (v, step = 1 / 12) => Math.round(v / step) * step;
const COLLIDE_KEY = 'livingspace.collide.v1';
const CM = 1 / 30.48;
// Nudge steps (feet) and their labels, per display units.
const NUDGE = {
  imperial: [[1 / 48, '¼"'], [1 / 12, '1"'], [0.5, '6"']],
  cm: [[0.5 * CM, '0.5 cm'], [2 * CM, '2 cm'], [10 * CM, '10 cm']],
};
const nudgeSteps = () => NUDGE[getUnits() === 'cm' ? 'cm' : 'imperial'];
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class LayoutEditor {
  constructor(opts) {
    Object.assign(this, opts);
    this.U = opts.U ?? null;
    this.items = [];
    this.assets = {};
    this.groups = new Map();
    this.selected = null;
    this.enabled = true;
    this.readOnly = false;
    this.dragging = null;
    this.collide = true;
    try { this.collide = localStorage.getItem(COLLIDE_KEY) !== 'off'; } catch { /* default */ }
    this.nudging = false;
    this.nudgeStep = 1;
    this.ray = new THREE.Raycaster();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.guideGroup = new THREE.Group();
    this.scene.add(this.guideGroup);
    this.guides = [];
    this.layer = document.createElement('div');
    this.layer.className = 'edit-layer';
    this.stage.append(this.layer);
    this.#bindUI();
    this.#bindPointer();
    this.#bindKeys();
  }

  // ---------------------------------------------------------------- loading
  // A whole design, from the server or a fresh start. Emits nothing.
  load(doc, { readOnly = false } = {}) {
    for (const uid of [...this.groups.keys()]) this.#unmount(uid);
    this.readOnly = readOnly;
    this.assets = Object.fromEntries((doc.assets ?? []).map((a) => [a.id, a]));
    this.items = (doc.items ?? []).map((i) => cleanItem(i, this.assets)).filter(Boolean);
    this.items.forEach((i) => this.#mount(i));
    this.select(null);
    this.#renderCatalog();
    this.#renderList();
    this.invalidate();
  }

  // Someone else changed the design. Pieces with unsaved local changes, and the
  // one being dragged, keep what this screen has.
  applyRemote(doc, keep = new Set()) {
    const assetsChanged = JSON.stringify(doc.assets ?? []) !== JSON.stringify(Object.values(this.assets));
    this.assets = Object.fromEntries((doc.assets ?? []).map((a) => [a.id, a]));
    if (this.dragging) keep = new Set([...keep, this.dragging]);
    const remote = new Map((doc.items ?? []).map((i) => [i.uid, cleanItem(i, this.assets)]).filter(([, i]) => i));
    const next = [];
    for (const item of this.items) {
      if (keep.has(item.uid)) next.push(item);
      else if (remote.has(item.uid)) {
        const r = remote.get(item.uid);
        const changed = JSON.stringify(r) !== JSON.stringify(item);
        next.push(r);
        if (changed || (assetsChanged && r.type === 'asset')) this.#mount(r);
      } else this.#unmount(item.uid);
    }
    for (const [uid, r] of remote) if (!next.some((i) => i.uid === uid) && !keep.has(uid)) { next.push(r); this.#mount(r); }
    this.items = next;
    if (this.selected && !this.items.some((i) => i.uid === this.selected)) this.select(null);
    else this.#refreshSelection();
    if (assetsChanged) this.#renderCatalog();
    this.#renderList();
    this.invalidate();
  }

  doc() {
    return { items: this.items, assets: Object.values(this.assets) };
  }

  // A new or rebuilt unit: walls and fixtures moved, so guides and warnings change.
  setUnit(U) {
    this.U = U;
    this.#refreshSelection();
    this.invalidate();
  }

  // What clearances are measured to: walls, built-ins and the trim on the walls.
  obstacles() { return this.U ? [...this.U.obstacles, ...trimRects(this.U)] : []; }
  insideUnit(x, z) { return !!this.U?.insideUnit(x, z); }

  // The display units changed: every size on screen.
  refreshUnits() {
    this.#renderBaseCatalog();
    this.#renderCatalog();
    this.#renderList();
    this.#refreshSelection();
  }

  // ---------------------------------------------------------------- edits
  #emit(upsert = [], remove = []) {
    this.onOps?.({ upsert, remove });
    this.#renderList();
    this.invalidate();
  }

  add(type, at, assetId = null) {
    if (this.readOnly) return null;
    const asset = assetId ? this.assets[assetId] : null;
    const def = catalogByType[type];
    const size = asset ? { name: asset.name, w: asset.w / 12, d: asset.d / 12, h: asset.h / 12 } : { name: def.name, w: def.w / 12, d: def.d / 12, h: def.h / 12 };
    const item = { uid: randomId(8), type: asset ? 'asset' : type, ...(asset ? { asset: asset.id } : {}), ...size, x: 0, z: 0, rot: at?.rot ?? 0, color: null };
    const mid = this.#middle();
    const p = this.#freeSpot(item, at?.x ?? mid.x, at?.z ?? mid.z);
    item.x = p.x; item.z = p.z;
    this.items.push(item);
    this.#mount(item);
    this.select(item.uid);
    this.#emit([item]);
    return item;
  }

  remove(uid, { undoable = true } = {}) {
    if (this.readOnly) return;
    const i = this.items.findIndex((x) => x.uid === uid);
    if (i < 0) return;
    const [item] = this.items.splice(i, 1);
    this.#unmount(uid);
    if (this.selected === uid) this.select(null);
    this.#emit([], [uid]);
    if (undoable) this.toast(`Removed ${item.name}`, 'Undo', () => { this.items.push(item); this.#mount(item); this.select(item.uid); this.#emit([item]); });
  }

  duplicate(uid) {
    const src = this.items.find((x) => x.uid === uid);
    if (!src || this.readOnly) return;
    const copy = { ...src, uid: randomId(8) };
    const p = this.#freeSpot(copy, src.x + Math.min(2, src.w * 0.6), src.z + Math.min(2, src.d * 0.6));
    copy.x = p.x; copy.z = p.z;
    this.items.push(copy);
    this.#mount(copy);
    this.select(copy.uid);
    this.#emit([copy]);
  }

  update(uid, patch, { rebuild = true, what = null } = {}) {
    const item = this.items.find((x) => x.uid === uid);
    if (!item || this.readOnly) return;
    // A turn or a new size that runs into something pushes the piece clear.
    if (what) {
      patch = this.#fitChange(item, patch, what);
      if (!patch) { this.#renderEditor(); return; }
    }
    Object.assign(item, patch);
    item.rot = ((item.rot % 360) + 360) % 360;
    if (rebuild) this.#mount(item);
    else {
      const g = this.groups.get(uid);
      g.position.set(item.x, 0, item.z);
      g.rotation.y = -THREE.MathUtils.degToRad(item.rot);
    }
    this.#refreshSelection();
    this.#emit([item]);
  }

  // Quarter and 15° turns land on multiples of 15°; 1° turns are exact.
  rotate(uid, delta) {
    const item = this.items.find((x) => x.uid === uid);
    if (!item) return;
    const unit = Math.abs(delta) % 15 === 0 ? 15 : 1;
    this.update(uid, { rot: Math.round((item.rot + delta) / unit) * unit }, { rebuild: false, what: 'turn it' });
  }

  // Move the selected piece a step in a screen direction ('up' is away from you,
  // or up the screen in Plan), sliding along and stopping at whatever it meets.
  nudge(dir, step = nudgeSteps()[this.nudgeStep][0]) {
    const item = this.current;
    if (!item || this.readOnly) return;
    const [ax, az] = this.#screenAxis(dir === 'left' || dir === 'right' ? 'right' : 'up');
    const sgn = dir === 'left' || dir === 'down' ? -1 : 1;
    let x = item.x + ax * sgn * step, z = item.z + az * sgn * step;
    if (this.collide) ({ x, z } = slideTo(item, x, z, this.#blockers(item), this.assets));
    if (Math.hypot(x - item.x, z - item.z) < 1e-5) { this.#stopped(); return; }
    this.update(item.uid, { x: Math.round(x * 1e4) / 1e4, z: Math.round(z * 1e4) / 1e4 }, { rebuild: false });
  }

  setCollide(on) {
    this.collide = !!on;
    try { localStorage.setItem(COLLIDE_KEY, on ? 'on' : 'off'); } catch { /* this visit only */ }
    if (this.ui.collide) this.ui.collide.checked = this.collide;
  }

  clearAll() {
    if (this.readOnly || !this.items.length) return;
    const before = this.items.map((i) => ({ ...i }));
    const uids = this.items.map((i) => i.uid);
    for (const uid of uids) this.#unmount(uid);
    this.items = [];
    this.select(null);
    this.#emit([], uids);
    this.toast('Cleared the layout', 'Undo', () => {
      this.items = before;
      before.forEach((i) => this.#mount(i));
      this.#emit(before);
    });
  }

  select(uid) {
    this.selected = uid;
    this.#refreshSelection();
    this.onSelect?.(uid);
    this.invalidate();
  }

  get current() { return this.items.find((x) => x.uid === this.selected) ?? null; }

  // Walk-mode collision: is (x, z) within r of a standing piece?
  blocks(x, z, r) {
    return this.items.some((i) => !isFlat(i) && nearPiece(i, x, z, r));
  }

  // ---------------------------------------------------------------- scene
  #mount(item) {
    this.#unmount(item.uid);
    const g = buildPiece(this.M, item, this.assets);
    this.root.add(g);
    this.groups.set(item.uid, g);
    if (item.uid === this.selected) this.#refreshSelection();
    this.invalidate();
  }

  #unmount(uid) {
    const g = this.groups.get(uid);
    if (!g) return;
    this.root.remove(g);
    g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.groups.delete(uid);
  }

  // Outline on the selected piece, plus the clearance guides.
  #refreshSelection() {
    for (const g of this.groups.values()) {
      const old = g.getObjectByName('selection');
      if (old) { g.remove(old); old.traverse((o) => o.geometry?.dispose()); }
    }
    const item = this.current;
    const g = item && this.groups.get(item.uid);
    if (g) {
      const sel = new THREE.Group();
      sel.name = 'selection';
      const w = item.w, d = item.d, t = 0.07, y = 0.06;
      for (const [cx, cz, sx, sz] of [[0, -d / 2, w + t, t], [0, d / 2, w + t, t], [-w / 2, 0, t, d + t], [w / 2, 0, t, d + t]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.02, sz), this.accentMat);
        bar.position.set(cx, y, cz);
        sel.add(bar);
      }
      // A notch past the front edge shows which way the piece faces.
      const notch = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 3), this.accentMat);
      notch.position.set(0, y, d / 2 + 0.22);
      notch.rotation.y = Math.PI / 6;
      sel.add(notch);
      // The outline follows the piece's scale-free footprint even for scaled assets.
      sel.scale.set(1 / g.scale.x, 1, 1 / g.scale.z);
      sel.traverse((o) => { o.renderOrder = 35; o.userData.pieceId = item.uid; });
      g.add(sel);
    }
    this.#updateGuides();
    this.#renderEditor();
    this.#renderBar();
  }

  #updateGuides() {
    for (const m of this.guideGroup.children.splice(0)) m.geometry.dispose();
    this.guides.forEach((gd) => gd.el.remove());
    this.guides = [];
    const item = this.current;
    if (!item || !this.root.visible || this.readOnly) { this.invalidate(); return; }
    for (const c of clearances(item, this.items, this.obstacles())) {
      if (c.dist < 0.04) continue;
      const a = c.axis === 0 ? [c.edge, c.at] : [c.at, c.edge];
      const b = c.axis === 0 ? [c.edge + c.dist * c.sign, c.at] : [c.at, c.edge + c.dist * c.sign];
      const bar = new THREE.Mesh(new THREE.BoxGeometry(c.axis === 0 ? c.dist : 0.035, 0.01, c.axis === 0 ? 0.035 : c.dist), this.accentMat);
      bar.position.set((a[0] + b[0]) / 2, 0.08, (a[1] + b[1]) / 2);
      this.guideGroup.add(bar);
      for (const p of [a, b]) {
        const tick = new THREE.Mesh(new THREE.BoxGeometry(c.axis === 0 ? 0.035 : 0.3, 0.01, c.axis === 0 ? 0.3 : 0.035), this.accentMat);
        tick.position.set(p[0], 0.08, p[1]);
        this.guideGroup.add(tick);
      }
      const el = document.createElement('div');
      el.className = 'guide-label';
      el.textContent = fmtLen(c.dist);
      this.layer.append(el);
      this.guides.push({ el, x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2 });
    }
    this.guideGroup.children.forEach((m) => { m.renderOrder = 40; });
    this.invalidate();
  }

  // Place guide labels on screen; called after each render.
  updateOverlay(cam) {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    const v = new THREE.Vector3();
    for (const gd of this.guides) {
      v.set(gd.x, 0.1, gd.z).project(cam);
      gd.el.hidden = v.z > 1 || !this.root.visible;
      gd.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  }

  // ---------------------------------------------------------------- placing
  #blockers(item) { return this.U ? blockersFor(item, this.U, this.items, this.assets) : []; }

  #overlaps(item) {
    return collides(item, this.#blockers(item), this.assets);
  }

  // A change to a piece's turn or size: as is when it fits (or collisions are
  // off, or the piece already overlapped something), pushed a little to fit,
  // or null with a note when there's no room.
  #fitChange(item, patch, what) {
    if (!this.collide || !this.U) return patch;
    if (collides(item, this.#blockers(item), this.assets)) return patch;
    const test = { ...item, ...patch };
    const shapes = this.#blockers(test);
    if (!collides(test, shapes, this.assets)) return patch;
    // Far enough to turn a long piece around beside a wall: half its length.
    const p = pushOut(test, shapes, Math.max(0.75, Math.max(test.w, test.d) / 2 + 0.25), this.assets);
    if (p) return { ...patch, x: Math.round(p.x * 1e4) / 1e4, z: Math.round(p.z * 1e4) / 1e4 };
    this.toast(`No room to ${what} here. Move it into the open first, or turn off "Pieces can't overlap".`);
    return null;
  }

  #stopped() {
    const now = performance.now();
    if (now - (this.stoppedAt ?? 0) > 2500) this.toast('It\'s up against something on that side.');
    this.stoppedAt = now;
  }

  // The plan axis nearest a screen direction: 'right', or 'up' (away from the
  // viewer in Dollhouse and Walk, up the screen in Plan).
  #screenAxis(which) {
    const cam = this.getCamera();
    const v = new THREE.Vector3(which === 'right' ? 1 : 0, 0, which === 'right' ? 0 : -1).applyQuaternion(cam.quaternion);
    if (which === 'up' && Math.hypot(v.x, v.z) < 0.3) v.set(0, 1, 0).applyQuaternion(cam.quaternion);
    return Math.abs(v.x) >= Math.abs(v.z) ? [Math.sign(v.x), 0] : [0, Math.sign(v.z)];
  }

  // Nearest spot to (x, z) inside the unit where the piece doesn't hit anything.
  #freeSpot(item, x, z) {
    const test = { ...item };
    for (let r = 0; r <= 8; r += 0.5) {
      const steps = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 0.75);
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        test.x = snap(x + Math.cos(a) * r); test.z = snap(z + Math.sin(a) * r);
        if (this.insideUnit(test.x, test.z) && !this.#overlaps(test)) return { x: test.x, z: test.z };
      }
    }
    return { x: snap(x), z: snap(z) };
  }

  // Slide flush against a wall or counter when it is within 4".
  #snapToWalls(item) {
    if (item.rot % 90 !== 0) return;
    for (const c of clearances(item, this.items, this.obstacles())) {
      if (c.dist > 0.001 && c.dist < 0.34) {
        if (c.axis === 0) item.x += c.dist * c.sign; else item.z += c.dist * c.sign;
      }
    }
  }

  #middle() {
    const b = this.U?.bounds ?? { x0: 0, z0: 0, x1: 30, z1: 20 };
    return { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
  }

  // Where a new piece goes: the floor point in the middle of the view, or the
  // middle of the unit.
  dropPoint() {
    const cam = this.getCamera();
    if (this.getMode() === 'walk') {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      dir.y = 0; dir.normalize();
      const yaw = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
      return { x: cam.position.x + dir.x * 4.5, z: cam.position.z + dir.z * 4.5, rot: Math.round(yaw / 90) * 90 };
    }
    this.ray.setFromCamera(new THREE.Vector2(0, 0), cam);
    const p = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(this.floorPlane, p) && this.insideUnit(p.x, p.z)) return { x: p.x, z: p.z, rot: 0 };
    return { ...this.#middle(), rot: 0 };
  }

  // ---------------------------------------------------------------- pointer
  #aim(e) {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.getCamera());
  }

  #pick(e) {
    if (!this.root.visible || !this.items.length) return null;
    this.#aim(e);
    const hit = this.ray.intersectObjects([this.root, ...this.occluders()], true)[0];
    return hit?.object.userData.pieceId ?? null;
  }

  #floorAt(e) {
    this.#aim(e);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.floorPlane, p) ? p : null;
  }

  #bindPointer() {
    const el = this.canvas;
    let drag = null;
    let empty = null;
    // Capture phase, so a press on a piece never reaches the camera controls.
    el.addEventListener('pointerdown', (e) => {
      // With the cursor locked in Walk, clicks belong to the crosshair.
      if (!this.enabled || drag || document.pointerLockElement === el) return;
      const uid = this.#pick(e);
      if (uid == null) {
        empty = { x: e.clientX, y: e.clientY, id: e.pointerId };
        return;
      }
      if (this.selected !== uid) this.select(uid);
      if (this.readOnly) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const item = this.current;
      const p = this.#floorAt(e);
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, ox: p ? item.x - p.x : 0, oz: p ? item.z - p.z : 0, blockers: this.collide ? this.#blockers(item) : null };
      this.dragging = uid;
      el.setPointerCapture(e.pointerId);
    }, { capture: true });

    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopImmediatePropagation();
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      drag.moved = true;
      const p = this.#floorAt(e);
      const item = this.current;
      if (!p || !item) return;
      // Alt (Option) while dragging: a ¼" grid instead of 1".
      const grid = e.altKey ? 1 / 48 : 1 / 12;
      const tx = snap(p.x + drag.ox, grid), tz = snap(p.z + drag.oz, grid);
      let next;
      if (drag.blockers) next = { ...item, ...slideTo(item, tx, tz, drag.blockers, this.assets) };
      else {
        next = { ...item, x: tx, z: tz };
        if (!this.insideUnit(next.x, next.z)) return;
      }
      const before = { x: next.x, z: next.z };
      this.#snapToWalls(next);
      if (drag.blockers && collides(next, drag.blockers, this.assets)) Object.assign(next, before);
      item.x = next.x; item.z = next.z;
      this.groups.get(item.uid).position.set(item.x, 0, item.z);
      this.#updateGuides();
      this.#renderBar();
    }, { capture: true });

    const end = (e) => {
      if (drag && e.pointerId === drag.id) {
        e.stopImmediatePropagation();
        if (drag.moved && this.current) { this.#emit([this.current]); this.#renderEditor(); }
        drag = null;
        this.dragging = null;
        return;
      }
      // A tap on empty space clears the selection.
      if (empty && e.pointerId === empty.id) {
        if (Math.hypot(e.clientX - empty.x, e.clientY - empty.y) < 6 && this.selected != null && e.type === 'pointerup') this.select(null);
        empty = null;
      }
    };
    el.addEventListener('pointerup', end, { capture: true });
    el.addEventListener('pointercancel', end, { capture: true });
  }

  #bindKeys() {
    addEventListener('keydown', (e) => {
      const item = this.current;
      if (!item || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Escape') { this.select(null); e.preventDefault(); return; }
      if (this.readOnly) return;
      const walk = this.getMode() === 'walk';
      // Arrows nudge 1" (1 cm), Alt the finest step, Shift a foot; in screen directions.
      const fine = nudgeSteps()[0][0], step = e.shiftKey ? 1 : e.altKey ? fine : getUnits() === 'cm' ? CM : 1 / 12;
      const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      const turn = e.altKey ? 1 : 15;
      if (e.key === 'Delete' || e.key === 'Backspace') this.remove(item.uid);
      else if (e.key === 'r' || e.key === 'R') this.rotate(item.uid, e.shiftKey ? -90 : 90);
      else if (e.code === 'BracketRight') this.rotate(item.uid, turn);
      else if (e.code === 'BracketLeft') this.rotate(item.uid, -turn);
      else if (dirs[e.key] && !walk) this.nudge(dirs[e.key], step);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true });
  }

  // ---------------------------------------------------------------- UI
  #bindUI() {
    const $ = (s) => document.querySelector(s);
    this.ui = {
      catalog: $('#catalog'), mine: $('#assetList'), mineGroup: $('#assetGroup'), list: $('#layoutList'), empty: $('#layoutEmpty'), editor: $('#pieceEditor'),
      name: $('#peName'), w: $('#peW'), d: $('#peD'), h: $('#peH'), rot: $('#peRot'), swatches: $('#peSwatches'), warn: $('#peWarn'),
      bar: $('#pieceBar'), barName: $('#pbName'), barDims: $('#pbDims'), barWarn: $('#pbWarn'), toast: $('#toast'), count: $('#furnitureCount'),
      suffixes: [...document.querySelectorAll('[data-len-unit]')],
    };
    this.#renderBaseCatalog();
    const addFrom = (e) => {
      const b = e.target.closest('[data-type], [data-asset]');
      if (!b) return;
      this.add(b.dataset.type ?? 'asset', this.dropPoint(), b.dataset.asset ?? null);
      this.onAdded?.();
    };
    this.ui.catalog.addEventListener('click', addFrom);
    this.ui.mine.addEventListener('click', addFrom);
    this.ui.swatches.innerHTML = SWATCHES.map((s) =>
      `<button class="swatch" data-color="${s.key ?? ''}" aria-label="${s.name}" title="${s.name}" style="background:${s.css ?? '#' + s.hex.toString(16).padStart(6, '0')}"></button>`).join('');
    this.ui.swatches.addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (b && this.current) this.update(this.current.uid, { color: b.dataset.color || null });
    });
    const dim = (input, key) => input.addEventListener('change', () => {
      const ft = fromInput(input.value);
      if (!this.current || ft === null || ft <= 0) return this.#renderEditor();
      this.update(this.current.uid, { [key]: Math.max(1 / 12, Math.min(key === 'h' ? 9 : 30, ft)) }, { what: 'make it that size' });
    });
    dim(this.ui.w, 'w'); dim(this.ui.d, 'd'); dim(this.ui.h, 'h');
    this.ui.rot.addEventListener('change', () => {
      const v = parseFloat(this.ui.rot.value);
      if (this.current && Number.isFinite(v)) this.update(this.current.uid, { rot: v }, { rebuild: false, what: 'turn it' });
    });
    this.ui.collide = $('#optCollide');
    if (this.ui.collide) {
      this.ui.collide.checked = this.collide;
      this.ui.collide.addEventListener('change', () => this.setCollide(this.ui.collide.checked));
    }
    this.ui.name.addEventListener('change', () => {
      const c = this.current;
      if (c) this.update(c.uid, { name: this.ui.name.value.trim().slice(0, 40) || (c.type === 'asset' ? this.assets[c.asset]?.name : catalogByType[c.type].name) || 'Piece' }, { rebuild: false });
    });
    $('#peDup').addEventListener('click', () => this.current && this.duplicate(this.current.uid));
    $('#peDel').addEventListener('click', () => this.current && this.remove(this.current.uid));
    this.ui.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-piece]');
      if (b) { this.select(b.dataset.piece); this.onFocusPiece?.(this.current); }
    });
    this.ui.bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      const item = this.current;
      if (!b || !item) return;
      ({
        ccw: () => this.rotate(item.uid, -90),
        cw: () => this.rotate(item.uid, 90),
        edit: () => this.onEdit?.(),
        dup: () => this.duplicate(item.uid),
        del: () => this.remove(item.uid),
        done: () => this.select(null),
        nudge: () => { this.nudging = !this.nudging; this.#renderBar(); },
        step: () => { this.nudgeStep = (this.nudgeStep + 1) % nudgeSteps().length; this.#renderBar(); },
      })[b.dataset.act]?.();
    });
    // The nudge pad acts on press and repeats while held.
    let hold = null;
    const stop = () => { if (hold) { clearTimeout(hold.t); clearInterval(hold.i); hold = null; } };
    this.ui.bar.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-nudge], [data-fine]');
      if (!b || !this.current) return;
      e.preventDefault();
      stop();
      const act = () => (b.dataset.nudge ? this.nudge(b.dataset.nudge) : this.rotate(this.current.uid, Number(b.dataset.fine)));
      act();
      hold = { t: setTimeout(() => { hold.i = setInterval(act, 90); }, 380) };
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) this.ui.bar.addEventListener(ev, stop);
    const clear = $('#clearLayout');
    clear.addEventListener('click', () => {
      if (!this.items.length || this.readOnly) return;
      if (clear.dataset.armed) {
        delete clear.dataset.armed;
        clear.textContent = 'Clear all';
        this.clearAll();
      } else {
        clear.dataset.armed = '1';
        clear.textContent = 'Tap again to clear';
        setTimeout(() => { delete clear.dataset.armed; clear.textContent = 'Clear all'; }, 3000);
      }
    });
  }

  #renderBaseCatalog() {
    const groups = [...new Set(CATALOG.map((c) => c.group))];
    this.ui.catalog.innerHTML = groups.map((g) => `<h3>${g}</h3><div class="catalog-grid">${CATALOG.filter((c) => c.group === g).map((c) =>
      `<button class="cat-btn" data-type="${c.type}"><b>${c.name}</b><small>${c.build === 'rug' ? fmtRug(c.w / 12, c.d / 12) : fmtSize(c.w / 12, c.d / 12)}</small></button>`).join('')}</div>`).join('');
  }

  // The unit's own custom pieces (made by an agent through MCP; sizes in inches).
  #renderCatalog() {
    const list = Object.values(this.assets);
    this.ui.mineGroup.hidden = !list.length;
    this.ui.mine.innerHTML = list.map((a) =>
      `<button class="cat-btn" data-asset="${escapeHTML(a.id)}"><b>${escapeHTML(a.name)}</b><small>${fmtSize(Math.round(a.w) / 12, Math.round(a.d) / 12)}</small></button>`).join('');
  }

  #renderList() {
    const { list, empty, count } = this.ui;
    empty.hidden = this.items.length > 0;
    count.textContent = this.items.length ? `${this.items.length}` : '';
    list.innerHTML = this.items.map((i) =>
      `<li><button class="piece-row" data-piece="${escapeHTML(i.uid)}" aria-current="${i.uid === this.selected}"><span>${escapeHTML(i.name)}</span><small>${fmtSize(i.w, i.d)}</small></button></li>`).join('');
  }

  #renderEditor() {
    const item = this.current, ui = this.ui;
    ui.editor.hidden = !item || this.readOnly;
    ui.list.querySelectorAll('[data-piece]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.piece === this.selected)));
    if (!item || this.readOnly) return;
    const cm = inputUnit() === 'cm';
    for (const input of [ui.w, ui.d, ui.h]) {
      input.step = cm ? '1' : '0.5';
      input.min = cm ? '3' : '1';
      input.max = cm ? (input === ui.h ? '274' : '914') : (input === ui.h ? '108' : '360');
    }
    ui.suffixes.forEach((el) => { el.textContent = inputUnit(); });
    if (document.activeElement !== ui.name) ui.name.value = item.name;
    if (document.activeElement !== ui.w) ui.w.value = toInput(item.w);
    if (document.activeElement !== ui.d) ui.d.value = toInput(item.d);
    if (document.activeElement !== ui.h) ui.h.value = toInput(item.h);
    if (document.activeElement !== ui.rot) ui.rot.value = String(Math.round(item.rot));
    ui.h.disabled = isFlat(item);
    ui.swatches.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.color || null) === item.color)));
    const issues = this.#problems(item);
    ui.warn.hidden = !issues.length;
    ui.warn.textContent = issues.length ? `This piece ${issues.join(', ')}.` : '';
  }

  // What is wrong with where a piece sits (src/fit.js), as short phrases.
  #problems(item) {
    if (!this.U || this.U.empty) return [];
    // Overlaps name the other piece's id for agents; people only need its name.
    return problems(item, this.items, this.U, this.assets).map((t) => t.replace(/ \([A-Za-z0-9_-]+\)$/, ''));
  }

  #renderBar() {
    const item = this.current, ui = this.ui;
    ui.bar.hidden = !item || !this.root.visible;
    ui.bar.classList.toggle('read-only', this.readOnly);
    if (!item || this.readOnly) this.nudging = false;
    ui.bar.classList.toggle('nudging', this.nudging);
    const stepBtn = ui.bar.querySelector('[data-act="step"]');
    if (stepBtn) stepBtn.textContent = nudgeSteps()[this.nudgeStep][1];
    if (!item) return;
    ui.barName.textContent = item.name;
    ui.barDims.textContent = fmtSize(item.w, item.d, item.h);
    if (!this.readOnly) ui.barDims.append(Object.assign(document.createElement('span'), { className: 'pb-rot', textContent: ` · ${Math.round(item.rot)}°` }));
    const issue = this.readOnly ? null : this.#problems(item)[0];
    ui.barWarn.hidden = !issue;
    ui.barWarn.textContent = issue ? issue[0].toUpperCase() + issue.slice(1) : '';
  }

  toast(text, action, onAction) {
    const t = this.ui.toast;
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    t.append(span);
    if (action) {
      const b = document.createElement('button');
      b.textContent = action;
      b.addEventListener('click', () => { t.hidden = true; onAction(); });
      t.append(b);
    }
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2500);
  }
}
