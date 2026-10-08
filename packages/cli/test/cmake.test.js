import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAddFilters, addFilterFor } from '../src/lib/cmake.js';
import { Project } from '../src/lib/project.js';
import { filterManifest } from '../src/lib/pack.js';

const repo = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-cmake-test-'));
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  return d;
};

// The shape of every filter repository's CMakeLists.txt (libjxl).
const LIBJXL_CMAKE = `cmake_minimum_required(VERSION 3.7)
project(Filters)
include(filters.cmake)
# No libc++/libc++abi here: the C++ runtime comes from the solver. (parentheses in a comment)
add_filter(libjxl
        "\${LIBJXL_SRC}"
        "\${LIBJXL_LIB}"
        []
        ""
        "\${LIBJXL_INC}"
        "-O0"
        "1")
set_source_files_properties(libcxx_compat_shim.cpp PROPERTIES COMPILE_FLAGS "-O0")
`;

describe('reading add_filter()', () => {
  test('name, generation and line of the real layout', () => {
    const calls = readAddFilters(repo({ 'CMakeLists.txt': LIBJXL_CMAKE }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'libjxl');
    assert.equal(calls[0].generation, 1);
    assert.equal(calls[0].line, 5);
  });

  test('commented-out calls and parentheses in strings or comments are ignored', () => {
    const d = repo({ 'CMakeLists.txt': `# add_filter(old "" "" [] "" "" "" "9")
add_filter(x "a(b)" "\${L}" [] "" "" "" "3") # add_filter(y ... "4")` });
    assert.deepEqual(readAddFilters(d).map((c) => [c.name, c.generation]), [['x', 3]]);
  });

  test('a generation that is a variable is reported, not guessed', () => {
    const c = readAddFilters(repo({ 'CMakeLists.txt': 'add_filter(x "" "" [] "" "" "" "${GEN}")' }))[0];
    assert.equal(c.generation, null);
    assert.equal(c.rawGeneration, '${GEN}');
  });

  test('the call for a given accessor is found by name, case aside', () => {
    const d = repo({ 'CMakeLists.txt': 'add_filter(a "" "" [] "" "" "" "1")\nADD_FILTER(libOpenVVC "" "" [] "" "" "" "2")' });
    assert.equal(addFilterFor(d, 'libopenvvc').generation, 2);
    assert.equal(addFilterFor(d, 'nope'), null, 'with several calls, no match means none');
  });

  test('no CMakeLists.txt, no call', () => {
    assert.deepEqual(readAddFilters(repo({})), []);
  });
});

describe('what the manifest leaves out', () => {
  const manifest = (extra = {}) => JSON.stringify({ name: 'libjxl', description: 'JXL decoder', filters: ['jxldec'], ...extra }, null, 4);
  const load = (d, file = 'libjxl.json') => new Project(d, path.join(d, file));

  test('no "version": generation N from CMake becomes N.0.0', () => {
    const d = repo({ 'libjxl.json': manifest(), 'CMakeLists.txt': LIBJXL_CMAKE.replace('"1")', '"3")') });
    const m = filterManifest(load(d));
    assert.equal(m.abi, 3);
    assert.equal(m.version, '3.0.0');
    assert.equal(m.main, path.join('.bevara', '.build', 'libjxl_3.wasm'));
    assert.match(m.derived.generation, /add_filter in CMakeLists\.txt, line 5/);
  });

  test('an explicit "version" wins, the generation still comes from CMake', () => {
    const d = repo({ 'libjxl.json': manifest({ version: '1.4.2' }), 'CMakeLists.txt': LIBJXL_CMAKE });
    const m = filterManifest(load(d));
    assert.equal(m.version, '1.4.2');
    assert.equal(m.abi, 1);
    assert.equal(m.derived.version, undefined);
  });

  test('"main" naming the file takes precedence over CMake', () => {
    const d = repo({ 'libjxl.json': manifest({ main: 'dist/libjxl_7.wasm' }), 'CMakeLists.txt': LIBJXL_CMAKE });
    assert.equal(filterManifest(load(d)).abi, 7);
  });

  test('without CMake, the single built module gives the generation', () => {
    const d = repo({ 'libjxl.json': manifest(), 'out/libjxl_2.wasm': '' });
    const m = filterManifest(load(d), { buildDir: 'out' });
    assert.equal(m.abi, 2);
    assert.equal(m.version, '2.0.0');
  });

  test('several built generations and no CMake: reported, not picked', () => {
    const d = repo({ 'libjxl.json': manifest(), 'build/libjxl_1.wasm': '', 'build/libjxl_2.wasm': '' });
    const m = filterManifest(load(d));
    assert.ok(m.derived.notes.some((n) => /several generations built/.test(n)));
  });

  test('a mixed-case name keeps its spelling for the file and is lowercase as a package', () => {
    const d = repo({
      'libOpenVVC.json': JSON.stringify({ name: 'libOpenVVC', filters: ['vvcdec'] }),
      'CMakeLists.txt': 'add_filter(libOpenVVC "" "" [] "" "" "" "1")',
    });
    const m = filterManifest(load(d, 'libOpenVVC.json'));
    assert.equal(m.name, 'libopenvvc');
    assert.equal(m.module, 'libOpenVVC');
    assert.equal(m.main, path.join('.bevara', '.build', 'libOpenVVC_1.wasm'));
  });

  test('CMake building a differently named filter is reported', () => {
    const d = repo({ 'libjxl.json': manifest(), 'CMakeLists.txt': 'add_filter(other "" "" [] "" "" "" "1")' });
    const m = filterManifest(load(d));
    assert.ok(m.derived.notes.some((n) => /CMakeLists\.txt builds other_1\.wasm/.test(n)), JSON.stringify(m.derived));
  });

  test('the manifest object itself is never modified', () => {
    const d = repo({ 'libjxl.json': manifest(), 'CMakeLists.txt': LIBJXL_CMAKE });
    const p = load(d);
    filterManifest(p);
    assert.equal(p.manifest.version, undefined);
    assert.equal(p.manifest.abi, undefined);
  });
});
