import * as THREE from 'three';

// Texture pictures and their quality. Every texture is made up front and
// handed to its material at once, so the copies src/fixtures.js tints from a
// material share it too; its picture is filled in when it's ready (a file
// loaded, a normal map worked out while the page is idle) and swapped in
// place when the quality changes.
//
// Quality 'low' (phones, tablets, small machines) loads the 512 px files,
// keeps code-drawn textures at half size and filters less; 'high' loads the
// 1024 px files. Tools can override the automatic choice per browser.

const KEY = 'livingspace.textures.v1';
const SETTINGS = ['auto', 'low', 'high'];
const MAX = { high: 1024, low: 512 };   // file size, and the largest derived map
const ANISO = { high: 8, low: 4 };
// The pictures sit beside the app, or come inline with a one-file copy of it
// (skill/3d-living-space/scripts/single.mjs), keyed '512/walnut-color'.
const INLINE = globalThis.LIVING_SPACE_TEXTURES ?? null;
const DIR = INLINE ? null : new URL('../assets/tex/', import.meta.url);

let renderer = null, changed = () => {};
let setting = 'auto', quality = 'high';
const sets = [];

// Phones and tablets, and machines with little memory or few cores, get the
// light set. deviceMemory and hardwareConcurrency are missing in some
// browsers; then the pointer decides.
export function autoQuality(r = renderer) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const memory = navigator.deviceMemory ?? 8, cores = navigator.hardwareConcurrency ?? 8;
  const small = (r?.capabilities.maxTextureSize ?? 8192) < 8192;
  return coarse || memory < 4 || cores < 4 || small ? 'low' : 'high';
}

export function initTextures(r, { onChange } = {}) {
  renderer = r;
  if (onChange) changed = onChange;
  try { setting = localStorage.getItem(KEY) ?? 'auto'; } catch { /* storage off */ }
  if (!SETTINGS.includes(setting)) setting = 'auto';
  quality = setting === 'auto' ? autoQuality(r) : setting;
}

export const textureQuality = () => quality;

// Auto, Low or High. Applies live: every texture in use is refilled at the
// new size.
export function setTextureSetting(value) {
  setting = SETTINGS.includes(value) ? value : 'auto';
  try { localStorage.setItem(KEY, setting); } catch { /* storage off */ }
  const q = setting === 'auto' ? autoQuality() : setting;
  if (q === quality) return;
  quality = q;
  for (const s of sets) fill(s);
}

export function anisotropy() {
  return Math.min(ANISO[quality], renderer?.capabilities.getMaxAnisotropy() ?? 1);
}

// ---------------------------------------------------------------------------
// Pictures

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return [c, c.getContext('2d')];
}

// A tiny flat picture to show until the real one is ready.
function swatch(css) {
  const [c, g] = canvas(2, 2);
  g.fillStyle = css; g.fillRect(0, 0, 2, 2);
  return c;
}

// The picture scaled to fit `max` px on its long side (never enlarged).
export function fit(img, max) {
  const w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
  if (k === 1) return img;
  const [c, g] = canvas(w * k, h * k);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// A file under assets/tex/, at the size the quality asks for.
export function load(name, q = quality) {
  const url = INLINE ? INLINE[`${MAX[q]}/${name}`] : new URL(`${MAX[q]}/${name}.webp`, DIR).href;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Texture ${name} didn't load`));
    img.src = url;
  });
}

function gray(img, w, h) {
  const [, g] = canvas(w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}

function put(w, h, each) {
  const [c, g] = canvas(w, h);
  const img = g.createImageData(w, h);
  each(img.data);
  g.putImageData(img, 0, 0);
  return c;
}

// Normal map from a height picture (Sobel, wrapping at the edges so it tiles).
// `relief` is how far a full black-to-white step stands, in feet; `feet` is
// the surface the picture covers, so the slopes come out right at any size.
function normals(H, w, h, relief, [fu, fv]) {
  const sx = (relief * w) / fu / 8, sy = (relief * h) / fv / 8;
  return put(w, h, (o) => {
    for (let y = 0; y < h; y++) {
      const up = ((y + h - 1) % h) * w, row = y * w, dn = ((y + 1) % h) * w;
      for (let x = 0; x < w; x++) {
        const l = (x + w - 1) % w, r = (x + 1) % w;
        const dx = H[up + r] + 2 * H[row + r] + H[dn + r] - H[up + l] - 2 * H[row + l] - H[dn + l];
        const dy = H[dn + l] + 2 * H[dn + x] + H[dn + r] - H[up + l] - 2 * H[up + x] - H[up + r];
        // Picture rows run down while v runs up, hence +dy.
        const nx = -dx * sx, ny = dy * sy, k = 127.5 / Math.sqrt(nx * nx + ny * ny + 1);
        const i = (row + x) * 4;
        o[i] = 127.5 + nx * k; o[i + 1] = 127.5 + ny * k; o[i + 2] = 127.5 + k; o[i + 3] = 255;
      }
    }
  });
}

// A gray picture from a height picture: v = a + b * height, clamped.
function ramp(H, w, h, a, b) {
  return put(w, h, (o) => {
    for (let i = 0; i < H.length; i++) {
      const v = Math.max(0, Math.min(255, (a + b * H[i]) * 255));
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v; o[i * 4 + 3] = 255;
    }
  });
}

// ---------------------------------------------------------------------------
// Texture sets

// Work that can wait (normal maps, roughness) runs while the page is idle, a
// piece at a time, so it never holds up a frame for long.
const queue = [];
let pumping = false;
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 40));
function later(job) {
  queue.push(job);
  if (!pumping) { pumping = true; idle(pump); }
}
function pump() {
  const job = queue.shift();
  try { job?.(); } catch (err) { console.error(err); }
  if (queue.length) idle(pump);
  else pumping = false;
}

function swap(tex, image) {
  if (!tex || !image) return;
  tex.dispose(); // a new size needs new GPU storage
  tex.image = image;
  tex.anisotropy = anisotropy();
  tex.needsUpdate = true;
}

function texture(image, feet, srgb) {
  const t = new THREE.Texture(image);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / feet[0], 1 / feet[1]);
  t.anisotropy = anisotropy();
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// One material's textures. UVs are in feet; `feet` is the surface one tile of
// the pictures covers. `make(quality)` returns (or promises) the pictures:
//   color   the color map (or a gray tone the material's color tints)
//   height  a height picture: the normal map is worked out from it (`relief`:
//           how far black stands below white, in feet), and so is the
//           roughness map (`rough: [at black, at white]`), unless
//   rough   a roughness picture is given instead (`rough: true`)
// `tone: [a, b]` makes the color map from the height when there's no color.
// `detail` scales the worked-out maps down (fine weaves need less there).
// Values in roughness maps multiply the material's roughness. `now` draws the
// color map at once, as code-drawn ones always were; otherwise it shows
// `placeholder` (a CSS color) until its picture arrives.
export function textureSet(spec) {
  const { feet, placeholder = '#ccc', relief = 0, rough = null, roughAt = 1, now = false } = spec;
  const r = Math.round(roughAt * 255);
  const s = {
    spec,
    map: spec.color !== false ? texture(swatch(placeholder), feet, true) : null,
    normalMap: relief ? texture(swatch('#8080ff'), feet, false) : null,
    roughnessMap: rough ? texture(swatch(`rgb(${r},${r},${r})`), feet, false) : null,
    gen: 0,
  };
  sets.push(s);
  if (now) {
    const pics = spec.make(quality);
    if (s.map && pics.color) { s.map.image = pics.color; s.map.needsUpdate = true; }
    derive(s, pics, ++s.gen, quality);
  } else fill(s);
  return { map: s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap };
}

async function fill(s) {
  const gen = ++s.gen, q = quality;
  let pics;
  try { pics = await s.spec.make(q); } catch (err) { console.warn(err.message); return; }
  if (gen !== s.gen) return; // the quality changed meanwhile
  if (pics.color) swap(s.map, pics.color);
  else if (s.map) s.map.anisotropy = anisotropy();
  changed();
  derive(s, pics, gen, q);
}

function derive(s, pics, gen, q) {
  const { spec } = s;
  if (!pics.height && !pics.rough) return;
  later(() => {
    if (gen !== s.gen) return;
    if (pics.height && spec.tone && !pics.color) {
      const src = fit(pics.height, MAX[q]), w = src.width, h = src.height;
      swap(s.map, ramp(gray(src, w, h), w, h, spec.tone[0], spec.tone[1] - spec.tone[0]));
    }
    if (pics.height && (s.normalMap || Array.isArray(spec.rough))) {
      const src = fit(pics.height, MAX[q] * (spec.detail ?? 1)), w = src.width, h = src.height;
      const H = gray(src, w, h);
      if (s.normalMap) swap(s.normalMap, normals(H, w, h, spec.relief, spec.feet));
      if (Array.isArray(spec.rough) && !pics.rough) swap(s.roughnessMap, ramp(H, w, h, spec.rough[0], spec.rough[1] - spec.rough[0]));
    }
    if (pics.rough) swap(s.roughnessMap, pics.rough);
    changed();
  });
}

// The Tools tab's Auto / Low / High buttons, and the note under them.
export function bindTextureControl(group, note) {
  if (!group) return;
  const name = (q) => (q === 'low' ? 'Low' : 'High');
  const render = () => {
    group.querySelectorAll('[data-quality]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.quality === setting)));
    if (note) note.textContent = `Auto picks ${name(autoQuality())} on this device. Low loads smaller pictures and uses less graphics memory, for phones and tablets.`;
  };
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[data-quality]');
    if (!b) return;
    setTextureSetting(b.dataset.quality);
    render();
  });
  render();
}
