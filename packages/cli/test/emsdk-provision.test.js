import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureEmsdk } from '../src/lib/emsdk-provision.js';

const pinned = () => ({ version: '6.0.8', file: '/repo/third_parties/emsdk_vers.txt' });
const base = (over = {}) => ({
  expectedEmsdk: pinned, activeEmsdk: () => null, installedVersion: () => null,
  environmentOf: () => ({ EMSDK: '/managed' }), confirm: async () => { throw new Error('asked'); },
  provision: async () => { throw new Error('downloaded'); }, ...over,
});
const env = { PATH: '/usr/bin', BEVARA_EMSDK_HOME: '/managed' };

test('the active SDK is used when it is the pinned one', async () => {
  const r = await ensureEmsdk('/repo', { env, deps: base({ activeEmsdk: () => ({ version: '6.0.8' }) }) });
  assert.equal(r.source, 'active');
});

test('the pinned version already in the managed emsdk is used without asking', async () => {
  const r = await ensureEmsdk('/repo', { env, deps: base({ installedVersion: () => '6.0.8' }) });
  assert.equal(r.source, 'managed');
  assert.equal(r.env.EMSDK, '/managed');
});

test('otherwise the pinned version is offered, and downloaded when accepted', async () => {
  let asked = null, wanted = null;
  const r = await ensureEmsdk('/repo', { env, interactive: true, deps: base({ confirm: async (q) => { asked = q; return true; }, provision: async (v) => { wanted = v; return v; } }) });
  assert.match(asked, /download it into \/managed/);
  assert.equal(wanted, '6.0.8');
  assert.equal(r.source, 'downloaded');
  // --yes accepts without asking; with no pin the latest stable is wanted.
  const latest = await ensureEmsdk('/repo', { env, yes: true, deps: base({ expectedEmsdk: () => null, provision: async (v) => { wanted = v; return '6.1.0'; } }) });
  assert.equal(wanted, 'latest');
  assert.equal(latest.version, '6.1.0');
});

test('declined: the commands for one\'s own emsdk; the active SDK if any, else an error', async () => {
  const mismatch = await ensureEmsdk('/repo', { env, interactive: true, deps: base({ activeEmsdk: () => ({ version: '5.0.0' }), confirm: async () => false }) });
  assert.equal(mismatch.source, 'mismatch');
  assert.equal(mismatch.version, '5.0.0');
  await assert.rejects(ensureEmsdk('/repo', { env, interactive: true, deps: base({ confirm: async () => false }) }), (e) => /no Emscripten SDK/.test(e.message) && /emsdk install 6\.0\.8/.test(e.hint) && /emsdk_env\.sh/.test(e.hint));
  // Not interactive and no --yes: nothing is downloaded, --yes is suggested.
  await assert.rejects(ensureEmsdk('/repo', { env, interactive: false, deps: base() }), (e) => /--yes/.test(e.hint));
});
