// The unit as a claude.ai Artifact: the same surface as src/sync.js's
// UnitSession, with the Artifact's own database (its `db` capability) where the
// site has its server. main.js loads this module only when the page runs as an
// Artifact (window.LIVING_SPACE === 'artifact').
//
// The page paints at once from the snapshot published with it (unit.json:
// { title, author, unit, unitRev, items, assets, savedAt }, or
// window.LIVING_SPACE_SNAPSHOT in the one-file copy), read-only. When
// the viewer's `db` and `user` answer (never during the page's first run; null
// when signed out, or when nobody answers within 10 s) it lights up: once the
// database holds unit/spec it is the unit, and changes to it (Claude's, another
// tab's) come in live through onRemote, as the site's polling brings them.
//
// The database:
//   unit/spec                    { unit, unitRev, savedAt }  the unit (src/unit.js), from Claude
//   unit/layout                  { items, savedAt }          the furniture (src/design.js), feet
//   unit/info                    { title, author }
//   assets/<id>                  one custom piece
//   suggestions/<user id>        { note, base, items, sent, sentAt, status, before?, appliedAt? }
//   data/users/<user id>/version { base, items, savedAt }    someone's own version, private
// Its rules: everyone reads, editors write; only editors read suggestions; from
// Contributor up, each person writes their own suggestion and private folder.
//
// Editors (user.canEdit()) furnish the shared layout: it is written whole a
// moment after the last change, one write at a time. Anyone else looks around
// and can make their own version, kept in their private folder when the
// database takes it and in this browser otherwise, and offer it back as a
// suggestion when the database takes that. Without a database (signed out, or
// a host that never answers) the snapshot is all there is.

import { emptyUnit } from './unit.js';
import { cleanAsset, cleanItem, cleanDesign, LIMITS } from './design.js';
import { layoutChanges, applyChanges } from './changes.js';

const SAVE_MS = 600;
const SYNC_MS = 15000;      // how long the database gets to answer before the page stops waiting for it
const VERSION_KEY = 'livingspace.version.v1';
const NOTE = 200;           // as server/service.js
// Rejections that mean "not for you": the rules refuse this viewer, or the
// database is gone for this visit. Anything else may work on another try.
const REFUSED = new Set(['invalid_argument', 'not_granted', 'revoked', 'capability_disabled', 'capability_removed', 'transform_error']);
const refused = (e) => e instanceof TypeError || REFUSED.has(e?.code);

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
// JSON with its keys in order: whether two bodies say the same, whatever order
// the database hands their keys back in.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const same = (a, b) => canon(a) === canon(b);
const clone = (v) => (v == null ? v : structuredClone(v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emptyPending = () => ({ upsert: new Map(), remove: new Set(), info: null });
const listOf = (v) => (Array.isArray(v) ? v : []);
const assetsOf = (list) => listOf(list).map(cleanAsset).filter(Boolean).sort((a, b) => (a.id < b.id ? -1 : 1));
// Pieces as the furniture editor keeps them (src/design.js), so one that
// didn't change reads the same here and on screen.
function itemsOf(list, assets) {
  const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
  return listOf(list).map((i) => {
    const c = cleanItem(i, byId);
    return c && c.uid === i.uid ? c : null;
  }).filter(Boolean);
}

// A layout with edits laid over it: changed pieces where they were, new ones at the end.
function compose(items, p, assets) {
  const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
  const out = new Map(items.filter((i) => !p.remove.has(i.uid)).map((i) => [i.uid, i]));
  for (const item of p.upsert.values()) {
    const c = cleanItem(item, byId);
    if (c) out.set(c.uid, c);
  }
  return [...out.values()];
}

// Your own version in this browser, for when the database can't keep it.
const kept = {
  get() {
    try {
      const v = JSON.parse(localStorage.getItem(VERSION_KEY) || 'null');
      return v && Array.isArray(v.items) ? { base: Array.isArray(v.base) ? v.base : null, items: v.items, savedAt: +v.savedAt || 0 } : null;
    } catch { return null; }
  },
  put(v) {
    try { localStorage.setItem(VERSION_KEY, JSON.stringify(v)); return true; } catch { return false; }
  },
  drop() {
    try { localStorage.removeItem(VERSION_KEY); } catch { /* storage off */ }
  },
};

export class ArtifactSession {
  // onLoad(doc, ss): a whole unit to show (the snapshot, your version, the original).
  // onRemote(doc, ss): it changed elsewhere; doc.unitRev says whether the unit itself did.
  // onState(ss): role, status, title, or what you can do changed.
  constructor({ onLoad, onRemote, onState }) {
    Object.assign(this, { onLoad, onRemote, onState });
    this.kind = 'artifact';
    this.role = 'loading';      // loading | owner (an editor, or in your own version) | viewer
    this.status = 'idle';       // idle | saving | saved | error
    this.error = null;
    this.message = null;        // something to say once (main.js shows it and clears it)
    this.id = null; this.version = 0; this.unitRev = 0;
    this.title = ''; this.author = ''; this.forkedFrom = null;
    this.busy = false;          // opening your version, or going back
    this.connecting = true;     // the database and who's viewing haven't answered yet
    this.showing = 'shared';    // shared: the unit everyone sees | own: your version
    // The unit everyone sees: the snapshot's, then the database's. `rev` is the
    // database's unitRev; this.unitRev counts rebuilds on this screen.
    this.shared = { unit: emptyUnit(), rev: 1, items: [], assets: [], title: '', author: '', layoutAt: null };
    this.own = null;            // your version: { base, items, savedAt }
    this.ownKept = null;        // where it was last kept: 'db' | 'local'
    this.ownDirty = false;      // changed since it was last kept
    this.pending = emptyPending();
    this.inflight = new Set();  // the pieces in the layout write on its way
    this.timer = 0;
    this.saving = false;
    this.db = null; this.user = null; this.uid = null; this.canEdit = false;
    // The database's documents as last delivered (null: not there).
    this.got = { spec: undefined, layout: undefined, info: undefined, assets: undefined };
    this.synced = false;        // each of them has answered once
    this.seeding = false;
    this.refused = { shared: false, own: false, suggest: false };
    this.stops = [];
    this.chains = new Map();
    this.ready = new Promise((r) => { this.isReady = r; });
    // Asked now: they never answer during the page's first run, and the page
    // doesn't wait for them to paint.
    const use = (name) => {
      try { return Promise.resolve(window.claude?.use?.(name) ?? null).catch(() => null); } catch { return Promise.resolve(null); }
    };
    this.asked = Promise.all([use('db'), use('user')]);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flush(); });
    addEventListener('pagehide', () => this.flush());
  }

  get editable() { return this.role === 'owner'; }
  get isExample() { return false; }
  get hasVersion() { return !!this.own; }
  viewUrl() { return null; }
  editUrl() { return null; }
  mcpUrl() { return null; }
  ownedUnits() { return []; }
  // Pieces with edits not saved yet, or on their way: what comes in from
  // elsewhere leaves them as they are on screen.
  pendingUids() { return new Set([...this.pending.upsert.keys(), ...this.pending.remove, ...this.inflight]); }

  // What the site has and an Artifact doesn't: a home page, other units, edit
  // codes. Who can change it is set in claude.ai's Share menu.
  home() {}
  async open() {}
  async create() { return null; }
  retry() {}
  async hasCode() { return null; }
  async setCode() { return 'Who can edit is set in the Share menu in Claude.'; }
  async unlock() { return 'Who can edit is set in the Share menu in Claude.'; }

  #emit() { this.onState?.(this); }
  #editor() { return this.canEdit && !!this.db && this.synced && !this.refused.shared; }
  #editsShared() { return this.editable && this.showing === 'shared' && !!this.db; }

  // The unit on screen, as onLoad and onRemote take it.
  #doc(unitRev = this.unitRev) {
    const s = this.shared;
    return {
      id: this.id, title: this.title, author: this.author, version: this.version, unitRev,
      unit: s.unit, items: clone(this.showing === 'own' ? this.own.items : s.items), assets: clone(s.assets),
    };
  }

  #remote(unitChanged = false) {
    this.version++;
    const doc = this.#doc(unitChanged ? this.unitRev + 1 : this.unitRev);
    this.onRemote?.(doc, this);
    this.unitRev = doc.unitRev;
    this.#emit();
  }

  // ---------------------------------------------------------------- opening

  // The snapshot first, so the page paints at once; then the database. The
  // one-file copy (skill/3d-living-space/scripts/single.mjs) carries its
  // snapshot along, and has no database.
  async start() {
    if (this.role !== 'loading') return;
    let raw = window.LIVING_SPACE_SNAPSHOT ?? null;
    if (!raw) {
      try {
        const res = await fetch('./unit.json', { cache: 'no-store' });
        if (res.ok) raw = await res.json();
      } catch { /* no snapshot: an empty unit */ }
    }
    const s = raw && typeof raw === 'object' ? raw : {};
    const assets = assetsOf(s.assets);
    this.shared = {
      unit: s.unit && typeof s.unit === 'object' ? s.unit : emptyUnit(), rev: Number.isFinite(s.unitRev) ? s.unitRev : 1,
      items: itemsOf(s.items, assets), assets,
      title: typeof s.title === 'string' ? s.title : '', author: typeof s.author === 'string' ? s.author : '', layoutAt: s.savedAt ?? null,
    };
    // A version made in this browser on an earlier visit.
    this.own = kept.get();
    if (this.own) this.ownKept = 'local';
    Object.assign(this, { role: 'viewer', id: 'unit', title: this.shared.title, author: this.shared.author, version: 1, unitRev: 1 });
    this.onLoad?.(this.#doc(), this);
    this.#emit();
    this.#connect();
  }

  async #connect() {
    const [db, user] = await this.asked;
    this.user = user;
    if (user) {
      const [canEdit, uid] = await Promise.all([user.canEdit().catch(() => false), user.id().catch(() => null)]);
      this.canEdit = canEdit === true;
      this.uid = typeof uid === 'string' && uid ? uid : null;
    }
    if (!db) { this.#settled(); return; }
    this.db = db;
    if (this.uid) await this.#findOwn();
    this.#listen();
    setTimeout(() => this.#settled(), SYNC_MS);
  }

  // Stop waiting: what's known now is what the page offers.
  #settled() {
    if (!this.connecting) return;
    this.connecting = false;
    this.isReady();
    this.#emit();
  }

  // Your version from an earlier visit, in your private folder. The newer of
  // it and this browser's copy wins.
  async #findOwn() {
    let snap;
    try { snap = await this.db.doc(`data/users/${this.uid}/version`).get(); } catch { return; }
    const v = snap.exists ? snap.data() : null;
    if (!v || !Array.isArray(v.items)) return;
    if (this.own && this.own.savedAt > (+v.savedAt || 0)) return;
    this.own = { base: Array.isArray(v.base) ? clone(v.base) : null, items: clone(v.items), savedAt: +v.savedAt || 0 };
    this.ownKept = 'db';
  }

  // One subscription per document, for the whole visit.
  #listen() {
    const watch = (ref, key, read) => {
      let retried = false;
      const on = () => ref.onSnapshot((snap) => this.#got(key, read(snap)), (e) => {
        // The bridge stopped answering: a fresh subscription is the only way back. Once.
        if (e?.code === 'unavailable' && !retried) { retried = true; setTimeout(() => { if (this.db) this.stops.push(on()); }, 1000); }
        else this.#lost();
      });
      this.stops.push(on());
    };
    const one = (snap) => (snap.exists ? clone(snap.data()) : null);
    try {
      watch(this.db.doc('unit/spec'), 'spec', one);
      watch(this.db.doc('unit/layout'), 'layout', one);
      watch(this.db.doc('unit/info'), 'info', one);
      watch(this.db.collection('assets'), 'assets', (snap) => snap.docs.map((d) => ({ ...clone(d.data()), id: d.id })));
    } catch { this.#lost(); }
  }

  #got(key, value) {
    this.got[key] = value;
    if (this.synced) { this.#adopt(); return; }
    if (Object.values(this.got).some((v) => v === undefined)) return;
    // The first answers, all together: an editor starts editing on what the
    // database holds, not on the snapshot.
    this.synced = true;
    const changed = this.#adopt({ quiet: true });
    if (this.#editor() && this.showing === 'shared') {
      this.role = 'owner';
      if (changed.unit) this.unitRev++;
      this.onLoad?.(this.#doc(), this);
    } else if (changed.unit || changed.items || changed.assets) this.#remote(changed.unit);
    if (this.connecting) this.#settled();
    else this.#emit();
  }

  // Take the database into the unit on screen. It is the unit once it holds
  // unit/spec; a layout or info it doesn't hold yet leaves what the page has.
  #adopt({ quiet = false } = {}) {
    const g = this.got, s = this.shared, changed = {};
    if (!g.spec || this.seeding) return changed;
    if (g.spec.unit && typeof g.spec.unit === 'object' && !same(g.spec.unit, s.unit)) { s.unit = g.spec.unit; changed.unit = true; }
    if (Number.isFinite(g.spec.unitRev)) s.rev = g.spec.unitRev;
    const assets = assetsOf(g.assets);
    if (!same(assets, s.assets)) { s.assets = assets; changed.assets = true; }
    if (g.layout) {
      s.layoutAt = g.layout.savedAt ?? null;
      const items = itemsOf(g.layout.items, s.assets);
      // The echo of this page's own write says what the screen already shows.
      if (!same(items, s.items)) { s.items = items; changed.items = true; }
    }
    if (g.info) {
      const title = typeof g.info.title === 'string' ? g.info.title : '', author = typeof g.info.author === 'string' ? g.info.author : '';
      if (title !== s.title || author !== s.author) { Object.assign(s, { title, author }); changed.info = true; }
    }
    // A name being typed stays as typed.
    if (!this.pending.info) { this.title = s.title; this.author = s.author; }
    if (quiet) return changed;
    if (changed.unit || changed.assets || (changed.items && this.showing === 'shared')) this.#remote(changed.unit);
    else if (changed.info || changed.items) this.#emit();
    return changed;
  }

  // The database is gone for this visit (access withdrawn, or it stopped
  // answering): keep what's on screen, and stop changing the shared unit.
  #lost() {
    if (!this.db) return;
    for (const stop of this.stops.splice(0)) { try { stop(); } catch { /* already stopped */ } }
    this.db = null;
    this.#settled();
    if (this.editable && this.showing === 'shared') {
      Object.assign(this, { role: 'viewer', pending: emptyPending(), status: 'idle', error: null });
      clearTimeout(this.timer);
      this.onLoad?.(this.#doc(), this);
    }
    this.#emit();
  }

  // ---------------------------------------------------------------- your own version

  // Open your version, or make it: a copy of the shared layout that remembers
  // what it was copied from, so a suggestion shows just what you changed.
  // Returns the unit shown (`created` when it's new), or null.
  async fork() {
    if (this.showing === 'own') return this.#doc();
    if (this.busy || this.role !== 'viewer') return null;
    this.busy = true;
    this.#emit();
    try {
      await this.ready;
      if (this.role !== 'viewer') return null;
      const created = !this.own;
      if (created) {
        const items = clone(this.shared.items);
        this.own = { base: clone(items), items, savedAt: Date.now() };
        this.ownDirty = true;
        // Kept before it opens: where it lives says whether it can be suggested.
        await this.flush();
      }
      this.#show('own');
      return { ...this.#doc(), created };
    } finally {
      this.busy = false;
      this.#emit();
    }
  }

  // Back from your version to the unit everyone sees.
  async original() {
    if (this.showing !== 'own' || this.busy) return;
    this.busy = true;
    this.#emit();
    try { await this.settle(); } finally { this.busy = false; }
    this.#show('shared');
  }

  #show(which) {
    const own = which === 'own';
    // A version that couldn't be kept says so (and is tried again on its own).
    const failed = own && this.ownDirty && this.status === 'error';
    Object.assign(this, {
      showing: which, id: own ? 'own' : 'unit', forkedFrom: own ? 'unit' : null,
      role: own || this.#editor() ? 'owner' : 'viewer', status: failed ? 'error' : own ? 'saved' : 'idle', error: failed ? this.error : null,
    });
    this.onLoad?.(this.#doc(), this);
    this.#emit();
  }

  // Keep your version: in your private folder when the database takes it,
  // in this browser otherwise.
  async #keepOwn() {
    const body = { base: this.own.base, items: this.own.items, savedAt: Date.now() };
    this.ownDirty = false;
    if (this.db && this.uid && !this.refused.own) {
      try {
        await this.#put(`data/users/${this.uid}/version`, body);
        this.own.savedAt = body.savedAt;
        this.ownKept = 'db';
        kept.drop();
        return;
      } catch (e) {
        if (!refused(e)) { this.ownDirty = true; throw e; }
        this.refused.own = true;
      }
    }
    if (!kept.put(body)) { this.ownDirty = true; throw { code: 'storage' }; }
    this.own.savedAt = body.savedAt;
    this.ownKept = 'local';
  }

  #foldOwn() {
    const p = this.pending;
    if (!p.upsert.size && !p.remove.size) return;
    this.pending = emptyPending();
    this.own.items = compose(this.own.items, p, this.shared.assets);
    this.ownDirty = true;
  }

  // ---------------------------------------------------------------- saving

  // Changes from the furniture editor: { upsert: [items], remove: [uids] }.
  queue({ upsert = [], remove = [] }) {
    if (!this.editable) return;
    for (const item of upsert) { this.pending.remove.delete(item.uid); this.pending.upsert.set(item.uid, item); }
    for (const uid of remove) { this.pending.upsert.delete(uid); this.pending.remove.add(uid); }
    this.#schedule();
  }

  // The unit's name and author, for editors. Your version goes by the unit's.
  setInfo({ title, author }) {
    if (!this.editable || this.showing !== 'shared') return;
    if (title !== undefined) this.title = title;
    if (author !== undefined) this.author = author;
    this.pending.info = { title: this.title, author: this.author };
    this.#schedule();
  }

  #schedule() {
    this.status = 'saving';
    this.#emit();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_MS);
  }

  #hasPending(p = this.pending) { return p.upsert.size > 0 || p.remove.size > 0 || !!p.info || this.ownDirty; }

  // Wait until every edit made so far is saved (or saving it failed).
  async settle() {
    for (let i = 0; i < 150 && (this.saving || this.#hasPending()) && this.status !== 'error'; i++) {
      if (this.saving) await wait(100);
      else {
        await this.flush();
        if (this.#hasPending()) await wait(100);
      }
    }
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.saving) { this.timer = setTimeout(() => this.flush(), 300); return; }
    if (!this.#hasPending()) {
      if (this.status === 'saving') { this.status = 'saved'; this.#emit(); }
      return;
    }
    this.saving = true;
    let error = null;
    try {
      if (this.showing === 'own') this.#foldOwn();
      if (this.ownDirty) await this.#keepOwn();
      if (this.#editsShared() && (this.pending.upsert.size || this.pending.remove.size || this.pending.info)) await this.#saveShared();
    } catch (e) {
      error = e;
    } finally {
      this.saving = false;
      this.inflight = new Set();
    }
    if (error) { this.#failed(error); return; }
    this.status = this.#hasPending() ? 'saving' : 'saved';
    this.error = null;
    this.#emit();
  }

  // An editor's edits, into the shared unit: the layout written whole, then
  // the name. Into an empty database, the snapshot goes in with them.
  async #saveShared() {
    const p = this.pending, s = this.shared;
    this.pending = emptyPending();
    this.inflight = new Set([...p.upsert.keys(), ...p.remove]);
    try {
      const items = compose(s.items, p, s.assets);
      const info = p.info ?? { title: s.title, author: s.author };
      if (!this.got.spec) {
        // Claude may have just built it, before its subscription said so: wait for that.
        if ((await this.db.doc('unit/spec').get()).exists) throw { code: 'wait' };
        await this.#seed(items, info);
        return;
      }
      if (!same(items, s.items)) await this.#writeLayout(items);
      if (p.info && (info.title !== s.title || info.author !== s.author)) await this.#writeInfo(info);
    } catch (e) {
      // Put the changes back (newer edits made meanwhile win) for the next try.
      for (const [uid, item] of p.upsert) if (!this.pending.upsert.has(uid) && !this.pending.remove.has(uid)) this.pending.upsert.set(uid, item);
      for (const uid of p.remove) if (!this.pending.upsert.has(uid)) this.pending.remove.add(uid);
      if (p.info && !this.pending.info) this.pending.info = p.info;
      throw e;
    }
  }

  // The database is empty and an editor saves: the snapshot goes in, with
  // their edits, and the unit's spec last, so a page watching it sees a whole
  // unit when it appears.
  async #seed(items, info) {
    const s = this.shared, at = Date.now();
    this.seeding = true;
    try {
      for (const a of s.assets) await this.#put(`assets/${a.id}`, a);
      await this.#writeInfo(info);
      await this.#writeLayout(items, at);
      await this.#put('unit/spec', { unit: s.unit, unitRev: s.rev, savedAt: at });
    } finally {
      this.seeding = false;
    }
    this.#adopt();
  }

  async #writeLayout(items, at = Date.now()) {
    const s = this.shared, was = { items: s.items, layoutAt: s.layoutAt };
    Object.assign(s, { items, layoutAt: at });
    try {
      await this.#put('unit/layout', { items, savedAt: at });
    } catch (e) {
      // Back to what the database holds, unless it said something newer meanwhile.
      if (s.items === items) Object.assign(s, this.got.spec && this.got.layout ? { items: itemsOf(this.got.layout.items, s.assets), layoutAt: this.got.layout.savedAt ?? null } : was);
      throw e;
    }
  }

  async #writeInfo(info) {
    const s = this.shared, was = { title: s.title, author: s.author };
    Object.assign(s, info);
    try {
      await this.#put('unit/info', { title: info.title, author: info.author });
    } catch (e) {
      Object.assign(s, this.got.spec && this.got.info ? { title: this.got.info.title ?? '', author: this.got.info.author ?? '' } : was);
      throw e;
    }
  }

  // One write at a time to each document. A passing failure gets one more try.
  #put(path, body, how = 'set') {
    const db = this.db;
    const write = async () => {
      if (!db) throw { code: 'revoked' };
      try {
        return await db.doc(path)[how](body);
      } catch (e) {
        if (e?.code !== 'unavailable') throw e;
        await wait(300 + Math.random() * 500);
        return db.doc(path)[how](body);
      }
    };
    const run = (this.chains.get(path) ?? Promise.resolve()).then(write, write);
    this.chains.set(path, run.catch(() => {}));
    return run;
  }

  #failed(e) {
    // Claude's unit is on its way in: save on top of it once it's here.
    if (e?.code === 'wait') { this.timer = setTimeout(() => this.flush(), 1000); return; }
    if (refused(e) && this.showing === 'shared' && this.editable) { this.#readOnly(); return; }
    this.status = 'error';
    this.error = e?.code === 'quota_exceeded' ? 'This page\'s storage is full, so changes can\'t be saved.'
      : e?.code === 'storage' ? 'This browser won\'t keep your version. Its storage may be off or full.'
        : 'Can\'t save right now. Your changes will be saved when it\'s back.';
    if (e?.code !== 'quota_exceeded' && e?.code !== 'storage') this.timer = setTimeout(() => this.flush(), 5000);
    this.#emit();
  }

  // The database refused an editor's write: they can't change the shared unit
  // after all. Read-only for the rest of the visit, showing what it holds.
  #readOnly() {
    this.refused.shared = true;
    clearTimeout(this.timer);
    Object.assign(this, {
      role: 'viewer', pending: emptyPending(), status: 'idle', error: null, title: this.shared.title, author: this.shared.author,
      message: 'Only editors can change this unit. Make your own version to change it.',
    });
    this.onLoad?.(this.#doc(), this);
    this.#emit();
  }

  // ---------------------------------------------------------------- suggesting your version

  // Your version can go back as a suggestion: the database, an id, and
  // nothing refused so far.
  #canSuggest() { return this.showing === 'own' && !!(this.db && this.uid && this.own) && !this.refused.own && !this.refused.suggest; }
  #changes() { return layoutChanges({ base: this.own.base, theirs: this.own.items, ours: this.shared.items }).length; }

  // As server/service.js mySuggestion: { to: { id, title, author } | null,
  // status: 'none' | 'open' | 'applied' | 'dismissed', note, sent, changes, sentAt }.
  async mySuggestion() {
    if (!this.#canSuggest()) return { to: null, status: 'none', changes: 0 };
    let s;
    try {
      const snap = await this.db.doc(`suggestions/${this.uid}`).get();
      s = snap.exists ? snap.data() : null;
    } catch { return { error: 'Can\'t reach this page\'s data. Try again.' }; }
    return {
      to: { id: 'unit', title: this.shared.title, author: this.shared.author },
      status: s?.status ?? 'none', note: s?.note ?? '', sentAt: s?.sentAt ?? null, sent: s ? s.sent ?? null : null,
      changes: this.#changes(),
    };
  }

  async suggest(note = '') {
    await this.settle();
    if (!this.#canSuggest()) return { error: 'You can\'t send suggestions on this page.' };
    const sent = this.#changes();
    if (!sent) return { error: 'Nothing to suggest yet: your version\'s furniture is the same as theirs.' };
    const body = { note: text(note, NOTE), base: this.own.base, items: this.own.items, sent, sentAt: Date.now(), status: 'open' };
    try {
      await this.#put(`suggestions/${this.uid}`, body);
    } catch (e) {
      if (!refused(e)) return { error: 'Couldn\'t send it. Try again.' };
      this.refused.suggest = true;
      return { error: 'You can\'t send suggestions on this page. Its owner can make you a Contributor in the Share menu.' };
    }
    return this.mySuggestion();
  }

  async withdrawSuggestion() {
    if (!this.#canSuggest()) return { to: null, status: 'none', changes: 0 };
    const path = `suggestions/${this.uid}`;
    try {
      const snap = await this.db.doc(path).get();
      if (snap.exists && snap.data().status === 'open') await this.#put(path, null, 'delete');
    } catch { return { error: 'Couldn\'t withdraw it. Try again.' }; }
    return this.mySuggestion();
  }

  // ---------------------------------------------------------------- suggestions, for editors

  // The suggestions waiting, as server/service.js suggestions(): [{ id, from,
  // author, title, note, createdAt, updatedAt, base, items, assets, changes }].
  // Only ids are stored; names come from claude.ai, as this viewer sees them.
  async suggestions() {
    if (!this.#editsShared()) return [];
    let docs;
    try { docs = (await this.db.collection('suggestions').get()).docs; } catch { return { error: 'Can\'t reach this page\'s data. Try again.' }; }
    const open = docs.filter((d) => d.exists && d.data()?.status === 'open');
    let people = {};
    try { if (open.length && this.user) people = await this.user.profiles(open.map((d) => d.id)); } catch { /* names stay empty */ }
    return open.map((d) => {
      const s = d.data(), base = Array.isArray(s.base) ? clone(s.base) : null, items = clone(listOf(s.items));
      return {
        id: d.id, from: d.id, author: people[d.id]?.name || '', title: '', note: typeof s.note === 'string' ? s.note : '',
        createdAt: s.sentAt ?? 0, updatedAt: s.sentAt ?? 0, base, items, assets: clone(this.shared.assets),
        changes: layoutChanges({ base, theirs: items, ours: this.shared.items }).length,
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async #suggestion(sid) {
    let snap;
    try { snap = await this.db.doc(`suggestions/${sid}`).get(); } catch (e) {
      return { error: e instanceof TypeError ? 'There is no such suggestion for this unit.' : 'Can\'t reach this page\'s data. Try again.' };
    }
    return snap.exists ? { s: clone(snap.data()) } : { error: 'There is no such suggestion for this unit.' };
  }

  // A layout change of the editor's own (applying, undoing): the autosave
  // waits for it, and it comes on screen as a change from elsewhere would.
  async #rewrite(change) {
    await this.settle();
    while (this.saving) await wait(100);
    this.saving = true;
    const before = this.shared.items;
    let out;
    try {
      out = await change();
    } catch (e) {
      out = { error: refused(e) ? 'Only editors can do that.' : 'That didn\'t work. Try again.' };
    } finally {
      this.saving = false;
    }
    if (this.shared.items !== before) this.#remote();
    return out;
  }

  // Take changes (layoutChanges group ids, or 'all'): { applied } or { error }.
  async applySuggestion(sid, groups = 'all') {
    if (!this.#editsShared()) return { error: 'Only editors can do that.' };
    if (groups !== 'all' && (!Array.isArray(groups) || !groups.length || !groups.every((g) => typeof g === 'string'))) return { error: 'Choose at least one change to apply.' };
    return this.#rewrite(async () => {
      const { s, error } = await this.#suggestion(sid);
      if (error) return { error };
      if (s.status !== 'open') return { error: 'That suggestion was already applied or dismissed.' };
      const ours = this.shared.items, assets = this.shared.assets;
      const out = applyChanges({ base: Array.isArray(s.base) ? s.base : null, theirs: listOf(s.items), ours, theirAssets: assets, ourAssets: assets, select: groups });
      if (!out.applied) return { error: 'Those changes are already in your layout, or no longer apply.' };
      const { items } = cleanDesign({ unit: this.shared.unit, items: out.items, assets });
      if (items.length < out.items.length) {
        return { error: out.items.length > LIMITS.items ? `A unit holds at most ${LIMITS.items} pieces.` : 'Some pieces could not be saved: check their type, asset and numbers.' };
      }
      const at = Date.now();
      await this.#writeLayout(items, at);
      // What undoing it needs: the layout before, and which layout it made.
      await this.#put(`suggestions/${sid}`, { status: 'applied', before: { items: ours }, appliedAt: at }, 'update');
      return { applied: out.applied };
    });
  }

  async dismissSuggestion(sid) {
    if (!this.#editsShared()) return { error: 'Only editors can do that.' };
    const { s, error } = await this.#suggestion(sid);
    if (error) return { error };
    if (s.status === 'open') {
      try { await this.#put(`suggestions/${sid}`, { status: 'dismissed' }, 'update'); } catch (e) {
        return { error: refused(e) ? 'Only editors can do that.' : 'That didn\'t work. Try again.' };
      }
    }
    return { ok: true };
  }

  // Put the layout back as it was before a suggestion was applied, and the
  // suggestion back in the list, if nothing has changed since.
  async undoSuggestion(sid) {
    if (!this.#editsShared()) return { error: 'Only editors can do that.' };
    return this.#rewrite(async () => {
      const { s, error } = await this.#suggestion(sid);
      if (error) return { error };
      if (s.status !== 'applied' || !s.before) return { error: 'There is nothing to undo.' };
      if (s.appliedAt !== this.shared.layoutAt) return { error: 'The layout has changed since, so this can\'t be undone in one go.' };
      await this.#writeLayout(listOf(s.before.items));
      const { before, appliedAt, ...rest } = s;
      await this.#put(`suggestions/${sid}`, { ...rest, status: 'open' });
      return { ok: true };
    });
  }
}
