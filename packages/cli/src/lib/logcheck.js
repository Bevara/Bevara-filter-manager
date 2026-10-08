// Client-side verification of the registry's append-only log.
//
// The lockfile pins the last checkpoint the project observed:
//   "log": { "seq", "head", "registryKeyId", "registryKey", "checkedAt" }
// On each audit the client fetches the entries after that seq, re-derives the
// hash chain from the pinned head and checks the new checkpoint's signature
// with the pinned registry key. A registry that rewrote or dropped entries
// cannot produce a chain that extends the pinned head.
import { verifyChain, verifyRecord, keyIdOf, GENESIS } from './sig.js';

export async function fetchKeys(client) {
  const { keys } = await client.get('/-/log/keys/all');
  return new Map(keys.map((k) => [k.keyId, k]));
}

export function checkCheckpoint(cp, pinned) {
  const findings = [];
  const { signature, publicKey, ...body } = cp;
  if (keyIdOf(publicKey) !== cp.keyId) findings.push({ severity: 'critical', kind: 'log', message: 'checkpoint key id does not match its public key' });
  if (!verifyRecord(body, signature, publicKey)) findings.push({ severity: 'critical', kind: 'log', message: 'checkpoint signature is invalid' });
  if (pinned?.registryKeyId && pinned.registryKeyId !== cp.keyId) findings.push({ severity: 'critical', kind: 'log', message: `registry signing key changed (${pinned.registryKeyId} → ${cp.keyId}); verify out of band and delete "log" from bevara-lock.json to re-pin` });
  return findings;
}

// Returns { findings, entries, checkpoint, newPin }.
export async function verifyLogSince(client, pinned, { keys } = {}) {
  const findings = [];
  const since = pinned?.seq ?? 0;
  const startHash = pinned?.head ?? GENESIS;
  let entries = [], cp = null, cursor = since;
  for (;;) {
    const page = await client.get(`/-/log?since=${cursor}&limit=2000`);
    entries = entries.concat(page.entries);
    cp = page.checkpoint;
    if (!page.more) break;
    cursor = page.entries.at(-1).seq;
  }
  findings.push(...checkCheckpoint(cp, pinned));
  keys ??= await fetchKeys(client);
  const chain = verifyChain(entries, { startHash, startSeq: since, resolveKey: (id) => keys.get(id)?.publicKey ?? null });
  if (!chain.ok) findings.push({ severity: 'critical', kind: 'log', message: `log verification failed: ${chain.error}` });
  else if (cp.seq !== chain.seq || cp.head !== chain.head) {
    if (cp.seq < since) findings.push({ severity: 'critical', kind: 'log', message: `registry log shrank: pinned seq ${since}, registry reports ${cp.seq} (history rewritten)` });
    else findings.push({ severity: 'critical', kind: 'log', message: `registry checkpoint (${cp.seq}, ${cp.head.slice(0, 12)}…) does not match the recomputed chain (${chain.seq}, ${chain.head.slice(0, 12)}…)` });
  }
  const newPin = chain.ok && !findings.length ? { seq: cp.seq, head: cp.head, registryKeyId: cp.keyId, registryKey: cp.publicKey, checkedAt: new Date().toISOString() } : null;
  return { findings, entries, checkpoint: cp, newPin, keys };
}
