#!/usr/bin/env node
// Seeds a registry from already-built accessors, e.g. the Showcase/accessors
// directory, reusing the <name>.json manifests of the Bevara filters repository
// when available.
//
//   node scripts/import-accessors.js --wasm-dir ../Showcase/accessors --json-dir ../filters \
//        --registry http://localhost:8080 [--version 1.0.0] [--only theora,ogg] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { values: o } = parseArgs({ options: {
  'wasm-dir': { type: 'string' }, 'json-dir': { type: 'string' }, registry: { type: 'string' },
  version: { type: 'string', default: '1.0.0' }, only: { type: 'string' }, 'dry-run': { type: 'boolean' }, license: { type: 'string', default: 'LGPL-2.1-or-later' },
} });
if (!o['wasm-dir']) { console.error('usage: import-accessors.js --wasm-dir <dir> [--json-dir <filters repo>] [--registry <url>]'); process.exit(2); }

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'cli', 'bin', 'bevara.js');
const only = o.only ? new Set(o.only.split(',')) : null;
const SUPPORT_MAP = { image: 'image', audio: 'audio', video: 'video', canvas: 'canvas', text: 'text', subtitle: 'subtitle' };

function findJson(name) {
  if (!o['json-dir']) return null;
  for (const cand of [path.join(o['json-dir'], name, `${name}.json`), path.join(o['json-dir'], `${name}.json`)]) {
    if (fs.existsSync(cand)) return JSON.parse(fs.readFileSync(cand, 'utf8'));
  }
  return null;
}

let ok = 0, failed = 0;
for (const file of fs.readdirSync(o['wasm-dir']).sort()) {
  const m = /^([a-z0-9][a-z0-9._-]*)_(\d+)\.wasm$/i.exec(file);
  if (!m) continue;
  const name = m[1].toLowerCase(), abi = parseInt(m[2], 10);
  if (only && !only.has(name)) continue;
  const src = findJson(name) ?? {};
  const manifest = {
    name, version: o.version, abi,
    description: src.description ?? `${name} accessor`,
    help: src.help,
    filters: src.filters ?? [name],
    support: (src.support ?? []).map((s) => SUPPORT_MAP[s] ?? s),
    formats: src.Format ?? src.formats ?? [],
    license: src.license ?? o.license,
    licence_required: !!src.licence_required,
    sources: src.sources,
    filter_source: src.filter_source,
    main: file,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bevara-import-${name}-`));
  fs.writeFileSync(path.join(dir, 'bevara.json'), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(o['wasm-dir'], file), path.join(dir, file));
  const args = [cli, 'publish', '-y', ...(o.registry ? ['-r', o.registry] : []), ...(o['dry-run'] ? ['--dry-run'] : [])];
  const r = spawnSync(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status === 0) { ok++; console.log(`✔ ${name}@${o.version} (abi ${abi})`); }
  else { failed++; console.log(`✖ ${name}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); }
}
console.log(`\n${ok} published, ${failed} failed`);
process.exit(failed ? 1 : 0);
