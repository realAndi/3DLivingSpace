// The plan as a PNG, drawn the way server/render.js draws it but with resvg's
// WebAssembly build: no native module to install, so it runs wherever Node
// does. Same resvg version, the same IBM Plex fonts (OFL) and options, so the
// picture comes out the same as the server's, byte for byte.
//
// Loading the wasm takes a moment, so nothing happens until ready() is
// awaited; only render_plan and doctor pay for it.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

export const FONT_FILES = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf', 'IBMPlexMono-Regular.ttf'];
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
// Packaged, the fonts and the wasm sit beside this file; in the repo, they are
// the server's fonts and the package's own wasm.
export const FONT_DIR = existsSync(here('./fonts')) ? here('./fonts') : here('../../../server/fonts');
const wasmPath = () => (existsSync(here('./vendor/resvg/index_bg.wasm'))
  ? here('./vendor/resvg/index_bg.wasm')
  : createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'));

let fonts = null;
export async function ready() {
  if (fonts) return;
  await initWasm(readFileSync(wasmPath()));
  fonts = FONT_FILES.map((f) => readFileSync(join(FONT_DIR, f)));
}

export function png(svg) {
  if (!fonts) throw new Error('The renderer isn\'t loaded: await ready() first.');
  return new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: 'IBM Plex Sans' } }).render().asPng();
}

// For doctor: a line in each font, drawn; ink counts the pixels it covered,
// so 0 means the fonts didn't load.
export async function selfTest() {
  const t0 = performance.now();
  await ready();
  const line = (y, family, weight = 400) => `<text x="8" y="${y}" font-family="${family}" font-weight="${weight}" font-size="16">Living 144 x 180</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">${line(20, 'IBM Plex Sans')}${line(44, 'IBM Plex Sans', 600)}${line(68, 'IBM Plex Mono')}</svg>`;
  const image = new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: 'IBM Plex Sans' } }).render();
  let ink = 0;
  for (let i = 3; i < image.pixels.length; i += 4) if (image.pixels[i] > 0) ink++;
  return { ms: Math.round(performance.now() - t0), width: image.width, height: image.height, ink };
}
