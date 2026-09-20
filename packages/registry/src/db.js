import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT,
  oidc_sub TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS filters (
  name TEXT PRIMARY KEY,
  description TEXT,
  latest TEXT,
  deprecated TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS versions (
  name TEXT NOT NULL REFERENCES filters(name) ON DELETE CASCADE,
  version TEXT NOT NULL,
  abi INTEGER NOT NULL DEFAULT 1,
  manifest TEXT NOT NULL,
  wasm_file TEXT NOT NULL,
  wasm_sha256 TEXT NOT NULL,
  wasm_size INTEGER NOT NULL,
  wasm_br_size INTEGER,
  tarball_sha256 TEXT NOT NULL,
  tarball_size INTEGER NOT NULL,
  wasm_info TEXT,
  published_by TEXT,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deprecated TEXT,
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS owners (
  name TEXT NOT NULL REFERENCES filters(name) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (name, user_id)
);
CREATE TABLE IF NOT EXISTS advisories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  range TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS advisories_name ON advisories(name);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
