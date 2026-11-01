import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { startRegistry, manifest, signup, publish } from './helpers.js';

// A stand-in identity provider: discovery + JWKS, and access tokens signed with its key.
const ISSUER = 'https://idp.test';
const idpKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fakeFetch = async (url) => {
  const body = url === `${ISSUER}/.well-known/openid-configuration` ? { issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks` }
    : url === `${ISSUER}/.well-known/jwks` ? { keys: [{ ...idpKey.publicKey.export({ format: 'jwk' }), kid: 'cert-1', use: 'sig', alg: 'RS256' }] }
    : null;
  return body ? new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 });
};
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims, { key = idpKey.privateKey, kid = 'cert-1', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg, kid, typ: 'JWT' });
  const body = b64u({ iss: ISSUER, aud: ['dashboard-client'], iat: now, exp: now + 3600, tokenType: 'access-token', ...claims });
  const sig = alg === 'none' ? '' : sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

describe('usage statistics (administrators\' dashboard)', () => {
  let reg, api, alice, bob;
  before(async () => {
    reg = await startRegistry({ oidc: { issuer: ISSUER, clientId: 'registry-client', clientSecret: 'x', fetch: fakeFetch }, adminAudiences: ['dashboard-client'] });
    api = reg.api;
    alice = await signup(api, 'alice');   // first account: admin
    bob = await signup(api, 'bob');
    reg.app.db.prepare("UPDATE users SET oidc_sub = 'sub-alice' WHERE name = 'alice'").run();
    reg.app.db.prepare("UPDATE users SET oidc_sub = 'sub-bob' WHERE name = 'bob'").run();
    assert.equal((await publish(api, alice, manifest())).status, 201);
  });
  after(() => reg.close());

  test('downloads, accessor loads and API calls are counted per day; HEAD is not', async () => {
    assert.equal((await api('GET', '/filters/bevara%3Adummy/-/dummy-1.0.0.tgz')).status, 200);
    assert.equal((await api('GET', '/accessors/dummy_1.wasm')).status, 200);
    assert.equal((await api('GET', '/accessors/dummy_1.wasm')).status, 200);
    assert.equal((await api('HEAD', '/accessors/dummy_1.wasm')).status, 200);
    assert.equal((await api('GET', '/accessors/bevara%3Adummy/1.0.0/dummy_1.wasm')).status, 200);
    assert.equal((await api('GET', '/accessors/mm_solver_1.0.1.js')).status, 200);
    assert.equal((await api('GET', '/accessors/index.json')).status, 200);
    assert.equal((await api('GET', '/filters?q=dummy')).status, 200);
    assert.equal((await api('GET', '/filters/dummy')).status, 200);
    assert.equal((await api('GET', '/accessors/nope_1.wasm')).status, 404);   // failures are not counted

    const r = await api('GET', '/-/admin/stats?days=7', { token: alice });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.data.viewer.name, 'alice');
    assert.equal(r.data.daily.length, 7);
    assert.equal(r.data.trackingSince, new Date().toISOString().slice(0, 10));
    const { period } = r.data;
    assert.equal(period.tarball, 1);
    assert.equal(period['accessor-latest'], 3);              // dummy twice + the solver's script
    assert.equal(period.accessor, 1);
    assert.equal(period.index, 1);
    assert.equal(period.search, 1);
    assert.equal(period.metadata, 1);
    assert.equal(period.publish, 2);                          // the solver, then dummy
    const today = r.data.daily.at(-1);
    assert.equal(today.downloads, 5);
    assert.equal(today.publish, 2);
    assert.equal(today.signup, 2);

    const dummy = r.data.packages.find((p) => p.name === 'bevara:dummy');
    assert.deepEqual({ ...dummy.period }, { tarball: 1, accessor: 1, accessorLatest: 2, metadata: 1, downloads: 4 });
    assert.equal(dummy.kind, 'filter');
    assert.equal(dummy.downloadsAllTime, 5);                   // the old counter also counts the HEAD
    assert.deepEqual(dummy.owners, ['alice']);
    assert.equal(r.data.packages[0].name, 'bevara:dummy');     // most downloaded first
    assert.equal(r.data.packages.find((p) => p.name === 'bevara:mm_solver').kind, 'runtime');
    assert.equal(r.data.channelsByKind.runtime.accessorLatest, 1);
    assert.deepEqual(r.data.totals.byKind, { filter: 1, runtime: 1, tags: 0 });
    assert.equal(r.data.totals.users, 2);
    assert.equal(r.data.totals.admins, 1);
    assert.equal(r.data.publishers[0].user, 'alice');
    assert.equal(r.data.activity[0].type, 'publish');
  });

  test('history survives an unpublish', async () => {
    assert.equal((await api('DELETE', '/filters/bevara%3Adummy', { token: alice })).status, 200);
    const r = await api('GET', '/-/admin/stats', { token: alice });
    const dummy = r.data.packages.find((p) => p.name === 'bevara:dummy');
    assert.equal(dummy.kind, 'removed');
    assert.equal(dummy.period.downloads, 4);
    assert.equal(r.data.period.unpublish, 1);
    assert.equal(r.data.period.publish, 2);                   // still known from the log
    assert.equal((await publish(api, alice, manifest())).status, 201);
  });

  test('only administrators read them', async () => {
    assert.equal((await api('GET', '/-/admin/stats')).status, 401);
    assert.equal((await api('GET', '/-/admin/stats', { token: 'bvr_nope' })).status, 401);
    assert.equal((await api('GET', '/-/admin/stats', { token: bob })).status, 403);
    assert.equal((await api('GET', '/-/admin/me', { token: bob })).status, 403);
    assert.equal((await api('GET', '/-/admin/me', { token: alice })).data.name, 'alice');
  });

  test('an access token issued to the dashboard stands for the administrator it names', async () => {
    const me = await api('GET', '/-/admin/me', { token: jwt({ sub: 'sub-alice' }) });
    assert.equal(me.status, 200);
    assert.equal(me.data.name, 'alice');
    assert.equal((await api('GET', '/-/admin/stats?days=1', { token: jwt({ sub: 'sub-alice' }) })).status, 200);
    assert.equal((await api('GET', '/-/admin/me', { token: jwt({ sub: 'sub-bob' }) })).status, 403);       // not an admin
    const stranger = await api('GET', '/-/admin/me', { token: jwt({ sub: 'sub-nobody' }) });
    assert.equal(stranger.status, 403);
    assert.match(stranger.data.error, /no registry account/);
  });

  test('other tokens from the identity provider are refused', async () => {
    const refused = async (token, why) => {
      const r = await api('GET', '/-/admin/me', { token });
      assert.equal(r.status, 401, why);
      return r.data.error;
    };
    assert.match(await refused(jwt({ sub: 'sub-alice', aud: 'another-app' })), /does not accept/);
    assert.match(await refused(jwt({ sub: 'sub-alice', exp: Math.floor(Date.now() / 1000) - 600 })), /expired/);
    assert.match(await refused(jwt({ sub: 'sub-alice', iss: 'https://evil.test' })), /another issuer/);
    assert.match(await refused(jwt({ sub: 'sub-alice', tokenType: 'refresh-token' })), /not an access token/);
    assert.match(await refused(jwt({ sub: 'sub-alice' }, { key: otherKey.privateKey })), /signature/);
    assert.match(await refused(jwt({ sub: 'sub-alice' }, { kid: 'cert-2' })), /unknown JWT signing key/);
    assert.match(await refused(jwt({ sub: 'sub-alice' }, { alg: 'none' })), /unsupported/);
    // Elsewhere an access token is no registry token.
    assert.equal((await api('GET', '/-/whoami', { token: jwt({ sub: 'sub-alice' }) })).status, 401);
  });

  test('without ADMIN_OIDC_AUDIENCES, identity provider tokens are not accepted at all', async () => {
    const plain = await startRegistry({ oidc: { issuer: ISSUER, clientId: 'registry-client', clientSecret: 'x', fetch: fakeFetch } });
    try {
      await signup(plain.api, 'root');
      plain.app.db.prepare("UPDATE users SET oidc_sub = 'sub-alice' WHERE name = 'root'").run();
      assert.equal((await plain.api('GET', '/-/admin/me', { token: jwt({ sub: 'sub-alice' }) })).status, 401);
    } finally { await plain.close(); }
  });
});

describe('usage reports of the MCP server', () => {
  let reg, api, admin;
  const TOKEN = 'mcp-stats-token-0123456789';
  const day = new Date().toISOString().slice(0, 10);
  before(async () => {
    reg = await startRegistry({ statsIngestTokens: [TOKEN] });
    api = reg.api;
    admin = await signup(api, 'root');
  });
  after(() => reg.close());

  const counts = [
    { day, event: 'request', name: 'initialize', client: 'claude-ai', n: 3 },
    { day, event: 'request', name: 'tools/call', n: 9 },
    { day, event: 'tool', name: 'bevara_show', ext: 'tif', source: 'drop', outcome: 'ok', n: 4 },
    { day, event: 'tool', name: 'bevara_show', ext: 'jxl', source: 'url', outcome: 'ok', n: 1 },
    { day, event: 'tool', name: 'bevara_show', ext: 'other', source: 'drop', outcome: 'error', n: 2 },
    { day, event: 'tool', name: 'bevara_convert', ext: 'tif', target: 'png', source: 'drop', outcome: 'ok', n: 1 },
    { day, event: 'tool', name: 'bevara_formats', ext: 'heic', outcome: 'ok', n: 1 },
  ];

  test('only the shared token reports', async () => {
    assert.equal((await api('POST', '/-/stats/mcp', { body: { counts } })).status, 401);
    assert.equal((await api('POST', '/-/stats/mcp', { token: 'mcp-stats-token-wrong-0000', body: { counts } })).status, 401);
    assert.equal((await api('POST', '/-/stats/mcp', { token: admin, body: { counts } })).status, 401);   // not a user's token
    const off = await startRegistry();
    try { assert.equal((await off.api('POST', '/-/stats/mcp', { token: TOKEN, body: { counts } })).status, 404); } finally { await off.close(); }
  });

  test('a report is checked whole: one bad row refuses the batch', async () => {
    const bad = async (row, why) => {
      const r = await api('POST', '/-/stats/mcp', { token: TOKEN, body: { counts: [counts[0], row] } });
      assert.equal(r.status, 400, why);
    };
    await bad({ day, event: 'tool', name: 'bevara_show', ext: 'my holiday photo.tif<script>', n: 1 }, 'free text');
    await bad({ day, event: 'tool', name: 'x'.repeat(49), n: 1 }, 'too long');
    await bad({ day, event: 'download', n: 1 }, 'unknown event');
    await bad({ day: '2001-01-01', event: 'request', name: 'ping', n: 1 }, 'old day');
    await bad({ day, event: 'request', name: 'ping', n: 0 }, 'no count');
    await bad({ day, event: 'request', name: 'ping', n: 1.5 }, 'fraction');
    assert.equal((await api('POST', '/-/stats/mcp', { token: TOKEN, body: { counts: Array(2001).fill(counts[0]) } })).status, 400);
    const r = await api('GET', '/-/admin/stats', { token: admin });
    assert.equal(r.data.mcp.period.requests, 0);
  });

  test('the counters add up and the administrators read them', async () => {
    assert.equal((await api('POST', '/-/stats/mcp', { token: TOKEN, body: { counts } })).data.rows, counts.length);
    assert.equal((await api('POST', '/-/stats/mcp', { token: TOKEN, body: { counts: [counts[2]] } })).status, 200);
    const { mcp } = (await api('GET', '/-/admin/stats?days=7', { token: admin })).data;
    assert.deepEqual(mcp.period, { sessions: 3, requests: 12, toolCalls: 13, errors: 2, conversions: 1 });
    assert.equal(mcp.lastDay, day);
    assert.ok(mcp.reportedAt);
    assert.deepEqual(mcp.tools[0], { name: 'bevara_show', calls: 11, errors: 2 });
    assert.deepEqual(mcp.extensions.find((e) => e.ext === 'tif'), { ext: 'tif', show: 8, convert: 1, formats: 0, errors: 0 });
    assert.deepEqual(mcp.targets, [{ target: 'png', n: 1 }]);
    assert.deepEqual(mcp.clients, [{ client: 'claude-ai', n: 3 }]);
    assert.deepEqual(mcp.sources.find((s) => s.source === 'url'), { source: 'url', n: 1 });
    const today = mcp.daily.at(-1);
    assert.equal(today.toolCalls, 13);
    assert.equal(today.tools.bevara_show, 11);
    assert.equal(mcp.daily.length, 7);
  });
});
