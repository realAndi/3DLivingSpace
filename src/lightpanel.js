import { sunAt, clockMinutes } from './lighting.js';

// The lights panel: a sun (or moon) button on the stage opens a small popover
// with the time of day (a slider, and Now to follow the clock) and every
// room's ceiling lights, plus all on, all off and back to auto. The time and
// the switches are this viewer's own and last the visit (src/lighting.js).

const fmt = (min) => {
  const m = Math.round(min) % 1440;
  return new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// The slider's track: today's sky, hour by hour, from night through dawn,
// day and dusk.
function skyTrack() {
  const today = new Date(), stops = [];
  for (let h = 0; h <= 24; h++) {
    const e = sunAt(today, h * 60).el;
    const c = e < -8 ? '#25304d' : e < -2 ? '#5b5476' : e < 4 ? '#d98e66' : e < 14 ? '#e9c38f' : '#9cc4e4';
    stops.push(`${c} ${((h / 24) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export function createLightPanel({ lighting, button, pop, getMode, onOpen }) {
  const $ = (s) => pop.querySelector(s);
  const slider = $('#lpTime'), clock = $('#lpClock'), now = $('#lpNow'), list = $('#lpRooms');
  let shownRooms = '';

  function open(on) {
    pop.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (on) {
      slider.style.setProperty('--lp-track', skyTrack());
      render();
      onOpen?.();
    }
  }

  function render() {
    const t = lighting.time;
    button.classList.toggle('night', lighting.night);
    if (pop.hidden) return;
    clock.textContent = fmt(t.now ? clockMinutes() : t.minutes);
    now.setAttribute('aria-pressed', String(t.now));
    if (document.activeElement !== slider) slider.value = String(Math.round(t.minutes));
    $('#lpNote').hidden = getMode() !== 'plan';
    const rooms = lighting.rooms;
    const ids = rooms.map((r) => r.id).join('|');
    if (ids !== shownRooms) {
      shownRooms = ids;
      list.textContent = '';
      for (const r of rooms) {
        const b = document.createElement('button');
        b.className = 'lp-room';
        b.dataset.room = r.id;
        b.innerHTML = '<span class="lp-bulb" aria-hidden="true"></span><span class="lp-name"></span><small></small>';
        b.querySelector('.lp-name').textContent = r.name;
        list.append(b);
      }
      $('#lpEmpty').hidden = rooms.length > 0;
    }
    for (const r of rooms) {
      const b = list.querySelector(`[data-room="${CSS.escape(r.id)}"]`);
      b.setAttribute('aria-pressed', String(r.on));
      b.querySelector('small').textContent = r.auto ? 'Auto' : '';
      b.title = `${r.name}: ${r.on ? 'on' : 'off'}${r.auto ? ' (auto: on while it\'s dark out)' : ''}`;
    }
  }

  button.addEventListener('click', () => open(pop.hidden));
  $('#lpClose').addEventListener('click', () => { open(false); button.focus(); });
  slider.addEventListener('input', () => lighting.setTime({ minutes: Number(slider.value) }));
  now.addEventListener('click', () => lighting.setTime({ now: true }));
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-room]');
    if (b) lighting.toggleRoom(b.dataset.room);
  });
  $('.lp-all').addEventListener('click', (e) => {
    const b = e.target.closest('[data-all]');
    if (b) lighting.setAll({ on: true, off: false, auto: null }[b.dataset.all]);
  });
  // Closes on Esc and on a press anywhere else.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) open(false); });
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !button.contains(e.target)) open(false);
  }, true);
  lighting.onChange(render);
  render();
  return { open, render };
}
