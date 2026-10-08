import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CONFIG_PATH is read when the module loads: point it at a scratch file first.
const RC = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-config-test-')), 'bevararc');
process.env.BEVARA_CONFIG = RC;
delete process.env.BEVARA_REGISTRY;
const { DEFAULT_REGISTRY, normalizeRegistry, resolveRegistry, resolveRegistrySource, writeConfig } = await import('../src/lib/config.js');

describe('default registry', () => {
  afterEach(() => { fs.rmSync(RC, { force: true }); delete process.env.BEVARA_REGISTRY; });

  test('is registry.bevara.ddns.net over https', () => {
    assert.equal(DEFAULT_REGISTRY, 'https://registry.bevara.ddns.net');
  });

  test('applies when nothing is configured', () => {
    assert.deepEqual(resolveRegistrySource(), { url: DEFAULT_REGISTRY, source: 'default' });
    assert.equal(resolveRegistry(), DEFAULT_REGISTRY);
  });

  test('precedence: flag > BEVARA_REGISTRY > bevara.json > settings file > default', () => {
    writeConfig({ registry: 'https://from-rc.example' });
    assert.deepEqual(resolveRegistrySource(), { url: 'https://from-rc.example', source: RC });
    assert.equal(resolveRegistrySource({ project: { registry: 'https://from-project.example' } }).source, 'bevara.json');
    process.env.BEVARA_REGISTRY = 'https://from-env.example';
    assert.equal(resolveRegistrySource({ project: { registry: 'https://from-project.example' } }).source, 'BEVARA_REGISTRY');
    assert.deepEqual(resolveRegistrySource({ flag: 'https://from-flag.example', project: { registry: 'x' } }),
      { url: 'https://from-flag.example', source: '--registry' });
  });

  test('an empty value does not shadow the next source', () => {
    process.env.BEVARA_REGISTRY = '';
    assert.equal(resolveRegistrySource({ flag: '' }).source, 'default');
  });
});

describe('registry URL normalisation', () => {
  test('a bare public host gets https', () => {
    assert.equal(normalizeRegistry('registry.bevara.ddns.net'), 'https://registry.bevara.ddns.net');
    assert.equal(normalizeRegistry('  registry.example.org/  '), 'https://registry.example.org');
  });

  test('a bare local address gets http', () => {
    assert.equal(normalizeRegistry('127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.equal(normalizeRegistry('localhost:8080'), 'http://localhost:8080');
    assert.equal(normalizeRegistry('[::1]:8080'), 'http://[::1]:8080');
  });

  test('an explicit scheme is kept, trailing slashes dropped', () => {
    assert.equal(normalizeRegistry('http://registry.example.org///'), 'http://registry.example.org');
    assert.equal(normalizeRegistry('https://127.0.0.1:8443/'), 'https://127.0.0.1:8443');
  });

  test('a public host that merely starts like a local one is not treated as local', () => {
    assert.equal(normalizeRegistry('localhost.example.org'), 'https://localhost.example.org');
  });
});
