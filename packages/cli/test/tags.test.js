import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/lib/project.js';
import { filterManifest, packFilter } from '../src/lib/pack.js';
import { validateManifest } from '../src/lib/manifest.js';
import { pageRequirements, locateSources } from '../src/lib/page-files.js';

function player(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-tags-'));
  fs.writeFileSync(path.join(dir, 'universal-tags.json'), JSON.stringify({ name: 'universal-tags', kind: 'tags', description: 'tags', tags: ['universal-img_1.js', 'universal-video_1.js'], main: 'build/dist', ...over }));
  fs.writeFileSync(path.join(dir, 'LICENCE'), 'SPDX-License-Identifier: ISC\n');
  fs.mkdirSync(path.join(dir, 'build', 'dist'), { recursive: true });
  for (const t of ['universal-img_1.js', 'universal-video_1.js']) fs.writeFileSync(path.join(dir, 'build', 'dist', t), `/*! notice */ define("${t}")`);
  return dir;
}

test('a tags package: generation from its scripts, packed with every script, no "using"', async () => {
  const dir = player();
  const project = Project.load({ dir });
  const m = filterManifest(project);
  assert.equal(m.abi, 1);
  assert.equal(m.version, '1.0.0');
  assert.equal(m.license, 'ISC');
  assert.deepEqual(validateManifest(m, { forPublish: true }).errors, []);
  const r = await packFilter(project, { dryRun: true });
  assert.deepEqual(r.entries.map((e) => e.path).filter((p) => p.endsWith('.js')), ['package/universal-img_1.js', 'package/universal-video_1.js']);
  assert.equal(r.scripts.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a tags package is checked: scripts of one generation, built, "extends" naming its own scripts', async () => {
  assert.ok(validateManifest({ name: 'x', version: '1.0.0', kind: 'tags', tags: ['a_1.js', 'b_2.js'] }).errors.some((e) => /one generation/.test(e)));
  assert.ok(validateManifest({ name: 'x', version: '1.0.0', kind: 'tags', tags: ['a_1.js'], extends: { 'c_1.js': 'universal-img_1' } }).errors.some((e) => /not in "tags"/.test(e)));
  assert.deepEqual(validateManifest({ name: 'x', version: '1.0.0', kind: 'tags', tags: ['my-img_1.js'], extends: { 'my-img_1.js': 'universal-img_1' } }, { forPublish: true }).errors, []);
  const dir = player();
  fs.rmSync(path.join(dir, 'build', 'dist', 'universal-video_1.js'));
  await assert.rejects(packFilter(Project.load({ dir }), { dryRun: true }), /tag scripts not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('update-page takes a tag script from the tags packages of the index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-tagpage-'));
  const reqs = pageRequirements('<script src="scripts/universal-img_1.js"></script>', dir);
  const index = { filters: [], runtimes: [], tags: [{ name: 'bevara:universal-tags', version: '1.0.0', file: 'universal-img_1.js', url: 'https://r/acc/universal-tags/1.0.0/universal-img_1.js', integrity: 'sha256-x' }] };
  const [s] = locateSources(reqs, { index });
  assert.equal(s.source.label, 'bevara:universal-tags@1.0.0');
  assert.match(locateSources(reqs, { index: { filters: [], tags: [] } })[0].missing, /no tags package/);
  fs.rmSync(dir, { recursive: true, force: true });
});
