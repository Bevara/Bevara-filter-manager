import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterManifestsIn, manifestIn, findProjectRoot, detectIndent, scanTopLevel, updateJsonText, Project } from '../src/lib/project.js';
import { fromLegacy } from '../src/lib/manifest.js';
import { filterManifest } from '../src/lib/pack.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-project-test-'));
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

// A manifest exactly as the filter repositories have them (libjxl.json).
const LIBJXL = `{
    "name": "libjxl",
    "description": "JXL decoder",
    "filters":["jxldec","rfjxl"],
    "help": "This filter decodes JXL images using libjxl.",
    "support": [
        "image"
    ],
    "sources":"https://bevara.ddns.net/sources/libjxl.accessor",
    "filter_source":{
        "jxldec" : "dec_jxl.c",
        "rfjxl" : "reframe_jxl.c"
    },
    "extension":{
      "jxl" : "img"
    },
    "licence_required":false
}
`;

describe('finding the manifest', () => {
  test('a filter repository is recognised by its <name>.json', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    write(d, 'CMakeLists.txt', '');
    assert.deepEqual(filterManifestsIn(d), [path.join(d, 'libjxl.json')]);
    assert.equal(manifestIn(d).file, path.join(d, 'libjxl.json'));
  });

  test('other JSON files are not mistaken for a manifest', () => {
    const d = tmp();
    write(d, 'filter_list.json', '{"tag":{},"with":["a"]}');
    write(d, 'recommended.json', '{"mimeTypes":{}}');
    write(d, 'other.json', '{"name":"libjxl","filters":["x"]}');     // name does not match the file
    write(d, 'notfilter.json', '{"name":"notfilter"}');              // no "filters"
    write(d, 'package.json', '{"name":"package","filters":["x"]}');  // never a manifest
    write(d, 'broken.json', '{ not json');
    assert.deepEqual(filterManifestsIn(d), []);
    assert.equal(manifestIn(d), null);
  });

  test('a namespaced name still matches its file', () => {
    const d = tmp();
    write(d, 'mine.json', '{"name":"bob:mine","filters":["x"]}');
    assert.equal(manifestIn(d).file, path.join(d, 'mine.json'));
  });

  test('bevara.json takes precedence and the shadowed manifest is reported', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    write(d, 'bevara.json', '{"name":"site","dependencies":{}}');
    const m = manifestIn(d);
    assert.equal(m.file, path.join(d, 'bevara.json'));
    assert.deepEqual(m.shadowed, [path.join(d, 'libjxl.json')]);
  });

  test('two filter manifests in one directory is an error, not a guess', () => {
    const d = tmp();
    write(d, 'a.json', '{"name":"a","filters":["x"]}');
    write(d, 'b.json', '{"name":"b","filters":["y"]}');
    assert.throws(() => manifestIn(d), /several filter manifests.*a\.json, b\.json/);
  });

  test('the search walks up from a subdirectory (e.g. build/)', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    fs.mkdirSync(path.join(d, 'build', 'CMakeFiles'), { recursive: true });
    const found = findProjectRoot(path.join(d, 'build', 'CMakeFiles'));
    assert.equal(found.root, d);
    assert.equal(found.file, path.join(d, 'libjxl.json'));
  });
});

describe('legacy fields', () => {
  test('"Format" becomes "formats"', () => {
    assert.deepEqual(fromLegacy({ name: 'x', Format: ['Theora'] }).formats, ['Theora']);
  });
  test('without "Format", the "extension" keys are used', () => {
    assert.deepEqual(fromLegacy(JSON.parse(LIBJXL)).formats, ['jxl']);
  });
  test('an explicit "formats" wins, and the input is not modified', () => {
    const m = { name: 'x', Format: ['A'], formats: ['B'] };
    assert.deepEqual(fromLegacy(m).formats, ['B']);
    assert.equal(m.formats.length, 1);
    assert.ok(!('formats' in JSON.parse(LIBJXL)));
  });
  test('"main" defaults to the module the build produces', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    const p = new Project(d, path.join(d, 'libjxl.json'));
    const m = filterManifest(p);
    assert.equal(m.main, path.join('.bevara', '.build', 'libjxl_1.wasm'));
    assert.equal(m.mainDefaulted, true);
  });
});

describe('editing a hand-formatted manifest', () => {
  const before = JSON.parse(LIBJXL);

  test('adding a key leaves every existing line as it was', () => {
    const out = updateJsonText(LIBJXL, before, { ...before, version: '1.0.0' }, 4);
    const kept = LIBJXL.split('\n').filter((l) => !/licence_required/.test(l) && l !== '}');
    for (const l of kept) assert.ok(out.split('\n').includes(l), `lost or changed: ${l}`);
    assert.ok(out.includes('    "version": "1.0.0"'));
    assert.deepEqual(JSON.parse(out), { ...before, version: '1.0.0' });
  });

  test('changing one value rewrites only that value', () => {
    const out = updateJsonText(LIBJXL, before, { ...before, licence_required: true }, 4);
    assert.equal(out, LIBJXL.replace('"licence_required":false', '"licence_required":true'));
  });

  test('nested objects are indented at their own level', () => {
    const out = updateJsonText(LIBJXL, before, { ...before, dependencies: { 'bevara:ogg': '^1.0.0' } }, 4);
    assert.match(out, /\n {4}"dependencies": \{\n {8}"bevara:ogg": "\^1\.0\.0"\n {4}\}\n\}/);
  });

  test('removing a key removes its separator too', () => {
    const { extension, ...rest } = before;
    const out = updateJsonText(LIBJXL, before, rest, 4);
    assert.deepEqual(JSON.parse(out), rest);
    assert.ok(!out.includes('extension'));
  });

  test('strings containing braces, quotes and escapes do not confuse the scanner', () => {
    const t = '{\n  "a": "x } { \\" ]",\n  "b": [1, {"c": "}"}],\n  "d": null\n}';
    const doc = scanTopLevel(t);
    assert.deepEqual(doc.entries.map((e) => e.key), ['a', 'b', 'd']);
    const out = updateJsonText(t, JSON.parse(t), { ...JSON.parse(t), d: 1 }, 2);
    assert.equal(out, t.replace('"d": null', '"d": 1'));
  });

  test('what it cannot edit safely it declines, and the caller rewrites', () => {
    assert.equal(updateJsonText('[1, 2]', [1, 2], [1, 2, 3], 2), null);
    assert.equal(scanTopLevel('not json'), null);
  });

  test('Project.saveManifest writes into the file it was read from', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    const p = new Project(d, path.join(d, 'libjxl.json'));
    p.manifest.version = '1.0.0';
    p.saveManifest();
    assert.ok(!fs.existsSync(path.join(d, 'bevara.json')));
    const text = fs.readFileSync(path.join(d, 'libjxl.json'), 'utf8');
    assert.ok(text.includes('"filters":["jxldec","rfjxl"]'), 'compact array kept');
    assert.equal(JSON.parse(text).version, '1.0.0');
  });

  test('indentation is detected', () => {
    assert.equal(detectIndent(LIBJXL), 4);
    assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
    assert.equal(detectIndent('{}'), 2);
  });
});

describe('naming the project and the build directory', async () => {
  const { checkArtifact } = await import('../src/lib/pack.js');
  // A real side module, so that checkArtifact accepts it.
  const WASM = fs.readFileSync(new URL('../../registry/test/fixtures/dummy_1.wasm', import.meta.url));

  test('the module is looked for in .bevara/.build, then build/, then the root', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    const p = new Project(d, path.join(d, 'libjxl.json'));
    const at = (rel) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), WASM); };
    const found = () => { const m = filterManifest(p); checkArtifact(p, m); return m.main; };
    at('libjxl_1.wasm');
    assert.equal(found(), 'libjxl_1.wasm');
    at('build/libjxl_1.wasm');
    assert.equal(found(), path.join('build', 'libjxl_1.wasm'));
    at('.bevara/.build/libjxl_1.wasm');
    assert.equal(found(), path.join('.bevara', '.build', 'libjxl_1.wasm'));
  });

  test('with -B, only that directory and the root count', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    fs.mkdirSync(path.join(d, 'build'));
    fs.writeFileSync(path.join(d, 'build', 'libjxl_1.wasm'), WASM);
    const p = new Project(d, path.join(d, 'libjxl.json'));
    const m = filterManifest(p, { buildDir: 'out' });
    assert.throws(() => checkArtifact(p, m), (e) => /looked for out\/libjxl_1\.wasm, libjxl_1\.wasm/.test(e.hint) && !/build\//.test(e.hint));
  });

  const { buildFilter, defaultBuildCommand } = await import('../src/lib/pack.js');

  test('an explicit directory is used as is, without walking up', () => {
    const parent = tmp();
    write(parent, 'libjxl.json', LIBJXL);
    fs.mkdirSync(path.join(parent, 'sub'));
    const p = Project.load({ dir: parent });
    assert.equal(p.manifestFile, path.join(parent, 'libjxl.json'));
    // A subdirectory without a manifest is an error, not its parent's project.
    assert.throws(() => Project.load({ dir: path.join(parent, 'sub') }), /no manifest in/);
  });

  test('a missing directory or a file is reported plainly', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    assert.throws(() => Project.load({ dir: path.join(d, 'nope') }), /no such directory/);
    assert.throws(() => Project.load({ dir: path.join(d, 'libjxl.json') }), /is not a directory/);
  });

  test('the build directory moves the default "main", an explicit one does not', () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    const p = new Project(d, path.join(d, 'libjxl.json'));
    assert.equal(filterManifest(p, { buildDir: 'out' }).main, path.join('out', 'libjxl_1.wasm'));
    p.manifest.main = 'dist/libjxl_1.wasm';
    assert.equal(filterManifest(p, { buildDir: 'out' }).main, 'dist/libjxl_1.wasm');
  });

  test('the default build command uses the build directory, quoted when needed', () => {
    assert.equal(defaultBuildCommand(), 'emcmake cmake -S . -B .bevara/.build && cmake --build .bevara/.build');
    assert.equal(defaultBuildCommand('out/wasm'), 'emcmake cmake -S . -B out/wasm && cmake --build out/wasm');
    assert.equal(defaultBuildCommand('my build'), 'emcmake cmake -S . -B "my build" && cmake --build "my build"');
  });

  test('a custom build command runs in the project and receives BEVARA_BUILD_DIR', async () => {
    const d = tmp();
    write(d, 'libjxl.json', LIBJXL);
    const p = new Project(d, path.join(d, 'libjxl.json'));
    p.manifest.scripts = { build: 'node -e "require(\'fs\').writeFileSync(\'seen.txt\', process.env.BEVARA_BUILD_DIR + \' \' + process.cwd())"' };
    await buildFilter(p, { buildDir: 'out' });
    const [dir, cwd] = fs.readFileSync(path.join(d, 'seen.txt'), 'utf8').split(' ');
    assert.equal(dir, 'out');
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(d));
  });
});
