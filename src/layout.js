import * as THREE from 'three';
import { CATALOG, catalogByType, SWATCHES, buildPiece, nearPiece, isFlat } from './furniture.js';
import { KINDS, placeOf, actOf } from './catalog.js';
import { clearances, problems, blockersFor, trimRects, collides, pushOut, slideTo, slideOnWall, onFloor } from './fit.js';
import { descendants, carry, supportOf, surfacesAt, surfaceUnder, fitOnSurface, hangOnWall, wallProblem, walkThrough, ceilingAt, ceilingY, facing } from './stacking.js';
import { frontOf, rightOf } from './geometry.js';
import { cleanItem, randomId } from './design.js';
import { fmtLen, fmtSize, fmtRug, toInput, fromInput, inputUnit, getUnits } from './units.js';

// Furniture on screen: add pieces from the catalog (or the unit's own custom
// pieces), drag them into place, turn, resize and recolor them. While a piece
// is selected, lines show its clearance to the nearest wall, counter or other
// piece on each side, and the editor says what is wrong with where it sits.
// Every change goes out through onOps as pieces added, changed or removed; the
// unit session saves them. Units that aren't yours open read-only. onMount(item,
// group) and onUnmount(uid) tell the rest of the scene (lights, things you can
// switch or open) when a piece's 3D model comes and goes.
//
// `U` is the built unit (src/unit.js): walls and fixtures to keep clear of,
// and where the floor is. setUnit() swaps it when the unit is rebuilt.
//
// Pieces go where their kind goes (src/stacking.js): on the floor, on a top or
// shelf (a lamp on a table, books on a bookshelf, a coffee maker on the
// counter), on a wall (art, a mirror, a TV, curtains) or from the ceiling (a
// pendant, a fan). Dragged, a tabletop piece lands on whatever top is under
// the pointer, a wall piece slides along and up and down its wall and moves to
// another wall the pointer reaches, and moving a piece carries what rests on it.
//
// With "Pieces can't overlap" on (the default, kept per browser) a piece slides
// along whatever it meets and stops flush against walls, their trim, built-ins
// and other pieces; turning or resizing it into something pushes it clear, or
// is refused when there's no room. Arrow keys and the piece bar's nudge pad move
// it in small steps, in screen directions (a wall piece along its wall and up
// and down it).

const snap = (v, step = 1 / 12) => Math.round(v / step) * step;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const COLLIDE_KEY = 'livingspace.collide.v1';
const CM = 1 / 30.48;
// Nudge steps (feet) and their labels, per display units.
const NUDGE = {
  imperial: [[1 / 48, '¼"'], [1 / 12, '1"'], [0.5, '6"']],
  cm: [[0.5 * CM, '0.5 cm'], [2 * CM, '2 cm'], [10 * CM, '10 cm']],
};
const nudgeSteps = () => NUDGE[getUnits() === 'cm' ? 'cm' : 'imperial'];
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Pieces hung higher than this don't stop you walking (art, pendants, fans).
const WALK_UNDER = 4;
// A surface within this of the pointer's height counts as the one it points at.
const BOARD = 0.15;
// What the catalog says about where a piece goes, beside its size.
const PLACE_TAG = { surface: 'tabletop', wall: 'wall', ceiling: 'ceiling' };
// Furniture's own rooms in the catalog.
const ROOMS = ['Living', 'Dining', 'Bedroom', 'Other'];
const KITCHEN = /kitchen|counter|fridge|range|sink|dishwasher|pantry/;

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
    this.kind = 'furniture';
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
  // one being dragged with what rests on it, keep what this screen has.
  applyRemote(doc, keep = new Set()) {
    const assetsChanged = JSON.stringify(doc.assets ?? []) !== JSON.stringify(Object.values(this.assets));
    this.assets = Object.fromEntries((doc.assets ?? []).map((a) => [a.id, a]));
    if (this.dragging) keep = new Set([...keep, this.dragging, ...descendants(this.dragging, this.items).map((i) => i.uid)]);
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

  // A new piece where the view is looking (dropPoint()): a tabletop piece on
  // the top there, a wall piece on the wall there, a ceiling piece up top.
  add(type, at = null, assetId = null) {
    if (this.readOnly) return null;
    const asset = assetId ? this.assets[assetId] : null;
    const def = catalogByType[type];
    const size = asset ? { name: asset.name, w: asset.w / 12, d: asset.d / 12, h: asset.h / 12 } : { name: def.name, w: def.w / 12, d: def.d / 12, h: def.h / 12 };
    const item = { uid: randomId(8), type: asset ? 'asset' : type, ...(asset ? { asset: asset.id } : {}), ...size, x: 0, z: 0, rot: 0, color: null };
    this.#setDown(item, at ?? this.dropPoint());
    this.items.push(item);
    this.#mount(item);
    this.select(item.uid);
    this.#emit([item]);
    return item;
  }

  // Remove a piece, and what rests on it, with one Undo for all of them.
  remove(uid, { undoable = true } = {}) {
    if (this.readOnly) return;
    const item = this.items.find((x) => x.uid === uid);
    if (!item) return;
    const gone = [item, ...descendants(uid, this.items)];
    const uids = new Set(gone.map((i) => i.uid));
    this.items = this.items.filter((i) => !uids.has(i.uid));
    gone.forEach((i) => this.#unmount(i.uid));
    if (uids.has(this.selected)) this.select(null);
    this.#emit([], [...uids]);
    if (!undoable) return;
    const more = gone.length - 1;
    const text = more ? `Removed ${item.name} and ${more === 1 ? '1 thing' : `${more} things`} on it` : `Removed ${item.name}`;
    this.toast(text, 'Undo', () => {
      this.items.push(...gone);
      gone.forEach((i) => this.#mount(i));
      this.select(item.uid);
      this.#emit(gone);
    });
  }

  // A copy beside the piece (on the same top, along the same wall). Only the
  // piece: what rests on a table stays with the table.
  duplicate(uid) {
    const src = this.items.find((x) => x.uid === uid);
    if (!src || this.readOnly) return;
    const copy = { ...src, uid: randomId(8) };
    const hold = this.#holdOf(src);
    const edge = hold === 'wall' && this.#edgeOf(src);
    const s = hold === 'surface' && src.on && surfaceUnder(src, this.items, this.U, this.assets);
    if (edge) {
      const r = rightOf(src.rot), k = src.w + 1 / 6;
      Object.assign(copy, this.#hangAlong(copy, edge, src.x + r[0] * k, src.z + r[1] * k, src.y ?? 0) ?? {});
    } else if (s) {
      Object.assign(copy, this.#freeOnSurface({ ...copy, x: src.x + Math.min(1, src.w * 0.6), z: src.z }, s) ?? {});
    } else {
      const p = this.#freeSpot(copy, src.x + Math.min(2, src.w * 0.6), src.z + Math.min(2, src.d * 0.6));
      copy.x = p.x; copy.z = p.z;
      if (hold === 'ceiling') copy.y = ceilingY(copy, this.U);
    }
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
    const before = { ...item };
    Object.assign(item, patch);
    item.rot = ((item.rot % 360) + 360) % 360;
    tidy(item);
    if (rebuild) this.#mount(item);
    else this.#pose(item);
    const carried = this.#carry(before, item);
    this.#refreshSelection();
    this.#emit([item, ...carried]);
  }

  // Quarter and 15° turns land on multiples of 15°; 1° turns are exact. A wall
  // piece turns only with its wall.
  rotate(uid, delta) {
    const item = this.items.find((x) => x.uid === uid);
    if (!item || this.#holdOf(item) === 'wall') return;
    const unit = Math.abs(delta) % 15 === 0 ? 15 : 1;
    this.update(uid, { rot: Math.round((item.rot + delta) / unit) * unit }, { rebuild: false, what: 'turn it' });
  }

  // Move the selected piece a step in a screen direction ('up' is away from you,
  // or up the screen in Plan), sliding along and stopping at whatever it meets.
  // A piece on a top stays on it; a wall piece moves along its wall, and up
  // and down it.
  nudge(dir, step = nudgeSteps()[this.nudgeStep][0]) {
    const item = this.current;
    if (!item || this.readOnly) return;
    const hold = this.#holdOf(item);
    if (hold === 'wall' && this.#edgeOf(item)) { this.#nudgeWall(item, dir, step); return; }
    const [ax, az] = this.#screenAxis(dir === 'left' || dir === 'right' ? 'right' : 'up');
    const sgn = dir === 'left' || dir === 'down' ? -1 : 1;
    let x = item.x + ax * sgn * step, z = item.z + az * sgn * step;
    const s = item.on && hold === 'surface' && surfaceUnder(item, this.items, this.U, this.assets);
    if (s) ({ x, z } = fitOnSurface({ ...item, x, z }, s) ?? item);
    if (this.collide) ({ x, z } = slideTo(item, x, z, this.#blockers(item), this.assets));
    if (Math.hypot(x - item.x, z - item.z) < 1e-5) { this.#stopped(); return; }
    const patch = { x: r4(x), z: r4(z) };
    if (hold === 'ceiling') patch.y = ceilingY({ ...item, ...patch }, this.U);
    this.update(item.uid, patch, { rebuild: false });
  }

  // Along the wall (left and right as you look at it) or up and down it.
  #nudgeWall(item, dir, step) {
    const shapes = this.collide ? this.#blockers(item) : [];
    if (dir === 'up' || dir === 'down') {
      const y = this.#raise(item, (item.y ?? 0) + (dir === 'up' ? step : -step), shapes, Math.min(step, 1 / 48));
      if (Math.abs(y - (item.y ?? 0)) < 1e-5) { this.#stopped(); return; }
      this.update(item.uid, { y: r4(y) }, { rebuild: false });
      return;
    }
    const r = rightOf(item.rot);
    const cam = new THREE.Vector3(1, 0, 0).applyQuaternion(this.getCamera().quaternion);
    const k = cam.x * r[0] + cam.z * r[1];
    // Looking along the wall (in Plan), right is the piece's own right.
    const sgn = (dir === 'right' ? 1 : -1) * (Math.abs(k) < 0.2 ? 1 : Math.sign(k));
    const p = slideOnWall(item, item.x + r[0] * sgn * step, item.z + r[1] * sgn * step, this.U, shapes, this.assets);
    if (Math.hypot(p.x - item.x, p.z - item.z) < 1e-5) { this.#stopped(); return; }
    this.update(item.uid, { x: r4(p.x), z: r4(p.z) }, { rebuild: false });
  }

  // Take a piece off its top and stand it on the floor nearby.
  putOnFloor(uid) {
    const item = this.items.find((x) => x.uid === uid);
    if (!item || this.readOnly || (!item.on && !(item.y > 0))) return;
    const p = this.#freeSpot({ ...item, y: 0, on: null }, item.x, item.z);
    this.update(uid, { x: p.x, z: p.z, y: 0, on: null }, { rebuild: false });
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

  // Walk-mode collision: is (x, z) within r of a piece you'd walk into? Rugs,
  // what hangs high enough to walk under (art, pendants, fans), and curtains
  // away from a wall (src/stacking.js walkThrough) don't count.
  blocks(x, z, r) {
    return this.items.some((i) => !isFlat(i, this.assets) && (i.y ?? 0) < WALK_UNDER && nearPiece(i, x, z, r) && !walkThrough(i, this.U, this.assets));
  }

  // The view changed ('dollhouse', 'plan' or 'walk'). Seen from above in
  // Plan, what hangs from the ceiling (a fan, a pendant) is drawn see-through
  // so it doesn't hide what's under it; it can still be picked and dragged.
  setView(mode) {
    this.view = mode;
    for (const item of this.items) if (item.on === 'ceiling') this.#ghost(this.groups.get(item.uid), mode === 'plan');
    this.invalidate();
  }

  #ghost(g, on) {
    if (!g || !!g.userData.ghost === on) return;
    g.userData.ghost = on;
    g.traverse((o) => {
      if (!o.isMesh || o.material === this.accentMat) return;
      if (on) {
        o.userData.solid = { material: o.material, cast: o.castShadow };
        o.material = Array.isArray(o.material) ? o.material.map(ghostOf) : ghostOf(o.material);
        o.castShadow = false;
      } else if (o.userData.solid) {
        o.material = o.userData.solid.material;
        o.castShadow = o.userData.solid.cast;
        delete o.userData.solid;
      }
    });
  }

  // ---------------------------------------------------------------- scene
  #mount(item) {
    this.#unmount(item.uid);
    const g = buildPiece(this.M, item, this.assets);
    this.root.add(g);
    this.groups.set(item.uid, g);
    this.onMount?.(item, g);
    if (this.view === 'plan' && item.on === 'ceiling') this.#ghost(g, true);
    if (item.uid === this.selected) this.#refreshSelection();
    this.invalidate();
  }

  #unmount(uid) {
    const g = this.groups.get(uid);
    if (!g) return;
    this.onUnmount?.(uid);
    this.root.remove(g);
    g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.groups.delete(uid);
  }

  // Move a piece's model to where the piece is, without rebuilding it.
  #pose(item) {
    const g = this.groups.get(item.uid);
    if (!g) return;
    g.position.set(item.x, item.y ?? 0, item.z);
    g.rotation.y = -THREE.MathUtils.degToRad(item.rot);
  }

  // A piece moved, turned, resized or raised from `before`: what rests on it
  // goes with it. Returns the pieces carried.
  #carry(before, item) {
    if (['x', 'z', 'y', 'rot', 'w', 'd', 'h'].every((k) => before[k] === item[k])) return [];
    const kids = descendants(item.uid, this.items);
    if (!kids.length) return [];
    for (const m of carry(before, item, this.items, this.assets)) {
      const k = kids.find((i) => i.uid === m.uid);
      if (k) { Object.assign(k, m); this.#pose(k); }
    }
    return kids;
  }

  // Outline on the selected piece at its own height (on the table top for a
  // lamp, a frame on the wall for art), plus the clearance guides.
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
      const w = item.w, d = item.d, h = item.h, t = 0.07;
      const bar = (sx, sy, sz, x, y, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), this.accentMat);
        m.position.set(x, y, z);
        sel.add(m);
      };
      if (this.#holdOf(item) === 'wall') {
        // A frame just in front of the piece's face.
        const f = d / 2 + 0.02;
        bar(w + 2 * t, t, 0.02, 0, -t / 2, f); bar(w + 2 * t, t, 0.02, 0, h + t / 2, f);
        bar(t, h, 0.02, -w / 2 - t / 2, h / 2, f); bar(t, h, 0.02, w / 2 + t / 2, h / 2, f);
      } else {
        const y = 0.06;
        for (const [cx, cz, sx, sz] of [[0, -d / 2, w + t, t], [0, d / 2, w + t, t], [-w / 2, 0, t, d + t], [w / 2, 0, t, d + t]]) bar(sx, 0.02, sz, cx, y, cz);
        // A notch past the front edge shows which way the piece faces.
        const notch = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 3), this.accentMat);
        notch.position.set(0, y, d / 2 + 0.22);
        notch.rotation.y = Math.PI / 6;
        sel.add(notch);
      }
      // The outline follows the piece's scale-free size even for scaled assets.
      sel.scale.set(1 / g.scale.x, 1 / g.scale.y, 1 / g.scale.z);
      sel.traverse((o) => { o.renderOrder = 35; o.userData.pieceId = item.uid; });
      g.add(sel);
    }
    this.#updateGuides();
    this.#renderEditor();
    this.#renderBar();
  }

  // Clearance lines, for pieces standing on the floor.
  #updateGuides() {
    for (const m of this.guideGroup.children.splice(0)) m.geometry.dispose();
    this.guides.forEach((gd) => gd.el.remove());
    this.guides = [];
    const item = this.current;
    if (!item || !this.root.visible || this.readOnly || !onFloor(item)) { this.invalidate(); return; }
    for (const c of clearances(item, this.items, this.obstacles(), this.assets)) {
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
  // How a piece is held up while it moves: 'floor', 'surface' (on a top or
  // shelf, or a tabletop piece on the floor), 'wall' or 'ceiling'.
  #holdOf(item) {
    if (item.on === 'wall' || item.on === 'ceiling') return item.on;
    return item.on ? 'surface' : placeOf(item, this.assets);
  }

  // What a piece may not overlap: the unit's walls, trim and built-ins and the
  // other pieces, at its height. A wall piece's reach the whole height of the
  // wall (it moves up and down it); curtains hang clear of the trim on their
  // rod. Ceiling pieces only meet walls and each other.
  #blockers(item, hold = this.#holdOf(item)) {
    if (!this.U) return [];
    if (hold === 'ceiling') {
      const others = this.items.filter((i) => i.on === 'ceiling' || i.uid === item.uid);
      return blockersFor(item, this.U, others, this.assets).filter((s) => s.kind === 'wall' || s.kind === 'piece');
    }
    if (hold === 'wall') {
      const shapes = blockersFor({ ...item, y: 0, h: 12 }, this.U, this.items, this.assets);
      return actOf(item, this.assets) === 'curtain' ? shapes.filter((s) => s.kind !== 'trim') : shapes;
    }
    return blockersFor(item, this.U, this.items, this.assets);
  }

  // A change to a piece's turn or size: as is when it fits (or collisions are
  // off, or the piece already overlapped something), pushed a little to fit,
  // or null with a note when there's no room. A piece on a top stays on it, a
  // wall piece keeps its back to the wall, a ceiling piece its top to the ceiling.
  #fitChange(item, patch, what) {
    const test = { ...item, ...patch };
    const hold = this.#holdOf(item);
    if (hold === 'wall' && patch.d != null) {
      const f = frontOf(item.rot), k = (patch.d - item.d) / 2;
      test.x = r4(item.x + f[0] * k); test.z = r4(item.z + f[1] * k);
    }
    if (hold === 'ceiling') test.y = ceilingY(test, this.U);
    const s = hold === 'surface' && item.on && surfaceUnder(item, this.items, this.U, this.assets);
    if (s) Object.assign(test, fitOnSurface(test, s) ?? {});
    const out = () => ({ ...patch, x: r4(test.x), z: r4(test.z), ...(test.y != null ? { y: r4(test.y) } : {}) });
    if (!this.collide || !this.U) return out();
    if (collides(item, this.#blockers(item), this.assets)) return out();
    const shapes = this.#blockers(test);
    if (!collides(test, shapes, this.assets)) return out();
    if (hold !== 'wall') {
      // Far enough to turn a long piece around beside a wall: half its length.
      const p = pushOut(test, shapes, Math.max(0.75, Math.max(test.w, test.d) / 2 + 0.25), this.assets);
      if (p && (!s || sameSpot(fitOnSurface({ ...test, ...p }, s), p))) { Object.assign(test, p); return out(); }
    }
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
    const shapes = this.#blockers(test);
    for (let r = 0; r <= 8; r += 0.5) {
      const steps = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 0.75);
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        test.x = snap(x + Math.cos(a) * r); test.z = snap(z + Math.sin(a) * r);
        if (this.insideUnit(test.x, test.z) && !collides(test, shapes, this.assets)) return { x: test.x, z: test.z };
      }
    }
    return { x: snap(x), z: snap(z) };
  }

  // Nearest spot to the piece's (x, z) on a top or shelf where it fits without
  // hitting anything there: { x, z, y, on }, or null when it's too big for it.
  #freeOnSurface(item, s) {
    const test = { ...item, y: s.y, on: s.on };
    const shapes = this.#blockers(test, 'surface');
    const first = fitOnSurface(test, s);
    if (!first) return null;
    for (let r = 0; r <= 3; r += 1 / 6) {
      const steps = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / (1 / 6));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const p = fitOnSurface({ ...test, x: item.x + Math.cos(a) * r, z: item.z + Math.sin(a) * r }, s);
        if (p && !collides({ ...test, ...p }, shapes, this.assets)) return { x: r4(p.x), z: r4(p.z), y: r4(s.y), on: s.on };
      }
    }
    return { x: r4(first.x), z: r4(first.z), y: r4(s.y), on: s.on };
  }

  // Slide flush against a wall or counter when it is within 4".
  #snapToWalls(item) {
    if (item.rot % 90 !== 0) return;
    for (const c of clearances(item, this.items, this.obstacles(), this.assets)) {
      if (c.dist > 0.001 && c.dist < 0.34) {
        if (c.axis === 0) item.x += c.dist * c.sign; else item.z += c.dist * c.sign;
      }
    }
  }

  #middle() {
    const b = this.U?.bounds ?? { x0: 0, z0: 0, x1: 30, z1: 20 };
    return { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
  }

  // Where a new piece goes: the floor point in the middle of the view (or the
  // middle of the unit; in Walk, a few steps ahead), plus what the middle of
  // the view looks at: a top to set things on (`top`; in Walk, the first one
  // ahead of you) and a wall to hang them on (`wall`).
  dropPoint() {
    const cam = this.getCamera(), mode = this.getMode();
    let out;
    if (mode === 'walk') {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      dir.y = 0; dir.normalize();
      const yaw = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
      out = { x: cam.position.x + dir.x * 4.5, z: cam.position.z + dir.z * 4.5, rot: Math.round(yaw / 90) * 90 };
      out.ahead = [1.5, 2.5, 3.5, 4.5, 5.5].map((k) => [cam.position.x + dir.x * k, cam.position.z + dir.z * k]);
      out.eye = cam.position.y;
    } else {
      this.ray.setFromCamera(new THREE.Vector2(0, 0), cam);
      const p = new THREE.Vector3();
      out = this.ray.ray.intersectPlane(this.floorPlane, p) && this.insideUnit(p.x, p.z) ? { x: p.x, z: p.z, rot: 0 } : { ...this.#middle(), rot: 0 };
    }
    if (mode !== 'plan') {
      this.ray.setFromCamera(new THREE.Vector2(0, 0), cam);
      const hit = this.#first(this.#targets());
      if (hit?.wall) out.wall = hit.wall;
      else if (hit && (mode !== 'walk' || hit.distance < 10)) out.top = { x: hit.point.x, z: hit.point.z, y: hit.point.y };
    }
    return out;
  }

  // Put a new piece down at a drop point, by where it goes.
  #setDown(item, at) {
    item.rot = at.rot ?? 0;
    item.x = at.x; item.z = at.z;
    const place = placeOf(item, this.assets);
    if (place === 'surface') {
      // Facing the way what it's on faces (a lamp on a nightstand, a laptop on a desk).
      for (const { s, x, z } of this.#topsAt(item, at)) {
        const rot = s.rot ?? item.rot;
        const p = this.#freeOnSurface({ ...item, x, z, rot }, s);
        if (p) return Object.assign(item, p, { rot });
      }
    } else if (place === 'wall') {
      const def = catalogByType[item.type];
      // Custom pieces: centered at eye level.
      const y = r4(def?.y != null ? def.y / 12 : Math.max(0, 57 / 12 - item.h / 2));
      const hung = (at.wall && this.#hangAlong(item, at.wall.e, at.wall.x, at.wall.z, y)) || this.#hangNear(item, at.x, at.z, y);
      if (hung) return Object.assign(item, hung);
    } else if (place === 'ceiling') {
      const p = this.#freeSpot({ ...item, on: 'ceiling', y: ceilingY(item, this.U) }, at.x, at.z);
      return Object.assign(item, p, { on: 'ceiling', y: ceilingY({ ...item, ...p }, this.U) });
    }
    Object.assign(item, this.#freeSpot(item, at.x, at.z));
  }

  // Tops a new tabletop piece could go on, best first, with the spot on each:
  // the one the view points at, else the first ahead in Walk, else the
  // highest under the drop point.
  #topsAt(item, at) {
    const near = (x, z) => surfacesAt(x, z, { items: this.items, U: this.U, assets: this.assets })
      .filter((s) => item.h <= s.clear + 0.02).map((s) => ({ s, x, z }));
    if (at.top) {
      const list = near(at.top.x, at.top.z);
      const best = pointedAt(list.map((o) => o.s), at.top.y);
      if (best) return [list.find((o) => o.s === best), ...list.filter((o) => o.s !== best)];
    }
    for (const [x, z] of at.ahead ?? []) {
      const list = near(x, z).filter((o) => o.s.y < (at.eye ?? 9) - 0.5);
      if (list.length) return list;
    }
    return near(at.x, at.z);
  }

  // ---------------------------------------------------------------- walls
  // Wall faces are the room edges (U.edges): p, u along, n out of the room
  // into the wall, len.

  // The wall face a hung piece's back is against, or null.
  #edgeOf(item) {
    if (!this.U) return null;
    const f = frontOf(item.rot), bx = item.x - (f[0] * item.d) / 2, bz = item.z - (f[1] * item.d) / 2;
    let best = null;
    for (const e of this.U.edges) {
      const turn = Math.abs(((facing(e.n) - item.rot + 540) % 360) - 180);
      if (turn > 1) continue;
      const dx = bx - e.p[0], dz = bz - e.p[1];
      const t = Math.abs(dx * e.n[0] + dz * e.n[1]), s = dx * e.u[0] + dz * e.u[1];
      if (t > 0.1 || s < -0.1 || s > e.len + 0.1) continue;
      if (!best || t < best.t) best = { e, t };
    }
    return best?.e ?? null;
  }

  // Hang a piece on a given wall face at height y, its middle as near the
  // spot along the face of (x, z) as the face's ends allow: { x, z, rot, y,
  // on }, or null when it doesn't fit there (a window, a doorway) or would hit
  // something in `shapes`.
  #hangOn(item, e, x, z, y, shapes = []) {
    const s = (x - e.p[0]) * e.u[0] + (z - e.p[1]) * e.u[1];
    // Just in front of the face, so hangOnWall takes this face.
    const px = e.p[0] + e.u[0] * s - e.n[0] * 0.05, pz = e.p[1] + e.u[1] * s - e.n[1] * 0.05;
    const hung = hangOnWall({ ...item, y }, px, pz, this.U, { y, reach: 0.5 });
    if (!hung) return null;
    const out = { x: hung.x, z: hung.z, rot: hung.rot, y, on: 'wall' };
    const at = { ...item, ...out };
    return this.#edgeOf(at) === e && !(shapes.length && collides(at, shapes, this.assets)) ? out : null;
  }

  // Hang a piece on one wall face at height y, as near (x, z) as it fits:
  // looks along the face for the nearest spot with wall behind all of it and,
  // with collisions on, nothing in the way. Null when it fits nowhere on it.
  #hangAlong(item, e, x, z, y) {
    const shapes = this.collide ? this.#blockers(item, 'wall') : [];
    const s0 = (x - e.p[0]) * e.u[0] + (z - e.p[1]) * e.u[1];
    for (let k = 0; k <= e.len; k += 0.25) {
      for (const s of k ? [s0 + k, s0 - k] : [s0]) {
        if (s < -0.25 || s > e.len + 0.25) continue;
        const out = this.#hangOn(item, e, e.p[0] + e.u[0] * s, e.p[1] + e.u[1] * s, y, shapes);
        if (out) return out;
      }
    }
    return null;
  }

  // Hang a piece on the wall nearest (x, z) that it fits on: the faces the
  // point is in front of, those of its own room first, then (outside Plan)
  // those facing the camera, so it doesn't land out of sight.
  #hangNear(item, x, z, y) {
    if (!this.U) return null;
    const room = this.U.roomAt(x, z)?.id;
    const cam = this.getMode() === 'plan' ? null : this.getCamera().position;
    const list = [];
    for (const e of this.U.edges) {
      const dx = x - e.p[0], dz = z - e.p[1];
      const t = dx * e.n[0] + dz * e.n[1], s = dx * e.u[0] + dz * e.u[1];
      if (t > 0.15) continue;
      const off = Math.hypot(Math.min(0, t), s < 0 ? s : s > e.len ? s - e.len : 0);
      const hidden = cam && (cam.x - e.p[0]) * e.n[0] + (cam.z - e.p[1]) * e.n[1] > 0;
      list.push({ e, off: off + (e.room === room ? 0 : 1000) + (hidden ? 500 : 0) });
    }
    list.sort((a, b) => a.off - b.off);
    for (const { e } of list.slice(0, 12)) {
      const hung = this.#hangAlong(item, e, x, z, y);
      if (hung) return hung;
    }
    return null;
  }

  // The wall face a hit on the walls' mesh is on (p a point, n its normal), or
  // null for the edge of an opening.
  #faceAt(p, n) {
    for (const e of this.U.edges) {
      if (-(n.x * e.n[0] + n.z * e.n[1]) < 0.9) continue;
      const dx = p.x - e.p[0], dz = p.z - e.p[1];
      const t = dx * e.n[0] + dz * e.n[1], s = dx * e.u[0] + dz * e.u[1];
      if (Math.abs(t) < 0.12 && s > -0.05 && s < e.len + 0.05) return e;
    }
    return null;
  }

  // Where the aimed ray meets a wall face's plane (moved `off` into the room:
  // the front of a piece hung there), seen from the room side, within the
  // face (over a window or doorway too): { point, distance } or null.
  #onFace(e, off = 0) {
    const { origin: o, direction: v } = this.ray.ray;
    const into = v.x * e.n[0] + v.z * e.n[1];
    const before = (o.x - e.p[0]) * e.n[0] + (o.z - e.p[1]) * e.n[1] + off;
    if (into < 1e-4 || before > 0) return null;
    const k = -before / into;
    const point = o.clone().addScaledVector(v, k);
    const s = (point.x - e.p[0]) * e.u[0] + (point.z - e.p[1]) * e.u[1];
    if (s < 0 || s > e.len || point.y < 0 || point.y > ceilingAt(point.x, point.z, this.U) + 0.5) return null;
    return { point, distance: k };
  }

  // Where a hung piece's middle goes for its back's spot (x, z) on a face, kept
  // between the face's ends.
  #alongFace(e, item, x, z) {
    const s = Math.max(item.w / 2, Math.min(e.len - item.w / 2, (x - e.p[0]) * e.u[0] + (z - e.p[1]) * e.u[1]));
    return { x: e.p[0] + e.u[0] * s - (e.n[0] * item.d) / 2, z: e.p[1] + e.u[1] * s - (e.n[1] * item.d) / 2 };
  }

  // Move a hung piece up or down toward height ty, stopping where the wall
  // behind it ends (a window, a doorway, the ceiling), at the floor, or
  // flush against what it meets. Returns the height it gets to.
  #raise(item, ty, shapes, step = 1 / 48) {
    const top = ceilingAt(item.x, item.z, this.U) - item.h;
    ty = Math.max(0, Math.min(top, ty));
    let y = item.y ?? 0;
    const ok = (v) => !wallProblem({ ...item, y: v }, this.U) && !(shapes?.length && collides({ ...item, y: v }, shapes, this.assets));
    // An inch at a time, then finer near what stops it.
    for (const inc of step < 1 / 12 ? [1 / 12, step] : [step]) {
      while (Math.abs(ty - y) > 1e-6) {
        const v = Math.abs(ty - y) <= inc ? ty : y + Math.sign(ty - y) * inc;
        if (!ok(v)) break;
        y = v;
      }
    }
    return r4(y);
  }

  // ---------------------------------------------------------------- pointer
  #aim(e) {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.getCamera());
  }

  // Hits of the aimed ray, nearest first, leaving out what the Dollhouse's
  // cutaway clips off.
  #hits(objects) {
    const clip = this.clipping?.() ?? [];
    const hits = this.ray.intersectObjects(objects, true);
    return clip.length ? hits.filter((h) => clip.every((pl) => pl.distanceToPoint(h.point) >= 0)) : hits;
  }

  // What the aimed ray can land a piece on: the pieces (but `skip`), the
  // built-ins and the walls.
  #targets(skip = new Set()) {
    const out = [];
    for (const [uid, g] of this.groups) if (!skip.has(uid)) out.push(g);
    const fixtures = this.builtIns?.(), walls = this.walls?.();
    if (fixtures) out.push(fixtures);
    if (walls) out.push(walls);
    return out;
  }

  // The first thing the aimed ray hits among `targets`: { what: 'piece' |
  // 'fixture' | 'wall', point, distance, wall: { e, x, z } for a wall face }.
  #first(targets) {
    const hit = this.#hits(targets)[0];
    if (!hit) return null;
    const out = { point: hit.point, distance: hit.distance };
    if (hit.object.userData.pieceId != null) return { ...out, what: 'piece' };
    const walls = this.walls?.();
    let o = hit.object;
    while (o && o !== walls) o = o.parent;
    if (!o) return { ...out, what: 'fixture' };
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    const e = n && this.U && this.#faceAt(hit.point, n);
    return { ...out, what: 'wall', wall: e ? { e, x: hit.point.x, z: hit.point.z, y: hit.point.y } : null };
  }

  #pick(e) {
    if (!this.root.visible || !this.items.length) return null;
    this.#aim(e);
    const hits = this.#hits([this.root, ...this.occluders()]);
    // A tap on a see-through ceiling piece (in Plan) reaches the piece under
    // it, unless the ceiling piece is the one selected.
    const ghost = (h) => h.object.userData.pieceId !== this.selected && !!this.groups.get(h.object.userData.pieceId)?.userData.ghost;
    const hit = hits[0] && ghost(hits[0]) ? hits.find((h) => h.object.userData.pieceId != null && !ghost(h)) ?? hits[0] : hits[0];
    const uid = hit?.object.userData.pieceId;
    return uid == null ? null : { uid, point: hit.point.clone() };
  }

  // Where the aimed ray (at the pointer) meets the level plane at height y.
  #planeAt(e, y = 0) {
    this.#aim(e);
    this.floorPlane.constant = -y;
    const p = new THREE.Vector3();
    const hit = this.ray.ray.intersectPlane(this.floorPlane, p);
    this.floorPlane.constant = 0;
    return hit ? p : null;
  }

  #bindPointer() {
    const el = this.canvas;
    let drag = null;
    let empty = null;
    // Capture phase, so a press on a piece never reaches the camera controls.
    el.addEventListener('pointerdown', (e) => {
      // With the cursor locked in Walk, clicks belong to the crosshair.
      if (!this.enabled || drag || document.pointerLockElement === el) return;
      const pick = this.#pick(e);
      if (!pick) {
        empty = { x: e.clientX, y: e.clientY, id: e.pointerId };
        return;
      }
      if (this.selected !== pick.uid) this.select(pick.uid);
      if (this.readOnly) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      drag = this.#startDrag(this.current, pick.point, e);
      this.dragging = pick.uid;
      el.setPointerCapture(e.pointerId);
    }, { capture: true });

    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopImmediatePropagation();
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      drag.moved = true;
      const item = this.current;
      if (!item) return;
      // Alt (Option) while dragging: a ¼" grid instead of 1".
      const grid = e.altKey ? 1 / 48 : 1 / 12;
      const next = {
        floor: () => this.#dragFloor(e, drag, item, grid),
        surface: () => this.#dragSurface(e, drag, item, grid),
        wall: () => this.#dragWall(e, drag, item, grid),
        ceiling: () => this.#dragCeiling(e, drag, item, grid),
      }[drag.hold]();
      if (!next) return;
      for (const k of ['x', 'z', 'y']) if (next[k] != null) next[k] = r4(next[k]);
      Object.assign(item, next);
      tidy(item);
      this.#pose(item);
      // What rests on it keeps its place on it, from where the drag began.
      for (const m of drag.kids.length ? carry(drag.start, item, drag.kids, this.assets) : []) {
        const k = this.items.find((i) => i.uid === m.uid);
        if (k) { Object.assign(k, m); this.#pose(k); }
      }
      this.#updateGuides();
      this.#renderBar();
      this.invalidate();
    }, { capture: true });

    const end = (e) => {
      if (drag && e.pointerId === drag.id) {
        e.stopImmediatePropagation();
        const item = this.current;
        if (drag.moved && item) {
          const kids = drag.kids.map((k) => this.items.find((i) => i.uid === k.uid)).filter(Boolean);
          this.#emit([item, ...kids]);
          this.#refreshSelection();
        }
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

  // A drag begins on `item`, grabbed at `point`. Everything a move needs is
  // worked out once here: what rests on it, what the pointer can land it on,
  // where it was grabbed. What it may not overlap is cached as it's needed.
  #startDrag(item, point, e) {
    const kids = descendants(item.uid, this.items);
    const d = {
      id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false,
      hold: this.#holdOf(item), start: { ...item }, kids: kids.map((k) => ({ ...k })),
      shapes: new Map(),
      ox: item.x - point.x, oz: item.z - point.z, py: point.y,
    };
    if (d.hold === 'floor') {
      const p = this.#planeAt(e, 0);
      d.ox = p ? item.x - p.x : 0; d.oz = p ? item.z - p.z : 0;
    } else if (d.hold === 'surface') {
      d.skip = new Set([item.uid, ...kids.map((k) => k.uid)]);
      d.targets = this.#targets(d.skip);
    } else if (d.hold === 'wall') {
      d.targets = [this.walls?.()].filter(Boolean);
      // Grabbed this far along the piece and up from its bottom.
      const r = rightOf(item.rot);
      d.oa = (item.x - point.x) * r[0] + (item.z - point.z) * r[1];
      d.oy = (item.y ?? 0) - point.y;
    }
    return d;
  }

  // What a dragged piece may not overlap where it is now, or null with
  // collisions off. Cached per drag by what holds it up.
  #dragShapes(d, item) {
    if (!this.collide || !this.U) return null;
    const key = d.hold === 'wall' ? 'wall' : `${item.on ?? ''}|${item.y ?? 0}`;
    if (!d.shapes.has(key)) d.shapes.set(key, this.#blockers(item, d.hold));
    return d.shapes.get(key);
  }

  // On the floor: the point under the pointer, sliding along what it meets and
  // snapping flush to a wall or counter within 4".
  #dragFloor(e, d, item, grid) {
    const p = this.#planeAt(e, 0);
    if (!p) return null;
    const tx = snap(p.x + d.ox, grid), tz = snap(p.z + d.oz, grid);
    const shapes = this.#dragShapes(d, item);
    let next;
    if (shapes) next = { ...item, ...slideTo(item, tx, tz, shapes, this.assets) };
    else {
      next = { ...item, x: tx, z: tz };
      if (!this.insideUnit(next.x, next.z)) return null;
    }
    const before = { x: next.x, z: next.z };
    this.#snapToWalls(next);
    if (shapes && collides(next, shapes, this.assets)) Object.assign(next, before);
    return { x: next.x, z: next.z };
  }

  // A tabletop piece: onto the top or shelf under the pointer (in Plan, the
  // highest), sliding among what's already there and kept on it; off any top,
  // onto the floor. It stays put over a shelf too low for it, or a top too
  // crowded or too small.
  #dragSurface(e, d, item, grid) {
    let s = null, px, pz;
    const tops = (x, z) => surfacesAt(x, z, { items: this.items, U: this.U, assets: this.assets, exclude: d.skip });
    if (this.getMode() === 'plan') {
      const p = this.#planeAt(e, 0);
      if (!p) return null;
      ({ x: px, z: pz } = p);
      s = tops(px, pz)[0] ?? null;
    } else {
      this.#aim(e);
      const hit = this.#first(d.targets);
      // Pointing at a wall: nowhere to go.
      if (hit?.what === 'wall') return null;
      if (hit) s = pointedAt(tops(hit.point.x, hit.point.z), hit.point.y);
      if (s) ({ x: px, z: pz } = hit.point);
      else {
        const p = this.#planeAt(e, 0);
        if (!p) return null;
        ({ x: px, z: pz } = p);
      }
    }
    if (s && item.h > s.clear + 0.02) return null;
    const y = s ? s.y : 0, on = s ? s.on : null;
    const at = { ...item, y, on, x: snap(px + d.ox, grid), z: snap(pz + d.oz, grid) };
    if (s) {
      const p = fitOnSurface(at, s);
      if (!p) return null;
      at.x = p.x; at.z = p.z;
    } else if (!this.insideUnit(at.x, at.z)) return null;
    const shapes = this.#dragShapes(d, at);
    if (!shapes) return { x: at.x, z: at.z, y, on };
    // On the same top: slide there.
    if ((item.on ?? null) === on && Math.abs((item.y ?? 0) - y) < 0.01) {
      const p = slideTo({ ...item, y, on }, at.x, at.z, shapes, this.assets);
      return { x: p.x, z: p.z, y, on };
    }
    // Onto another: set down there, nudged clear of what's already on it.
    if (!collides(at, shapes, this.assets)) return { x: at.x, z: at.z, y, on };
    const p = pushOut(at, shapes, 0.5, this.assets);
    if (!p || (s && !sameSpot(fitOnSurface({ ...at, ...p }, s), p))) return null;
    return { x: p.x, z: p.z, y, on };
  }

  // A wall piece: where the pointer meets its wall (over a window too), slid
  // along it, stopping at windows, doorways, corners and other pieces, and up
  // or down it to the pointer's height (1" steps); onto another wall the
  // pointer reaches. In Plan, along and between walls at the same height.
  #dragWall(e, d, item, grid) {
    if (!this.U) return null;
    const cur = this.#edgeOf(item);
    const shapes = this.#dragShapes(d, item) ?? [];
    let edge = null, tx, tz, ty = item.y ?? 0;
    if (this.getMode() === 'plan') {
      const p = this.#planeAt(e, 0);
      if (!p) return null;
      tx = p.x + d.ox; tz = p.z + d.oz;
      // The wall nearest the pointer that it fits on; along its own when
      // that's the one, or when none near has room for it there.
      const hung = hangOnWall(item, tx, tz, this.U, { reach: 2.5 });
      const near = hung && this.#edgeOf({ ...item, ...hung });
      if (near && near !== cur && !collides({ ...item, ...hung }, shapes, this.assets)) return { x: hung.x, z: hung.z, rot: hung.rot, on: 'wall' };
      edge = cur;
      if (!edge) return null;
    } else {
      this.#aim(e);
      const hit = this.#first(d.targets);
      const face = cur && this.#onFace(cur, item.d);
      // Its own wall, unless the pointer is on another wall in front of it.
      const mine = face && (!hit?.wall || hit.wall.e === cur || face.distance <= hit.distance + 0.05);
      const pt = mine ? face.point : hit?.wall ? hit.point : null;
      if (!pt) return null;
      edge = mine ? cur : hit.wall.e;
      const r = rightOf(facing(edge.n));
      tx = pt.x + r[0] * d.oa; tz = pt.z + r[1] * d.oa;
      ty = snap(pt.y + d.oy, grid);
    }
    if (edge !== cur) {
      // Onto another wall: at the pointer's height if it fits there, else its own.
      for (const y of [Math.max(0, ty), item.y ?? 0]) {
        const hung = this.#hangOn(item, edge, tx, tz, y, shapes);
        if (hung) return hung;
      }
      return null;
    }
    const to = this.#alongFace(edge, item, tx, tz);
    const p = slideOnWall(item, to.x, to.z, this.U, shapes, this.assets);
    const y = this.#raise({ ...item, x: p.x, z: p.z }, ty, shapes);
    return { x: p.x, z: p.z, y, on: 'wall' };
  }

  // A ceiling piece: under the pointer at the height it was grabbed, sliding
  // along walls and other ceiling pieces, its top kept to the ceiling.
  #dragCeiling(e, d, item, grid) {
    const p = this.#planeAt(e, d.py);
    if (!p) return null;
    const tx = snap(p.x + d.ox, grid), tz = snap(p.z + d.oz, grid);
    const shapes = this.#dragShapes(d, item);
    let x = tx, z = tz;
    if (shapes) ({ x, z } = slideTo(item, tx, tz, shapes, this.assets));
    else if (!this.insideUnit(tx, tz)) return null;
    return { x, z, y: ceilingY({ ...item, x, z }, this.U), on: 'ceiling' };
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
      catalog: $('#catalog'), kinds: $('#kindChips'), mine: $('#assetList'), mineGroup: $('#assetGroup'), list: $('#layoutList'), empty: $('#layoutEmpty'), editor: $('#pieceEditor'),
      name: $('#peName'), w: $('#peW'), d: $('#peD'), h: $('#peH'), rot: $('#peRot'), swatches: $('#peSwatches'), warn: $('#peWarn'),
      place: $('#pePlace'), yField: $('#peYField'), y: $('#peY'), on: $('#peOn'), floor: $('#peFloor'),
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
    this.ui.kinds.addEventListener('click', (e) => {
      const b = e.target.closest('[data-kind]');
      if (!b || b.dataset.kind === this.kind) return;
      this.kind = b.dataset.kind;
      this.#renderBaseCatalog();
      this.#renderCatalog();
    });
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
    // A wall piece's height off the floor.
    this.ui.y.addEventListener('change', () => {
      const item = this.current, ft = fromInput(this.ui.y.value);
      if (!item || ft === null) return this.#renderEditor();
      const y = r4(Math.max(0, Math.min(ceilingAt(item.x, item.z, this.U) - item.h, ft)));
      if (this.collide && collides({ ...item, y }, this.#blockers(item), this.assets) && !collides(item, this.#blockers(item), this.assets)) {
        this.toast('Something is in the way at that height.');
        return this.#renderEditor();
      }
      this.update(item.uid, { y }, { rebuild: false });
    });
    this.ui.floor.addEventListener('click', () => this.current && this.putOnFloor(this.current.uid));
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

  // The catalog, one kind at a time (chips across the top); furniture under
  // the rooms it's for. Each button says where its piece goes when that isn't
  // the floor. Wall pieces read width × height.
  #renderBaseCatalog() {
    this.ui.kinds.innerHTML = KINDS.map((k) => `<button class="kind-chip" data-kind="${k.key}" aria-pressed="${k.key === this.kind}">${k.name}</button>`).join('');
    const list = CATALOG.filter((c) => c.kind === this.kind);
    const room = (c) => (ROOMS.includes(c.group) ? c.group : 'Other');
    const kind = KINDS.find((k) => k.key === this.kind)?.name;
    const groups = this.kind === 'furniture' ? ROOMS.map((g) => [g, list.filter((c) => room(c) === g)]) : [[kind, list, 'kind-head']];
    const button = (c) => {
      const size = c.build === 'rug' ? fmtRug(c.w / 12, c.d / 12) : fmtSize(c.w / 12, (c.place === 'wall' ? c.h : c.d) / 12);
      const tag = PLACE_TAG[c.place];
      return `<button class="cat-btn" data-type="${c.type}"><b>${c.name}</b><small>${size}${tag ? ` <i>${tag}</i>` : ''}</small></button>`;
    };
    this.ui.catalog.innerHTML = groups.filter(([, l]) => l.length).map(([g, l, cls]) =>
      `<h3${cls ? ` class="${cls}"` : ''}>${g}</h3><div class="catalog-grid">${l.map(button).join('')}</div>`).join('');
  }

  // The unit's own custom pieces (made by an agent through MCP; sizes in
  // inches), the ones of the chosen kind.
  #renderCatalog() {
    const list = Object.values(this.assets).filter((a) => (a.kind ?? 'furniture') === this.kind);
    this.ui.mineGroup.hidden = !list.length;
    this.ui.mine.innerHTML = list.map((a) => {
      const tag = PLACE_TAG[a.place];
      return `<button class="cat-btn" data-asset="${escapeHTML(a.id)}"><b>${escapeHTML(a.name)}</b><small>${fmtSize(Math.round(a.w) / 12, Math.round(a.place === 'wall' ? a.h : a.d) / 12)}${tag ? ` <i>${tag}</i>` : ''}</small></button>`;
    }).join('');
  }

  // The layout, with what rests on a piece listed under it.
  #renderList() {
    const { list, empty, count } = this.ui;
    empty.hidden = this.items.length > 0;
    count.textContent = this.items.length ? `${this.items.length}` : '';
    const uids = new Set(this.items.map((i) => i.uid));
    const under = (uid) => this.items.filter((i) => i.on === `p:${uid}`);
    const rows = [];
    const add = (i, depth) => {
      rows.push(`<li${depth ? ` class="on-piece" style="--depth:${Math.min(depth, 3)}"` : ''}><button class="piece-row" data-piece="${escapeHTML(i.uid)}" aria-current="${i.uid === this.selected}"><span>${escapeHTML(i.name)}</span><small>${fmtSize(i.w, i.d)}</small></button></li>`);
      if (depth < 8) under(i.uid).forEach((k) => add(k, depth + 1));
    };
    this.items.filter((i) => !(i.on?.startsWith('p:') && uids.has(i.on.slice(2)))).forEach((i) => add(i, 0));
    list.innerHTML = rows.join('');
  }

  // What holds the piece up, in words: 'On Dining table', 'On the counter'.
  #supportText(item) {
    const s = supportOf(item, this.items, this.U);
    if (s.kind === 'piece') return `On ${s.piece.name}`;
    if (s.kind === 'fixture') {
      const f = s.fixture;
      return f.type === 'island' ? 'On the island' : KITCHEN.test(f.type) ? 'On the counter' : `On the ${f.name.toLowerCase()}`;
    }
    if (s.kind === 'ceiling') return 'Hangs from the ceiling';
    return null;
  }

  #renderEditor() {
    const item = this.current, ui = this.ui;
    ui.editor.hidden = !item || this.readOnly;
    ui.list.querySelectorAll('[data-piece]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.piece === this.selected)));
    if (!item || this.readOnly) return;
    const cm = inputUnit() === 'cm';
    for (const input of [ui.w, ui.d, ui.h, ui.y]) {
      input.step = cm ? '1' : '0.5';
      input.min = input === ui.y ? '0' : cm ? '3' : '1';
      input.max = cm ? (input === ui.h || input === ui.y ? '274' : '914') : (input === ui.h || input === ui.y ? '108' : '360');
    }
    ui.suffixes.forEach((el) => { el.textContent = inputUnit(); });
    const hold = this.#holdOf(item);
    if (document.activeElement !== ui.name) ui.name.value = item.name;
    if (document.activeElement !== ui.w) ui.w.value = toInput(item.w);
    if (document.activeElement !== ui.d) ui.d.value = toInput(item.d);
    if (document.activeElement !== ui.h) ui.h.value = toInput(item.h);
    if (document.activeElement !== ui.rot) ui.rot.value = String(Math.round(item.rot));
    if (document.activeElement !== ui.y) ui.y.value = toInput(item.y ?? 0);
    // A catalog rug is as thick as a rug; a custom piece keeps its height.
    ui.h.disabled = catalogByType[item.type]?.build === 'rug';
    // A wall piece turns with its wall, and has a height off the floor; a
    // piece on a top says what it's on and can come down to the floor.
    ui.rot.disabled = hold === 'wall';
    const on = this.#supportText(item);
    const down = hold === 'surface' && (!!item.on || item.y > 0);
    ui.place.hidden = hold !== 'wall' && !on && !down;
    ui.yField.hidden = hold !== 'wall';
    ui.on.hidden = !on;
    ui.on.textContent = on ?? '';
    ui.floor.hidden = !down;
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
    const hold = this.#holdOf(item);
    ui.bar.classList.toggle('on-wall', hold === 'wall');
    ui.barName.textContent = item.name;
    // A wall piece: width × height and how high it hangs; a piece on a top: what it's on.
    ui.barDims.textContent = hold === 'wall' ? `${fmtSize(item.w, item.h)} · ${fmtLen(item.y ?? 0)} up` : fmtSize(item.w, item.d, item.h);
    const on = item.on?.startsWith('p:') || item.on?.startsWith('f:') ? this.#supportText(item) : null;
    if (on) ui.barDims.textContent += ` · ${on[0].toLowerCase()}${on.slice(1)}`;
    if (!this.readOnly && hold !== 'wall') ui.barDims.append(Object.assign(document.createElement('span'), { className: 'pb-rot', textContent: ` · ${Math.round(item.rot)}°` }));
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

// A piece on the floor stores neither its height nor its support.
function tidy(item) {
  if (!item.on) delete item.on;
  if (!(item.y > 0)) delete item.y;
}

// The top the pointer points at among those under it (highest first): the
// highest at or just under the pointer's height, so pointing into a
// bookshelf picks the shelf under the pointer; else the nearest in height.
function pointedAt(list, y) {
  if (!list.length) return null;
  return list.find((s) => s.y <= y + BOARD) ?? list.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
}

const sameSpot = (a, b) => !!a && Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.z - b.z) < 1e-4;

// A see-through copy of a material, made once. A lamp's glow still follows
// the lamp's own material (its on and off).
const ghosts = new WeakMap();
function ghostOf(m) {
  if (!ghosts.has(m)) {
    const c = m.clone();
    c.transparent = true;
    c.opacity = m.opacity * 0.3;
    c.depthWrite = false;
    if ('emissiveIntensity' in m) Object.defineProperty(c, 'emissiveIntensity', { get: () => m.emissiveIntensity, set() {} });
    ghosts.set(m, c);
  }
  return ghosts.get(m);
}
