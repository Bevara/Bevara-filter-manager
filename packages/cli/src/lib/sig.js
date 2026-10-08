// Signing primitives shared by the CLI and the registry (kept dependency-free).
//
// A publish "record" is a small JSON document describing what was published
// (name, version, content hashes). The publisher signs its canonical form with
// an Ed25519 key; the registry verifies it, stores it and appends it to an
// append-only hash-chained log. Anyone can later re-verify the signature and
// the chain without trusting the registry's database.
import { createHash, generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from 'node:crypto';

// Deterministic JSON: sorted keys, no whitespace, no undefined.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { publicKey: pub, privateKey: priv, keyId: keyIdOf(pub) };
}

// Key identifier: "sha256:" + first 16 bytes (hex) of the SPKI DER digest.
export function keyIdOf(publicKeyB64) {
  return 'sha256:' + createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 32);
}

export function signRecord(record, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(canonicalize(record)), key).toString('base64');
}

export function verifyRecord(record, signatureB64, publicKeyB64) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), type: 'spki', format: 'der' });
    return verify(null, Buffer.from(canonicalize(record)), key, Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

// Log entry hash: chains the previous entry, the record and its signature.
export function entryHash(prevHash, record, signature) {
  return entryHashFromDigest(prevHash, sha256hex(canonicalize(record)), signature);
}
export function entryHashFromDigest(prevHash, recordHash, signature) {
  return sha256hex(`${prevHash ?? ''}\n${recordHash}\n${signature}`);
}

export const GENESIS = '0'.repeat(64);

// Walks entries [seq ascending], returns { ok, head, seq, error }.
export function verifyChain(entries, { startHash = GENESIS, startSeq = 0, resolveKey } = {}) {
  let prev = startHash, seq = startSeq;
  for (const e of entries) {
    if (e.seq !== seq + 1) return { ok: false, seq, head: prev, error: `gap in log: expected seq ${seq + 1}, got ${e.seq}` };
    const h = entryHash(prev, e.record, e.signature);
    if (h !== e.hash) return { ok: false, seq: e.seq, head: prev, error: `entry ${e.seq} hash mismatch` };
    if (resolveKey) {
      const pub = resolveKey(e.keyId);
      if (!pub) return { ok: false, seq: e.seq, head: prev, error: `entry ${e.seq}: unknown key ${e.keyId}` };
      if (!verifyRecord(e.record, e.signature, pub)) return { ok: false, seq: e.seq, head: prev, error: `entry ${e.seq}: invalid signature` };
    }
    prev = h; seq = e.seq;
  }
  return { ok: true, head: prev, seq };
}
