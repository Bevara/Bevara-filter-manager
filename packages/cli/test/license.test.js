import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLicenceFile, identifyLicence, licenceFromRepository } from '../src/lib/license.js';
import { Project } from '../src/lib/project.js';
import { filterManifest } from '../src/lib/pack.js';

const repo = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-licence-test-'));
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
  return d;
};

// Distinctive excerpts of the real texts (the full texts are in third_parties/).
const LGPL21 = 'GNU LESSER GENERAL PUBLIC LICENSE\n Version 2.1, February 1999\n';
const BSD3 = 'Redistribution and use in source and binary forms, with or without modification...\n3. Neither the name of the copyright holder nor ...';
const BSD2 = 'Redistribution and use in source and binary forms, with or without modification...';
const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy\nof this software ... THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY';
const APACHE = 'Apache License\n Version 2.0, January 2004';
const GPL3 = 'GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007';

describe('finding the licence file', () => {
  test('both spellings, LICENCE first, case-insensitive', () => {
    assert.match(findLicenceFile(repo({ LICENCE: MIT, LICENSE: BSD3 })), /LICENCE$/);
    assert.match(findLicenceFile(repo({ 'license.md': MIT })), /license\.md$/);
    assert.match(findLicenceFile(repo({ COPYING: GPL3 })), /COPYING$/);
    assert.equal(findLicenceFile(repo({ 'README.md': 'x' })), null);
  });
});

describe('identifying the licence', () => {
  test('an SPDX tag is taken as is', () => {
    assert.deepEqual(identifyLicence('SPDX-License-Identifier: LGPL-2.1-or-later AND BSD-3-Clause AND MIT\n\n' + MIT),
      { spdx: 'LGPL-2.1-or-later AND BSD-3-Clause AND MIT', how: 'SPDX-License-Identifier' });
    assert.equal(identifyLicence('/* SPDX-License-Identifier: MPL-2.0 */').spdx, 'MPL-2.0');
  });

  test('known texts are recognised', () => {
    for (const [text, id] of [[MIT, 'MIT'], [BSD3, 'BSD-3-Clause'], [BSD2, 'BSD-2-Clause'], [APACHE, 'Apache-2.0']]) {
      assert.equal(identifyLicence(text).spdx, id);
    }
  });

  test('several texts in one file are joined with AND, in order, without repeats', () => {
    assert.equal(identifyLicence([LGPL21, BSD3, BSD3, MIT].join('\n'), { orLater: true }).spdx, 'LGPL-2.1-or-later AND BSD-3-Clause AND MIT');
  });

  test('(L)GPL: "or later" comes from the sources, "-only" when nothing says', () => {
    assert.equal(identifyLicence(LGPL21, { orLater: true }).spdx, 'LGPL-2.1-or-later');
    assert.equal(identifyLicence(LGPL21, { orLater: false }).spdx, 'LGPL-2.1-only');
    const unknown = identifyLicence(LGPL21);
    assert.equal(unknown.spdx, 'LGPL-2.1-only');
    assert.equal(unknown.guessed, true);
  });

  test('the GPL is not mistaken for the LGPL, nor the reverse', () => {
    assert.equal(identifyLicence(GPL3, { orLater: true }).spdx, 'GPL-3.0-or-later');
    assert.ok(!identifyLicence(LGPL21, { orLater: true }).spdx.includes('GPL-2.0'));
  });

  test('an unknown text yields nothing', () => {
    assert.equal(identifyLicence('All rights reserved. Ask us.'), null);
  });
});

describe('licence of a repository', () => {
  test('"or later" read from a source header', () => {
    const d = repo({ LICENCE: LGPL21, 'reframe.c': '/* ... either version 2, or (at your option)\n * any later version. GNU Lesser General Public License */' });
    assert.equal(licenceFromRepository(d).spdx, 'LGPL-2.1-or-later');
  });

  test('unrecognised text falls back to npm\'s "SEE LICENSE IN"', () => {
    const r = licenceFromRepository(repo({ LICENCE: 'Proprietary. All rights reserved.' }));
    assert.equal(r.spdx, 'SEE LICENSE IN LICENCE');
    assert.ok(r.notes.some((n) => /SPDX-License-Identifier/.test(n)));
  });

  test('no file, no licence', () => {
    assert.equal(licenceFromRepository(repo({})), null);
  });
});

describe('licence in the published manifest', () => {
  const manifest = (extra = {}) => JSON.stringify({ name: 'x', filters: ['xdec'], ...extra });

  test('taken from LICENCE when the manifest has none, which stays untouched', () => {
    const d = repo({ 'x.json': manifest(), LICENCE: 'SPDX-License-Identifier: MIT\n' + MIT });
    const p = new Project(d, path.join(d, 'x.json'));
    const m = filterManifest(p);
    assert.equal(m.license, 'MIT');
    assert.match(m.derived.license, /LICENCE \(SPDX-License-Identifier\)/);
    assert.equal(p.manifest.license, undefined);
  });

  test('a "license" in the manifest wins, and a disagreement is reported', () => {
    const d = repo({ 'x.json': manifest({ license: 'Apache-2.0' }), LICENCE: 'SPDX-License-Identifier: MIT\n' });
    const m = filterManifest(new Project(d, path.join(d, 'x.json')));
    assert.equal(m.license, 'Apache-2.0');
    assert.ok(m.derived.notes.some((n) => /differs from LICENCE \(MIT\)/.test(n)));
  });
});
