// Units in SQLite (node:sqlite, built into Node 24). One row per unit; the unit
// spec, its furniture and its custom assets are one JSON document in the row:
// { unit, unitRev, items, assets }.
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
    this.q = {
      insert: this.db.prepare(`INSERT OR IGNORE INTO units (id, key_hash, title, author, doc, version, forked_from, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      get: this.db.prepare('SELECT * FROM units WHERE id = ?'),
      // The version check makes concurrent writes to one unit take turns.
      update: this.db.prepare(`UPDATE units SET title = ?, author = ?, doc = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM units'),
    };
  }

  insert({ id, keyHash, title, author, doc, forkedFrom = null, version = 1, createdAt = Date.now(), updatedAt = createdAt }) {
    return this.q.insert.run(id, keyHash, title, author, JSON.stringify(doc), version, forkedFrom, createdAt, updatedAt).changes === 1;
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
