// Units on the server, and which of them are yours. A unit lives at u/<id>;
// this browser keeps the edit keys of the units it made (localStorage), and that
// is what makes a unit yours: with its key you can furnish it and get its MCP
// address, without one it opens view-only and offers to make your own version.
//
// An owner can also set an edit code: on another device, with only the unit's
// link, the code unlocks the key (unlock()), and that browser keeps it too.
//
// Furniture edits go up as pieces added, changed or removed, a moment after the
// last one, and the open unit is polled every few seconds, so Claude building
// or furnishing it through MCP (or another tab) shows up without a reload. The
// browser never changes the unit itself; `unitRev` tells it when to rebuild.

import { EXAMPLE_UNIT, EXAMPLE_TITLE } from './example.js';

const OWNED = 'livingspace.units.v1';
const POLL_MS = 4000;
const SAVE_MS = 600;
const ID = /^[A-Za-z0-9_-]{3,32}$/;

export const owned = {
  list() {
    try {
      const raw = JSON.parse(localStorage.getItem(OWNED) || '[]');
      return (Array.isArray(raw) ? raw : []).filter((u) => u && typeof u.id === 'string' && typeof u.key === 'string');
    } catch { return []; }
  },
  // Newest first.
  sorted() { return this.list().sort((a, b) => (b.at ?? 0) - (a.at ?? 0)); },
  get(id) { return this.list().find((u) => u.id === id) ?? null; },
  put(entry) {
    try {
      const rest = this.list().filter((u) => u.id !== entry.id);
      localStorage.setItem(OWNED, JSON.stringify([{ ...this.get(entry.id), ...entry, at: Date.now() }, ...rest].slice(0, 60)));
    } catch { /* storage off: the edit link still works */ }
  },
  drop(id) {
    try { localStorage.setItem(OWNED, JSON.stringify(this.list().filter((u) => u.id !== id))); } catch { /* ignore */ }
  },
};

const emptyPending = () => ({ upsert: new Map(), remove: new Set(), info: null });

export class UnitSession {
  // onLoad(doc, ss): a whole unit to show (opened, created, forked, home).
  // onRemote(doc, ss): someone else changed it; doc.unitRev says whether the unit itself changed.
  // onState(ss): role, status, title or the list of your units changed.
  constructor({ onLoad, onRemote, onState }) {
    Object.assign(this, { onLoad, onRemote, onState });
    this.role = 'loading';      // loading | home | owner | viewer | missing | offline
    this.status = 'idle';       // idle | saving | saved | error
    this.error = null;
    this.id = null; this.key = null; this.version = 0; this.unitRev = 0;
    this.title = ''; this.author = ''; this.forkedFrom = null;
    this.pending = emptyPending();
    this.timer = 0;
    this.saving = false;
    this.busy = false;          // creating or forking
    this.route = null;
    this.base = new URL(document.baseURI).pathname.replace(/[^/]*$/, '');
    setInterval(() => this.#poll(), POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.#poll(); });
    addEventListener('pagehide', () => this.#flushOnExit());
    // Back and forward between home and units.
    addEventListener('popstate', () => { if (this.#path() !== this.route) this.start(); });
  }

  get editable() { return this.role === 'owner'; }
  get isExample() { return this.id === 'example' || this.role === 'home'; }
  viewUrl() { return this.id ? `${location.origin}${this.base}u/${this.id}` : null; }
  editUrl() { return this.id && this.key ? `${this.viewUrl()}#edit=${this.key}` : null; }
  mcpUrl() {
    if (!this.id || !this.key) return null;
    return owned.get(this.id)?.mcpUrl ?? `${location.origin}${this.base}mcp/${this.id}/${this.key}`;
  }
  ownedUnits() { return owned.sorted(); }
  pendingUids() { return new Set([...this.pending.upsert.keys(), ...this.pending.remove]); }

  #emit() { this.onState?.(this); }
  #path() { return location.pathname.startsWith(this.base) ? location.pathname.slice(this.base.length) : ''; }
  // Keep the view's #dollhouse / #plan / #walk, drop an #edit= key.
  #hash() { return /^#(dollhouse|plan|walk)$/.test(location.hash) ? location.hash : ''; }
  #go(path, push) {
    history[push ? 'pushState' : 'replaceState'](null, '', `${this.base}${path}${this.#hash()}`);
    this.route = this.#path();
  }

  // Open whatever the address names.
  async start() {
    clearTimeout(this.timer);
    const rel = this.#path();
    this.route = rel;
    const m = /^u\/([^/]+)\/?$/.exec(rel);
    if (m && ID.test(m[1])) {
      const key = /edit=([A-Za-z0-9_-]{8,64})/.exec(location.hash)?.[1];
      if (key && m[1] !== 'example') owned.put({ id: m[1], key });
      if (key) history.replaceState(null, '', `${this.base}u/${m[1]}`);
      return this.open(m[1]);
    }
    return this.home();
  }

  // Home: the example, read-only, behind the welcome panel. It is built from
  // the copy shipped with the page, so it shows even without the server.
  home({ push = false } = {}) {
    this.#leave();
    this.#reset();
    Object.assign(this, { role: 'home', id: null, key: null, title: EXAMPLE_TITLE, author: '', status: 'idle' });
    if (this.#path() !== '' || push) this.#go('', push);
    this.onLoad?.({ id: 'example', title: EXAMPLE_TITLE, author: '', version: 1, unitRev: 1, unit: EXAMPLE_UNIT, items: [], assets: [] }, this);
    this.#emit();
  }

  async open(id, { push = false } = {}) {
    this.#leave();
    this.#reset();
    Object.assign(this, { role: 'loading', id, key: null });
    if (push) this.#go(`u/${id}`, true);
    this.#emit();
    let res;
    try { res = await fetch(`api/units/${encodeURIComponent(id)}`, { cache: 'no-store' }); } catch { res = null; }
    if (this.id !== id) return;   // something else was opened meanwhile
    if (!res || (!res.ok && res.status !== 404)) {
      Object.assign(this, { role: 'offline', status: 'error', error: 'Can\'t reach the server.' });
      this.onLoad?.(null, this);
      this.#emit();
      return;
    }
    if (res.status === 404) {
      owned.drop(id);
      Object.assign(this, { role: 'missing', title: '', author: '' });
      this.onLoad?.(null, this);
      this.#emit();
      return;
    }
    const doc = await res.json();
    this.#adopt(doc, id === 'example' ? null : owned.get(id)?.key ?? null);
  }

  // Going to another unit or home: send edits still waiting on this one.
  #leave() {
    if (!this.editable || !this.#hasPending()) return;
    if (this.saving) this.#flushOnExit();
    else this.flush();
  }

  #reset() {
    clearTimeout(this.timer);
    this.pending = emptyPending();
    Object.assign(this, { status: 'idle', error: null, version: 0, unitRev: 0, forkedFrom: null });
  }

  #adopt(doc, key, { push = false } = {}) {
    Object.assign(this, {
      id: doc.id, key, version: doc.version, unitRev: doc.unitRev ?? 0, title: doc.title ?? '', author: doc.author ?? '',
      forkedFrom: doc.forkedFrom ?? null, role: key ? 'owner' : 'viewer', status: 'saved', error: null,
    });
    this.pending = emptyPending();
    if (key) owned.put({ id: doc.id, key, title: doc.title ?? '', ...(doc.mcpUrl ? { mcpUrl: doc.mcpUrl } : {}) });
    this.#go(`u/${doc.id}`, push);
    this.onLoad?.(doc, this);
    this.#emit();
  }

  // A new unit of your own: empty, or a copy ({ from: 'example' | '<id>' }).
  async create({ from } = {}) {
    if (this.busy) return null;
    this.busy = true;
    this.#emit();
    try {
      await this.flush();
      let res;
      try {
        res = await fetch('api/units', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(from ? { from } : {}) });
      } catch { res = null; }
      return await this.#took(res);
    } finally {
      this.busy = false;
      this.#emit();
    }
  }

  // Your own copy of the unit on screen, furniture and all.
  async fork() {
    if (!this.id && this.role !== 'home') return null;
    if (this.busy) return null;
    this.busy = true;
    this.#emit();
    try {
      let res;
      try { res = await fetch(`api/units/${encodeURIComponent(this.id ?? 'example')}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { res = null; }
      return await this.#took(res);
    } finally {
      this.busy = false;
      this.#emit();
    }
  }

  async #took(res) {
    if (!res?.ok) {
      this.error = res ? (await res.json().catch(() => ({}))).error ?? 'That didn\'t work. Try again.' : 'Can\'t reach the server. Check your connection and try again.';
      this.#emit();
      return null;
    }
    const doc = await res.json();
    this.#reset();
    this.#adopt(doc, doc.key, { push: true });
    return doc;
  }

  // The edit code. hasCode(): true or false, or null when it can't tell.
  // setCode(code) sets it (null removes it); it returns null, or why not.
  async hasCode() {
    if (!this.editable) return null;
    try {
      const res = await fetch(`api/units/${this.id}/code`, { headers: { 'X-Edit-Key': this.key }, cache: 'no-store' });
      return res.ok ? (await res.json()).set : null;
    } catch { return null; }
  }

  async setCode(code) {
    if (!this.editable) return 'Only the owner can set an edit code.';
    let res;
    try {
      res = await fetch(`api/units/${this.id}/code`, {
        method: code === null ? 'DELETE' : 'PUT', headers: { 'Content-Type': 'application/json', 'X-Edit-Key': this.key },
        body: code === null ? undefined : JSON.stringify({ code }),
      });
    } catch { return 'Can\'t reach the server. Try again.'; }
    return res.ok ? null : (await res.json().catch(() => ({}))).error ?? 'That didn\'t work. Try again.';
  }

  // Trade the unit's edit code for its key: this browser owns it from now on.
  // Returns null, or why not.
  async unlock(code) {
    if (!this.id || this.role !== 'viewer' || this.busy) return null;
    const id = this.id;
    this.busy = true;
    this.#emit();
    try {
      let res;
      try {
        res = await fetch(`api/units/${encodeURIComponent(id)}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      } catch { return 'Can\'t reach the server. Try again.'; }
      if (!res.ok) return (await res.json().catch(() => ({}))).error ?? 'That didn\'t work. Try again.';
      const doc = await res.json();
      if (this.id !== id) return null;
      this.#reset();
      this.#adopt(doc, doc.key);
      return null;
    } finally {
      this.busy = false;
      this.#emit();
    }
  }

  // Suggestions (server/service.js, src/changes.js). Each returns the server's
  // answer, or { error } saying why not. Applying and undoing bring the unit's
  // new layout in through onRemote, as another device's edits would.
  async #call(path, { method = 'GET', body } = {}) {
    if (!this.editable) return { error: 'Only the owner can do that.' };
    let res;
    try {
      res = await fetch(`api/units/${this.id}/${path}`, {
        method, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Edit-Key': this.key }, body: body ? JSON.stringify(body) : undefined,
      });
    } catch { return { error: 'Can\'t reach the server. Try again.' }; }
    const out = await res.json().catch(() => ({}));
    return res.ok ? out : { error: out.error ?? 'That didn\'t work. Try again.' };
  }

  // A copy's own suggestion: { to: { id, title, author } | null, status:
  // 'none' | 'open' | 'applied' | 'dismissed', note, changes, sentAt }.
  mySuggestion() { return this.#call('suggestion'); }
  async suggest(note = '') { await this.settle(); return this.#call('suggest', { method: 'POST', body: { note } }); }
  withdrawSuggestion() { return this.#call('suggestion', { method: 'DELETE' }); }

  // The suggestions waiting for this unit: [{ id, from, author, title, note,
  // createdAt, updatedAt, base, items, assets, changes }].
  async suggestions() {
    const out = await this.#call('suggestions');
    return out.error ? out : out.suggestions;
  }

  // Take changes (layoutChanges group ids, or 'all'): { applied } or { error }.
  async applySuggestion(sid, groups = 'all') {
    await this.settle();
    const out = await this.#call(`suggestions/${sid}/apply`, { method: 'POST', body: { groups } });
    if (out.design) { this.#remote(out.design); this.#emit(); }
    return out;
  }
  dismissSuggestion(sid) { return this.#call(`suggestions/${sid}/dismiss`, { method: 'POST' }); }
  async undoSuggestion(sid) {
    const out = await this.#call(`suggestions/${sid}/undo`, { method: 'POST' });
    if (out.design) { this.#remote(out.design); this.#emit(); }
    return out;
  }

  // Changes from the furniture editor: { upsert: [items], remove: [uids] }.
  queue({ upsert = [], remove = [] }) {
    if (!this.editable) return;
    for (const item of upsert) { this.pending.remove.delete(item.uid); this.pending.upsert.set(item.uid, item); }
    for (const uid of remove) { this.pending.upsert.delete(uid); this.pending.remove.add(uid); }
    this.#schedule();
  }

  setInfo({ title, author }) {
    if (!this.editable) return;
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

  #hasPending(p = this.pending) { return p.upsert.size > 0 || p.remove.size > 0 || !!p.info; }

  // Wait until every edit made so far is saved (or saving it failed): flush()
  // alone returns at once while a save is already on its way.
  async settle() {
    for (let i = 0; i < 150 && this.editable && (this.saving || this.#hasPending()) && this.status !== 'error'; i++) {
      if (!this.saving) await this.flush();
      else await new Promise((r) => setTimeout(r, 100));
    }
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.saving) { this.timer = setTimeout(() => this.flush(), 300); return; }
    if (!this.editable || !this.#hasPending()) {
      if (this.editable && this.status === 'saving') { this.status = 'saved'; this.#emit(); }
      return;
    }
    const { id, key, title } = this;
    const p = this.pending;
    this.pending = emptyPending();
    this.saving = true;
    let refetch = false;
    try {
      const body = { baseVersion: this.version, upsert: [...p.upsert.values()], remove: [...p.remove], ...(p.info ?? {}) };
      let res;
      try {
        res = await fetch(`api/units/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Edit-Key': key }, body: JSON.stringify(body) });
      } catch { res = null; }
      // Saved after leaving it (home, or another unit): just keep its name current.
      if (this.id !== id) {
        if (res?.ok && p.info) { owned.put({ id, key, title }); this.#emit(); }
        return;
      }
      if (!res?.ok) {
        // Put the changes back (newer edits made meanwhile win) and try again.
        for (const [uid, item] of p.upsert) if (!this.pending.upsert.has(uid) && !this.pending.remove.has(uid)) this.pending.upsert.set(uid, item);
        for (const uid of p.remove) if (!this.pending.upsert.has(uid)) this.pending.remove.add(uid);
        if (p.info && !this.pending.info) this.pending.info = p.info;
        const err = res ? await res.json().catch(() => ({})) : {};
        this.error = err.error ?? 'Can\'t reach the server. Your changes will be saved when it\'s back.';
        this.status = 'error';
        if (res?.status === 403 || res?.status === 404) {
          owned.drop(id);
          Object.assign(this, { role: res.status === 404 ? 'missing' : 'viewer', key: null });
          this.pending = emptyPending();
        } else if (res?.status !== 400) {
          const wait = res?.status === 429 ? (+res.headers.get('Retry-After') || 10) * 1000 : 5000;
          this.timer = setTimeout(() => this.flush(), wait);
        }
        this.#emit();
        return;
      }
      const out = await res.json();
      this.version = out.version;
      if (out.design) this.#remote(out.design);
      else refetch = out.unitRev !== undefined && out.unitRev !== this.unitRev;
      owned.put({ id, key: this.key, title: this.title });
      this.status = this.#hasPending() ? 'saving' : 'saved';
      this.error = null;
      this.#emit();
    } finally {
      this.saving = false;
    }
    // The unit changed but the answer didn't carry it.
    if (refetch) this.#poll(true);
  }

  #remote(doc) {
    this.version = doc.version;
    if (!this.pending.info) { this.title = doc.title ?? ''; this.author = doc.author ?? ''; }
    this.onRemote?.(doc, this);
    this.unitRev = doc.unitRev ?? this.unitRev;
  }

  // Leaving the page: send what is still waiting, without waiting for an answer.
  #flushOnExit() {
    const p = this.pending;
    if (!this.editable || !this.#hasPending()) return;
    clearTimeout(this.timer);
    fetch(`api/units/${this.id}`, {
      method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Edit-Key': this.key },
      body: JSON.stringify({ upsert: [...p.upsert.values()], remove: [...p.remove], ...(p.info ?? {}) }),
    }).catch(() => {});
    this.pending = emptyPending();
  }

  // `full` asks for the whole unit even if the version looks current.
  async #poll(full = false) {
    if (document.hidden || this.saving || !this.id || !['owner', 'viewer'].includes(this.role)) return;
    const id = this.id;
    let res;
    try { res = await fetch(`api/units/${id}${full ? '' : `?since=${this.version}`}`, { cache: 'no-store' }); } catch { return; }
    if (this.id !== id || this.saving) return;
    if (res.status === 404) {
      owned.drop(id);
      Object.assign(this, { role: 'missing', key: null });
      this.onLoad?.(null, this);
      this.#emit();
      return;
    }
    if (res.status !== 200) return;
    const doc = await res.json();
    if (!full && doc.version <= this.version) return;
    this.#remote(doc);
    if (this.key) owned.put({ id, key: this.key, title: this.title });
    this.#emit();
  }

  // Try the server again after it was unreachable.
  retry() { return this.start(); }
}
