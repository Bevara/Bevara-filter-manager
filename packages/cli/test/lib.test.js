import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectWasm, accessorFileName } from '../src/lib/wasm.js';
import { validateManifest, normalizeManifest } from '../src/lib/manifest.js';
import { parseSpec, pickVersion, resolveTree } from '../src/lib/resolve.js';

const FIXTURE = fs.readFileSync(new URL('../../registry/test/fixtures/dummy_1.wasm', import.meta.url));

describe('wasm inspector', () => {
  test('detects an Emscripten side module and lists exports', () => {
    const i = inspectWasm(FIXTURE);
    assert.equal(i.valid, true);
    assert.equal(i.sideModule, true);
    assert.ok(i.exports.some((e) => e.name === 'dummy_version'));
    assert.ok(i.imports.some((e) => e.name === 'gf_filter_auto_register'));
  });
  test('rejects garbage and flags non side modules', () => {
    assert.match(inspectWasm(Buffer.from('hello')).error, /magic/);
    const plain = inspectWasm(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    assert.equal(plain.valid, true);
    assert.equal(plain.sideModule, false);
    assert.match(inspectWasm(Buffer.concat([FIXTURE.subarray(0, 40)])).error, /truncated|malformed/);
  });
  test('accessor file naming', () => assert.equal(accessorFileName('theora', 1), 'theora_1.wasm'));
});

describe('manifest validation', () => {
  const base = { name: 'theora', version: '1.0.0', description: 'x', filters: ['theoradec'] };
  test('accepts a minimal manifest', () => assert.deepEqual(validateManifest(base).errors, []));
  test('rejects bad names, versions, filters', () => {
    assert.ok(validateManifest({ ...base, name: 'Theora' }).errors.some((e) => /name/.test(e)));
    assert.ok(validateManifest({ ...base, version: '1.0' }).errors.some((e) => /semver/.test(e)));
    assert.ok(validateManifest({ ...base, filters: [] }).errors.some((e) => /filters/.test(e)));
    assert.ok(validateManifest({ ...base, priority: 999 }).errors.some((e) => /priority/.test(e)));
    assert.ok(validateManifest({ ...base, dependencies: { 'Bad Name': '^1' } }).errors.some((e) => /dependency/.test(e)));
  });
  test('warns on unknown support values', () => {
    assert.ok(validateManifest({ ...base, support: ['hologram'] }).warnings.some((w) => /hologram/.test(w)));
  });
  test('normalize fills defaults', () => {
    const m = normalizeManifest(base);
    assert.equal(m.abi, 1);
    assert.equal(m.priority, 50);
    assert.deepEqual(m.dependencies, {});
  });
});

describe('resolver', () => {
  test('parseSpec', () => {
    assert.deepEqual(parseSpec('theora'), { name: 'theora', range: 'latest' });
    assert.deepEqual(parseSpec('theora@^1.2'), { name: 'theora', range: '^1.2' });
    assert.deepEqual(parseSpec('theora@'), { name: 'theora', range: 'latest' });
  });
  const pk = (name, versions, deps = {}) => ({
    name, 'dist-tags': { latest: versions.at(-1) },
    versions: Object.fromEntries(versions.map((v) => [v, { name, version: v, abi: 1, dependencies: deps[v] ?? {}, dist: { file: `${name}_1.wasm`, integrity: 'x', wasm: `u/${name}/${v}` } }])),
  });
  test('pickVersion honours ranges and latest', () => {
    const p = pk('a', ['1.0.0', '1.2.0', '2.0.0']);
    assert.equal(pickVersion(p, 'latest'), '2.0.0');
    assert.equal(pickVersion(p, '^1'), '1.2.0');
    assert.equal(pickVersion(p, '1.0.0'), '1.0.0');
    assert.equal(pickVersion(p, '^3'), null);
  });
  test('resolveTree follows dependencies and keeps a flat set', async () => {
    const db = { a: pk('a', ['1.0.0', '1.1.0'], { '1.1.0': { b: '^2.0.0' } }), b: pk('b', ['1.0.0', '2.0.0', '2.1.0']) };
    const client = { base: 'test', packument: async (n) => { if (!db[n]) { const e = new Error('nf'); e.status = 404; throw e; } return db[n]; } };
    const chosen = await resolveTree(client, { a: 'latest' });
    assert.equal(chosen.get('a').version, '1.1.0');
    assert.equal(chosen.get('b').version, '2.1.0');
    // A lock entry inside the range is preferred over the newest version.
    const locked = await resolveTree(client, { a: 'latest', b: '^2' }, { lock: { b: { version: '2.0.0' } } });
    assert.equal(locked.get('b').version, '2.0.0');
    // Conflicting ranges are reported.
    await assert.rejects(resolveTree(client, { a: '1.1.0', b: '1.0.0' }), /cannot satisfy b/);
  });
});

describe('signatures and log', async () => {
  const { generateKeyPair, signRecord, verifyRecord, canonicalize, entryHash, verifyChain, keyIdOf, GENESIS } = await import('../src/lib/sig.js');
  test('canonical JSON is key-sorted and stable', () => {
    assert.equal(canonicalize({ b: 1, a: [3, { z: 1, y: undefined }] }), '{"a":[3,{"z":1}],"b":1}');
  });
  test('sign / verify round trip, tamper detection', () => {
    const k = generateKeyPair();
    assert.equal(keyIdOf(k.publicKey), k.keyId);
    const rec = { type: 'publish', name: 'bevara:x', version: '1.0.0' };
    const sig = signRecord(rec, k.privateKey);
    assert.equal(verifyRecord(rec, sig, k.publicKey), true);
    assert.equal(verifyRecord({ ...rec, version: '1.0.1' }, sig, k.publicKey), false);
    assert.equal(verifyRecord(rec, sig, generateKeyPair().publicKey), false);
  });
  test('hash chain verification', () => {
    const k = generateKeyPair();
    const entries = [];
    let prev = GENESIS;
    for (let i = 1; i <= 3; i++) {
      const record = { type: 'publish', name: 'bevara:x', version: `1.0.${i}`, keyId: k.keyId };
      const signature = signRecord(record, k.privateKey);
      const hash = entryHash(prev, record, signature);
      entries.push({ seq: i, record, signature, keyId: k.keyId, hash });
      prev = hash;
    }
    const resolveKey = () => k.publicKey;
    assert.equal(verifyChain(entries, { resolveKey }).ok, true);
    assert.equal(verifyChain(entries, { resolveKey }).head, prev);
    assert.equal(verifyChain(entries.slice(1), { resolveKey, startHash: entries[0].hash, startSeq: 1 }).ok, true);
    assert.match(verifyChain([entries[0], entries[2]], { resolveKey }).error, /gap/);
    const t = structuredClone(entries); t[1].record.version = '9.9.9';
    assert.match(verifyChain(t, { resolveKey }).error, /hash mismatch/);
    assert.match(verifyChain(entries, { resolveKey: () => null }).error, /unknown key/);
  });
});

describe('namespaced names', async () => {
  const { fullName, splitName, shortName, NAME_RE } = await import('../src/lib/manifest.js');
  test('helpers', () => {
    assert.equal(fullName('theora', 'bevara'), 'bevara:theora');
    assert.equal(fullName('acme:theora', 'bevara'), 'acme:theora');
    assert.deepEqual(splitName('acme:theora'), { namespace: 'acme', pkg: 'theora' });
    assert.equal(shortName('acme:theora'), 'theora');
    assert.equal(NAME_RE.test('acme:theora'), true);
    assert.equal(NAME_RE.test('a:b:c'), false);
    assert.equal(accessorFileName('acme:theora', 2), 'theora_2.wasm');
  });
});
