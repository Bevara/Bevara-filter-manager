import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pageRequirements, locateSources, deployFiles } from '../src/lib/page-files.js';
import { readExecutables } from '../src/lib/cmake.js';
import { runtimeBuiltins } from '../src/lib/caps.js';
import { validateManifest } from '../src/lib/manifest.js';
import { Project } from '../src/lib/project.js';
import { filterManifest } from '../src/lib/pack.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-page-'));
const integrity = (b) => `sha256-${createHash('sha256').update(b).digest('base64')}`;

const PAGE = `<html><body>
<img is="universal-img_1" src="a.jxl" using="solver_minimal_1" with="libjxl_1">
<canvas is="universal-canvas_1" data-url="v.mp4" using="solver_1" with="isobmff_1;libde265_1" script-directory="https://cdn.example/acc/"></canvas>
<script src="scripts/universal-img_1.js"></script>
<script src="https://cdn.example/universal-canvas_1.js"></script>
</body></html>`;

test('page requirements: the tag script, the solver pair and the accessors, next to the page', () => {
  const dir = tmp();
  const reqs = pageRequirements(PAGE, dir);
  assert.deepEqual(reqs.map((r) => [r.kind, r.ref]), [
    ['script', 'scripts/universal-img_1.js'],
    ['solver', 'solver_minimal_1.js'], ['solver', 'solver_minimal_1.wasm'],
    ['accessor', 'libjxl_1.wasm'],
  ]);
  // An absolute script-directory or script URL is served from elsewhere: nothing to copy.
  assert.ok(!reqs.some((r) => /isobmff|solver_1|canvas/.test(r.name)));
});

test('deploy: local runtime dirs first, solvers from the runtime packages, integrity checked, hand-made files kept unless --refresh', async () => {
  const dir = tmp(), rt = tmp();
  fs.writeFileSync(path.join(rt, 'solver_minimal_1.js'), 'local solver js');
  const wasm = Buffer.from('\0asm\x01\0\0\0');
  const served = { 'https://r/acc/libjxl_1.wasm': wasm, 'https://r/rt/solver_minimal_1.wasm': wasm };
  const client = { download: async (u) => served[u] };
  const index = {
    filters: [{ name: 'bevara:libjxl', version: '1.0.0', file: 'libjxl_1.wasm', url: 'https://r/acc/libjxl_1.wasm', integrity: integrity(wasm) }],
    runtimes: [{ name: 'bevara:solver_minimal', version: '1.0.0', module: 'solver_minimal_1', file: 'solver_minimal_1.wasm', url: 'https://r/rt/solver_minimal_1.wasm', integrity: integrity(wasm),
      js: 'solver_minimal_1.js', jsUrl: 'https://r/rt/solver_minimal_1.js', jsIntegrity: integrity(Buffer.from('x')) }],
  };
  const located = locateSources(pageRequirements(PAGE, dir), { index, runtimeDirs: [rt] });
  let r = await deployFiles(located, { client });
  const by = (name) => r.find((x) => x.name === name);
  assert.equal(by('solver_minimal_1.js').status, 'added');
  assert.equal(by('solver_minimal_1.js').source.file, path.join(rt, 'solver_minimal_1.js'));
  assert.equal(by('solver_minimal_1.wasm').status, 'added');
  assert.equal(by('solver_minimal_1.wasm').source.label, 'bevara:solver_minimal@1.0.0');
  assert.equal(by('libjxl_1.wasm').status, 'added');
  // The tag scripts are not on the registry: --runtime or nothing.
  assert.equal(by('universal-img_1.js').status, 'missing');

  fs.writeFileSync(path.join(dir, 'libjxl_1.wasm'), 'built by hand');
  r = await deployFiles(located, { client });
  assert.equal(by('libjxl_1.wasm').status, 'kept');
  assert.equal(by('solver_minimal_1.wasm').status, 'present');
  r = await deployFiles(located, { client, refresh: true });
  assert.equal(by('libjxl_1.wasm').status, 'replaced');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'libjxl_1.wasm')), wasm);
  // A bad integrity is refused; a dry run writes nothing.
  const other = tmp();
  r = await deployFiles(locateSources(pageRequirements(PAGE, other), { index }), { client: { download: async () => Buffer.from('tampered') }, dryRun: true });
  assert.equal(by('libjxl_1.wasm').status, 'failed');
  assert.deepEqual(fs.readdirSync(other), []);
});

test('a runtime: generation from add_executable, built-in filters from loader.js, no "filters" nor "using"', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.7)\nset(VERSION "1")\n# add_executable(old_${VERSION} x.c)\nadd_executable(solver_minimal_${VERSION} ${SRC})\n');
  fs.writeFileSync(path.join(dir, 'loader.js'), 'addFunction(Module._fin_register); Module._fout_register; Module._auto_register; Module._fin_register');
  fs.writeFileSync(path.join(dir, 'LICENCE'), 'SPDX-License-Identifier: LGPL-2.1-or-later\n');
  fs.writeFileSync(path.join(dir, 'solver_minimal.json'), JSON.stringify({ name: 'solver_minimal', kind: 'runtime', description: 'x' }));
  assert.deepEqual(readExecutables(dir).map((e) => [e.name, e.generation]), [['solver_minimal', 1]]);
  assert.deepEqual(runtimeBuiltins(dir), ['fin', 'fout']);
  const m = filterManifest(Project.load({ dir }));
  assert.equal(m.version, '1.0.0');
  assert.equal(m.license, 'LGPL-2.1-or-later');
  assert.deepEqual(m.builtins, ['fin', 'fout']);
  assert.ok(m.main.endsWith('solver_minimal_1.wasm'));
  assert.deepEqual(validateManifest(m, { forPublish: true }).errors, []);
  assert.ok(validateManifest({ ...m, using: ['solver_1'] }).errors.some((e) => /no "using"/.test(e)));
  assert.ok(validateManifest({ ...m, filters: ['x'] }).errors.some((e) => /no "filters"/.test(e)));
});

test('a filter must name its runtimes in "using" to be published', () => {
  const f = { name: 'x', version: '1.0.0', filters: ['xdec'] };
  assert.ok(validateManifest(f, { forPublish: true }).errors.some((e) => /"using" must list the runtimes/.test(e)));
  assert.deepEqual(validateManifest({ ...f, using: ['solver_1'] }, { forPublish: true }).errors, []);
});
