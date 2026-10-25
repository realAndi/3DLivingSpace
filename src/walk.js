const DEG = Math.PI / 180;
const wrap = (a) => ((a % 360) + 540) % 360 - 180;

// First-person controls: drag to look, WASD / arrows / joystick to move,
// tap the floor to walk there. Yaw is a compass bearing (0 = plan north).
export class WalkControls {
  constructor(camera, dom, { isBlocked, pick, onTapDoor, onUserMove }) {
    Object.assign(this, { camera, dom, isBlocked, pick, onTapDoor, onUserMove });
    this.x = 0; this.z = 0; this.y = 5.2; this.yaw = 0; this.pitch = 0; this.roll = 0;
    this.enabled = false;
    this.keys = new Set();
    this.joy = { x: 0, y: 0 };
    this.glide = null;
    this.tween = null;
    this.speed = 5.5;
    this.radius = 0.7;
    camera.rotation.order = 'YXZ';
    this.#bindPointer();
    this.#bindKeys();
  }

  setPose({ x, y = this.y, z, yaw = this.yaw, pitch = 0, roll = 0 }, { animate = false, duration = 0.9 } = {}) {
    this.glide = null;
    if (!animate) {
      Object.assign(this, { x, y, z, yaw, pitch, roll });
      this.tween = null;
      this.apply();
      return;
    }
    this.tween = {
      from: { x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: this.pitch, roll: this.roll },
      to: { x, y, z, yaw: this.yaw + wrap(yaw - this.yaw), pitch, roll },
      t: 0, duration,
    };
  }

  apply() {
    this.camera.position.set(this.x, this.y, this.z);
    this.camera.rotation.set(this.pitch * DEG, -this.yaw * DEG, this.roll * DEG, 'YXZ');
  }

  // Returns true when the camera moved this frame.
  update(dt) {
    if (!this.enabled) return false;
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      for (const k of ['x', 'y', 'z', 'yaw', 'pitch', 'roll']) this[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * e;
      if (tw.t >= 1) this.tween = null;
      this.apply();
      return true;
    }
    let fwd = 0, side = 0, turn = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
    if (k.has('KeyA')) side -= 1;
    if (k.has('KeyD')) side += 1;
    if (k.has('ArrowLeft') || k.has('KeyQ')) turn -= 1;
    if (k.has('ArrowRight') || k.has('KeyE')) turn += 1;
    fwd -= this.joy.y; side += this.joy.x;
    const run = k.has('ShiftLeft') || k.has('ShiftRight') ? 1.8 : 1;
    let moved = false;
    if (turn) { this.yaw += turn * 90 * dt; this.roll = 0; moved = true; }
    if (fwd || side) {
      this.glide = null;
      this.roll = 0;
      const len = Math.hypot(fwd, side);
      const s = (this.speed * run * dt) / Math.max(1, len);
      const fx = Math.sin(this.yaw * DEG), fz = -Math.cos(this.yaw * DEG);
      this.#tryMove((fwd * fx - side * fz) * s, (fwd * fz + side * fx) * s);
      moved = true;
      this.onUserMove?.();
    } else if (this.glide) {
      const dx = this.glide.x - this.x, dz = this.glide.z - this.z, d = Math.hypot(dx, dz);
      if (d < 0.12) this.glide = null;
      else {
        const s = Math.min(d, Math.max(1.5, Math.min(7, d * 2.5)) * dt);
        if (!this.#tryMove((dx / d) * s, (dz / d) * s)) this.glide = null;
        moved = true;
      }
    }
    if (moved) this.apply();
    return moved;
  }

  #tryMove(dx, dz) {
    const nx = this.x + dx, nz = this.z + dz;
    if (!this.isBlocked(nx, nz, this.radius)) { this.x = nx; this.z = nz; return true; }
    if (!this.isBlocked(nx, this.z, this.radius)) { this.x = nx; return true; }
    if (!this.isBlocked(this.x, nz, this.radius)) { this.z = nz; return true; }
    return false;
  }

  #bindPointer() {
    const el = this.dom;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const degPerPx = this.camera.fov / el.clientHeight;
      this.yaw -= (e.clientX - drag.x) * degPerPx;
      this.pitch = Math.max(-80, Math.min(80, this.pitch + (e.clientY - drag.y) * degPerPx));
      drag.x = e.clientX; drag.y = e.clientY;
      this.tween = null;
      this.roll = 0;
      this.apply();
      this.onUserMove?.('look');
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const tap = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 7 && performance.now() - drag.t < 450;
      drag = null;
      if (!tap || e.type === 'pointercancel') return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit?.type === 'door') this.onTapDoor?.(hit.id);
      else if (hit?.type === 'floor') {
        this.glide = { x: hit.point.x, z: hit.point.z };
        this.tween = null;
        this.onUserMove?.();
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const step = Math.sign(e.deltaY) * -1.2;
      this.#tryMove(Math.sin(this.yaw * DEG) * step, -Math.cos(this.yaw * DEG) * step);
      this.apply();
      this.onUserMove?.();
    }, { passive: false });
  }

  #bindKeys() {
    const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    addEventListener('keydown', (e) => {
      if (!this.enabled || typing() || e.metaKey || e.ctrlKey) return;
      if (/^(Key[WASDQE]|Arrow\w+|Shift\w+)$/.test(e.code)) { this.keys.add(e.code); this.tween = null; e.preventDefault(); }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  // On-screen joystick for touch screens.
  attachJoystick(pad, knob) {
    let id = null, cx = 0, cy = 0;
    const R = () => pad.clientWidth / 2;
    const set = (x, y) => {
      const r = R(), d = Math.hypot(x, y), m = Math.min(1, d / r);
      const nx = d ? (x / d) * m : 0, ny = d ? (y / d) * m : 0;
      this.joy.x = Math.abs(nx) < 0.12 ? 0 : nx;
      this.joy.y = Math.abs(ny) < 0.12 ? 0 : ny;
      knob.style.transform = `translate(${nx * r * 0.6}px, ${ny * r * 0.6}px)`;
    };
    pad.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      const b = pad.getBoundingClientRect();
      cx = b.left + b.width / 2; cy = b.top + b.height / 2;
      pad.setPointerCapture(id);
      set(e.clientX - cx, e.clientY - cy);
      e.stopPropagation();
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e.clientX - cx, e.clientY - cy); });
    const end = (e) => { if (e.pointerId === id) { id = null; set(0, 0); } };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  }

  get active() {
    return !!(this.tween || this.glide || this.keys.size || this.joy.x || this.joy.y);
  }
}
