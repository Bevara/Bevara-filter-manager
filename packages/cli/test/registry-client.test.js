import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeHttpFailure, describeNetworkFailure, bodyExcerpt, RegistryError } from '../src/lib/registry-client.js';

const NGINX_503 = `<html>
<head><title>503 Service Temporarily Unavailable</title></head>
<body>
<center><h1>503 Service Temporarily Unavailable</h1></center>
<hr><center>nginx/1.25.3</center>
</body>
</html>`;

describe('HTTP failures', () => {
  test('a 503 from a proxy says the registry is not answering, and why', () => {
    const d = describeHttpFailure({
      status: 503, statusText: 'Service Unavailable', base: 'https://registry.example', method: 'GET',
      path: '/filters', server: 'nginx/1.25.3', bodyText: NGINX_503,
    });
    assert.match(d.message, /registry https:\/\/registry\.example is not answering \(503 Service Unavailable\)/);
    assert.ok(d.details.includes('GET https://registry.example/filters'));
    assert.ok(d.details.some((l) => /down, still starting, or not deployed/.test(l)));
    assert.ok(d.details.includes('served by nginx/1.25.3'));
    assert.match(d.hint, /bevara ping/);
    assert.match(d.hint, /BEVARA_REGISTRY/);
    // The body only restated the status, so it is not repeated as a detail.
    assert.ok(!d.details.some((l) => /response body/.test(l)), d.details.join(' | '));
  });

  test('502 and 504 are reported as unreachable too, with their own reason', () => {
    const f = (status) => describeHttpFailure({ status, base: 'https://r.example', method: 'GET', path: '/filters' });
    assert.match(f(502).message, /is not answering \(502 Bad Gateway\)/);
    assert.ok(f(502).details.some((l) => /invalid response/.test(l)));
    assert.match(f(504).message, /504 Gateway Timeout/);
    assert.ok(f(504).details.some((l) => /did not answer the proxy in time/.test(l)));
  });

  test("the registry's own JSON message is kept, with the status as context", () => {
    const d = describeHttpFailure({
      status: 404, statusText: 'Not Found', base: 'https://r.example', method: 'GET',
      path: '/filters/theora', json: { error: 'filter "bevara:theora" not found' },
    });
    assert.equal(d.message, 'filter "bevara:theora" not found');
    assert.ok(d.details.includes('the registry answered 404 Not Found'));
    assert.ok(!d.details.some((l) => /response body/.test(l)), 'a JSON error needs no body excerpt');
  });

  test('statuses carry the action that resolves them', () => {
    const at = (status, json) => describeHttpFailure({ status, base: 'https://r.example', method: 'PUT', path: '/x', json });
    assert.match(at(401, { error: 'authentication required' }).hint, /bevara login/);
    assert.match(at(413).hint, /MAX_TARBALL_BYTES|proxy-body-size/);
    assert.match(at(500).hint, /logs/);
    assert.match(at(405).hint, /really a Bevara registry/);
    assert.equal(at(409, { error: 'already published' }).hint, undefined);
  });

  test('a non-JSON body that adds information is shown', () => {
    const d = describeHttpFailure({
      status: 403, statusText: 'Forbidden', base: 'https://r.example', method: 'GET', path: '/filters',
      bodyText: '<html><body>Blocked by corporate proxy: policy DENY-WASM</body></html>',
    });
    assert.ok(d.details.some((l) => /Blocked by corporate proxy: policy DENY-WASM/.test(l)), d.details.join(' | '));
  });
});

describe('body excerpts', () => {
  test('tags are stripped and the duplicated title/heading collapsed', () => {
    assert.equal(bodyExcerpt(NGINX_503), '503 Service Temporarily Unavailable nginx/1.25.3');
  });
  test('empty, blank and tag-only bodies yield nothing', () => {
    for (const b of [null, '', '   ', '<html><body><br></body></html>']) assert.equal(bodyExcerpt(b), null);
  });
  test('long bodies are truncated', () => {
    const e = bodyExcerpt('x '.repeat(400), 40);
    assert.ok(e.length <= 40 && e.endsWith('…'));
  });
});

describe('network failures', () => {
  const at = (code, url = 'https://registry.example/filters') => describeNetworkFailure(Object.assign(new Error('fetch failed'), { cause: { code } }), url);

  test('DNS, refused connections and timeouts each get their own wording', () => {
    assert.match(at('ENOTFOUND').message, /the host registry\.example does not resolve/);
    assert.match(at('ECONNREFUSED', 'http://127.0.0.1:8080/filters').message, /nothing is listening on 127\.0\.0\.1:8080/);
    assert.match(at('ECONNREFUSED', 'http://127.0.0.1:8080/filters').hint, /npm run registry/);
    assert.match(at('ETIMEDOUT').message, /did not answer in time/);
  });

  test('TLS problems are named, with the way out', () => {
    assert.match(at('CERT_HAS_EXPIRED').message, /certificate of registry\.example has expired/);
    assert.match(at('DEPTH_ZERO_SELF_SIGNED_CERT').hint, /NODE_EXTRA_CA_CERTS/);
  });

  test('the message names the registry origin, not the failing path', () => {
    assert.match(at('ENOTFOUND', 'https://registry.example/filters/bevara:theora').message, /cannot reach registry https:\/\/registry\.example:/);
  });

  test('an unknown code falls back to the underlying message', () => {
    assert.match(at('SOMETHING_ELSE').message, /cannot reach registry\.example/);
  });
});

describe('RegistryError', () => {
  test('context lines and server validation errors stay separate', () => {
    const e = new RegistryError(400, 'invalid manifest', { extra: { errors: ['"name" is required'] }, details: ['PUT /filters/x/1.0.0'], hint: 'fix bevara.json' });
    assert.deepEqual(e.details, ['PUT /filters/x/1.0.0']);
    assert.deepEqual(e.extra.errors, ['"name" is required']);
    assert.equal(e.hint, 'fix bevara.json');
    assert.equal(e.status, 400);
  });
});

describe('registry versions', async () => {
  const { assertRegistryVersion, isRegistryTooOld, MIN_REGISTRY_VERSION } = await import('../src/lib/registry-client.js');

  test('a registry older than the CLI needs is refused with the way out', () => {
    assert.throws(() => assertRegistryVersion({ version: '1.0.0' }, 'https://r.example'),
      (e) => /runs version 1\.0\.0, older than this CLI needs/.test(e.message) && /redeploy/.test(e.hint));
    assert.throws(() => assertRegistryVersion({}, 'https://r.example'), /version unknown/);
  });

  test('the minimum and anything newer are accepted', () => {
    for (const v of [MIN_REGISTRY_VERSION, '1.2.0', '2.0.0', '1.10.0']) {
      assert.doesNotThrow(() => assertRegistryVersion({ version: v }, 'x'), v);
      assert.equal(isRegistryTooOld({ version: v }), false, v);
    }
    assert.equal(isRegistryTooOld({ version: '1.0.9' }), true);
  });

  test('an unknown route is explained as a version gap', () => {
    const d = describeHttpFailure({ status: 404, statusText: 'Not Found', base: 'https://r.example', method: 'PUT', path: '/-/keys', json: { error: 'no route for PUT /-/keys' } });
    assert.match(d.message, /does not support PUT \/-\/keys: it is probably an older registry/);
    assert.match(d.hint, /bevara ping/);
  });

  test('a genuine 404 from the registry keeps its own message', () => {
    const d = describeHttpFailure({ status: 404, base: 'https://r.example', method: 'GET', path: '/filters/x', json: { error: 'filter "bevara:x" not found' } });
    assert.equal(d.message, 'filter "bevara:x" not found');
  });
});
