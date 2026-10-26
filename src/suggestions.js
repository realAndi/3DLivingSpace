import * as THREE from 'three';
import { Batch } from './kit.js';
import { buildPiece } from './furniture.js';
import { catalogByType, SWATCHES, isFlat, nearPiece, placeOf } from './catalog.js';
import { layoutChanges, applyChanges, samePiece, whatChanged } from './changes.js';
import { fmtLen, fmtSize, getUnits } from './units.js';

// Suggestions, in the browser (the server side: server/service.js; the changes
// themselves: src/changes.js). Anyone can make their own version of a unit;
// the copy can then suggest its layout back, like a pull request.
//
// The owner sees the suggestions waiting at the top of the Furnish tab, with a
// count on the tab. One at a time can be previewed: the real furniture hides
// and the result stands in for it, in every view (walking through it is the
// point), with what would change outlined and faint ghosts where pieces were.
// Before and After flip between your layout and the result. Each change has a
// box; the ones that clash with what you changed since start unchecked. Apply
// takes the checked ones (with an Undo), Dismiss drops the suggestion.
//
// A copy: "Suggest your changes" sends its layout to the unit it came from,
// with a note, and says what became of it. Sending again updates it.
//
// The preview is plain pieces from buildPiece, kept per piece, so checking a
// box or flipping Before and After rebuilds only the pieces that differ. They
// have no lights and do nothing when tapped; they do stop you walking.

const POLL_MS = 20000;
const WALK_UNDER = 4;      // as src/layout.js: what hangs higher doesn't stop you walking
const GHOST_MOVE = 0.5;    // a piece moved further than this (feet) leaves a ghost where it was
const KITCHEN = /kitchen|counter|fridge|range|sink|dishwasher|pantry/;
const $ = (s) => document.querySelector(s);
const make = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Short moves read in inches in the original look: 6", not 0'6".
function len(ft) {
  if (getUnits() !== 'ftin' || ft >= 11.75 / 12) return fmtLen(ft);
  const v = Math.round(ft * 24) / 2;
  return `${Math.floor(v) || ''}${v % 1 ? '½' : ''}"`;
}
const nameOf = (s) => s?.author || 'Someone';

// "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", "Oct 2".
function ago(ms, now = Date.now()) {
  const s = (now - ms) / 1000;
  if (!(s >= 0) || s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const list3 = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

// A change group in words: { text, clash }. `names(uid)` finds a piece's name
// in either layout; `fixture(id)` a built-in. Lengths go through src/units.js.
function describe(g, { names = () => null, fixture = () => null } = {}) {
  const [root, ...rest] = g.pieces;
  const what = (p) => verbs(p, names, fixture);
  let text;
  if (root.kind === 'added') text = `${root.name} added${onText(root.theirs, g, names, fixture)}`;
  else if (root.kind === 'removed') text = `${root.name} removed`;
  else {
    const subject = root.what.renamed ? (root.base ?? root.ours).name : root.name;
    text = `${subject} ${list3(what(root)) || 'changed'}`;
  }
  // What rests on it and just goes along; and the rest, said on their own.
  const along = [], own = [];
  for (const p of rest) {
    const follows = p.kind === root.kind && (p.kind !== 'changed' || Object.keys(p.what).every((k) => ['moved', 'turned', 'raised'].includes(k)));
    if (follows) along.push(p);
    else own.push(p.kind === 'added' ? `${p.name} added on it` : p.kind === 'removed' ? `${p.name} removed` : `${p.name} ${list3(what(p)) || 'changed'}`);
  }
  if (along.length) {
    const shown = along.slice(0, 2).map((p) => `the ${p.name}`);
    if (along.length > 2) shown.push(plural(along.length - 2, 'more thing'));
    text += ` with ${list3(shown)} on it`;
  }
  if (own.length) text += `; ${own.join('; ')}`;
  return { text, clash: clashText(g) };
}

// What changed about one piece, as short phrases: ['moved 2\'3"', 'turned 90°'].
function verbs(p, names, fixture) {
  const w = p.what, t = p.theirs, out = [];
  if (w.onto) out.push(ontoText(w.onto, names, fixture));
  else if (w.moved) out.push(`moved ${len(w.moved)}`);
  if (w.raised) out.push(`${w.raised > 0 ? 'raised' : 'lowered'} ${len(Math.abs(w.raised))}`);
  if (w.turned) out.push(`turned ${Math.round(Math.abs(w.turned))}°`);
  if (w.resized) out.push(`resized to ${isFlat(t) ? fmtSize(t.w, t.d) : placeOf(t) === 'wall' ? fmtSize(t.w, t.h) : fmtSize(t.w, t.d, t.h)}`);
  if (w.retyped) out.push(`changed to ${t.type === 'asset' ? t.name : catalogByType[t.type]?.name.toLowerCase() ?? t.name}`);
  if (w.recolored) {
    const sw = SWATCHES.find((s) => s.key === (t.color ?? null));
    out.push(!t.color ? 'back to its own color' : sw ? `recolored ${sw.name.toLowerCase()}` : 'recolored');
  }
  if (w.renamed) out.push(`renamed ${t.name}`);
  return out;
}

function supportName(on, names, fixture) {
  if (on.startsWith('p:')) { const n = names(on.slice(2)); return n ? `the ${n}` : 'another piece'; }
  const f = fixture(on.slice(2));
  return !f ? 'the counter' : f.type === 'island' ? 'the island' : KITCHEN.test(f.type) ? 'the counter' : `the ${f.name.toLowerCase()}`;
}

function ontoText(on, names, fixture) {
  if (on === 'floor') return 'put on the floor';
  if (on === 'wall') return 'hung on the wall';
  if (on === 'ceiling') return 'hung from the ceiling';
  return `moved onto ${supportName(on, names, fixture)}`;
}

// " on the Dresser" for a piece added on something that isn't in its group.
function onText(item, g, names, fixture) {
  const on = item?.on;
  if (!on || on === 'wall' || on === 'ceiling') return '';
  if (on.startsWith('p:') && g.pieces.some((p) => p.uid === on.slice(2))) return '';
  return ` on ${supportName(on, names, fixture)}`;
}

// What the owner did to a piece since the copy was made, as a verb.
function ownVerb(w) {
  if (w.moved || w.onto) return 'moved';
  if (w.turned) return 'turned';
  if (w.resized) return 'resized';
  if (w.recolored) return 'recolored';
  if (w.raised) return w.raised > 0 ? 'raised' : 'lowered';
  if (w.renamed) return 'renamed';
  return 'changed';
}

// Why a group clashes with the owner's own changes, in words, or null.
function clashText(g) {
  const p = g.pieces.find((x) => x.conflict);
  if (!p) return null;
  const it = p === g.pieces[0] ? 'it' : `the ${p.name}`;
  if (p.conflict === 'support') return `What ${it} sits on is gone from yours: it'll go on the floor.`;
  if (p.conflict === 'removed') return `You removed ${it}: taking this puts it back.`;
  const did = p.base && p.ours ? ownVerb(whatChanged(p.base, p.ours)) : null;
  if (p.kind === 'removed') return `You ${did ?? 'changed'} ${it} since: taking this removes it anyway.`;
  return did ? `You ${did} ${it} too: taking theirs replaces yours.` : `You have ${it} too: taking theirs replaces yours.`;
}

// A see-through copy of a material, made once (as src/layout.js does for
// ceiling pieces in Plan).
const ghosts = new WeakMap();
function ghostOf(m) {
  if (!ghosts.has(m)) {
    const c = m.clone();
    c.transparent = true;
    c.opacity = m.opacity * 0.32;
    c.depthWrite = false;
    ghosts.set(m, c);
  }
  return ghosts.get(m);
}
function ghostly(g) {
  g.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(ghostOf) : ghostOf(o.material);
    o.castShadow = false;
  });
}

// Corner brackets around a piece's box (its own frame: footprint centered on
// the origin, from its underside up), a little outside it so they show.
const BAR = 0.075, PAD = 0.09;
function brackets(B, mat, w, h, d) {
  const x = w / 2 + PAD, z = d / 2 + PAD, top = h + PAD;
  const ax = Math.min(0.9, w * 0.3 + PAD), az = Math.min(0.9, d * 0.3 + PAD), ay = Math.min(0.9, h * 0.3 + PAD);
  // Flat pieces (a rug) get the corners of their outline only.
  const levels = h < 0.35 ? [top] : [BAR / 2 + 0.005, top];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const cx = sx * x, cz = sz * z;
    for (const y of levels) {
      B.box(mat, cx + (sx * BAR) / 2, y - BAR / 2, cz - BAR / 2, cx - sx * ax, y + BAR / 2, cz + BAR / 2);
      B.box(mat, cx - BAR / 2, y - BAR / 2, cz + (sz * BAR) / 2, cx + BAR / 2, y + BAR / 2, cz - sz * az);
    }
    if (levels.length > 1) {
      B.box(mat, cx - BAR / 2, 0.005, cz - BAR / 2, cx + BAR / 2, ay, cz + BAR / 2);
      B.box(mat, cx - BAR / 2, top - ay, cz - BAR / 2, cx + BAR / 2, top + BAR / 2, cz + BAR / 2);
    }
  }
}

// Seen from above in Plan: a frame `bw` wide around the footprint, at height y.
function frame(B, mat, w, d, y, bw) {
  const x = w / 2 + PAD, z = d / 2 + PAD, h = bw / 2;
  B.box(mat, -x - h, y, -z - h, x + h, y + 0.01, -z + h);
  B.box(mat, -x - h, y, z - h, x + h, y + 0.01, z + h);
  B.box(mat, -x - h, y, -z + h, -x + h, y + 0.01, z - h);
  B.box(mat, x - h, y, -z + h, x + h, y + 0.01, z - h);
}

// opts: M, scene, layout (src/layout.js), session (src/sync.js), accent (the
// theme's accent material), invalidate, getU() (the built unit), focus(item)
// (frame a piece in the current view), openTab(id), closeSheet() (a phone's
// sheet, so the result and its toast show), onPreview(on) (hide the real
// furniture and stop editing it, or put both back).
export function createSuggestions(opts) {
  const { M, scene, layout, session, invalidate } = opts;
  const ui = {
    tab: $('#t-furniture'), badge: $('#suggestBadge'), body: $('#tab-furniture'),
    group: $('#suggestGroup'), list: $('#sgList'), detail: $('#sgDetail'), back: $('#sgBack'),
    who: $('#sgWho'), when: $('#sgWhen'), note: $('#sgNote'), summary: $('#sgSummary'), changes: $('#sgChanges'),
    apply: $('#sgApply'), dismiss: $('#sgDismiss'), status: $('#sgStatus'),
    bar: $('#suggestBar'), barWho: $('#sbWho'), barSub: $('#sbSub'), sides: $('#sbSides'), barChanges: $('#sbChanges'), done: $('#sbDone'),
    offer: $('#offerGroup'), offerTo: $('#offerTo'), offerName: $('#offerName'), offerNote: $('#offerNote'),
    send: $('#offerSend'), withdraw: $('#offerWithdraw'), offerStatus: $('#offerStatus'),
  };

  let unitId;               // the unit the lists below belong to (undefined: fetch again)
  let waiting = [];         // the suggestions waiting for this unit (its owner's)
  let mine = null;          // what this copy has suggested (session.mySuggestion)
  let view = null;          // the one previewed: { s, groups, chosen: Set of group ids, after }
  let busy = false;         // applying or dismissing
  let sending = false;
  let noteEdited = false;   // the note field has words not yet sent
  let mode = 'dollhouse';
  let lastStatus = null, mineTimer = 0;
  let nameTimer = 0;        // a name typed, not yet handed to the session

  // ---------------------------------------------------------------- preview
  const root = new THREE.Group();
  root.name = 'suggestion';
  scene.add(root);
  const shown = new Map();  // 'p:<uid>' (standing) or 'g:<uid>' (ghost) -> { sig, g }
  // The outline is the theme's accent; in Plan it's drawn over everything,
  // with a dark edge so it shows on a light floor too.
  const outlineMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const planMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, depthTest: false, depthWrite: false });
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0.4, toneMapped: false, transparent: true, depthTest: false, depthWrite: false });
  let outline = null;
  let standing = [];        // the pieces standing in the preview, for walking into

  const changesOf = (s) => layoutChanges({ base: s.base, theirs: s.items, ours: layout.items });

  // What the preview shows: the pieces standing, which of them change (or, in
  // Before, would), and ghosts where moved and removed pieces stand now.
  function previewPlan() {
    const ours = layout.items, ourAssets = Object.values(layout.assets);
    const { s, groups, chosen, after } = view;
    const select = groups.filter((g) => chosen.has(g.id)).map((g) => g.id);
    const out = applyChanges({ base: s.base, theirs: s.items, ours, theirAssets: s.assets ?? [], ourAssets, select });
    const result = new Map(out.items.map((i) => [i.uid, i]));
    if (!after) {
      const marked = new Set(ours.filter((o) => !result.has(o.uid) || !samePiece(o, result.get(o.uid))).map((o) => o.uid));
      return { items: ours, assets: ourAssets, marked, ghosts: [] };
    }
    const byUid = new Map(ours.map((o) => [o.uid, o]));
    const marked = new Set(out.items.filter((i) => !byUid.has(i.uid) || !samePiece(byUid.get(i.uid), i)).map((i) => i.uid));
    const ghosts = ours.filter((o) => {
      const r = result.get(o.uid);
      if (!r) return true;
      const w = whatChanged(o, r);
      return w.onto || (w.moved ?? 0) > GHOST_MOVE || Math.abs(w.raised ?? 0) > GHOST_MOVE;
    });
    return { items: out.items, assets: out.assets, marked, ghosts };
  }

  function drop(g) {
    root.remove(g);
    g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }

  function clearPreview() {
    for (const e of shown.values()) drop(e.g);
    shown.clear();
    dropOutline();
    standing = [];
  }

  // Bring the preview in line with the plan: pieces that didn't change stay,
  // the rest are rebuilt.
  function renderPreview() {
    if (!view) return;
    const plan = previewPlan();
    const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a]));
    const A = byId(plan.assets), ourA = layout.assets;
    const want = new Map();
    // Seen from above in Plan, what hangs from the ceiling is see-through.
    const above = (i) => mode === 'plan' && i.on === 'ceiling';
    for (const i of plan.items) want.set(`p:${i.uid}`, { item: i, assets: A, ghost: above(i) });
    for (const i of plan.ghosts) want.set(`g:${i.uid}`, { item: i, assets: ourA, ghost: true });
    for (const w of want.values()) {
      const asset = w.item.type === 'asset' ? w.assets[w.item.asset] ?? null : null;
      w.sig = `${w.ghost}|${JSON.stringify(w.item)}|${asset ? JSON.stringify(asset) : ''}`;
    }
    for (const [key, e] of shown) if (want.get(key)?.sig !== e.sig) { drop(e.g); shown.delete(key); }
    for (const [key, w] of want) {
      if (shown.has(key)) continue;
      const g = buildPiece(M, w.item, w.assets);
      if (w.ghost) ghostly(g);
      root.add(g);
      shown.set(key, { sig: w.sig, g });
      // A lamp's glow and a screen's picture are the real piece's own
      // materials (src/furniture.js); building switched them off. Put them back.
      const real = layout.groups.get(w.item.uid);
      if (real && g.userData.setState) real.userData.setState?.(real.userData.state);
    }
    standing = plan.items;
    drawOutline(plan.items.filter((i) => plan.marked.has(i.uid)));
    invalidate();
  }

  function dropOutline() {
    if (outline) drop(outline);
    outline = null;
  }

  // Brackets around every piece that changes (in Plan, frames): a mesh or two.
  function drawOutline(items) {
    dropOutline();
    if (!items.length) return;
    outlineMat.color.copy(opts.accent.color);
    planMat.color.copy(opts.accent.color);
    const B = new Batch('suggestion-outline');
    const m = new THREE.Matrix4();
    for (const i of items) {
      m.makeRotationY(-THREE.MathUtils.degToRad(i.rot)).setPosition(i.x, i.y ?? 0, i.z);
      B.push(m);
      if (mode === 'plan') {
        frame(B, edgeMat, i.w, i.d, i.h + PAD, 0.26);
        frame(B, planMat, i.w, i.d, i.h + PAD, 0.12);
      } else brackets(B, outlineMat, i.w, i.h, i.d);
      B.pop();
    }
    outline = B.build({ shadows: false, receive: false });
    for (const o of outline.children) o.renderOrder = o.material === edgeMat ? 36 : 37;
    root.add(outline);
  }

  function preview(s) {
    if (!s || view?.s.id === s.id) return;
    const groups = changesOf(s);
    const first = !view;
    view = { s, groups, chosen: new Set(groups.filter((g) => !g.conflict).map((g) => g.id)), after: true };
    status('');
    if (first) opts.onPreview(true);
    ui.body.classList.add('previewing');
    renderPreview();
    renderPanel();
  }

  function leave() {
    if (!view) return;
    view = null;
    clearPreview();
    ui.body.classList.remove('previewing');
    opts.onPreview(false);
    status('');
    renderPanel();
    scrollToTop();
    invalidate();
  }

  // Scroll the tab back up to the section when it's scrolled past it. (Not
  // scrollIntoView: a closed sheet is off screen, and that would scroll the page.)
  function scrollToTop() {
    const box = ui.group.closest('.tab-body');
    const d = box && !ui.group.hidden ? ui.group.getBoundingClientRect().top - box.getBoundingClientRect().top : 0;
    if (d < 0) box.scrollTop += d;
  }

  // The owner's layout or the suggestion changed: work the changes out again,
  // keeping the boxes as they were (new ones start as clashes say).
  function regroup() {
    if (!view) return;
    const groups = changesOf(view.s);
    const was = new Map(view.groups.map((g) => [g.id, view.chosen.has(g.id)]));
    view.groups = groups;
    view.chosen = new Set(groups.filter((g) => (was.has(g.id) ? was.get(g.id) : !g.conflict)).map((g) => g.id));
    renderPreview();
    renderPanel();
  }

  // ---------------------------------------------------------------- the owner's list
  async function refresh() {
    if (!session.editable || !session.id) return;
    const id = session.id;
    const out = await session.suggestions();
    // Polls fail quietly; what you do yourself says why it didn't work.
    if (session.id !== id || !session.editable || out.error || busy) return;
    waiting = out;
    if (view) {
      const s = waiting.find((x) => x.id === view.s.id);
      if (!s) {
        const who = nameOf(view.s);
        leave();
        layout.toast(`${who}'s suggestion isn't waiting any more.`);
      } else if (s.updatedAt !== view.s.updatedAt) {
        view.s = s;
        regroup();
        layout.toast(`${nameOf(s)} updated their suggestion.`);
      }
    }
    renderPanel();
  }

  function renderBadge() {
    const n = session.editable ? waiting.length : 0;
    ui.badge.hidden = !n;
    ui.badge.textContent = String(n);
    ui.badge.title = `${plural(n, 'suggestion')} waiting`;
  }

  function renderList() {
    ui.list.textContent = '';
    for (const s of waiting) {
      const n = changesOf(s).length;
      const b = make('button', 'sg-row');
      b.dataset.sid = s.id;
      b.setAttribute('aria-current', String(view?.s.id === s.id));
      const top = make('span', 'sg-top');
      top.append(make('b', null, nameOf(s)), make('small', null, ago(s.updatedAt)));
      b.append(top, make('span', 'sg-count', n ? plural(n, 'change') : 'Nothing new'));
      if (s.note) b.append(make('span', 'sg-note', s.note));
      const li = make('li');
      li.append(b);
      ui.list.append(li);
    }
  }

  function renderPanel() {
    renderBadge();
    ui.group.hidden = !session.editable || (!waiting.length && !view);
    // While one is previewed, the others stay in reach to swap to.
    ui.list.hidden = !!view && waiting.length < 2;
    ui.list.classList.toggle('compact', !!view);
    ui.detail.hidden = !view;
    renderList();
    renderBar();
    if (!view) return;
    const { s, groups, chosen } = view;
    ui.back.querySelector('span').textContent = waiting.length > 1 ? 'Close preview' : 'Back';
    ui.who.textContent = nameOf(s);
    ui.when.textContent = ago(s.updatedAt);
    ui.note.textContent = s.note ?? '';
    ui.note.hidden = !s.note;
    const clashes = groups.filter((g) => g.conflict).length;
    ui.summary.textContent = !groups.length ? 'Everything in it is already in your layout.'
      : `${plural(groups.length, 'change')}${clashes ? `, ${clashes} clashing with your own edits` : ''}. Check the ones to take; tap one to see it.`;
    const U = opts.getU();
    const items = new Map([...s.items, ...layout.items].map((i) => [i.uid, i.name]));
    const ctx = { names: (uid) => items.get(uid) ?? null, fixture: (id) => U?.fixtures.find((f) => f.id === id) ?? null };
    ui.changes.textContent = '';
    for (const g of groups) {
      const { text, clash } = describe(g, ctx);
      const li = make('li', `sg-change${clash ? ' clash' : ''}`);
      const label = make('label', 'sg-box');
      const box = make('input');
      box.type = 'checkbox';
      box.checked = chosen.has(g.id);
      box.dataset.gid = g.id;
      box.setAttribute('aria-label', text);
      label.append(box);
      const b = make('button', 'sg-what');
      b.dataset.gid = g.id;
      b.title = 'Show it';
      b.append(make('span', null, text));
      if (clash) b.append(make('small', null, clash));
      li.append(label, b);
      ui.changes.append(li);
    }
    renderApply();
  }

  function renderApply() {
    const n = view?.chosen.size ?? 0;
    ui.apply.textContent = `Apply ${plural(n, 'change')}`;
    ui.apply.disabled = !n || busy;
    ui.dismiss.disabled = busy;
  }

  function renderBar() {
    ui.bar.hidden = !view;
    if (!view) return;
    const n = view.chosen.size;
    ui.barWho.textContent = nameOf(view.s);
    // Phones show the short part only.
    ui.barSub.textContent = '';
    if (view.after) ui.barSub.append(`${n} of ${view.groups.length}`, make('span', 'sb-long', ` change${view.groups.length === 1 ? '' : 's'}`));
    else ui.barSub.append('Your layout', make('span', 'sb-long', ' now'));
    ui.sides.querySelectorAll('[data-side]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.side === 'after') === view.after)));
  }

  function status(text, error = false) {
    ui.status.textContent = text;
    ui.status.dataset.state = error ? 'error' : '';
  }

  // The piece a change is about, where the preview shows it now.
  function focusGroup(gid) {
    const p = view?.groups.find((g) => g.id === gid)?.pieces[0];
    if (!p) return;
    opts.focus(standing.find((i) => i.uid === p.uid) ?? p.ours ?? p.theirs ?? p.base);
  }

  async function apply() {
    if (!view || busy || !view.chosen.size) return;
    const { s } = view, groups = [...view.chosen];
    busy = true;
    renderApply();
    status('Applying…');
    const out = await session.applySuggestion(s.id, groups);
    busy = false;
    if (out.error) { status(out.error, true); renderApply(); return; }
    waiting = waiting.filter((x) => x.id !== s.id);
    leave();
    opts.closeSheet();
    layout.toast(`Applied ${plural(out.applied, 'change')} from ${nameOf(s)}`, 'Undo', () => undo(s));
    refresh();
  }

  async function undo(s) {
    const out = await session.undoSuggestion(s.id);
    if (out.error) { layout.toast(out.error); return; }
    layout.toast(`Undone. ${nameOf(s)}'s suggestion is back in your list.`);
    refresh();
  }

  // Dismissing can't be undone: the first tap asks for a second.
  let armed = 0;
  async function dismiss() {
    if (!view || busy) return;
    if (!armed) {
      ui.dismiss.textContent = 'Tap again to dismiss';
      armed = setTimeout(() => { armed = 0; ui.dismiss.textContent = 'Dismiss'; }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    ui.dismiss.textContent = 'Dismiss';
    const { s } = view;
    busy = true;
    renderApply();
    const out = await session.dismissSuggestion(s.id);
    busy = false;
    if (out.error) { status(out.error, true); renderApply(); return; }
    waiting = waiting.filter((x) => x.id !== s.id);
    leave();
    opts.closeSheet();
    layout.toast(`Dismissed ${nameOf(s)}'s suggestion`);
    refresh();
  }

  function setAfter(after) {
    if (!view || view.after === after) return;
    view.after = after;
    renderPreview();
    renderBar();
  }

  ui.list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sid]');
    if (b) preview(waiting.find((s) => s.id === b.dataset.sid));
  });
  ui.back.addEventListener('click', () => leave());
  ui.changes.addEventListener('change', (e) => {
    const gid = e.target.dataset.gid;
    if (!view || !gid) return;
    if (e.target.checked) view.chosen.add(gid); else view.chosen.delete(gid);
    renderPreview();
    renderApply();
    renderBar();
  });
  ui.changes.addEventListener('click', (e) => {
    const b = e.target.closest('.sg-what');
    if (b) focusGroup(b.dataset.gid);
  });
  ui.apply.addEventListener('click', apply);
  ui.dismiss.addEventListener('click', dismiss);
  ui.sides.addEventListener('click', (e) => {
    const b = e.target.closest('[data-side]');
    if (b) setAfter(b.dataset.side === 'after');
  });
  ui.barChanges.addEventListener('click', () => {
    opts.openTab('t-furniture');
    scrollToTop();
  });
  ui.done.addEventListener('click', () => leave());

  // ---------------------------------------------------------------- a copy's own suggestion
  const canSuggest = () => session.editable && !!session.forkedFrom && session.forkedFrom !== 'example';

  async function refreshMine() {
    if (!canSuggest()) { mine = null; renderOffer(); return; }
    const id = session.id;
    const out = await session.mySuggestion();
    if (session.id !== id || out.error) return;
    mine = out;
    renderOffer();
  }

  function offerStatus(text, error = false) {
    ui.offerStatus.textContent = text;
    ui.offerStatus.dataset.state = error ? 'error' : '';
  }

  function renderOffer() {
    const show = canSuggest() && !!mine?.to;
    ui.offer.hidden = !show;
    if (!show) return;
    const { to, status: st, changes } = mine;
    ui.offerTo.textContent = '';
    ui.offerTo.append('Your version of ', make('b', null, to.title || (to.author ? `${to.author}'s unit` : 'their unit')));
    if (to.title && to.author) ui.offerTo.append(` by ${to.author}`);
    ui.offerTo.append('. Send them your layout: they see what you changed and pick what to take.');
    if (!noteEdited && document.activeElement !== ui.offerNote) ui.offerNote.value = st === 'open' ? mine.note ?? '' : '';
    ui.send.disabled = !changes || sending;
    ui.send.textContent = !changes ? 'No changes yet' : st === 'open' ? 'Send again' : 'Send suggestion';
    ui.withdraw.hidden = st !== 'open';
    const them = to.author || 'They';
    offerStatus(sending ? 'Sending…'
      : st === 'open' ? `Sent ${plural(changes, 'change')}. Waiting for them. Send again to update it.`
        : st === 'applied' ? `${them} applied your suggestion.${changes ? ' Send again to suggest more.' : ''}`
          : st === 'dismissed' ? `${them} dismissed your suggestion.${changes ? ' Change it and send it again if you like.' : ''}`
            : changes ? '' : 'Move, add or remove pieces first.');
  }

  async function send() {
    if (sending || !mine?.changes) return;
    sending = true;
    renderOffer();
    // A name typed just now goes with it.
    clearTimeout(nameTimer);
    nameTimer = 0;
    const name = ui.offerName.value.trim();
    if (name !== session.author) session.setInfo({ author: name });
    const out = await session.suggest(ui.offerNote.value.trim());
    sending = false;
    if (out.error) { renderOffer(); offerStatus(out.error, true); return; }
    mine = out;
    noteEdited = false;
    renderOffer();
    layout.toast(`Sent to ${out.to.author || 'its owner'}`);
  }

  async function withdraw() {
    const out = await session.withdrawSuggestion();
    if (out.error) { offerStatus(out.error, true); return; }
    mine = out;
    noteEdited = false;
    renderOffer();
    layout.toast('Withdrawn');
  }

  ui.send.addEventListener('click', send);
  ui.withdraw.addEventListener('click', withdraw);
  ui.offerNote.addEventListener('input', () => { noteEdited = true; });
  ui.offerName.addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => { nameTimer = 0; session.setInfo({ author: ui.offerName.value.trim() }); }, 400);
  });

  // ---------------------------------------------------------------- when to look
  setInterval(() => {
    if (document.hidden) return;
    refresh();
    if (mine?.to) refreshMine();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  // Opening the Furnish tab shows what's waiting first.
  ui.tab.addEventListener('click', () => { refresh().then(scrollToTop); refreshMine(); });

  return {
    root,
    get active() { return !!view; },

    // The session changed (main.js renderSession): another unit, or your
    // edits just saved (what your version would suggest changed).
    sync(ss) {
      const key = ss.editable ? ss.id : null;
      if (key !== unitId) {
        unitId = key;
        waiting = [];
        mine = null;
        noteEdited = false;
        clearTimeout(nameTimer);
        nameTimer = 0;
        leave();
        renderPanel();
        renderOffer();
        if (key) { refresh(); refreshMine(); }
      }
      if (lastStatus === 'saving' && ss.status === 'saved' && mine?.to) {
        clearTimeout(mineTimer);
        mineTimer = setTimeout(refreshMine, 1200);
      }
      lastStatus = ss.status;
      if (document.activeElement !== ui.offerName && !nameTimer) ui.offerName.value = ss.author ?? '';
    },

    // A whole unit loaded: start over.
    reset() {
      leave();
      unitId = undefined;
    },

    // The owner's layout changed under the preview (another device, Claude).
    layoutChanged() {
      if (!view || busy) return;
      regroup();
    },

    // The view changed: ceiling pieces turn see-through in Plan.
    setView(m) {
      mode = m;
      if (view && view.groups) renderPreview();
    },

    // Walking: is (x, z) within r of a preview piece you'd walk into?
    blocks(x, z, r) {
      return !!view && root.visible && standing.some((i) => !isFlat(i) && (i.y ?? 0) < WALK_UNDER && nearPiece(i, x, z, r));
    },
  };
}
