import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startRegistry, makeTarball, manifest, runtimeManifest, RUNTIME_JS, signup, publish, keys, FIXTURE_WASM } from './helpers.js';
import { generateKeyPair, verifyChain, verifyRecord, keyIdOf, canonicalize, signRecord } from '../src/sig.js';

describe('registry', () => {
  let reg, api, alice, bob;
  before(async () => { reg = await startRegistry(); api = reg.api; alice = await signup(api, 'alice'); bob = await signup(api, 'bob'); });
  after(() => reg.close());

  test('ping and config', async () => {
    const r = await api('GET', '/-/ping');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.oidc, false);
  });

  test('first user is admin, second is user', async () => {
    assert.equal((await api('GET', '/-/whoami', { token: alice })).data.role, 'admin');
    assert.equal((await api('GET', '/-/whoami', { token: bob })).data.role, 'user');
  });

  test('duplicate signup and bad password are rejected', async () => {
    assert.equal((await api('POST', '/-/user', { body: { name: 'alice', password: 'password123' } })).status, 409);
    assert.equal((await api('POST', '/-/user', { body: { name: 'carol', password: 'short' } })).status, 400);
  });

  test('login with password returns a token; wrong password 401', async () => {
    const ok = await api('POST', '/-/login', { body: { name: 'alice', password: 'password123' } });
    assert.equal(ok.status, 200);
    assert.match(ok.data.token, /^bvr_/);
    assert.equal((await api('POST', '/-/login', { body: { name: 'alice', password: 'nope' } })).status, 401);
  });

  test('publish requires auth and a signature', async () => {
    const r = await api('PUT', '/filters/dummy/1.0.0', { body: await makeTarball(manifest()), headers: { 'content-type': 'application/gzip' } });
    assert.equal(r.status, 401);
    const unsigned = await publish(api, alice, manifest(), { sign: false });
    assert.equal(unsigned.status, 400);
    assert.match(unsigned.data.error, /signed/);
  });

  test('publish rejects tampered records, foreign and unknown keys', async () => {
    let r = await publish(api, alice, manifest(), { record: { wasmSha256: 'f'.repeat(64) } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /does not match the upload/);
    r = await publish(api, alice, manifest(), { key: keys.get(bob) });           // bob's key, alice's token
    assert.equal(r.status, 403);
    r = await publish(api, alice, manifest(), { key: generateKeyPair() });        // never registered
    assert.equal(r.status, 400);
    assert.match(r.data.error, /unknown signing key/);
    const k = keys.get(alice);
    const bad = { ...k, privateKey: generateKeyPair().privateKey };               // right keyId, wrong private key
    r = await publish(api, alice, manifest(), { key: bad });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /invalid signature/);
  });

  test('publish rejects a non side-module wasm and a plain non-wasm', async () => {
    // Minimal valid wasm without dylink: magic + version only.
    const plain = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    let r = await publish(api, alice, manifest(), { wasm: plain });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /side module/);
    r = await publish(api, alice, manifest(), { wasm: Buffer.from('not wasm at all') });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /bad magic/);
  });

  test('publish rejects invalid manifest and URL mismatch', async () => {
    let r = await publish(api, alice, manifest({ filters: [] }));
    assert.equal(r.status, 400);
    assert.ok(r.data.errors.some((e) => /filters/.test(e)));
    r = await api('PUT', '/filters/dummy/9.9.9', { token: alice, body: await makeTarball(manifest()), headers: { 'content-type': 'application/gzip' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /URL/);
  });

  test('publish succeeds, packument and accessor endpoints work', async () => {
    const r = await publish(api, alice, manifest(), { extra: { 'README.md': '# dummy' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.name, 'bevara:dummy');
    assert.equal(r.data.dist.file, 'dummy_1.wasm');
    assert.equal(r.data.signature.keyId, keys.get(alice).keyId);
    // Entry #1 is the runtime solver_1 that "using" names, published first.
    assert.equal(r.data.signature.logSeq, 2);
    assert.equal(r.data.checkpoint.seq, 2);
    const sha = createHash('sha256').update(FIXTURE_WASM).digest('base64');
    assert.equal(r.data.dist.integrity, `sha256-${sha}`);

    const p = await api('GET', '/filters/dummy');
    assert.equal(p.status, 200);
    assert.equal(p.data.name, 'bevara:dummy');
    assert.equal((await api('GET', '/filters/bevara%3Adummy')).data.name, 'bevara:dummy');
    assert.equal(p.data['dist-tags'].latest, '1.0.0');
    const v = p.data.versions['1.0.0'];
    assert.equal(verifyRecord(v.signature.record, v.signature.signature, v.signature.publicKey), true);
    assert.equal(keyIdOf(v.signature.publicKey), v.signature.keyId);
    assert.deepEqual(p.data.owners, ['alice']);
    assert.equal(p.data.versions['1.0.0'].wasm.exports.includes('dummy_version'), true);

    const w = await api('GET', '/accessors/dummy_1.wasm');
    assert.equal(w.status, 200);
    assert.equal(w.headers.get('content-type'), 'application/wasm');
    assert.equal(w.headers.get('access-control-allow-origin'), '*');
    assert.equal(Buffer.compare(w.data, FIXTURE_WASM), 0);

    const br = await fetch(`${reg.base}/accessors/dummy/1.0.0/dummy_1.wasm`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(br.headers.get('content-encoding'), 'br');
    assert.equal(Buffer.compare(Buffer.from(await br.arrayBuffer()), FIXTURE_WASM), 0); // fetch decodes brotli

    const list = await api('GET', '/accessors/filter_list.json');
    assert.deepEqual(list.data.with, ['dummy']);
    const idx = await api('GET', '/accessors/index.json');
    assert.equal(idx.data.filters[0].file, 'dummy_1.wasm');
    assert.equal(idx.data.filters[0].name, 'bevara:dummy');
    assert.equal(idx.data.checkpoint.seq, 2);        // the runtime, then dummy
    assert.equal((await api('GET', '/accessors/bevara:dummy_1.wasm')).status, 200);
    assert.equal((await api('GET', '/accessors/bevara%3Adummy/1.0.0/dummy_1.wasm')).status, 200);

    const tgz = await api('GET', '/filters/dummy/-/dummy-1.0.0.tgz');
    assert.equal(tgz.status, 200);
    assert.equal(tgz.headers.get('content-type'), 'application/gzip');
  });

  test('republishing the same version is a conflict', async () => {
    assert.equal((await publish(api, alice, manifest())).status, 409);
  });

  test('non-owner cannot publish a new version; owner can add owners', async () => {
    assert.equal((await publish(api, bob, manifest({ version: '1.1.0' }))).status, 403);
    assert.equal((await api('PUT', '/filters/dummy/owners/bob', { token: alice })).status, 200);
    const r = await publish(api, bob, manifest({ version: '1.1.0' }));
    assert.equal(r.status, 201);
    assert.equal((await api('GET', '/filters/dummy')).data['dist-tags'].latest, '1.1.0');
    assert.equal((await api('GET', '/accessors/dummy_1.wasm')).headers.get('x-bevara-version'), '1.1.0');
  });

  test('version lookup by range and latest', async () => {
    assert.equal((await api('GET', '/filters/dummy/latest')).data.version, '1.1.0');
    assert.equal((await api('GET', encodeURI('/filters/dummy/~1.0.0'))).data.version, '1.0.0');
    assert.equal((await api('GET', '/filters/dummy/2.0.0')).status, 404);
  });

  test('search and filtering', async () => {
    await publish(api, alice, manifest({ name: 'other', description: 'Other audio thing', support: ['audio'], formats: ['Other'] }));
    // The runtime solver is a package too.
    assert.equal((await api('GET', '/filters')).data.total, 3);
    assert.equal((await api('GET', '/filters?namespace=bevara')).data.total, 3);
    assert.equal((await api('GET', '/filters?q=audio')).data.filters[0].name, 'bevara:other');
    assert.equal((await api('GET', '/filters?support=video')).data.total, 1);
    assert.equal((await api('GET', '/filters?format=dummy')).data.total, 1);
  });

  test('deprecate a version moves latest, deprecate filter shows in listing', async () => {
    let r = await api('POST', '/filters/dummy/deprecate', { token: alice, body: { version: '1.1.0', message: 'broken' } });
    assert.equal(r.status, 200);
    assert.equal((await api('GET', '/filters/dummy')).data['dist-tags'].latest, '1.0.0');
    assert.equal((await api('GET', '/accessors/dummy_1.wasm')).headers.get('x-bevara-version'), '1.0.0');
    r = await api('POST', '/filters/other/deprecate', { token: alice, body: { message: 'use dummy' } });
    assert.equal((await api('GET', '/filters?q=other')).data.filters[0].deprecated, 'use dummy');
    // undo
    await api('POST', '/filters/dummy/deprecate', { token: alice, body: { version: '1.1.0', message: '' } });
    assert.equal((await api('GET', '/filters/dummy')).data['dist-tags'].latest, '1.1.0');
  });

  test('advisories need admin and show up in audit', async () => {
    const body = { name: 'dummy', range: '<1.1.0', severity: 'high', title: 'Heap overflow in demuxer' };
    assert.equal((await api('POST', '/-/advisories', { token: bob, body })).status, 403);
    const r = await api('POST', '/-/advisories', { token: alice, body });
    assert.equal(r.status, 201);
    const audit = await api('POST', '/-/audit', { body: { filters: { dummy: '1.0.0', other: '1.0.0', ghost: '1.0.0' } } });
    assert.equal(audit.data.report.dummy.advisories.length, 1);
    assert.equal(audit.data.report.dummy.latest, '1.1.0');
    assert.equal(audit.data.report.other.deprecated, 'use dummy');
    assert.equal(audit.data.report.ghost.found, false);
    const auditNew = await api('POST', '/-/audit', { body: { filters: { dummy: '1.1.0' } } });
    assert.equal(auditNew.data.report.dummy.advisories.length, 0);
    assert.equal((await api('DELETE', `/-/advisories/${r.data.id}`, { token: alice })).status, 200);
  });

  test('web login form issues a token and redirects to the local callback', async () => {
    const page = await api('GET', '/-/login/web?callback=http://127.0.0.1:5555/callback');
    assert.equal(page.status, 200);
    assert.match(page.data, /<form/);
    assert.equal((await api('GET', '/-/login/web?callback=http://evil.example/x')).status, 400);
    const res = await fetch(`${reg.base}/-/login/web`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'alice', password: 'password123', callback: 'http://127.0.0.1:5555/callback' }) });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin, 'http://127.0.0.1:5555');
    assert.match(loc.searchParams.get('token'), /^bvr_/);
    assert.equal((await api('GET', '/-/whoami', { token: loc.searchParams.get('token') })).data.name, 'alice');
  });

  test('token revocation', async () => {
    const { data } = await api('POST', '/-/login', { body: { name: 'bob', password: 'password123' } });
    assert.equal((await api('DELETE', '/-/token', { token: data.token })).status, 200);
    assert.equal((await api('GET', '/-/whoami', { token: data.token })).status, 401);
  });

  test('namespaces: the default one is open to any account, users own their own, first publisher claims a new one', async () => {
    // bob is not an administrator, yet publishes a new filter with a bare name.
    let r = await publish(api, bob, manifest({ name: 'bobfree' }));
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.name, 'bevara:bobfree');
    assert.deepEqual((await api('GET', '/filters/bobfree')).data.owners, ['bob']);
    // ...which then belongs to him: another account cannot push a version of it.
    const carl = await signup(api, 'carl');
    r = await publish(api, carl, manifest({ name: 'bobfree', version: '1.1.0' }));
    assert.equal(r.status, 403);
    assert.match(r.data.error, /bevara:bobfree belongs to bob: only its owners publish new versions/);
    assert.match(r.data.hint, /bevara owner add carl bevara:bobfree/);
    // A personal namespace stays personal.
    r = await publish(api, carl, manifest({ name: 'bob:carlthing' }));
    assert.equal(r.status, 403);
    assert.match(r.data.hint, /bare name: "carlthing"/);
    r = await publish(api, bob, manifest({ name: 'bob:bobthing' }));
    assert.equal(r.status, 201);
    assert.equal(r.data.name, 'bob:bobthing');
    r = await publish(api, bob, manifest({ name: 'acme:tool' }));
    assert.equal(r.status, 201);                     // new namespace claimed by bob
    r = await publish(api, alice, manifest({ name: 'acme:tool2' }));
    assert.equal(r.status, 201);                     // alice is admin
    const ns = await api('GET', '/-/namespaces');
    const acme = ns.data.namespaces.find((n) => n.name === 'acme');
    assert.deepEqual(acme.owners, ['bob']);
    assert.equal((await api('PUT', '/-/namespaces/acme/owners/alice', { token: bob })).status, 200);
    assert.equal((await api('GET', '/-/whoami', { token: bob })).data.namespaces.includes('acme'), true);
    // The namespaced URL form still serves what is published there.
    assert.equal((await api('GET', '/accessors/bob:bobthing_1.wasm')).status, 200);
  });

  test('an accessor name belongs to one package, across namespaces, ABIs and letter case', async () => {
    // bevara:dummy already provides dummy_1.wasm.
    let r = await publish(api, bob, manifest({ name: 'bob:dummy' }));
    assert.equal(r.status, 409);
    assert.match(r.data.error, /accessor name "dummy" is already taken by bevara:dummy/);
    assert.match(r.data.hint, /owner add/);
    // Another ABI is still the same accessor name.
    r = await publish(api, bob, manifest({ name: 'bob:dummy', abi: 2 }));
    assert.equal(r.status, 409);
    // Same name in another case, through "module".
    r = await publish(api, bob, manifest({ name: 'bob:dummy', module: 'DUMMY' }));
    assert.equal(r.status, 409);
    // The refused upload left nothing behind.
    assert.equal((await api('GET', '/filters/bob%3Adummy')).status, 404);
    assert.ok(!fs.existsSync(path.join(reg.dataDir, 'store', 'bob:dummy')));
    // The owner of the name can of course keep publishing it.
    r = await publish(api, alice, manifest({ name: 'dummy', version: '1.0.9' }));
    assert.equal(r.status, 201);
    await api('DELETE', '/filters/dummy/1.0.9', { token: alice });
  });

  test('a GPAC filter registered by another package is reported', async () => {
    const r = await publish(api, bob, manifest({ name: 'bob:otherdec', filters: ['dummydec'] }));
    assert.equal(r.status, 201);
    assert.ok(r.data.warnings.some((w) => /dummydec also registered by bevara:dummy/.test(w)), JSON.stringify(r.data.warnings));
  });

  test('transparency log: chain verifies, records are signed by the right keys, yank/deprecate are recorded', async () => {
    const before = (await api('GET', '/-/log/checkpoint')).data;
    assert.equal((await api('DELETE', '/filters/acme/tool2', { token: alice })).status, 404); // wrong path form
    assert.equal((await api('DELETE', '/filters/acme%3Atool2', { token: alice })).status, 200);
    const { entries, checkpoint } = (await api('GET', '/-/log?since=0')).data;
    assert.equal(checkpoint.seq, before.seq + 1);
    assert.equal(entries.at(-1).record.type, 'yank');
    assert.equal(entries.at(-1).keyId, checkpoint.keyId);          // signed by the registry
    const { keys: all } = (await api('GET', '/-/log/keys/all')).data;
    const km = new Map(all.map((k) => [k.keyId, k.publicKey]));
    const chain = verifyChain(entries, { resolveKey: (id) => km.get(id) });
    assert.equal(chain.ok, true, chain.error);
    assert.equal(chain.head, checkpoint.head);
    assert.equal(chain.seq, checkpoint.seq);
    const { signature, publicKey, ...body } = checkpoint;
    assert.equal(verifyRecord(body, signature, publicKey), true);
    // inclusion proof for entry 2 (after the runtime) lets a client recompute the head
    const proof = (await api('GET', '/-/log/2')).data;
    assert.equal(proof.record.name, 'bevara:dummy');
    let h = proof.hash;
    const { entryHashFromDigest } = await import('../src/sig.js');
    for (const p of proof.path) h = entryHashFromDigest(h, p.recordHash, p.signature);
    assert.equal(h, checkpoint.head);
    // a tampered entry breaks the chain
    const forged = entries.map((e) => (e.seq === 2 ? { ...e, record: { ...e.record, version: '9.9.9' } } : e));
    assert.equal(verifyChain(forged, { resolveKey: (id) => km.get(id) }).ok, false);
  });

  test('keys: revoke blocks publishing; audit exposes the signature', async () => {
    const extra = generateKeyPair();
    assert.equal((await api('PUT', '/-/keys', { token: bob, body: { publicKey: extra.publicKey } })).status, 201);
    assert.equal((await api('PUT', '/-/keys', { token: alice, body: { publicKey: extra.publicKey } })).status, 409);
    assert.equal((await api('DELETE', `/-/keys/${extra.keyId}`, { token: bob })).status, 200);
    const r = await publish(api, bob, manifest({ name: 'bob:bobthing', version: '1.0.1' }), { key: extra });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /revoked/);
    assert.equal((await api('PUT', '/-/keys', { token: alice, body: { publicKey: 'AAAA' } })).status, 400);
    const audit = await api('POST', '/-/audit', { body: { filters: { dummy: '1.0.0' } } });
    assert.equal(audit.data.report.dummy.name, 'bevara:dummy');
    assert.equal(audit.data.report.dummy.version.signature.keyId, keys.get(alice).keyId);
    assert.ok(audit.data.checkpoint.seq > 0);
  });

  test('unpublish version then whole filter', async () => {
    assert.equal((await api('DELETE', '/filters/dummy/1.1.0', { token: bob })).status, 200);
    assert.equal((await api('GET', '/filters/dummy')).data['dist-tags'].latest, '1.0.0');
    assert.equal((await api('DELETE', '/filters/other', { token: bob })).status, 403);
    assert.equal((await api('DELETE', '/filters/other', { token: alice })).status, 200);
    assert.equal((await api('GET', '/filters/other')).status, 404);
    assert.equal((await api('GET', '/accessors/other_1.wasm')).status, 404);
  });

  test('an upload over the limit gets a 413 the client can read, not a dropped connection', async () => {
    const small = await startRegistry({ maxTarball: 64 });
    try {
      const token = await signup(small.api, 'dave');
      const r = await publish(small.api, token, manifest({ name: 'dave:big' }), { runtimes: false });
      assert.equal(r.status, 413);
      assert.match(r.data.error, /limit/);
    } finally { await small.close(); }
  });

  test('catalog UI is served', async () => {
    const r = await api('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.data, /Bevara filter registry/);
  });
});

describe('registry opened on an older database', () => {
  test('accessor names are reserved from what is published, and existing clashes are reported', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-migrate-'));
    const dbFile = path.join(dataDir, 'registry.sqlite');
    const logs = [];
    let reg = await startRegistry({ dataDir, dbFile, log: (m) => logs.push(m) });
    const t = await signup(reg.api, 'erin');
    assert.equal((await publish(reg.api, t, manifest({ name: 'erin:clash' }))).status, 201);
    // Simulate a database from before the reservation table: drop the
    // reservations and add a second package providing the same accessor.
    reg.app.db.exec("DELETE FROM accessor_names");
    reg.app.db.exec("INSERT INTO namespaces (name) VALUES ('frank')");
    reg.app.db.exec("INSERT INTO filters (name, description, latest) VALUES ('frank:clash', 'x', '1.0.0')");
    reg.app.db.exec("INSERT INTO versions (name, version, abi, manifest, wasm_file, wasm_sha256, wasm_size, tarball_sha256, tarball_size) VALUES ('frank:clash', '1.0.0', 1, '{}', 'clash_1.wasm', 'x', 1, 'x', 1)");
    await new Promise((r) => reg.app.server.close(r)); reg.app.db.close();

    reg = await startRegistry({ dataDir, dbFile, log: (m) => logs.push(m) });
    try {
      assert.ok(logs.some((m) => /accessor name already used by two packages \(clash: erin:clash and frank:clash\)/.test(m)), logs.join('\n'));
      // The first publisher keeps the name: a new version of the other is refused.
      const holder = reg.app.db.prepare("SELECT name FROM accessor_names WHERE key = 'clash'").get().name;
      assert.equal(holder, 'erin:clash');
    } finally { await reg.close(); }
  });
});

describe('administrators and namespaces on an existing registry', () => {
  const fileRegistry = async (dataDir, config = {}) => startRegistry({ dataDir, dbFile: path.join(dataDir, 'registry.sqlite'), ...config });

  test('ADMIN_USERS promotes an account that already exists', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-admins-'));
    let reg = await fileRegistry(dataDir);
    await signup(reg.api, 'first');                       // first account: admin
    const tok = await signup(reg.api, 'gorinje');         // created as a plain user
    assert.equal((await reg.api('GET', '/-/whoami', { token: tok })).data.role, 'user');
    await new Promise((r) => reg.app.server.close(r)); reg.app.db.close();

    reg = await fileRegistry(dataDir, { adminUsers: ['gorinje'] });
    try {
      assert.equal((await reg.api('GET', '/-/whoami', { token: tok })).data.role, 'admin');
      // and may publish in the default namespace
      assert.equal((await publish(reg.api, tok, manifest({ name: 'official' }))).status, 201);
    } finally { await reg.close(); }
  });

  test('"extension" and "using" are published in the capability index', async () => {
    const reg = await startRegistry();
    try {
      const tok = await signup(reg.api, 'root');
      assert.equal((await publish(reg.api, tok, manifest({ name: 'extdec', extension: { xyz: 'img' }, using: ['solver_1'] }))).status, 201);
      const idx = await reg.api('GET', '/accessors/index.json');
      const e = idx.data.filters.find((f) => f.file === 'extdec_1.wasm');
      assert.deepEqual(e.extension, { xyz: 'img' });
      assert.deepEqual(e.using, ['solver_1']);
      assert.equal((await publish(reg.api, tok, manifest({ name: 'badext', extension: ['xyz'] }))).status, 400);
      assert.equal((await publish(reg.api, tok, manifest({ name: 'badusing', using: 'solver_1' }))).status, 400);
      assert.equal((await publish(reg.api, tok, manifest({ name: 'badusing', using: ['solver'] }))).status, 400);
    } finally { await reg.close(); }
  });

  test('reading needs no account; publishing needs one, and nothing else', async () => {
    const reg = await startRegistry();
    try {
      await signup(reg.api, 'root');                                  // first account, admin
      const dev = await signup(reg.api, 'dev');                       // an ordinary account
      assert.ok((await reg.api('GET', '/-/namespaces')).data.namespaces.some((n) => n.name === 'bevara'));
      assert.equal((await publish(reg.api, dev, manifest({ name: 'anyone' }))).status, 201);
      // Anonymous: every read works, publishing does not.
      for (const p of ['/', '/-/ping', '/filters', '/filters/anyone', '/filters/anyone/1.0.0', '/accessors/index.json',
        '/accessors/filter_list.json', '/accessors/anyone_1.wasm', '/filters/anyone/-/anyone-1.0.0.tgz',
        '/-/namespaces', '/-/advisories', '/-/log', '/-/log/checkpoint', '/-/log/1']) {
        assert.equal((await reg.api('GET', p)).status, 200, p);
      }
      assert.equal((await reg.api('POST', '/-/audit', { body: { filters: { anyone: '1.0.0' } } })).status, 200);
      assert.equal((await publish(reg.api, null, manifest({ name: 'anon' }))).status, 401);
    } finally { await reg.close(); }
  });

  test('accounts created before namespaces get their own at start-up, but never the default one', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-own-ns-'));
    let reg = await fileRegistry(dataDir);
    await signup(reg.api, 'first');
    const old = await signup(reg.api, 'oldtimer');
    reg.app.auth.createUser({ name: 'bevara', password: 'password123' });   // an account named like the default namespace
    reg.app.db.exec("DELETE FROM namespace_owners; DELETE FROM namespaces;"); // as on a registry older than namespaces
    await new Promise((r) => reg.app.server.close(r)); reg.app.db.close();

    reg = await fileRegistry(dataDir);
    try {
      const { data } = await reg.api('GET', '/-/whoami', { token: old });
      assert.deepEqual(data.namespaces, ['oldtimer']);
      const ns = (await reg.api('GET', '/-/namespaces')).data.namespaces;
      assert.deepEqual(ns.find((n) => n.name === 'bevara').owners, [], 'the account "bevara" does not own the default namespace');
    } finally { await reg.close(); }
  });
});

describe('registry with optional signatures', () => {
  test('unsigned publish is accepted and flagged', async () => {
    const reg = await startRegistry({ requireSignatures: false });
    try {
      const t = await signup(reg.api, 'carol');
      const r = await publish(reg.api, t, manifest({ name: 'carol:x' }), { sign: false });
      assert.equal(r.status, 201);
      assert.equal(r.data.signature, null);
      // Only the (signed) runtime it names is in the log, not the unsigned filter.
      assert.ok(!(await reg.api('GET', '/-/log?since=0')).data.entries.some((e) => e.record.name === 'carol:x'));
    } finally { await reg.close(); }
  });
});

describe('registry with signup disabled and bootstrap admin', () => {
  test('signup is refused, ADMIN_USERS gets admin role', async () => {
    const reg = await startRegistry({ allowSignup: false, adminUsers: ['root'] });
    try {
      assert.equal((await reg.api('POST', '/-/user', { body: { name: 'x', password: 'password123' } })).status, 403);
      reg.app.auth.createUser({ name: 'someone', password: 'password123' });
      reg.app.auth.createUser({ name: 'root', password: 'password123' });
      assert.equal(reg.app.auth.getUser('someone').role, 'admin'); // first user
      assert.equal(reg.app.auth.getUser('root').role, 'admin');    // listed admin
    } finally { await reg.close(); }
  });
});

describe('deployment', () => {
  // The deployed registry once lagged behind the code because the image tag was
  // never bumped. The tag must be the package version, which /-/ping reports.
  test('the image tag in deploy/k8s/registry.yaml is the package version', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const yaml = fs.readFileSync(new URL('../../../deploy/k8s/registry.yaml', import.meta.url), 'utf8');
    const tag = /image:\s*\S+\/bevara-registry:(\S+)/.exec(yaml)?.[1];
    assert.equal(tag, pkg.version, `bump the image tag to ${pkg.version} in deploy/k8s/registry.yaml (and SDK/registry/registry.yaml)`);
  });

  // ArgoCD deploys the registry when its image tag changes: code changed under
  // an unchanged version would never reach the cluster. Since the commit that
  // last set the version, the registry must not have changed without a new one.
  test('a change to the registry comes with a new version', async () => {
    const { execFileSync } = await import('node:child_process');
    const pkgDir = new URL('..', import.meta.url).pathname;
    const git = (...args) => execFileSync('git', args, { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let since;
    try { since = git('log', '-1', '--format=%H', '-G', '"version"', '--', 'package.json'); } catch { return; }   // not a git checkout
    if (!since) return;
    const committed = JSON.parse(git('show', `${since}:packages/registry/package.json`)).version;
    const current = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    if (current !== committed) return;                     // a new version is on its way
    const changed = git('diff', '--name-only', since, '--', 'src', 'Dockerfile', 'package-lock.json').split('\n').filter(Boolean);
    const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'src').split('\n').filter(Boolean);
    assert.deepEqual([...changed, ...untracked], [], `the registry changed since version ${current} was set (${since.slice(0, 7)}): bump "version" in packages/registry/package.json and the image tag in deploy/k8s/registry.yaml and SDK/registry/registry.yaml, or ArgoCD will not deploy it`);
  });

  test('/-/ping reports the package version', async () => {
    const reg = await startRegistry();
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      assert.equal((await reg.api('GET', '/-/ping')).data.version, pkg.version);
    } finally { await reg.close(); }
  });
});

describe('selection by capability (/-/select)', () => {
  let reg, token;
  const raw = [{ property: 'GF_PROP_PID_STREAM_TYPE', format: 'GF_STREAM_VISUAL' }, { property: 'GF_PROP_PID_CODECID', format: 'GF_CODECID_RAW' }];
  before(async () => {
    reg = await startRegistry();
    token = await signup(reg.api);
    const pub = (name, filter, priority, projects) => publish(reg.api, token, manifest({ name, filters: [filter], projects, caps: [{ filter, priority, bundles: [{ inputs: raw, outputs: [] }] }] }));
    assert.equal((await pub('rgbenc', 'rgbenc', 0, ['gpac', 'libpng'])).status, 201);
    assert.equal((await pub('ffenc', 'ffenc', 128, ['gpac', 'ffmpeg'])).status, 201);
    assert.equal((await publish(reg.api, token, manifest({ name: 'nocaps', filters: ['nocapsdec'] }))).status, 201);
  });
  after(() => reg.close());

  test('answers the paper query by POST, priority bound and all', async () => {
    const r = await reg.api('POST', '/-/select', { body: { inputs: [{ property: 'GF_PROP_PID_PIXFMT', format: 'GF_PIXEL_RGBA' }], maxpriority: 50, language: 'wasm' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.matches.map((m) => m.filter), ['rgbenc']);
    assert.ok(r.data.matches[0].url.endsWith('/rgbenc_1.wasm'));
    assert.ok(r.data.excluded.some((x) => x.name === 'bevara:ffenc' && /priority/.test(x.reason)));
    assert.deepEqual(r.data.uncharacterised, ['bevara:nocaps']);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });

  test('answers by GET, as JSON or as plain parameters, without an account', async () => {
    const q = encodeURIComponent(JSON.stringify({ inputs: [{ property: 'PIXFMT', format: 'RGBA' }], projectname: 'ffmpeg' }));
    assert.deepEqual((await reg.api('GET', `/-/select?query=${q}`)).data.matches.map((m) => m.filter), ['ffenc']);
    assert.deepEqual((await reg.api('GET', '/-/select?pixfmt=rgba&maxpriority=200')).data.matches.map((m) => m.filter), ['rgbenc', 'ffenc']);
  });

  test('explains a malformed query', async () => {
    const r = await reg.api('POST', '/-/select', { body: { maxpriority: 50 } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /selects nothing/);
  });

  test('publishes caps, projects and language in the index', async () => {
    const { data } = await reg.api('GET', '/accessors/index.json');
    const e = data.filters.find((f) => f.name === 'bevara:rgbenc');
    assert.equal(e.caps[0].filter, 'rgbenc');
    assert.deepEqual(e.projects, ['gpac', 'libpng']);
    assert.equal(e.language, 'wasm');
  });
});

describe('runtimes (solvers) as packages', () => {
  let reg, root, alice, bob;
  before(async () => {
    reg = await startRegistry();
    root = await signup(reg.api, 'root');     // the first account administers the registry
    alice = await signup(reg.api, 'alice');
    bob = await signup(reg.api, 'bob');
    void root;
  });
  after(() => reg.close());

  test('a filter cannot be published before the runtime its "using" names', async () => {
    const r = await publish(reg.api, alice, manifest({ name: 'early', filters: ['earlydec'], using: ['solver_minimal_1'] }), { runtimes: false });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /none of the runtimes in "using" \(solver_minimal_1\) is published/);
    const none = await publish(reg.api, alice, manifest({ name: 'nousing', filters: ['nousingdec'], using: undefined }), { runtimes: false });
    assert.equal(none.status, 400);
    assert.ok(none.data.errors.some((e) => /"using" must list the runtimes/.test(e)));
  });

  test('any account publishes a runtime; its owners only publish new versions', async () => {
    const r = await publish(reg.api, bob, runtimeManifest({ name: 'solver_minimal' }));
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const other = await publish(reg.api, alice, runtimeManifest({ name: 'solver_minimal', version: '1.0.1' }));
    assert.equal(other.status, 403);
    // A runtime has the .js too, and no "using".
    const bad = await publish(reg.api, bob, runtimeManifest({ name: 'solver_bad', using: ['solver_1'] }));
    assert.equal(bad.status, 400);
  });

  test('then the filter publishes, and pages get the solver from /accessors/ as .js and .wasm', async () => {
    // One published runtime is enough; the others are reported.
    const r = await publish(reg.api, alice, manifest({ name: 'early', filters: ['earlydec'], using: ['solver_minimal_1', 'solver_other_1'] }), { runtimes: false });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.ok(r.data.warnings.some((w) => /solver_other_1: not published here/.test(w)));
    const js = await reg.api('GET', '/accessors/solver_minimal_1.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(js.data, RUNTIME_JS.toString());
    assert.equal((await reg.api('GET', '/accessors/solver_minimal_1.wasm')).status, 200);
    assert.equal((await reg.api('GET', '/accessors/early_1.js')).status, 404);
    const doc = await reg.api('GET', '/filters/solver_minimal/1.0.0');
    assert.equal(doc.data.kind, 'runtime');
    assert.equal(doc.data.dist.jsFile, 'solver_minimal_1.js');
    assert.equal((await reg.api('GET', doc.data.dist.js.replace(reg.base, ''))).status, 200);
  });

  test('the index lists runtimes apart from accessors', async () => {
    const { data } = await reg.api('GET', '/accessors/index.json');
    assert.deepEqual(data.runtimes.map((r) => [r.module, r.js]), [['solver_minimal_1', 'solver_minimal_1.js']]);
    assert.ok(!data.filters.some((f) => f.name === 'bevara:solver_minimal'));
    assert.ok(data.filters.some((f) => f.name === 'bevara:early'));
    // A runtime's name is an accessor name like any other: no filter can take it.
    const clash = await publish(reg.api, alice, manifest({ name: 'solver_minimal', filters: ['x'], using: ['solver_minimal_1'] }), { runtimes: false });
    assert.equal(clash.status, 403);
  });
});

describe('tag scripts (kind "tags")', () => {
  let reg, root, bob;
  const scripts = { 'universal-img_1.js': 'customElements.define("universal-img_1")', 'universal-audio_1.js': 'customElements.define("universal-audio_1")' };
  const tagsManifest = (over = {}) => ({ name: 'universal-tags', version: '1.0.0', abi: 1, kind: 'tags', description: 'Universal tags', license: 'MIT', patents: { status: 'royalty-free' }, tags: Object.keys(scripts), ...over });
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const publishTags = (token, m = tagsManifest(), { tamper = false } = {}) => publish(reg.api, token, m, {
    wasm: null, extra: Object.fromEntries(Object.entries(scripts).map(([f, t]) => [f, Buffer.from(t)])),
    record: { file: m.tags[0], wasmSha256: sha(Buffer.from(scripts[m.tags[0]])), tagsSha256: Object.fromEntries(m.tags.map((t) => [t, tamper ? 'f'.repeat(64) : sha(Buffer.from(scripts[t]))])) },
  });
  before(async () => {
    reg = await startRegistry();
    root = await signup(reg.api, 'root');
    bob = await signup(reg.api, 'bob');
    void root;
  });
  after(() => reg.close());

  test('any account publishes them; the signed record must cover every script', async () => {
    assert.equal((await publishTags(bob, tagsManifest(), { tamper: true })).status, 400);
    const r = await publishTags(bob);
    assert.equal(r.status, 201, JSON.stringify(r.data));
  });

  test('pages load each script from /accessors/, and the index lists them apart', async () => {
    const img = await reg.api('GET', '/accessors/universal-img_1.js');
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /javascript/);
    assert.equal(img.data, scripts['universal-img_1.js']);
    assert.equal((await reg.api('GET', '/accessors/universal-audio_1.js')).data, scripts['universal-audio_1.js']);
    const { data } = await reg.api('GET', '/accessors/index.json');
    assert.deepEqual(data.tags.map((t) => t.file).sort(), Object.keys(scripts).sort());
    assert.ok(!data.filters.some((f) => f.name === 'bevara:universal-tags'));
    const doc = await reg.api('GET', '/filters/universal-tags/1.0.0');
    assert.deepEqual(doc.data.dist.files.map((f) => f.file), Object.keys(scripts));
  });

  test('the names of its scripts are reserved: no accessor can take them', async () => {
    const clash = await publish(reg.api, root, manifest({ name: 'universal-img', filters: ['x'] }));
    assert.equal(clash.status, 409);
    assert.match(clash.data.error, /universal-img/);
    const bad = await publish(reg.api, bob, tagsManifest({ version: '1.0.1', tags: ['universal-img_1.js', 'universal-video_2.js'] }), { wasm: null });
    assert.equal(bad.status, 400);
  });
});

describe('patent status', () => {
  let reg, token;
  before(async () => { reg = await startRegistry(); token = await signup(reg.api, 'root'); });
  after(() => reg.close());

  test('every status is accepted and served; the restricted ones are announced', async () => {
    const r = await publish(reg.api, token, manifest({ name: 'hevcdec', filters: ['hevcdec'], patents: { status: 'licence-required', note: 'HEVC patent pools', regions: ['US', 'JP'] } }));
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.ok(r.data.warnings.some((w) => /a patent licence may be required to use it in US, JP \(HEVC patent pools\)/.test(w)));
    for (const status of ['royalty-free', 'expired', 'under-review']) {
      assert.equal((await publish(reg.api, token, manifest({ name: `p-${status}`, filters: [`p${status}`], patents: { status } }))).status, 201);
    }
    const got = await reg.api('GET', '/accessors/hevcdec_1.wasm');
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('x-bevara-patents'), 'licence-required');
    assert.match(got.headers.get('x-bevara-patents-notice'), /in US, JP/);
    assert.match(got.headers.get('access-control-expose-headers'), /x-bevara-patents/);
    assert.equal((await reg.api('GET', '/accessors/p-royalty-free_1.wasm')).headers.get('x-bevara-patents-notice'), null);
    const { data } = await reg.api('GET', '/accessors/index.json');
    assert.deepEqual(data.filters.find((f) => f.name === 'bevara:hevcdec').patents.regions, ['US', 'JP']);
  });

  test('a filter must state its status; the old flags are refused', async () => {
    const none = await publish(reg.api, token, manifest({ name: 'nostatus', filters: ['nostatus'], patents: undefined }));
    assert.equal(none.status, 400);
    assert.ok(none.data.errors.some((e) => /"patents" must state/.test(e)));
    const old = await publish(reg.api, token, manifest({ name: 'oldflag', filters: ['oldflag'], licence_required: true }));
    assert.equal(old.status, 400);
    assert.ok(old.data.errors.some((e) => /replaced by "patents"/.test(e)));
  });
});
