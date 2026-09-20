import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startRegistry, makeTarball, manifest, signup, publish, FIXTURE_WASM } from './helpers.js';

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

  test('publish requires auth', async () => {
    const r = await api('PUT', '/filters/dummy/1.0.0', { body: await makeTarball(manifest()), headers: { 'content-type': 'application/gzip' } });
    assert.equal(r.status, 401);
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
    assert.equal(r.data.dist.file, 'dummy_1.wasm');
    const sha = createHash('sha256').update(FIXTURE_WASM).digest('base64');
    assert.equal(r.data.dist.integrity, `sha256-${sha}`);

    const p = await api('GET', '/filters/dummy');
    assert.equal(p.status, 200);
    assert.equal(p.data['dist-tags'].latest, '1.0.0');
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
    assert.equal((await api('GET', '/filters')).data.total, 2);
    assert.equal((await api('GET', '/filters?q=audio')).data.filters[0].name, 'other');
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

  test('unpublish version then whole filter', async () => {
    assert.equal((await api('DELETE', '/filters/dummy/1.1.0', { token: bob })).status, 200);
    assert.equal((await api('GET', '/filters/dummy')).data['dist-tags'].latest, '1.0.0');
    assert.equal((await api('DELETE', '/filters/other', { token: bob })).status, 403);
    assert.equal((await api('DELETE', '/filters/other', { token: alice })).status, 200);
    assert.equal((await api('GET', '/filters/other')).status, 404);
    assert.equal((await api('GET', '/accessors/other_1.wasm')).status, 404);
  });

  test('catalog UI is served', async () => {
    const r = await api('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.data, /Bevara filter registry/);
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
