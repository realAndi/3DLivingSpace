// Pictures of a unit: the drawings (src/drawing.js) as PNG, set in the IBM
// Plex fonts kept here (OFL). The card is a link preview; the detail plan is
// what the MCP tools hand an agent to compare with the floor plan.
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

export { facts, cardSvg, detailSvg } from '../src/drawing.js';

const FONTS = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf', 'IBMPlexMono-Regular.ttf']
  .map((f) => fileURLToPath(new URL(`./fonts/${f}`, import.meta.url)));

export function png(svg) {
  return new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' } }).render().asPng();
}
