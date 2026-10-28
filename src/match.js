// Match a photo (as a claude.ai Artifact): the viewer picks a photo of a real
// surface (their floor, a counter, the sofa's fabric), boxes the part that
// shows it, and the viewer's own Claude (the `sample` capability, with the
// photo) designs a texture recipe (src/recipes.js) to match. Claude tries a
// recipe with try_texture, which draws it here and measures it against the
// boxed photo (colors, contrast), and adjusts it until they match; then the
// page saves it into the unit (src/claude-store.js saveTexture) and uses it
// for what the viewer chose. The photo goes to Claude only, on the viewer's
// account; nothing keeps it.
//
// createMatch({ session, layout, getU, toast }) → { connect(), open(target) }.
// Targets: 'piece' (the selected piece), 'floor' (the unit's floor), 'room:<id>',
// 'counters', 'cabinets', 'backsplash', 'tile'.

import { cleanTexture, patch, imageStats, compareStats, RECIPE_GUIDE } from './recipes.js';

const $ = (s) => document.querySelector(s);
const CROP = 360;    // the boxed part goes to Claude this many px across, at most
const MEASURE = 160; // and is measured at this size
const TARGETS = {
  piece: 'The selected piece', floor: 'Floors (all rooms)', counters: 'Countertops', cabinets: 'Cabinets',
  backsplash: 'Kitchen backsplash', tile: 'Bath tile',
};
const USE_FOR = { piece: null, floor: 'floor', counters: 'counter', cabinets: 'cabinet', backsplash: 'tile', tile: 'tile' };

const fail = {
  not_granted: 'Claude isn\'t allowed on this page. You can allow it from the Artifact\'s permissions.',
  sampling_disabled: 'Claude isn\'t available on this account.',
  rate_limited: 'Too many requests just now. Try again in a little while.',
  session_expired: 'Sign in to Claude again, then try again.',
  image_rejected: 'That photo couldn\'t be used. Try another one (JPEG or PNG).',
  refused: 'Claude wouldn\'t design this one. Try a different photo.',
  invalid_json: 'Claude\'s answer couldn\'t be read. Try again.',
  empty_completion: 'Claude didn\'t answer. Try again.',
};
const HIDE = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'images_unavailable', 'tools_unavailable']);

export function createMatch({ session, layout, getU, toast }) {
  let sample = null, ok = false;
  const ui = {
    dialog: $('#matchDialog'), close: $('#matchClose'), file: $('#matchFile'), pick: $('#matchPick'),
    crop: $('#matchCrop'), photo: $('#matchPhoto'), box: $('#matchBox'), cropNote: $('#matchCropNote'),
    target: $('#matchTarget'), note: $('#matchNote'), result: $('#matchResult'), sample: $('#matchSample'),
    texture: $('#matchTexture'), score: $('#matchScore'), status: $('#matchStatus'),
    go: $('#matchGo'), stop: $('#matchStop'), use: $('#matchUse'), again: $('#matchAgain'), name: $('#matchName'),
  };
  if (!ui.dialog) return { connect() {}, open() {}, refresh() {} };
  let img = null, box = null, ctl = null, made = null, tries = 0;

  // Shown only where Claude can look at photos and run the page's tool, to editors.
  function refresh() {
    const can = ok && session.canMakeTextures;
    $('#peMatch').hidden = !can;
    $('#matchGroup').hidden = !can;
    if (!can && !ui.dialog.hidden) close();
  }
  async function connect() {
    try { sample = await (window.claude?.use?.('sample') ?? null); } catch { sample = null; }
    const limits = sample ? await sample.limits().catch(() => null) : null;
    ok = !!(limits?.images && limits?.tools);
    if (limits?.images) ui.file.accept = limits.images.mediaTypes.join(',');
    refresh();
  }

  // ---- the dialog
  function open(target = 'floor') {
    if (!ok) return;
    const U = getU(), piece = layout.current;
    const options = Object.entries(TARGETS).filter(([k]) => k !== 'piece' || piece)
      .map(([k, v]) => `<option value="${k}">${k === 'piece' ? `${esc(piece.name)}` : v}</option>`);
    const rooms = U.rooms.filter((r) => !r.outdoor).map((r) => `<option value="room:${esc(r.id)}">Floor: ${esc(r.name)}</option>`);
    ui.target.innerHTML = [...options, ...rooms].join('');
    ui.target.value = target === 'piece' && !piece ? 'floor' : target;
    reset();
    ui.dialog.hidden = false;
    ui.dialog.focus();
  }
  function close() {
    ctl?.abort();
    ui.dialog.hidden = true;
    img = null;
  }
  function reset() {
    made = null; tries = 0;
    ui.result.hidden = true; ui.use.hidden = true; ui.again.hidden = true; ui.stop.hidden = true;
    ui.go.hidden = false; ui.go.disabled = !img;
    ui.pick.hidden = !!img; ui.crop.hidden = !img; ui.cropNote.hidden = !img;
    ui.status.textContent = '';
    ui.name.textContent = '';
  }
  ui.close.addEventListener('click', close);
  ui.dialog.addEventListener('click', (e) => { if (e.target === ui.dialog) close(); });
  ui.dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  $('#peMatch')?.addEventListener('click', () => open('piece'));
  $('#matchGroup')?.addEventListener('click', (e) => { const b = e.target.closest('[data-match]'); if (b) open(b.dataset.match); });
  $('#matchChange')?.addEventListener('click', () => ui.file.click());

  // ---- the photo, and the box around the surface in it
  ui.file.addEventListener('change', async () => {
    const f = ui.file.files?.[0];
    ui.file.value = '';
    if (!f) return;
    try {
      img = await createImageBitmap(f, { imageOrientation: 'from-image' });
    } catch {
      ui.status.textContent = 'That photo couldn\'t be opened. Try a JPEG or PNG.';
      return;
    }
    // Drawn at up to 900 px; the page shows it smaller.
    const k = Math.min(1, 900 / Math.max(img.width, img.height));
    ui.photo.width = Math.round(img.width * k); ui.photo.height = Math.round(img.height * k);
    ui.photo.getContext('2d').drawImage(img, 0, 0, ui.photo.width, ui.photo.height);
    // A square in the middle, to start.
    const s = Math.min(img.width, img.height) * 0.5;
    box = { x: (img.width - s) / 2, y: (img.height - s) / 2, w: s, h: s };
    reset();
    requestAnimationFrame(drawBox);
  });
  // The box over the photo as it's shown (scaled, and centered in its frame).
  function drawBox() {
    if (!img || !box) return;
    const r = ui.photo.getBoundingClientRect(), c = ui.crop.getBoundingClientRect(), k = r.width / img.width;
    Object.assign(ui.box.style, { left: `${r.left - c.left + box.x * k}px`, top: `${r.top - c.top + box.y * k}px`, width: `${box.w * k}px`, height: `${box.h * k}px` });
  }
  addEventListener('resize', () => { if (!ui.dialog.hidden) drawBox(); });
  // Drag inside the box to move it; drag elsewhere to draw a new one.
  let drag = null;
  ui.crop.addEventListener('pointerdown', (e) => {
    if (!img || ctl) return;
    const r = ui.photo.getBoundingClientRect(), k = img.width / r.width;
    const p = { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    const inside = p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h;
    drag = { k, r, from: p, start: { ...box }, move: inside, id: e.pointerId };
    ui.crop.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  ui.crop.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = { x: (e.clientX - drag.r.left) * drag.k, y: (e.clientY - drag.r.top) * drag.k };
    const clampX = (v) => Math.max(0, Math.min(img.width, v)), clampY = (v) => Math.max(0, Math.min(img.height, v));
    if (drag.move) {
      const dx = p.x - drag.from.x, dy = p.y - drag.from.y;
      box = { ...drag.start, x: Math.max(0, Math.min(img.width - drag.start.w, drag.start.x + dx)), y: Math.max(0, Math.min(img.height - drag.start.h, drag.start.y + dy)) };
    } else {
      const x0 = clampX(Math.min(drag.from.x, p.x)), x1 = clampX(Math.max(drag.from.x, p.x));
      const y0 = clampY(Math.min(drag.from.y, p.y)), y1 = clampY(Math.max(drag.from.y, p.y));
      if (x1 - x0 > 8 && y1 - y0 > 8) box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    drawBox();
  });
  const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  ui.crop.addEventListener('pointerup', end);
  ui.crop.addEventListener('pointercancel', end);

  // The boxed part: a JPEG for Claude, and its pixels, measured.
  function boxed(size) {
    const k = Math.min(1, size / Math.max(box.w, box.h));
    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(box.w * k)); c.height = Math.max(8, Math.round(box.h * k));
    c.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    return c;
  }
  const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  function show(canvas, rgba, w, h) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'), d = ctx.createImageData(w, h);
    d.data.set(rgba);
    ctx.putImageData(d, 0, 0);
  }

  // ---- asking Claude
  ui.go.addEventListener('click', () => run());
  ui.again.addEventListener('click', () => run());
  ui.stop.addEventListener('click', () => ctl?.abort());

  async function run() {
    if (!img || !sample || ctl) return;
    const target = ui.target.value, use = target.startsWith('room:') ? 'floor' : USE_FOR[target];
    const what = target.startsWith('room:') ? `the floor of ${getU().roomById[target.slice(5)]?.name ?? 'a room'}` : target === 'piece' ? `the ${layout.current?.name ?? 'piece'}'s upholstery or main material` : TARGETS[target].toLowerCase();
    const crop = boxed(CROP), small = boxed(MEASURE);
    const px = small.getContext('2d').getImageData(0, 0, small.width, small.height);
    const photo = imageStats(px.data, small.width, small.height);
    ui.result.hidden = false;
    show(ui.sample, px.data, small.width, small.height);
    ui.texture.width = ui.texture.width; // cleared
    ui.score.textContent = 'Texture';
    const blob = await toBlob(crop);
    ctl = new AbortController();
    made = null; tries = 0;
    ui.go.hidden = true; ui.again.hidden = true; ui.use.hidden = true; ui.stop.hidden = false;
    ui.status.textContent = 'Claude is looking at the photo…';
    const tool = {
      name: 'try_texture',
      description: 'Draws a texture recipe and compares it with the photo: returns match (0-100), the measured colors and contrast of the photo and of the texture, their differences, and hints on what to change. Call it with each version of the recipe.',
      inputSchema: { type: 'object', properties: { recipe: { type: 'object', description: 'The texture recipe, as described.' } }, required: ['recipe'] },
      execute: ({ recipe }) => {
        const t = cleanTexture({ ...(recipe ?? {}), id: 'trial', for: recipe?.for ?? use ?? 'other' }, new Set(), []);
        if (!t) throw new Error('That isn\'t a recipe: pass {"recipe": {…}}.');
        const p = patch(t, { px: MEASURE });
        show(ui.texture, p.rgba, p.w, p.h);
        const result = compareStats(photo, imageStats(p.rgba, p.w, p.h));
        tries++;
        ui.score.textContent = `Try ${tries}: ${result.match}% match`;
        ui.status.textContent = `Claude is adjusting it (try ${tries})…`;
        return { ...result, shown_inches_across: p.inches };
      },
    };
    const prompt = `You are matching a texture to a photo for 3D Living Space, a to-scale 3D model of someone's apartment. The image is a close crop of a photo showing ${what}${ui.note.value.trim() ? `; the person says: "${ui.note.value.trim().slice(0, 200)}"` : ''}.

Design a texture recipe that looks like that surface at its real size: read its pattern and sizes (planks or tiles in inches, by things of known size), its main colors (base, two to four close piece colors, the joint color) and its markings (grain, veins, chips, weave). Then call try_texture with the recipe; it draws it and compares it with the photo. Adjust and call it again until match is 85 or more, or after four tries at most. The photo's lighting can make it look darker or yellower than the surface is in daylight; match what you see.

${RECIPE_GUIDE}

${use ? `Use "for": "${use}".` : 'Choose "for" to fit what the surface is.'} When you're done, reply with only the final recipe as one JSON object, including a short "name" like "Oak herringbone".`;
    try {
      const recipe = await sample.json(prompt, { images: [blob], tools: [tool], signal: ctl.signal });
      const t = cleanTexture({ ...(recipe ?? {}), for: recipe?.for ?? use ?? 'other' }, new Set((getU().textures ?? []).map((x) => x.id)), []);
      if (!t) throw { code: 'invalid_json' };
      made = { texture: t, target };
      const p = patch(t, { px: MEASURE });
      show(ui.texture, p.rgba, p.w, p.h);
      const m = compareStats(photo, imageStats(p.rgba, p.w, p.h)).match;
      ui.score.textContent = `${m}% match`;
      ui.name.textContent = t.name;
      ui.status.textContent = 'Here it is. Use it, or try again.';
      ui.use.hidden = false; ui.again.hidden = false;
    } catch (e) {
      if (e?.code === 'cancelled') ui.status.textContent = 'Stopped.';
      else {
        ui.status.textContent = fail[e?.code] ?? 'Something went wrong. Try again.';
        if (HIDE.has(e?.code)) { ok = false; refresh(); }
      }
      ui.again.hidden = false;
    } finally {
      ctl = null;
      ui.stop.hidden = true;
    }
  }

  // ---- using it
  ui.use.addEventListener('click', async () => {
    if (!made) return;
    const { texture, target } = made;
    ui.use.disabled = true;
    ui.status.textContent = 'Saving…';
    try {
      const where = target.startsWith('room:') ? { rooms: [target.slice(5)] } : target === 'piece' ? {} : { finishes: [target] };
      const saved = await session.saveTexture(texture, where);
      if (target === 'piece' && layout.current) layout.update(layout.current.uid, { material: `tex:${saved.id}` });
      close();
      toast(`${saved.name} is in. It's in the unit's textures for Claude too.`);
    } catch (e) {
      ui.status.textContent = e?.message && !e.code ? e.message : 'It couldn\'t be saved. Try again.';
    } finally {
      ui.use.disabled = false;
    }
  });

  return { connect, open, refresh };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
