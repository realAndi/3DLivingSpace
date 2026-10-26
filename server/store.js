// Units in SQLite (node:sqlite, built into Node 24). One row per unit; the unit
// spec, its furniture and its custom assets are one JSON document in the row:
// { unit, unitRev, items, assets }. `code` holds the edit key locked with the
// owner's edit code, when they set one.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.db = new DatabaseSync(join(dataDir, 'units.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS units (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        doc TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        forked_from TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Columns added after the first units: the edit code (see Units.setCode),
    // and for a copy, the layout it was copied from (see Units.suggest).
    const cols = this.db.prepare('PRAGMA table_info(units)').all().map((c) => c.name);
    if (!cols.includes('code')) this.db.exec('ALTER TABLE units ADD COLUMN code TEXT');
    if (!cols.includes('base')) this.db.exec('ALTER TABLE units ADD COLUMN base TEXT');
    // Suggestions: a copy's layout offered back to the unit it was copied
    // from, at most one open per copy. doc is { base, items, assets }.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY,
        unit_id TEXT NOT NULL,
        from_id TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        doc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        before TEXT,
        applied_version INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS suggestions_unit ON suggestions (unit_id, status);
      CREATE INDEX IF NOT EXISTS suggestions_from ON suggestions (from_id, status);
    `);
    this.q = {
      insert: this.db.prepare(`INSERT OR IGNORE INTO units (id, key_hash, title, author, doc, version, forked_from, created_at, updated_at, base)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      get: this.db.prepare('SELECT * FROM units WHERE id = ?'),
      // The version check makes concurrent writes to one unit take turns.
      update: this.db.prepare(`UPDATE units SET title = ?, author = ?, doc = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM units'),
      // Not part of the document: setting it doesn't change the unit's version.
      setCode: this.db.prepare('UPDATE units SET code = ? WHERE id = ?'),
      suggestion: this.db.prepare('SELECT * FROM suggestions WHERE id = ?'),
      openFor: this.db.prepare(`SELECT * FROM suggestions WHERE unit_id = ? AND status = 'open' ORDER BY updated_at DESC`),
      latestFrom: this.db.prepare('SELECT * FROM suggestions WHERE from_id = ? ORDER BY updated_at DESC LIMIT 1'),
      addSuggestion: this.db.prepare(`INSERT INTO suggestions (id, unit_id, from_id, author, title, note, doc, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`),
      resendSuggestion: this.db.prepare(`UPDATE suggestions SET author = ?, title = ?, note = ?, doc = ?, updated_at = ? WHERE id = ? AND status = 'open'`),
      closeSuggestion: this.db.prepare('UPDATE suggestions SET status = ?, before = ?, applied_version = ?, updated_at = ? WHERE id = ?'),
      dropSuggestion: this.db.prepare(`DELETE FROM suggestions WHERE id = ? AND status = 'open'`),
    };
  }

  insert({ id, keyHash, title, author, doc, forkedFrom = null, version = 1, createdAt = Date.now(), updatedAt = createdAt, base = null }) {
    return this.q.insert.run(id, keyHash, title, author, JSON.stringify(doc), version, forkedFrom, createdAt, updatedAt, base ? JSON.stringify(base) : null).changes === 1;
  }

  get(id) {
    const row = this.q.get.get(id);
    return row ? { ...row, doc: JSON.parse(row.doc) } : null;
  }

  // Returns false if someone else wrote first.
  update(id, version, { title, author, doc }) {
    return this.q.update.run(title, author, JSON.stringify(doc), Date.now(), id, version).changes === 1;
  }

  count() { return this.q.count.get().n; }

  setCode(id, code) { this.q.setCode.run(code, id); }

  // Suggestions, with doc and before parsed.
  #suggestion(row) { return row ? { ...row, doc: JSON.parse(row.doc), before: row.before ? JSON.parse(row.before) : null } : null; }
  suggestion(id) { return this.#suggestion(this.q.suggestion.get(id)); }
  openSuggestions(unitId) { return this.q.openFor.all(unitId).map((r) => this.#suggestion(r)); }
  latestSuggestionFrom(fromId) { return this.#suggestion(this.q.latestFrom.get(fromId)); }
  addSuggestion({ id, unitId, fromId, author, title, note, doc, at = Date.now() }) {
    this.q.addSuggestion.run(id, unitId, fromId, author, title, note, JSON.stringify(doc), at, at);
  }
  resendSuggestion(id, { author, title, note, doc, at = Date.now() }) {
    return this.q.resendSuggestion.run(author, title, note, JSON.stringify(doc), at, id).changes === 1;
  }
  closeSuggestion(id, status, { before = null, version = null } = {}) {
    this.q.closeSuggestion.run(status, before ? JSON.stringify(before) : null, version, Date.now(), id);
  }
  dropSuggestion(id) { this.q.dropSuggestion.run(id); }

  // Designs saved before units existed (designs.db) were furniture placed in
  // the one apartment, which is now the example unit. Bring them over once,
  // with the same ids and edit keys, so their links keep working.
  importDesigns(toDoc) {
    const file = join(this.dataDir, 'designs.db');
    if (this.count() > 0 || !existsSync(file)) return 0;
    const old = new DatabaseSync(file, { readOnly: true });
    let n = 0;
    try {
      for (const r of old.prepare('SELECT * FROM designs').all()) {
        let doc;
        try { doc = toDoc(JSON.parse(r.doc)); } catch { continue; }
        n += this.insert({
          id: r.id, keyHash: r.key_hash, title: r.title, author: r.author, doc,
          forkedFrom: r.forked_from, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
        }) ? 1 : 0;
      }
    } finally {
      old.close();
    }
    return n;
  }

  // A consistent copy of the database, one a day, a week of them kept.
  backup() {
    const dir = join(this.dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const name = `units-${day}.db`;
    const existing = readdirSync(dir).filter((f) => /^units-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    if (!existing.includes(name)) this.db.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
    for (const old of existing.filter((f) => f !== name).slice(0, -6)) rmSync(join(dir, old), { force: true });
  }

  close() { this.db.close(); }
}
