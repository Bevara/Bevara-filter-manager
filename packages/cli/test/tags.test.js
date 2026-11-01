import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../src/lib/project.js';
import { filterManifest, packFilter } from '../src/lib/pack.js';
import { validateManifest } from '../src/lib/manifest.js';
import { pageRequirements, locateSources } from '../src/lib/page-files.js';
import { stripUniversal } from '../src/lib/page-record.js';
import { chooseTags, universalTag, sourceAttrFor } from '../src/lib/tag-choice.js';

function player(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-tags-'));
  fs.writeFileSync(path.join(dir, 'universal-tags.json'), JSON.stringify({ name: 'universal-tags', kind: 'tags', description: 'tags', tags: ['universal-img_1.js', 'universal-video_1.js'], main: 'build/dist', patents: { status: 'royalty-free' }, ...over }));
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
  assert.deepEqual(validateManifest({ name: 'x', version: '1.0.0', kind: 'tags', tags: ['my-img_1.js'], extends: { 'my-img_1.js': 'universal-img_1' }, patents: { status: 'royalty-free' } }, { forPublish: true }).errors, []);
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

describe('update-page --tags: the tag of each element', () => {
  const at = (name, file, ext = null) => ({ name, version: '1.0.0', file, url: `https://r/acc/${file}`, integrity: 'sha256-x', extends: ext });
  const index = { filters: [], runtimes: [], tags: [
    at('bevara:universal-tags', 'universal-canvas_1.js'), at('bevara:universal-tags', 'universal-tags_1.js'),
    at('bevara:art-player', 'art-player_1.js', 'universal-canvas_1'),
    at('zoe:fancy', 'fancy-img_1.js', 'universal-img_1'), at('zoe:fancy', 'fancy-art_1.js', 'art-player_1'),
    at('zoe:loose', 'loose_1.js'),
  ] };

  test('a package, a tag or element=tag; the universal tags otherwise', () => {
    assert.deepEqual([...chooseTags(['art-player'], index)], [['canvas', 'art-player_1']]);
    assert.deepEqual([...chooseTags(['bevara:art-player'], index)], [['canvas', 'art-player_1']]);
    assert.deepEqual([...chooseTags(['fancy-img_1'], index)], [['img', 'fancy-img_1']]);
    // A tag built on a tag stands for the element at the root.
    assert.deepEqual([...chooseTags(['fancy-art_1'], index)], [['canvas', 'fancy-art_1']]);
    assert.deepEqual([...chooseTags(['canvas=my-canvas_2'], null)], [['canvas', 'my-canvas_2']]);
    assert.deepEqual([...chooseTags(['art-player,fancy-img_1'], index)].sort(), [['canvas', 'art-player_1'], ['img', 'fancy-img_1']]);
    // The universal tags are the default: choosing them changes nothing.
    assert.equal(chooseTags(['universal-tags'], index).size, 0);
    assert.equal(chooseTags([], index).size, 0);
    assert.equal(universalTag('video'), 'universal-video_1');
  });

  test('what cannot be placed is refused', () => {
    assert.throws(() => chooseTags(['nothing'], index), /no tags package nor tag named nothing/);
    assert.throws(() => chooseTags(['loose_1'], index), /does not say which element/);
    assert.throws(() => chooseTags(['art-player'], null), /needs the registry/);
    assert.throws(() => chooseTags(['span=x_1'], null), /not a media element/);
    assert.throws(() => chooseTags(['canvas=nogeneration'], null), /not a tag name/);
    // zoe:fancy puts fancy-art_1 on <canvas>, as art-player does.
    assert.throws(() => chooseTags(['art-player', 'zoe:fancy'], index), /two tags/);
  });

  test('the universal canvas reads data-url, every other tag src', () => {
    assert.equal(sourceAttrFor('canvas', 'universal-canvas_1'), 'data-url');
    assert.equal(sourceAttrFor('canvas', 'art-player_1'), 'src');
    assert.equal(sourceAttrFor('img', 'universal-img_1'), 'src');
  });

  test('the page then loads the script of its tag, its solver and accessors; revert removes them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-artpage-'));
    const page = `<html><body>
<canvas is="art-player_1" src="v.mpg" using="mm_solver_1.0.1" with="libmpeg2_1"></canvas>
<script src="scripts/art-player_1.js"></script>
<script src="js/jquery_3.js"></script>
</body></html>`;
    const reqs = pageRequirements(page, dir);
    assert.deepEqual(reqs.map((r) => [r.kind, r.ref]), [
      ['script', 'scripts/art-player_1.js'],
      ['solver', 'mm_solver_1.0.1.js'], ['solver', 'mm_solver_1.0.1.wasm'],
      ['accessor', 'libmpeg2_1.wasm'],
    ]);
    assert.equal(locateSources(reqs, { index })[0].source.label, 'bevara:art-player@1.0.0');
    assert.equal(stripUniversal(page), `<html><body>
<canvas src="v.mpg"></canvas>
<script src="js/jquery_3.js"></script>
</body></html>`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
