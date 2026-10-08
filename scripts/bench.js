#!/usr/bin/env node
// Reproducible measurements used in the paper section (docs/paper).
//   node scripts/bench.js --wasm-dir ../Showcase/accessors --json-dir ../filters
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createApp } from '../packages/registry/src/app.js';
import { generateKeyPair, signRecord, canonicalize, verifyChain, verifyRecord, entryHash, GENESIS } from '../packages/registry/src/sig.js';
import { RegistryClient } from '../packages/cli/src/lib/registry-client.js';
import { resolveTree } from '../packages/cli/src/lib/resolve.js';
import * as tar from 'tar';

const { values: o } = parseArgs({ options: { 'wasm-dir': { type: 'string' }, 'json-dir': { type: 'string' }, only: { type: 'string' } } });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-bench-'));
const app = createApp({ dataDir, dbFile: path.join(dataDir, 'db.sqlite') });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const api = async (m, p, { body, token, headers = {} } = {}) => {
  const h = { ...headers }; if (token) h.authorization = `Bearer ${token}`;
  let payload = body; if (body && !Buffer.isBuffer(body)) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + p, { method: m, headers: h, body: payload });
  return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], mean: s.reduce((a, b) => a + b, 0) / s.length, min: s[0], max: s.at(-1) }; };
const fmt = (x) => (typeof x === 'number' ? x.toFixed(2) : x);

const admin = (await api('POST', '/-/user', { body: { name: 'admin', password: 'password123' } })).data.token;
const key = generateKeyPair();
await api('PUT', '/-/keys', { token: admin, body: { publicKey: key.publicKey } });

async function tarballFor(manifest, wasm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-tgz-'));
  fs.mkdirSync(path.join(dir, 'package'));
  fs.writeFileSync(path.join(dir, 'package/bevara.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, `package/${manifest.name.split(':').pop()}_${manifest.abi}.wasm`), wasm);
  await tar.create({ gzip: true, cwd: dir, file: path.join(dir, 'p.tgz') }, ['package']);
  const buf = fs.readFileSync(path.join(dir, 'p.tgz')); fs.rmSync(dir, { recursive: true, force: true }); return buf;
}

// ------------------------------------------------------------ 1. publish real accessors
const rows = [];
if (o['wasm-dir']) {
  const only = o.only ? new Set(o.only.split(',')) : null;
  for (const file of fs.readdirSync(o['wasm-dir']).sort()) {
    const m = /^([a-z0-9][a-z0-9._-]*)_(\d+)\.wasm$/i.exec(file); if (!m) continue;
    const name = m[1].toLowerCase(); if (only && !only.has(name)) continue;
    let src = {}; for (const c of [path.join(o['json-dir'] ?? '', name, `${name}.json`)]) if (o['json-dir'] && fs.existsSync(c)) src = JSON.parse(fs.readFileSync(c, 'utf8'));
    const wasm = fs.readFileSync(path.join(o['wasm-dir'], file));
    const manifest = { name: `bevara:${name}`, version: '1.0.0', abi: parseInt(m[2], 10), description: src.description ?? name, filters: src.filters ?? [name], support: src.support ?? [], formats: src.Format ?? [], license: 'LGPL-2.1-or-later', inputs: [{ stream_type: 'visual' }], outputs: [{ stream_type: 'visual', codec: 'raw' }] };
    const t0 = performance.now();
    const tgz = await tarballFor(manifest, wasm);
    const t1 = performance.now();
    const record = { type: 'publish', name: manifest.name, version: '1.0.0', abi: manifest.abi, file: `${name}_${manifest.abi}.wasm`, wasmSha256: sha(wasm), tarballSha256: sha(tgz), keyId: key.keyId, timestamp: new Date().toISOString() };
    const sig = signRecord(record, key.privateKey);
    const t2 = performance.now();
    const r = await api('PUT', `/filters/${encodeURIComponent(manifest.name)}/1.0.0`, { token: admin, body: tgz, headers: { 'content-type': 'application/gzip', 'x-bevara-record': Buffer.from(canonicalize(record)).toString('base64'), 'x-bevara-signature': sig } });
    const t3 = performance.now();
    if (r.status !== 201) { console.error(name, r.data); continue; }
    const { brotliCompressSync: bc, constants: zc } = await import('node:zlib');
    const tb0 = performance.now(); bc(wasm, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: wasm.length } }); const brotli_ms = performance.now() - tb0;
    rows.push({ name, wasm: wasm.length, tgz: tgz.length, br: r.data.dist.brSize, pack_ms: t1 - t0, sign_ms: t2 - t1, server_ms: t3 - t2, brotli_ms });
  }
  console.log('\n== 1. Publish (client pack + sign, then server: unpack, validate, brotli, log append)');
  console.log('name'.padEnd(14), 'wasm kB'.padStart(8), 'tgz kB'.padStart(7), 'br kB'.padStart(6), 'pack ms'.padStart(8), 'sign ms'.padStart(8), 'server ms'.padStart(10), 'of which brotli'.padStart(16));
  for (const r of rows) console.log(r.name.padEnd(14), (r.wasm / 1024).toFixed(0).padStart(8), (r.tgz / 1024).toFixed(0).padStart(7), (r.br / 1024).toFixed(0).padStart(6), fmt(r.pack_ms).padStart(8), fmt(r.sign_ms).padStart(8), fmt(r.server_ms).padStart(10), fmt(r.brotli_ms).padStart(16));
  const tot = rows.reduce((a, r) => a + r.wasm, 0), totBr = rows.reduce((a, r) => a + r.br, 0);
  console.log(`total ${rows.length} accessors: ${(tot / 1024).toFixed(0)} kB raw, ${(totBr / 1024).toFixed(0)} kB brotli (${(100 * totBr / tot).toFixed(0)}%); server median ${fmt(stats(rows.map((r) => r.server_ms)).median)} ms of which brotli-11 ${fmt(stats(rows.map((r) => r.brotli_ms)).median)} ms; validation+sig+log median ${fmt(stats(rows.map((r) => r.server_ms - r.brotli_ms)).median)} ms; sign median ${fmt(stats(rows.map((r) => r.sign_ms)).median)} ms`);

  // index size
  const idx = await api('GET', '/accessors/index.json');
  const idxJson = JSON.stringify(idx.data);
  const { brotliCompressSync, gzipSync } = await import('node:zlib');
  console.log(`\n== 2. Capability index (/accessors/index.json) for ${rows.length} accessors: ${idxJson.length} B raw, ${gzipSync(idxJson).length} B gzip, ${brotliCompressSync(idxJson).length} B brotli (${(idxJson.length / rows.length).toFixed(0)} B / accessor)`);

  // resolution + install (client side, loopback)
  const client = new RegistryClient(base);
  const names = rows.slice(0, 3).map((r) => `bevara:${r.name}`);
  const t = [];
  for (let i = 0; i < 20; i++) { const t0 = performance.now(); await resolveTree(client, Object.fromEntries(names.map((n) => [n, 'latest']))); t.push(performance.now() - t0); }
  console.log(`\n== 3. Resolve ${names.length} filters (packument fetches + semver): median ${fmt(stats(t).median)} ms over loopback`);
  const dl = [];
  for (let i = 0; i < 10; i++) { const t0 = performance.now(); for (const n of names) { const v = await client.version(n, 'latest'); const buf = await client.download(v.dist.wasm); verifyRecord(v.signature.record, v.signature.signature, v.signature.publicKey); sha(buf); } dl.push(performance.now() - t0); }
  console.log(`   download + sha256 + signature check for ${names.map((n) => n.split(':')[1]).join(', ')}: median ${fmt(stats(dl).median)} ms`);
}

// ------------------------------------------------------------ 4. log verification at scale
console.log('\n== 4. Log verification (client-side Ed25519 + SHA-256, single core)');
const keys = Array.from({ length: 20 }, () => generateKeyPair());
const km = new Map(keys.map((k) => [k.keyId, k.publicKey]));
for (const N of [1000, 10000]) {
  const entries = []; let prev = GENESIS;
  const tb = performance.now();
  for (let i = 1; i <= N; i++) {
    const k = keys[i % keys.length];
    const record = { type: 'publish', name: `bevara:f${i % 300}`, version: `1.${Math.floor(i / 300)}.${i % 7}`, abi: 1, file: `f${i % 300}_1.wasm`, wasmSha256: sha(String(i)), tarballSha256: sha('t' + i), keyId: k.keyId, timestamp: '2026-09-21T00:00:00.000Z' };
    const signature = signRecord(record, k.privateKey);
    const hash = entryHash(prev, record, signature);
    entries.push({ seq: i, prevHash: prev, hash, record, signature, keyId: k.keyId }); prev = hash;
  }
  const build = performance.now() - tb;
  const bytes = JSON.stringify(entries).length;
  const t0 = performance.now(); const hashOnly = verifyChain(entries); const t1 = performance.now();
  const full = verifyChain(entries, { resolveKey: (id) => km.get(id) }); const t2 = performance.now();
  const inc = entries.slice(N - 50); const t3 = performance.now(); verifyChain(inc, { startHash: entries[N - 51].hash, startSeq: N - 50, resolveKey: (id) => km.get(id) }); const t4 = performance.now();
  console.log(`N=${N}: build+sign ${fmt(build)} ms (${fmt(build / N)} ms/entry) | ${(bytes / 1024).toFixed(0)} kB JSON (${(bytes / N).toFixed(0)} B/entry) | hash chain only ${fmt(t1 - t0)} ms (${fmt(1000 * (t1 - t0) / N)} µs/entry) | chain + signatures ${fmt(t2 - t1)} ms (${fmt(1000 * (t2 - t1) / N)} µs/entry) | incremental 50 entries ${fmt(t4 - t3)} ms | ok=${hashOnly.ok && full.ok}`);
}
await new Promise((r) => app.server.close(r)); app.db.close(); fs.rmSync(dataDir, { recursive: true, force: true });
