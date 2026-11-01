import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchModules, cacheDir } from '../src/lib/run-prep.js';

const integrity = (b) => `sha256-${createHash('sha256').update(b).digest('base64')}`;
const files = { 'flac.wasm': Buffer.from('flac'), 'mm_solver_1.0.1.js': Buffer.from('s1js'), 'mm_solver_1.0.1.wasm': Buffer.from('s1'), 'mm_solver_minimal_1.0.1.js': Buffer.from('smjs'), 'mm_solver_minimal_1.0.1.wasm': Buffer.from('sm') };
const at = (f) => `https://r/acc/${f}`;
const index = {
  filters: [{ name: 'bevara:libflac', file: 'libflac_1.wasm', url: at('flac.wasm'), integrity: integrity(files['flac.wasm']), using: ['mm_solver_minimal_1.0.1', 'mm_solver_1.0.1'] }],
  runtimes: [
    { name: 'bevara:mm_solver', module: 'mm_solver_1.0.1', file: 'mm_solver_1.0.1.wasm', url: at('mm_solver_1.0.1.wasm'), integrity: integrity(files['mm_solver_1.0.1.wasm']), js: 'mm_solver_1.0.1.js', jsUrl: at('mm_solver_1.0.1.js'), jsIntegrity: integrity(files['mm_solver_1.0.1.js']) },
    { name: 'bevara:mm_solver_minimal', module: 'mm_solver_minimal_1.0.1', file: 'mm_solver_minimal_1.0.1.wasm', url: at('mm_solver_minimal_1.0.1.wasm'), integrity: integrity(files['mm_solver_minimal_1.0.1.wasm']), js: 'mm_solver_minimal_1.0.1.js', jsUrl: at('mm_solver_minimal_1.0.1.js'), jsIntegrity: integrity(files['mm_solver_minimal_1.0.1.js']) },
  ],
};
const client = { download: async (u) => files[u.split('/').pop()] };

test('test and bench need no install: the modules and a runtime they share go to the cache', async () => {
  process.env.BEVARA_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-cache-'));
  try {
    const dir = await fetchModules([['libflac_1']], index, { client, registry: 'https://registry.example' });
    assert.equal(dir, cacheDir('https://registry.example'));
    for (const f of ['libflac_1.wasm', 'mm_solver_1.0.1.js', 'mm_solver_1.0.1.wasm', 'mm_solver_minimal_1.0.1.wasm']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'libflac.json'), 'utf8')).using, ['mm_solver_minimal_1.0.1', 'mm_solver_1.0.1']);
    // --solver narrows the runtimes fetched; an unpublished module is said so.
    await assert.rejects(fetchModules([['libflac_1', 'nothere_1']], index, { client, registry: 'https://registry.example' }), /nothere_1 is not published/);
    await assert.rejects(fetchModules([['libflac_1']], index, { client, registry: 'https://registry.example', solver: 'solver_x_1' }), /no runtime/);
  } finally {
    fs.rmSync(process.env.BEVARA_CACHE, { recursive: true, force: true });
    delete process.env.BEVARA_CACHE;
  }
});
