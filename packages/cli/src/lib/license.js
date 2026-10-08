/* The licence of a filter comes from its licence file, not from the manifest.
 *
 * A repository states its licence once, in LICENCE (or LICENSE, COPYING…),
 * which is also the file the licence itself requires to be distributed with the
 * module. The CLI reads it at publish time and sends the result to the registry
 * as the package's "license", so the information is never written twice.
 *
 * Exact when the file carries an SPDX tag, as its first line ideally:
 *
 *   SPDX-License-Identifier: LGPL-2.1-or-later AND BSD-3-Clause AND MIT
 *
 * Otherwise the licence texts it contains are recognised, in order of
 * appearance. A text says nothing about "or later" for the (L)GPL: that comes
 * from the source headers ("…or (at your option) any later version"), which are
 * checked; when neither tells, "-only" is reported, the safe reading.
 */
import fs from 'node:fs';
import path from 'node:path';

// Both spellings, as found in the repositories; the first match wins.
export const LICENCE_FILES = [
  'LICENCE', 'LICENSE', 'LICENCE.md', 'LICENSE.md', 'LICENCE.txt', 'LICENSE.txt',
  'COPYING', 'COPYING.md', 'COPYING.txt', 'COPYING.LESSER',
];

export function findLicenceFile(root) {
  let entries;
  try { entries = fs.readdirSync(root); } catch { return null; }
  const byLower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const name of LICENCE_FILES) {
    const real = byLower.get(name.toLowerCase());
    if (real && fs.statSync(path.join(root, real)).isFile()) return path.join(root, real);
  }
  return null;
}

/* Recognisable texts. Each rule must match distinctive wording, so that a file
 * quoting several licences yields each of them once. */
const TEXTS = [
  { id: 'LGPL-2.1', gpl: true, all: [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 2\.1,? February 1999/i] },
  { id: 'LGPL-3.0', gpl: true, all: [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 3, 29 June 2007/i] },
  { id: 'GPL-2.0', gpl: true, all: [/GNU GENERAL PUBLIC LICENSE/, /Version 2, June 1991/i] },
  { id: 'GPL-3.0', gpl: true, all: [/GNU GENERAL PUBLIC LICENSE/, /Version 3, 29 June 2007/i], unless: [/GNU LESSER GENERAL PUBLIC LICENSE/i] },
  { id: 'AGPL-3.0', gpl: true, all: [/GNU AFFERO GENERAL PUBLIC LICENSE/i] },
  { id: 'MPL-2.0', all: [/Mozilla Public License,? (Version|v\.?) ?2\.0/i] },
  { id: 'Apache-2.0', all: [/Apache License/i, /Version 2\.0, January 2004/i] },
  { id: 'BSD-3-Clause', all: [/Redistribution and use in source and binary forms/i, /Neither the name of/i] },
  { id: 'BSD-2-Clause', all: [/Redistribution and use in source and binary forms/i], unless: [/Neither the name of/i] },
  { id: 'MIT', all: [/Permission is hereby granted, free of charge, to any person obtaining a copy/i, /THE SOFTWARE IS PROVIDED "AS IS"/i] },
  { id: 'ISC', all: [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i] },
  { id: 'Zlib', all: [/This software is provided 'as-is', without any express or implied/i, /Altered source versions must be plainly marked/i] },
  { id: 'BSL-1.0', all: [/Boost Software License - Version 1\.0/i] },
  { id: 'Unlicense', all: [/This is free and unencumbered software released into the public domain/i] },
];

const SPDX_TAG = /SPDX-License-Identifier:\s*([^\n\r*#]+?)\s*(?:\*\/|-->)?\s*$/im;

/* Whether the sources at the root of the repository grant "any later version". */
function sourcesSayOrLater(root) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return null; }
  let seen = false;
  for (const f of entries.filter((e) => /\.(c|cc|cpp|h|hpp)$/i.test(e)).slice(0, 50)) {
    const head = fs.readFileSync(path.join(root, f), 'utf8').slice(0, 3000);
    if (/General Public License/i.test(head)) {
      seen = true;
      if (/any later version/i.test(head)) return true;
    }
  }
  return seen ? false : null;
}

/* The licence of one block of text: its SPDX tag, or the texts it contains,
 * joined with AND in the order they appear. */
export function identifyLicence(text, { orLater = null } = {}) {
  const tag = SPDX_TAG.exec(text);
  if (tag) return { spdx: tag[1].trim(), how: 'SPDX-License-Identifier' };
  const found = [];
  for (const rule of TEXTS) {
    if (!rule.all.every((re) => re.test(text))) continue;
    if (rule.unless?.some((re) => re.test(text))) continue;
    const at = Math.min(...rule.all.map((re) => text.search(re)));
    const id = rule.gpl ? `${rule.id}-${orLater ? 'or-later' : 'only'}` : rule.id;
    found.push({ id, at });
  }
  if (!found.length) return null;
  const ids = [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.id))];
  return { spdx: ids.join(' AND '), how: 'licence text', guessed: found.some((f) => /-only$/.test(f.id) && orLater === null) };
}

/* { file, spdx, how, notes } for a repository, or null without a licence file.
 * Unrecognised text falls back to npm's convention, "SEE LICENSE IN <file>". */
export function licenceFromRepository(root) {
  const file = findLicenceFile(root);
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  const name = path.basename(file);
  const notes = [];
  const id = identifyLicence(text, { orLater: sourcesSayOrLater(root) });
  if (!id) {
    notes.push(`${name} matches no licence text the CLI knows: published as "SEE LICENSE IN ${name}". An "SPDX-License-Identifier:" line in ${name} makes it exact`);
    return { file, spdx: `SEE LICENSE IN ${name}`, how: 'fallback', notes };
  }
  if (id.how === 'licence text') notes.push(`licence read from the text of ${name} (${id.spdx}); an "SPDX-License-Identifier:" line would make it exact`);
  if (id.guessed) notes.push(`${name} has a (L)GPL text but no source header says whether later versions apply: reported as "-only"`);
  return { file, spdx: id.spdx, how: id.how, notes };
}
