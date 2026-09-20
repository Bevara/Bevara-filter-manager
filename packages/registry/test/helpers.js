import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { createApp } from '../src/app.js';

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
  if (wasm) fs.writeFileSync(path.join(pkg, `${manifest.name}_${manifest.abi ?? 1}.wasm`), wasm);
  for (const [k, v] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(pkg, k)), { recursive: true }); fs.writeFileSync(path.join(pkg, k), v); }
  const file = path.join(dir, 'p.tgz');
  await tar.create({ gzip: true, cwd: dir, file }, ['package']);
  const buf = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return buf;
}

export const manifest = (over = {}) => ({ name: 'dummy', version: '1.0.0', abi: 1, description: 'Dummy decoder', filters: ['dummydec'], support: ['video'], formats: ['Dummy'], license: 'MIT', ...over });

export async function signup(api, name = 'alice') {
  const r = await api('POST', '/-/user', { body: { name, password: 'password123', email: `${name}@example.org` } });
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

export async function publish(api, token, m, opts) {
  return api('PUT', `/filters/${m.name}/${m.version}`, { token, body: await makeTarball(m, opts), headers: { 'content-type': 'application/gzip' } });
}
