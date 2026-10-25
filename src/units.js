// Display units, per viewer: everything the browser shows as a length or an
// area goes through here. Stored values stay in feet (and the MCP in inches).
//
//   ftin  Feet & inches, the original look: rooms 12'7", pieces in inches (84 × 36 in)
//   in    Inches only: 151", halves as ½
//   cm    Centimeters: 384 cm, areas in m²

const KEY = 'livingspace.displayUnits.v1';
export const UNIT_CHOICES = [
  { key: 'ftin', name: 'Feet & inches' },
  { key: 'in', name: 'Inches' },
  { key: 'cm', name: 'Centimeters' },
];
const valid = (u) => UNIT_CHOICES.some((c) => c.key === u);
const CM = 30.48;

let current = 'ftin';
try { const v = localStorage.getItem(KEY); if (valid(v)) current = v; } catch { /* storage off */ }

// Fires 'change' when the setting changes, here or in another tab.
export const unitEvents = new EventTarget();
export const onUnitsChange = (fn) => unitEvents.addEventListener('change', fn);
addEventListener('storage', (e) => {
  if (e.key === KEY && valid(e.newValue) && e.newValue !== current) { current = e.newValue; unitEvents.dispatchEvent(new Event('change')); }
});

export function getUnits() { return current; }
export function setUnits(u) {
  if (!valid(u) || u === current) return;
  current = u;
  try { localStorage.setItem(KEY, u); } catch { /* still applies for this visit */ }
  unitEvents.dispatchEvent(new Event('change'));
}

// 30.5 → "30½"
const halves = (inches) => {
  const v = Math.round(inches * 2) / 2;
  const whole = Math.floor(v);
  return v === whole ? String(whole) : `${whole || ''}½`;
};
// 30.5 → "30.5", as the piece sizes always read.
const decimalInches = (inches) => {
  const v = Math.round(inches * 2) / 2;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

// A length in the room: 12'7", 151", 384 cm.
export function fmtLen(ft) {
  if (current === 'cm') return `${Math.round(ft * CM)} cm`;
  if (current === 'in') return `${halves(ft * 12)}"`;
  const t = Math.round(ft * 12);
  return `${Math.floor(t / 12)}'${t % 12}"`;
}

// Two room dimensions: 12'7" × 19'9", 151" × 237", 384 × 602 cm.
export function fmtDims(a, b) {
  if (current === 'cm') return `${Math.round(a * CM)} × ${Math.round(b * CM)} cm`;
  return `${fmtLen(a)} × ${fmtLen(b)}`;
}

// A piece's size, width × depth (× height): 84 × 36 × 34 in, 213 × 91 × 86 cm.
export function fmtSize(...dims) {
  if (current === 'cm') return `${dims.map((v) => Math.round(v * CM)).join(' × ')} cm`;
  return `${dims.map((v) => (current === 'in' ? halves(v * 12) : decimalInches(v * 12))).join(' × ')} in`;
}

// A rug's size, which reads in feet in the original look: 8' × 10'.
export function fmtRug(w, d) {
  if (current === 'ftin') return `${Math.round(w * 2) / 2}' × ${Math.round(d * 2) / 2}'`;
  return fmtSize(w, d);
}

export function fmtArea(sqft) {
  if (current === 'cm') {
    const m2 = sqft * 0.09290304;
    return `${m2 < 10 ? m2.toFixed(1) : Math.round(m2)} m²`;
  }
  return `${Math.round(sqft)} sq ft`;
}

// The piece editor's number fields: inches, or centimeters in cm mode.
export const inputUnit = () => (current === 'cm' ? 'cm' : 'in');
export function toInput(ft) {
  if (current === 'cm') return String(Math.round(ft * CM));
  return decimalInches(ft * 12);
}
export function fromInput(value) {
  const v = parseFloat(String(value).replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  return current === 'cm' ? v / CM : v / 12;
}

// A round length for the plan's scale bar that is at least minFt long:
// feet, or meters in cm mode. Returns { ft, label }.
export function scaleStep(minFt) {
  if (current === 'cm') {
    const m = [0.5, 1, 2, 5, 10, 20, 50, 100].find((v) => v / 0.3048 >= minFt) ?? 100;
    return { ft: m / 0.3048, label: `${m} m` };
  }
  const f = [1, 2, 5, 10, 20, 50, 100, 200].find((v) => v >= minFt) ?? 200;
  return { ft: f, label: `${f} ft` };
}
