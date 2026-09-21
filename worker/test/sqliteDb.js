import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

// A D1-shaped wrapper over an in-memory SQLite with every migration applied.
// fakeDb.js replays canned rows, which cannot tell whether a query is right;
// this one runs the real SQL against the real schema, constraints and
// triggers included. Only the calls the ledger modules make are covered.
export function sqliteDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));

  const plain = (row) => (row ? { ...row } : row);
  return {
    sqlite,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) {
          params = values;
          return statement;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...params).map(plain) };
        },
        async first() {
          return plain(sqlite.prepare(sql).get(...params)) ?? null;
        },
        async run() {
          sqlite.prepare(sql).run(...params);
          return { success: true };
        },
      };
      return statement;
    },
  };
}
