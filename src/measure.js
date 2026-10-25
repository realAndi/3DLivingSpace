import * as THREE from 'three';
import { fmtLen } from './units.js';

// A tape measure that works in every view. In Plan it measures along the floor
// and snaps to wall faces; in Dollhouse and Walk it measures between any two
// surface points (floor, walls, counters, furniture), so heights work too.
// Nearly level, plumb or square lines snap straight. Wall faces come from the
// built unit `U` (setUnit swaps it when the unit is rebuilt); `floors()` is the
// floor mesh group Plan measures on.
export class TapeMeasure {
  constructor(opts) {
    Object.assign(this, opts);
    this.U = opts.U ?? null;
    this.active = false;
    this.start = null;
    this.preview = null;
    this.items = [];
    this.ray = new THREE.Raycaster();
    this.dotGeo = new THREE.SphereGeometry(0.11, 16, 10);
    this.#bind();
  }

  setActive(on) {
    this.active = on;
    if (!on) this.cancel();
    this.onChange?.();
    this.invalidate();
  }

  cancel() {
    this.start = null;
    this.#clearPreview();
    this.invalidate();
  }

  clear() {
    this.items.splice(0).forEach((m) => this.#dispose(m));
    this.cancel();
    this.onChange?.();
  }

  get count() { return this.items.length; }

  setUnit(U) { this.U = U; }

  // The display units changed.
  refreshLabels() {
    for (const m of [...this.items, ...(this.preview ? [this.preview] : [])]) this.#label(m.el, m.a, m.b);
  }

  // ------------------------------------------------------------ picking
  #aim(e) {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.getCamera());
  }

  #point(e) {
    this.#aim(e);
    if (this.getMode() === 'plan') {
      const floors = this.floors();
      const h = floors ? this.ray.intersectObject(floors, true)[0] : null;
      return h ? this.#snap(new THREE.Vector3(h.point.x, 0.06, h.point.z), true) : null;
    }
    const h = this.ray.intersectObjects(this.targets(), true)[0];
    if (!h) return null;
    // Lift off the surface a hair so the line isn't buried in it.
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return this.#snap(h.point.clone().add(n.multiplyScalar(0.01)), false);
  }

  #snap(p, flat) {
    const s = 0.3;
    for (const [x0, z0, x1, z1] of this.U?.wallRects ?? []) {
      if (p.z > z0 - 0.1 && p.z < z1 + 0.1) { if (Math.abs(p.x - x0) < s) p.x = x0; else if (Math.abs(p.x - x1) < s) p.x = x1; }
      if (p.x > x0 - 0.1 && p.x < x1 + 0.1) { if (Math.abs(p.z - z0) < s) p.z = z0; else if (Math.abs(p.z - z1) < s) p.z = z1; }
    }
    if (!flat && p.y < 0.12) p.y = 0.02;
    const a = this.start;
    if (a) {
      const horiz = Math.hypot(p.x - a.x, p.z - a.z);
      if (!flat && horiz < 0.3) { p.x = a.x; p.z = a.z; }          // plumb
      if (Math.abs(p.y - a.y) < 0.15) p.y = a.y;                   // level
      if (Math.abs(p.x - a.x) < 0.3 && horiz >= 0.3) p.x = a.x;    // square to the walls
      if (Math.abs(p.z - a.z) < 0.3 && horiz >= 0.3) p.z = a.z;
    }
    return p;
  }

  #bind() {
    let down = null;
    // Capture phase, so the point lands before the view's own tap handling, which
    // checks `active` and stands down. The events still reach the camera
    // controls, so a drag while measuring still orbits, pans or looks around.
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    }, { capture: true });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.active || !this.start || e.pointerType !== 'mouse' || e.buttons) return;
      const p = this.#point(e);
      if (!p) return;
      this.#clearPreview();
      this.preview = this.#make(this.start, p, true);
      this.invalidate();
    });
    const end = (e) => {
      if (!this.active || !down || e.pointerId !== down.id) return;
      const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 7 && performance.now() - down.t < 500 && e.type === 'pointerup';
      down = null;
      if (!tap) return;
      const p = this.#point(e);
      if (!p) return;
      if (!this.start) {
        this.start = p;
        this.#clearPreview();
        this.preview = this.#make(p, p.clone(), true);
      } else {
        this.#clearPreview();
        if (p.distanceTo(this.start) > 0.04) this.items.push(this.#make(this.start, p, false));
        this.start = null;
        this.onChange?.();
      }
      this.invalidate();
    };
    this.canvas.addEventListener('pointerup', end, { capture: true });
    this.canvas.addEventListener('pointercancel', end, { capture: true });
    addEventListener('keydown', (e) => {
      if (this.active && e.key === 'Escape') { if (this.start) this.cancel(); else this.setActive(false); }
    });
  }

  // ------------------------------------------------------------ drawing
  #make(a, b, isPreview) {
    const group = new THREE.Group();
    const len = a.distanceTo(b);
    if (len > 0.01) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 8), this.material);
      bar.position.copy(a).add(b).multiplyScalar(0.5);
      bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      group.add(bar);
    }
    for (const p of [a, b]) {
      const dot = new THREE.Mesh(this.dotGeo, this.material);
      dot.position.copy(p);
      group.add(dot);
    }
    group.traverse((o) => { o.renderOrder = 45; });
    this.scene.add(group);
    const el = document.createElement('div');
    el.className = `measure-label${isPreview ? ' preview' : ''}`;
    this.#label(el, a, b);
    this.layer.append(el);
    return { group, el, a: a.clone(), b: b.clone(), len };
  }

  // The length, plus rise and run when the line slopes.
  #label(el, a, b) {
    const rise = Math.abs(b.y - a.y), run = Math.hypot(b.x - a.x, b.z - a.z);
    el.textContent = fmtLen(a.distanceTo(b));
    if (rise > 0.08 && run > 0.08) {
      const sub = document.createElement('small');
      sub.textContent = `↕ ${fmtLen(rise)} · ↔ ${fmtLen(run)}`;
      el.append(sub);
    }
  }

  #dispose(m) {
    this.scene.remove(m.group);
    m.group.children.forEach((o) => { if (o.geometry !== this.dotGeo) o.geometry.dispose(); });
    m.el.remove();
  }

  #clearPreview() {
    if (this.preview) { this.#dispose(this.preview); this.preview = null; }
  }

  // Place labels after each render.
  update(cam) {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    const v = new THREE.Vector3();
    for (const m of [...this.items, ...(this.preview ? [this.preview] : [])]) {
      v.copy(m.a).add(m.b).multiplyScalar(0.5).project(cam);
      m.el.hidden = v.z > 1 || m.len < 0.04;
      m.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -150%)`;
    }
  }
}
