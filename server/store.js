// Designs in SQLite (node:sqlite, built into Node 24). One row per design; the
// furniture and custom assets are a JSON document in the row.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.db = new DatabaseSync(join(dataDir, 'designs.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS designs (
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
      insert: this.db.prepare(`INSERT INTO designs (id, key_hash, title, author, doc, version, forked_from, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`),
      get: this.db.prepare('SELECT * FROM designs WHERE id = ?'),
      // The version check makes concurrent writes to one design take turns.
      update: this.db.prepare(`UPDATE designs SET title = ?, author = ?, doc = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM designs'),
    };
  }

  insert({ id, keyHash, title, author, doc, forkedFrom = null }) {
    const now = Date.now();
    this.q.insert.run(id, keyHash, title, author, JSON.stringify(doc), forkedFrom, now, now);
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

  // A consistent copy of the database, one a day, seven kept.
  backup() {
    const dir = join(this.dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = join(dir, `designs-${day}.db`);
    const existing = readdirSync(dir).filter((f) => /^designs-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    if (!existing.includes(`designs-${day}.db`)) this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    for (const old of existing.filter((f) => f !== `designs-${day}.db`).slice(0, -6)) rmSync(join(dir, old), { force: true });
  }

  close() { this.db.close(); }
}
