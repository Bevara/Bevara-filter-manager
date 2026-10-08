import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { generateKeyPair, signRecord, canonicalize } from '../src/sig.js';

export const FIXTURE_WASM = fs.readFileSync(new URL('./fixtures/dummy_1.wasm', import.meta.url));

export async function startRegistry(config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-registry-test-'));
  const app = createApp({ dataDir, dbFile: ':memory:', ...config });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, p, { body, token, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload = body;
    if (body && !Buffer.isBuffer(body)) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : ct.includes('text') ? await res.text() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  const close = async () => { await new Promise((r) => app.server.close(r)); app.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { app, base, api, close, dataDir };
}

// Builds a publish tarball in memory: package/bevara.json + package/<name>_<abi>.wasm (+ extras).
export async function makeTarball(manifest, { wasm = FIXTURE_WASM, extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-tgz-'));
  const pkg = path.join(dir, 'package');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'bevara.json'), JSON.stringify(manifest));
  if (wasm) fs.writeFileSync(path.join(pkg, `${manifest.module ?? manifest.name.split(':').pop()}_${manifest.abi ?? 1}.wasm`), wasm);
  for (const [k, v] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(pkg, k)), { recursive: true }); fs.writeFileSync(path.join(pkg, k), v); }
  const file = path.join(dir, 'p.tgz');
  await tar.create({ gzip: true, cwd: dir, file }, ['package']);
  const buf = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

export const manifest = (over = {}) => ({ name: 'dummy', version: '1.0.0', abi: 1, description: 'Dummy decoder', filters: ['dummydec'], support: ['video'], formats: ['Dummy'], license: 'MIT', ...over });

// token -> signing key registered for that token's user
export const keys = new Map();

export async function signup(api, name = 'alice') {
  const r = await api('POST', '/-/user', { body: { name, password: 'password123', email: `${name}@example.org` } });
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  const key = generateKeyPair();
  const k = await api('PUT', '/-/keys', { token: r.data.token, body: { publicKey: key.publicKey, label: 'test' } });
  if (k.status !== 201) throw new Error(`key registration failed: ${JSON.stringify(k.data)}`);
  keys.set(r.data.token, key);
  return r.data.token;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

// Publishes like the CLI does: tarball + signed record headers (unless sign:false).
export async function publish(api, token, m, { sign = true, record: override, key: keyOverride, ...opts } = {}) {
  const tarball = await makeTarball(m, opts);
  const headers = { 'content-type': 'application/gzip' };
  const key = keyOverride ?? keys.get(token);
  if (sign && key) {
    const wasm = opts.wasm ?? FIXTURE_WASM;
    const full = m.name.includes(':') ? m.name : `bevara:${m.name}`;
    const record = { type: 'publish', name: full, version: m.version, abi: m.abi ?? 1, file: `${m.module ?? m.name.split(':').pop()}_${m.abi ?? 1}.wasm`, wasmSha256: sha(wasm), tarballSha256: sha(tarball), keyId: key.keyId, timestamp: new Date().toISOString(), ...override };
    headers['x-bevara-record'] = Buffer.from(canonicalize(record)).toString('base64');
    headers['x-bevara-signature'] = signRecord(record, key.privateKey);
  }
  return api('PUT', `/filters/${encodeURIComponent(m.name)}/${m.version}`, { token, body: tarball, headers });
}
