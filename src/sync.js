// Saving and sharing. A design lives on the server at d/<id>. This browser
// keeps the edit keys of the designs it made (localStorage), and that is what
// makes a design yours: with its key you edit it, without one it opens
// view-only and offers to make your own version.
//
// Edits go up as pieces added, changed or removed, a moment after the last one,
// and the open design is polled every few seconds, so an agent working through
// MCP (or another tab) shows up without a reload.

const OWNED = 'livingspace.owned.v1';
const LEGACY = 'livingspace.layout.v1';
const POLL_MS = 4000;
const SAVE_MS = 600;

const owned = {
  list() {
    try { return JSON.parse(localStorage.getItem(OWNED) || '[]').filter((d) => d && d.id && d.key); } catch { return []; }
  },
  get(id) { return this.list().find((d) => d.id === id) ?? null; },
  put(entry) {
    try {
      const rest = this.list().filter((d) => d.id !== entry.id);
      localStorage.setItem(OWNED, JSON.stringify([{ ...this.get(entry.id), ...entry, at: Date.now() }, ...rest].slice(0, 50)));
    } catch { /* storage off: the edit link still works */ }
  },
  drop(id) {
    try { localStorage.setItem(OWNED, JSON.stringify(this.list().filter((d) => d.id !== id))); } catch { /* ignore */ }
  },
};

// Share links from before designs lived on the server: ?layout=<base64url JSON rows>.
function decodeLegacy(code) {
  const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  const rows = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  return rows.map(([type, w, d, h, x, z, rot, color, name]) => ({ type, w, d, h, x, z, rot, color: color || null, ...(name ? { name } : {}) }));
}

export class DesignSession {
  constructor({ getDoc, onLoad, onRemote, onState }) {
    Object.assign(this, { getDoc, onLoad, onRemote, onState });
    this.role = 'loading';      // loading | new | owner | viewer | missing | offline
    this.status = 'idle';       // idle | saving | saved | error
    this.id = null; this.key = null; this.version = 0;
    this.title = ''; this.author = '';
    this.pending = { upsert: new Map(), remove: new Set(), info: null };
    this.timer = 0;
    this.saving = false;
    this.base = new URL(document.baseURI).pathname.replace(/[^/]*$/, '');
    setInterval(() => this.#poll(), POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.#poll(); });
    addEventListener('pagehide', () => this.#flushOnExit());
  }

  get editable() { return this.role === 'owner' || this.role === 'new'; }
  viewUrl() { return this.id ? `${location.origin}${this.base}d/${this.id}` : null; }
  editUrl() { return this.id && this.key ? `${this.viewUrl()}#edit=${this.key}` : null; }
  ownedDesigns() { return owned.list(); }
  pendingUids() { return new Set([...this.pending.upsert.keys(), ...this.pending.remove]); }

  #emit() { this.onState?.(this); }
  #setUrl(path) {
    const hash = location.hash.replace(/#?edit=[A-Za-z0-9]+/, '');
    history.replaceState(null, '', `${this.base}${path}${hash}`);
  }

  async start() {
    const rel = location.pathname.startsWith(this.base) ? location.pathname.slice(this.base.length) : '';
    const m = /^d\/([A-Za-z0-9]{8,16})\/?$/.exec(rel);
    const key = /edit=([A-Za-z0-9]{20,48})/.exec(location.hash)?.[1];
    if (m) {
      if (key) owned.put({ id: m[1], key });
      return this.open(m[1]);
    }
    const params = new URLSearchParams(location.search);
    if (params.get('layout')) {
      let items = [];
      try { items = decodeLegacy(params.get('layout')); } catch { items = []; }
      return this.#create({ items, title: '' });
    }
    const mine = owned.list().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    if (!params.has('new') && mine.length) return this.open(mine[0].id);
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(LEGACY) || '[]'); } catch { legacy = []; }
    if (Array.isArray(legacy) && legacy.length) {
      await this.#create({ items: legacy, title: '' });
      try { localStorage.removeItem(LEGACY); } catch { /* ignore */ }
      return;
    }
    this.#startNew();
  }

  #startNew() {
    Object.assign(this, { role: 'new', id: null, key: null, version: 0, title: '', author: '', status: 'idle' });
    this.pending = { upsert: new Map(), remove: new Set(), info: null };
    this.onLoad?.({ items: [], assets: [] }, this);
    this.#emit();
  }

  newDesign() {
    this.#setUrl('?new');
    this.#startNew();
  }

  async open(id) {
    this.role = 'loading';
    this.#emit();
    let res;
    try { res = await fetch(`api/designs/${id}`); } catch { res = null; }
    if (!res || (!res.ok && res.status !== 404)) {
      Object.assign(this, { role: 'offline', id, status: 'error' });
      this.onLoad?.({ items: [], assets: [] }, this);
      this.#emit();
      return;
    }
    if (res.status === 404) {
      owned.drop(id);
      Object.assign(this, { role: 'missing', id: null });
      this.onLoad?.({ items: [], assets: [] }, this);
      this.#emit();
      return;
    }
    const doc = await res.json();
    this.#adopt(doc, owned.get(id)?.key ?? null);
  }

  #adopt(doc, key) {
    Object.assign(this, { id: doc.id, key, version: doc.version, title: doc.title, author: doc.author, role: key ? 'owner' : 'viewer', status: 'saved' });
    this.pending = { upsert: new Map(), remove: new Set(), info: null };
    if (key) owned.put({ id: doc.id, key, title: doc.title });
    this.#setUrl(`d/${doc.id}`);
    this.onLoad?.(doc, this);
    this.#emit();
  }

  async #create(input) {
    let res;
    try {
      res = await fetch('api/designs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    } catch { res = null; }
    if (!res?.ok) {
      this.status = 'error';
      this.error = res ? (await res.json().catch(() => ({}))).error : 'Saving needs a connection.';
      if (this.role !== 'new') this.#startNew();
      this.#emit();
      return null;
    }
    const doc = await res.json();
    this.#adopt(doc, doc.key);
    return doc;
  }

  // Changes from the editor: { upsert: [items], remove: [uids] }.
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

  async flush() {
    clearTimeout(this.timer);
    if (this.saving) { this.timer = setTimeout(() => this.flush(), 300); return; }
    const p = this.pending;
    if (!p.upsert.size && !p.remove.size && !p.info) { this.status = this.role === 'new' ? 'idle' : 'saved'; this.#emit(); return; }
    this.saving = true;
    try {
      if (this.role === 'new') {
        // The first change makes the design.
        const doc = this.getDoc();
        this.pending = { upsert: new Map(), remove: new Set(), info: null };
        await this.#create({ ...doc, title: this.title, author: this.author });
        return;
      }
      this.pending = { upsert: new Map(), remove: new Set(), info: null };
      const body = { baseVersion: this.version, upsert: [...p.upsert.values()], remove: [...p.remove], ...(p.info ?? {}) };
      let res;
      try {
        res = await fetch(`api/designs/${this.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Edit-Key': this.key }, body: JSON.stringify(body) });
      } catch { res = null; }
      if (!res?.ok) {
        // Put the changes back (newer edits made meanwhile win) and try again.
        for (const [uid, item] of p.upsert) if (!this.pending.upsert.has(uid) && !this.pending.remove.has(uid)) this.pending.upsert.set(uid, item);
        for (const uid of p.remove) if (!this.pending.upsert.has(uid)) this.pending.remove.add(uid);
        if (p.info && !this.pending.info) this.pending.info = p.info;
        const err = res ? await res.json().catch(() => ({})) : {};
        this.error = err.error ?? 'Can\'t reach the server. Your changes will be saved when it\'s back.';
        if (res?.status === 403) { owned.drop(this.id); this.role = 'viewer'; this.key = null; this.pending = { upsert: new Map(), remove: new Set(), info: null }; }
        this.status = 'error';
        if (this.role === 'owner' && res?.status !== 400) this.timer = setTimeout(() => this.flush(), 5000);
        this.#emit();
        return;
      }
      const out = await res.json();
      this.version = out.version;
      if (out.design) this.onRemote?.(out.design, this);
      owned.put({ id: this.id, key: this.key, title: this.title });
      this.status = this.pending.upsert.size || this.pending.remove.size || this.pending.info ? 'saving' : 'saved';
      this.error = null;
      this.#emit();
    } finally {
      this.saving = false;
    }
  }

  #flushOnExit() {
    const p = this.pending;
    if (this.role !== 'owner' || (!p.upsert.size && !p.remove.size && !p.info)) return;
    fetch(`api/designs/${this.id}`, {
      method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Edit-Key': this.key },
      body: JSON.stringify({ upsert: [...p.upsert.values()], remove: [...p.remove], ...(p.info ?? {}) }),
    }).catch(() => {});
  }

  async #poll() {
    if (document.hidden || this.saving || !this.id || !['owner', 'viewer'].includes(this.role)) return;
    let res;
    try { res = await fetch(`api/designs/${this.id}?since=${this.version}`); } catch { return; }
    if (res.status !== 200) return;
    const doc = await res.json();
    if (doc.version <= this.version) return;
    this.version = doc.version;
    if (!this.pending.info) { this.title = doc.title; this.author = doc.author; }
    this.onRemote?.(doc, this);
    this.#emit();
  }

  // Your own copy of the design on screen.
  async fork() {
    if (!this.id) return null;
    let res;
    try { res = await fetch(`api/designs/${this.id}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { res = null; }
    if (!res?.ok) {
      this.error = res ? (await res.json().catch(() => ({}))).error : 'Can\'t reach the server.';
      this.status = 'error';
      this.#emit();
      return null;
    }
    const doc = await res.json();
    this.#adopt(doc, doc.key);
    return doc;
  }
}
