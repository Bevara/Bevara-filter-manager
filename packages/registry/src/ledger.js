// The registry's append-only log ("ledger") and its own signing key.
//
// Every publish is recorded as an entry {seq, prev_hash, hash, record,
// signature, key_id}. Publish records are signed by the publisher's key;
// registry-originated records (yank, deprecate) are signed by the registry key.
// A checkpoint {seq, head, timestamp} signed by the registry key lets clients
// pin the head they observed and detect any rewrite of history.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, entryHash, generateKeyPair, signRecord, keyIdOf, GENESIS, sha256hex } from './sig.js';

export class Ledger {
  constructor(db, { dataDir, keyFile } = {}) {
    this.db = db;
    const file = keyFile ?? (dataDir ? path.join(dataDir, 'registry-key.json') : null);
    if (file && fs.existsSync(file)) this.key = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      this.key = generateKeyPair();
      if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(this.key), { mode: 0o600 }); }
    }
    this.keyId = keyIdOf(this.key.publicKey);
  }

  head() {
    const row = this.db.prepare('SELECT seq, hash FROM log ORDER BY seq DESC LIMIT 1').get();
    return row ?? { seq: 0, hash: GENESIS };
  }

  // Appends an already-signed record. Callers verify signatures beforehand.
  append(record, signature, keyId) {
    const { hash: prev } = this.head();
    const hash = entryHash(prev, record, signature);
    const r = this.db.prepare('INSERT INTO log (prev_hash, hash, record, signature, key_id, name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(prev, hash, canonicalize(record), signature, keyId, record.name ?? '');
    return { seq: Number(r.lastInsertRowid), hash, prevHash: prev };
  }

  // Records emitted by the registry itself (yank/deprecate) are signed with its key.
  appendOwn(record) {
    const rec = { ...record, keyId: this.keyId, timestamp: new Date().toISOString() };
    return this.append(rec, signRecord(rec, this.key.privateKey), this.keyId);
  }

  entries({ since = 0, limit = 1000, name } = {}) {
    const rows = name
      ? this.db.prepare('SELECT * FROM log WHERE name = ? AND seq > ? ORDER BY seq LIMIT ?').all(name, since, limit)
      : this.db.prepare('SELECT * FROM log WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit);
    return rows.map((r) => ({ seq: r.seq, prevHash: r.prev_hash, hash: r.hash, record: JSON.parse(r.record), signature: r.signature, keyId: r.key_id, createdAt: r.created_at }));
  }

  checkpoint() {
    const { seq, hash } = this.head();
    const cp = { seq, head: hash, timestamp: new Date().toISOString(), keyId: this.keyId };
    return { ...cp, signature: signRecord(cp, this.key.privateKey), publicKey: this.key.publicKey };
  }

  // Inclusion "proof" for a linear hash chain: the entry plus the hashes of the
  // entries after it up to the head, so a client holding a signed checkpoint
  // can recompute the head. Bounded by `maxLen`; beyond that clients fetch the
  // log incrementally.
  proof(seq, maxLen = 256) {
    const entry = this.db.prepare('SELECT * FROM log WHERE seq = ?').get(seq);
    if (!entry) return null;
    const rest = this.db.prepare('SELECT seq, record, signature FROM log WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, maxLen)
      .map((r) => ({ seq: r.seq, recordHash: sha256hex(r.record), signature: r.signature }));
    return { seq, prevHash: entry.prev_hash, hash: entry.hash, record: JSON.parse(entry.record), signature: entry.signature, keyId: entry.key_id, path: rest, truncated: rest.length === maxLen };
  }
}
