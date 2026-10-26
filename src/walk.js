const DEG = Math.PI / 180;
const wrap = (a) => ((a % 360) + 540) % 360 - 180;

// First-person controls. With a mouse, a click locks the pointer and the mouse looks
// around like a shooter (Esc frees it). On touch, or where the lock is refused, drag to
// look and tap the floor to walk there. WASD / arrows / joystick move; E uses
// what you face (a door, a drawer, a lamp: onInteract), and a tap or a click at
// the crosshair uses what's there (pick() says { type: 'use', key }). Yaw is a
// compass bearing (0 = plan north).
export class WalkControls {
  #enabled = false;
  #overlay = null;
  #wasLocked = false;
  #lockPending = false;
  #lockByPromise = false;
  #pendingTap = null;

  constructor(camera, dom, { isBlocked, pick, onUse, onInteract, onUserMove, canLock = () => true, onLockChange }) {
    Object.assign(this, { camera, dom, isBlocked, pick, onUse, onInteract, onUserMove, canLock, onLockChange });
    this.x = 0; this.z = 0; this.y = 5.2; this.yaw = 0; this.pitch = 0; this.roll = 0;
    this.enabled = false;
    this.keys = new Set();
    this.joy = { x: 0, y: 0 };
    this.glide = null;
    this.tween = null;
    this.speed = 5.5;
    this.radius = 0.7;
    this.lookSpeed = 0.15; // degrees per pixel of locked mouse movement at a 70° fov
    this.lookScale = 1;    // the viewer's look-speed setting, a multiplier on every way of looking
    camera.rotation.order = 'YXZ';
    this.#bindPointer();
    this.#bindKeys();
  }

  get enabled() { return this.#enabled; }
  set enabled(on) {
    this.#enabled = !!on;
    if (!on) this.unlock();
    this.#syncOverlay();
  }

  // True while the mouse is captured for FPS look.
  get locked() { return document.pointerLockElement === this.dom; }

  unlock() {
    if (this.locked) document.exitPointerLock();
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
    if (this.locked && !this.canLock()) this.unlock();
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
    // With the mouse locked it does the turning, so the side arrows strafe like A / D.
    const strafe = this.locked;
    if (k.has('KeyA') || (strafe && k.has('ArrowLeft'))) side -= 1;
    if (k.has('KeyD') || (strafe && k.has('ArrowRight'))) side += 1;
    if (!strafe && k.has('ArrowLeft')) turn -= 1;
    if (!strafe && k.has('ArrowRight')) turn += 1;
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

  // Turns the view by degrees: positive `right` turns right, positive `down` looks down.
  #look(right, down) {
    this.yaw += right;
    this.pitch = Math.max(-85, Math.min(85, this.pitch - down));
    this.tween = null;
    this.roll = 0;
    this.apply();
    this.onUserMove?.('look');
  }

  #tapAt(x, y) {
    const hit = this.pick(x, y);
    if (hit?.type === 'use') this.onUse?.(hit.key);
    else if (hit?.type === 'floor') {
      this.glide = { x: hit.point.x, z: hit.point.z };
      this.tween = null;
      this.onUserMove?.();
    }
  }

  // Chrome returns a promise; Safari and Firefox return nothing and answer with
  // pointerlockchange / pointerlockerror instead. No unadjustedMovement: raw input
  // skips the system's pointer acceleration, which makes trackpads crawl.
  #requestLock() {
    this.#lockPending = true;
    let req;
    try { req = this.dom.requestPointerLock(); } catch { req = Promise.reject(); }
    this.#lockByPromise = typeof req?.then === 'function';
    if (this.#lockByPromise) req.catch(() => this.#lockRefused());
  }

  // The press that asked for the lock falls back to drag to look; a click acts where it landed.
  #lockRefused() {
    if (!this.#lockPending) return;
    this.#lockPending = false;
    const tap = this.#pendingTap;
    this.#pendingTap = null;
    if (tap && this.enabled) this.#tapAt(tap.x, tap.y);
  }

  #bindPointer() {
    const el = this.dom;
    const coarse = matchMedia('(pointer: coarse)');
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (this.locked) {
        // Locked: a click uses what's at the crosshair, and does nothing else.
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        const hit = this.pick(r.left + r.width / 2, r.top + r.height / 2);
        if (hit?.type === 'use') this.onUse?.(hit.key);
        return;
      }
      if (drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() };
      el.setPointerCapture(e.pointerId);
      // A mouse click on a desktop grabs the cursor; until the lock lands (or if it's refused,
      // as in a sandboxed iframe) the press drags to look.
      if (e.pointerType === 'mouse' && e.button === 0 && !coarse.matches && el.requestPointerLock && this.canLock()) {
        drag.locking = true;
        this.#requestLock();
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // Like moving a camera: drag right to turn right, down to look down.
      const degPerPx = ((1.3 * this.camera.fov) / el.clientHeight) * this.lookScale;
      this.#look((e.clientX - drag.x) * degPerPx, (e.clientY - drag.y) * degPerPx);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const tap = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 7 && performance.now() - drag.t < 450;
      const { locking } = drag;
      drag = null;
      if (!tap || e.type === 'pointercancel') return;
      // The click that asks for the lock does nothing else, unless the lock is refused.
      if (locking && this.#lockPending) this.#pendingTap = { x: e.clientX, y: e.clientY };
      else this.#tapAt(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // Locked, the mouse reports movement and no position.
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || !this.locked) return;
      const dx = e.movementX, dy = e.movementY;
      // Some browsers report one wild jump right after locking.
      if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return;
      const degPerPx = ((this.lookSpeed * this.camera.fov) / 70) * this.lookScale;
      if (dx || dy) this.#look(dx * degPerPx, dy * degPerPx);
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = this.locked;
      this.#lockPending = false;
      this.#pendingTap = null;
      if (locked) {
        if (drag) { try { el.releasePointerCapture(drag.id); } catch {} drag = null; }
        // Walk was switched off while the lock was on its way.
        if (!this.enabled) { document.exitPointerLock(); return; }
      }
      this.#syncOverlay();
      if (locked !== this.#wasLocked) {
        this.#wasLocked = locked;
        this.onLockChange?.(locked);
      }
    });
    document.addEventListener('pointerlockerror', () => { if (!this.#lockByPromise) this.#lockRefused(); });
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
      if (e.code === 'KeyE') { if (!e.repeat) this.onInteract?.(); e.preventDefault(); return; }
      if (/^(Key[WASD]|Arrow\w+|Shift\w+)$/.test(e.code)) { this.keys.add(e.code); this.tween = null; e.preventDefault(); }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.unlock(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.unlock(); });
  }

  // Crosshair and the Esc reminder, shown only while the mouse is locked in Walk.
  #syncOverlay() {
    const show = this.enabled && this.locked;
    if (!this.#overlay && show) this.#overlay = makeOverlay(this.dom.parentElement || document.body);
    for (const node of this.#overlay || []) node.hidden = !show;
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

// Crosshair and "Esc" pill while the cursor is locked (styled in index.html).
function makeOverlay(parent) {
  const cross = document.createElement('div');
  cross.className = 'walk-crosshair';
  cross.setAttribute('aria-hidden', 'true');
  const pill = document.createElement('div');
  pill.className = 'walk-lock-pill';
  pill.innerHTML = '<kbd>E</kbd> use &nbsp; <kbd>Esc</kbd> free the cursor';
  parent.append(cross, pill);
  return [cross, pill];
}
