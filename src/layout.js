import * as THREE from 'three';
import { CATALOG, catalogByType, SWATCHES, buildPiece, bounds, nearPiece, isFlat } from './furniture.js';

// Your own furniture: add pieces from the catalog, drag them into place, turn,
// resize and recolor them. While a piece is selected, lines show its clearance
// to the nearest wall, counter or other piece on each side. The layout saves in
// this browser, and a share link carries it to another device.

const STORE_KEY = 'livingspace.layout.v1';
const snap = (v, step = 1 / 12) => Math.round(v / step) * step;
const r2 = (v) => Math.round(v * 100) / 100;
const inches = (ft) => {
  const v = Math.round(ft * 12 * 2) / 2;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(code) {
  const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Keep only well-formed pieces with sane sizes.
function sanitize(raw) {
  if (!Array.isArray(raw)) return [];
  const num = (v, lo, hi, dflt) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : dflt);
  return raw.filter((i) => i && catalogByType[i.type]).slice(0, 200).map((i) => {
    const def = catalogByType[i.type];
    return {
      type: i.type,
      name: typeof i.name === 'string' && i.name.trim() ? i.name.trim().slice(0, 40) : def.name,
      w: num(i.w, 0.25, 30, def.w / 12), d: num(i.d, 0.25, 30, def.d / 12), h: num(i.h, 0.02, 9, def.h / 12),
      x: num(i.x, -5, 45, 20), z: num(i.z, -5, 35, 15), rot: num(i.rot, -3600, 3600, 0) % 360,
      color: SWATCHES.some((s) => s.key === i.color) ? i.color : null,
    };
  });
}

export class LayoutEditor {
  constructor(opts) {
    Object.assign(this, opts);
    this.items = [];
    this.groups = new Map();
    this.selected = null;
    this.nextId = 1;
    this.enabled = true;
    this.viewingShared = false;
    this.ray = new THREE.Raycaster();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.guideGroup = new THREE.Group();
    this.guideGroup.renderOrder = 40;
    this.scene.add(this.guideGroup);
    this.guides = [];
    this.layer = document.createElement('div');
    this.layer.className = 'edit-layer';
    this.stage.append(this.layer);
    this.#bindUI();
    this.#bindPointer();
    this.#bindKeys();
    this.#loadInitial();
  }

  // ---------------------------------------------------------------- state
  add(type, at) {
    const def = catalogByType[type];
    const item = { id: this.nextId++, type, name: def.name, w: def.w / 12, d: def.d / 12, h: def.h / 12, x: 0, z: 0, rot: at?.rot ?? 0, color: null };
    const p = this.#freeSpot(item, at?.x ?? 20, at?.z ?? 18);
    item.x = p.x; item.z = p.z;
    this.items.push(item);
    this.#mount(item);
    this.select(item.id);
    this.changed();
    return item;
  }

  remove(id, { undoable = true } = {}) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [item] = this.items.splice(i, 1);
    this.#unmount(id);
    if (this.selected === id) this.select(null);
    this.changed();
    if (undoable) this.toast(`Removed ${item.name}`, 'Undo', () => { this.items.push(item); this.#mount(item); this.select(item.id); this.changed(); });
  }

  duplicate(id) {
    const src = this.items.find((x) => x.id === id);
    if (!src) return;
    const copy = { ...src, id: this.nextId++ };
    const p = this.#freeSpot(copy, src.x + Math.min(2, src.w * 0.6), src.z + Math.min(2, src.d * 0.6));
    copy.x = p.x; copy.z = p.z;
    this.items.push(copy);
    this.#mount(copy);
    this.select(copy.id);
    this.changed();
  }

  update(id, patch, { rebuild = true } = {}) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return;
    Object.assign(item, patch);
    item.rot = ((item.rot % 360) + 360) % 360;
    if (rebuild) this.#mount(item);
    else {
      const g = this.groups.get(id);
      g.position.set(item.x, 0, item.z);
      g.rotation.y = -THREE.MathUtils.degToRad(item.rot);
    }
    this.#refreshSelection();
    this.changed();
  }

  rotate(id, delta) {
    const item = this.items.find((x) => x.id === id);
    if (item) this.update(id, { rot: Math.round((item.rot + delta) / 15) * 15 }, { rebuild: false });
  }

  setItems(items) {
    for (const id of [...this.groups.keys()]) this.#unmount(id);
    this.items = items.map((i) => ({ ...i, id: this.nextId++ }));
    this.items.forEach((i) => this.#mount(i));
    this.select(null);
    this.changed();
  }

  select(id) {
    this.selected = id;
    this.#refreshSelection();
    this.onSelect?.(id);
    this.invalidate();
  }

  get current() { return this.items.find((x) => x.id === this.selected) ?? null; }

  // Called after every change: save, refresh the panel.
  changed() {
    this.#renderList();
    this.#save();
    this.invalidate();
  }

  // Walk-mode collision: is (x, z) within r of a standing piece?
  blocks(x, z, r) {
    return this.items.some((i) => !isFlat(i) && nearPiece(i, x, z, r));
  }

  // ---------------------------------------------------------------- scene
  #mount(item) {
    this.#unmount(item.id);
    const g = buildPiece(this.M, item);
    this.root.add(g);
    this.groups.set(item.id, g);
    if (item.id === this.selected) this.#refreshSelection();
    this.invalidate();
  }

  #unmount(id) {
    const g = this.groups.get(id);
    if (!g) return;
    this.root.remove(g);
    g.traverse((o) => { if (o.isMesh && !o.userData.shared) o.geometry.dispose(); });
    this.groups.delete(id);
  }

  // Outline and tint on the selected piece, plus the clearance guides.
  #refreshSelection() {
    for (const g of this.groups.values()) {
      const old = g.getObjectByName('selection');
      if (old) { g.remove(old); old.traverse((o) => o.geometry?.dispose()); }
    }
    const item = this.current;
    const g = item && this.groups.get(item.id);
    if (g) {
      const sel = new THREE.Group();
      sel.name = 'selection';
      const w = item.w, d = item.d, t = 0.07, y = 0.06;
      for (const [cx, cz, sx, sz] of [[0, -d / 2, w + t, t], [0, d / 2, w + t, t], [-w / 2, 0, t, d + t], [w / 2, 0, t, d + t]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.02, sz), this.accentMat);
        bar.position.set(cx, y, cz);
        sel.add(bar);
      }
      // A notch on the front edge shows which way the piece faces.
      const notch = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 3), this.accentMat);
      notch.position.set(0, y, d / 2 + 0.22);
      notch.rotation.y = Math.PI / 6;
      sel.add(notch);
      sel.traverse((o) => { o.renderOrder = 35; o.userData.pieceId = item.id; });
      g.add(sel);
    }
    this.#updateGuides();
    this.#renderEditor();
    this.#renderBar();
  }

  // Distances from the piece to the nearest obstacle on each side.
  clearances(item) {
    const b = bounds(item);
    const obs = [...this.obstacles(), ...this.items.filter((i) => i.id !== item.id && !isFlat(i)).map(bounds)];
    const out = [];
    const sides = [
      { axis: 0, sign: 1, edge: b[2], lo: b[1], hi: b[3] },
      { axis: 0, sign: -1, edge: b[0], lo: b[1], hi: b[3] },
      { axis: 1, sign: 1, edge: b[3], lo: b[0], hi: b[2] },
      { axis: 1, sign: -1, edge: b[1], lo: b[0], hi: b[2] },
    ];
    for (const s of sides) {
      let best = null;
      for (const o of obs) {
        const [olo, ohi] = s.axis === 0 ? [o[1], o[3]] : [o[0], o[2]];
        const ov0 = Math.max(s.lo, olo), ov1 = Math.min(s.hi, ohi);
        if (ov1 - ov0 < 0.02) continue;
        const face = s.sign > 0 ? o[s.axis] : o[s.axis + 2];
        const dist = (face - s.edge) * s.sign;
        if (dist < -0.01) continue;
        if (!best || dist < best.dist) best = { dist: Math.max(0, dist), at: (ov0 + ov1) / 2 };
      }
      if (best && best.dist < 15) out.push({ ...s, ...best });
    }
    return out;
  }

  #updateGuides() {
    for (const m of this.guideGroup.children.splice(0)) m.geometry.dispose();
    this.guides.forEach((gd) => gd.el.remove());
    this.guides = [];
    const item = this.current;
    if (!item || !this.root.visible) { this.invalidate(); return; }
    for (const c of this.clearances(item)) {
      if (c.dist < 0.04) continue;
      const a = c.axis === 0 ? [c.edge, c.at] : [c.at, c.edge];
      const b = c.axis === 0 ? [c.edge + c.dist * c.sign, c.at] : [c.at, c.edge + c.dist * c.sign];
      const len = c.dist;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(c.axis === 0 ? len : 0.035, 0.01, c.axis === 0 ? 0.035 : len), this.accentMat);
      bar.position.set((a[0] + b[0]) / 2, 0.08, (a[1] + b[1]) / 2);
      this.guideGroup.add(bar);
      for (const p of [a, b]) {
        const tick = new THREE.Mesh(new THREE.BoxGeometry(c.axis === 0 ? 0.035 : 0.3, 0.01, c.axis === 0 ? 0.3 : 0.035), this.accentMat);
        tick.position.set(p[0], 0.08, p[1]);
        this.guideGroup.add(tick);
      }
      const el = document.createElement('div');
      el.className = 'guide-label';
      el.textContent = this.fmt(len);
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
  #overlaps(item) {
    const b = bounds(item);
    const hit = (o) => b[0] < o[2] - 0.02 && b[2] > o[0] + 0.02 && b[1] < o[3] - 0.02 && b[3] > o[1] + 0.02;
    if (this.obstacles().some(hit)) return true;
    if (isFlat(item)) return false;
    return this.items.some((i) => i.id !== item.id && !isFlat(i) && hit(bounds(i)));
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
    for (const c of this.clearances(item)) {
      if (c.dist > 0.001 && c.dist < 0.34) {
        if (c.axis === 0) item.x += c.dist * c.sign; else item.z += c.dist * c.sign;
      }
    }
  }

  // Where a new piece goes: the floor point in the middle of the view.
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
    return { x: 30, z: 18, rot: 0 };
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
      if (!this.enabled || drag) return;
      const id = this.#pick(e);
      if (id == null) {
        empty = { x: e.clientX, y: e.clientY, id: e.pointerId };
        return;
      }
      e.stopImmediatePropagation();
      e.preventDefault();
      if (this.selected !== id) this.select(id);
      const item = this.current;
      const p = this.#floorAt(e);
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, ox: p ? item.x - p.x : 0, oz: p ? item.z - p.z : 0 };
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
      const next = { ...item, x: snap(p.x + drag.ox), z: snap(p.z + drag.oz) };
      if (!this.insideUnit(next.x, next.z)) return;
      this.#snapToWalls(next);
      item.x = next.x; item.z = next.z;
      const g = this.groups.get(item.id);
      g.position.set(item.x, 0, item.z);
      this.#updateGuides();
      this.#renderBar();
    }, { capture: true });

    const end = (e) => {
      if (drag && e.pointerId === drag.id) {
        e.stopImmediatePropagation();
        if (drag.moved) this.changed();
        drag = null;
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
      const walk = this.getMode() === 'walk';
      const step = e.shiftKey ? 1 : 1 / 12;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === 'Escape') this.select(null);
      else if (e.key === 'Delete' || e.key === 'Backspace') this.remove(item.id);
      else if (e.key === 'r' || e.key === 'R') this.rotate(item.id, e.shiftKey ? -90 : 90);
      else if (e.key === ']') this.rotate(item.id, 15);
      else if (e.key === '[') this.rotate(item.id, -15);
      else if (moves[e.key] && !walk) {
        const [dx, dz] = moves[e.key];
        this.update(item.id, { x: snap(item.x + dx), z: snap(item.z + dz) }, { rebuild: false });
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true });
  }

  // ---------------------------------------------------------------- UI
  #bindUI() {
    const $ = (s) => document.querySelector(s);
    this.ui = {
      catalog: $('#catalog'), list: $('#layoutList'), empty: $('#layoutEmpty'), editor: $('#pieceEditor'),
      name: $('#peName'), w: $('#peW'), d: $('#peD'), h: $('#peH'), rot: $('#peRot'), swatches: $('#peSwatches'),
      bar: $('#pieceBar'), barName: $('#pbName'), barDims: $('#pbDims'), toast: $('#toast'),
      banner: $('#shareBanner'), count: $('#furnitureCount'),
    };
    const groups = [...new Set(CATALOG.map((c) => c.group))];
    this.ui.catalog.innerHTML = groups.map((g) => `<h3>${g}</h3><div class="catalog-grid">${CATALOG.filter((c) => c.group === g).map((c) =>
      `<button class="cat-btn" data-type="${c.type}"><b>${c.name}</b><small>${c.build === 'rug' ? `${c.w / 12}' × ${c.d / 12}'` : `${c.w} × ${c.d} in`}</small></button>`).join('')}</div>`).join('');
    this.ui.catalog.addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      this.add(b.dataset.type, this.dropPoint());
      this.onAdded?.();
    });
    this.ui.swatches.innerHTML = SWATCHES.map((s) =>
      `<button class="swatch" data-color="${s.key ?? ''}" aria-label="${s.name}" title="${s.name}" style="background:${s.css ?? '#' + s.hex.toString(16).padStart(6, '0')}"></button>`).join('');
    this.ui.swatches.addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (b && this.current) this.update(this.current.id, { color: b.dataset.color || null });
    });
    const dim = (input, key) => input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!this.current || !Number.isFinite(v) || v <= 0) return this.#renderEditor();
      this.update(this.current.id, { [key]: Math.min(key === 'h' ? 108 : 360, v) / 12 });
    });
    dim(this.ui.w, 'w'); dim(this.ui.d, 'd'); dim(this.ui.h, 'h');
    this.ui.rot.addEventListener('change', () => {
      const v = parseFloat(this.ui.rot.value);
      if (this.current && Number.isFinite(v)) this.update(this.current.id, { rot: v }, { rebuild: false });
    });
    this.ui.name.addEventListener('change', () => {
      if (this.current) this.update(this.current.id, { name: this.ui.name.value.trim().slice(0, 40) || catalogByType[this.current.type].name }, { rebuild: false });
    });
    $('#peDup').addEventListener('click', () => this.current && this.duplicate(this.current.id));
    $('#peDel').addEventListener('click', () => this.current && this.remove(this.current.id));
    this.ui.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-piece]');
      if (b) { this.select(+b.dataset.piece); this.onFocusPiece?.(this.current); }
    });
    this.ui.bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      const item = this.current;
      if (!b || !item) return;
      ({
        ccw: () => this.rotate(item.id, -90),
        cw: () => this.rotate(item.id, 90),
        edit: () => this.onEdit?.(),
        dup: () => this.duplicate(item.id),
        del: () => this.remove(item.id),
        done: () => this.select(null),
      })[b.dataset.act]?.();
    });
    $('#shareLayout').addEventListener('click', () => this.share());
    const clear = $('#clearLayout');
    clear.addEventListener('click', () => {
      if (!this.items.length) return;
      if (clear.dataset.armed) {
        delete clear.dataset.armed;
        clear.textContent = 'Clear all';
        const before = this.items.map((i) => ({ ...i }));
        this.setItems([]);
        this.toast('Cleared the layout', 'Undo', () => this.setItems(before));
      } else {
        clear.dataset.armed = '1';
        clear.textContent = 'Tap again to clear';
        setTimeout(() => { delete clear.dataset.armed; clear.textContent = 'Clear all'; }, 3000);
      }
    });
    $('#keepShared').addEventListener('click', () => { this.viewingShared = false; this.#save(); this.#endShared(); });
    $('#dropShared').addEventListener('click', () => { this.viewingShared = false; this.setItems(this.#readStore()); this.#endShared(); });
  }

  #renderList() {
    const { list, empty, count } = this.ui;
    empty.hidden = this.items.length > 0;
    count.textContent = this.items.length ? `${this.items.length}` : '';
    list.innerHTML = this.items.map((i) =>
      `<li><button class="piece-row" data-piece="${i.id}" aria-current="${i.id === this.selected}"><span>${escapeHTML(i.name)}</span><small>${inches(i.w)} × ${inches(i.d)} in</small></button></li>`).join('');
  }

  #renderEditor() {
    const item = this.current, ui = this.ui;
    ui.editor.hidden = !item;
    this.ui.list.querySelectorAll('[data-piece]').forEach((b) => b.setAttribute('aria-current', String(+b.dataset.piece === this.selected)));
    if (!item) return;
    if (document.activeElement !== ui.name) ui.name.value = item.name;
    if (document.activeElement !== ui.w) ui.w.value = inches(item.w);
    if (document.activeElement !== ui.d) ui.d.value = inches(item.d);
    if (document.activeElement !== ui.h) ui.h.value = inches(item.h);
    if (document.activeElement !== ui.rot) ui.rot.value = String(Math.round(item.rot));
    ui.h.disabled = isFlat(item);
    ui.swatches.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.color || null) === item.color)));
  }

  #renderBar() {
    const item = this.current, ui = this.ui;
    ui.bar.hidden = !item || !this.root.visible;
    if (!item) return;
    ui.barName.textContent = item.name;
    ui.barDims.textContent = `${inches(item.w)} × ${inches(item.d)} in · ${Math.round(item.rot)}°`;
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

  // ---------------------------------------------------------------- saving and sharing
  #readStore() {
    try { return sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || '[]')); } catch { return []; }
  }

  #save() {
    if (this.viewingShared) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.items.map(({ id, ...rest }) => rest))); } catch { /* storage off: layout lives for this visit */ }
  }

  encode() {
    const rows = this.items.map((i) => [i.type, r2(i.w), r2(i.d), r2(i.h), r2(i.x), r2(i.z), Math.round(i.rot), i.color ?? 0, i.name === catalogByType[i.type].name ? 0 : i.name]);
    return b64urlEncode(JSON.stringify(rows));
  }

  static decode(code) {
    const rows = JSON.parse(b64urlDecode(code));
    return sanitize(rows.map(([type, w, d, h, x, z, rot, color, name]) => ({ type, w, d, h, x, z, rot, color: color || null, name: name || undefined })));
  }

  async share() {
    if (!this.items.length) { this.toast('Add some furniture first'); return; }
    const url = `${location.origin}${location.pathname}?layout=${this.encode()}#plan`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: '3D Living Space layout', url }); return; } catch (err) { if (err?.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Share link copied');
    } catch {
      window.prompt('Copy this link', url);
    }
  }

  #loadInitial() {
    const params = new URLSearchParams(location.search);
    const code = params.get('layout');
    const mine = this.#readStore();
    let shared = null;
    if (code) {
      try { shared = LayoutEditor.decode(code); } catch { shared = null; }
    }
    if (shared) {
      const differs = JSON.stringify(mine) !== JSON.stringify(shared);
      this.viewingShared = mine.length > 0 && differs;
      this.setItems(shared);
      if (this.viewingShared) {
        this.ui.banner.hidden = false;
        this.ui.banner.querySelector('span').textContent = `Viewing a shared layout · ${shared.length} piece${shared.length === 1 ? '' : 's'}`;
      } else this.#endShared();
    } else {
      this.setItems(mine);
    }
  }

  #endShared() {
    this.ui.banner.hidden = true;
    const params = new URLSearchParams(location.search);
    if (params.has('layout')) {
      params.delete('layout');
      const q = params.toString();
      history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
    }
  }
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
