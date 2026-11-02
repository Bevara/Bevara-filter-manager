#!/usr/bin/env node
// Republishes the latest version of every accessor of a registry with its
// "using" renamed, e.g. after the solvers became mm_solver_1.0.1 and
// mm_solver_minimal_1.0.1. Each accessor is republished from its own published
// tarball - same .wasm, same manifest - as the next patch version. A name may
// map to several (old=a+b): the accessor then links against each of them.
//
//   node scripts/republish-using.js --map solver_1=mm_solver_1.0.1+mm_solver_1.0.2,solver_minimal_1=mm_solver_minimal_1.0.1 \
//        [--registry https://registry.bevara.ddns.net] [--only libpng,ogg] [--dry-run]
// Publishes are signed with the CLI's key, as `bevara publish` does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const { values: o } = parseArgs({ options: {
  map: { type: 'string' }, registry: { type: 'string', default: 'https://registry.bevara.ddns.net' },
  only: { type: 'string' }, 'dry-run': { type: 'boolean' },
} });
if (!o.map) { console.error('usage: republish-using.js --map <old>=<new>[+<new>][,<old>=<new>] [--registry <url>] [--only a,b] [--dry-run]'); process.exit(2); }
const map = new Map(o.map.split(',').map((p) => { const [from, to] = p.split('='); return [from, to.split('+')]; }));
const registry = o.registry.replace(/\/$/, '');
const only = o.only ? new Set(o.only.split(',')) : null;
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'cli', 'bin', 'bevara.js');

async function get(url, as = 'json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

const index = await get(`${registry}/accessors/index.json`);
let ok = 0, failed = 0, skipped = 0;
for (const entry of index.filters) {
  const short = entry.name.split(':').pop();
  if (only && !only.has(short)) continue;
  if (!(entry.using ?? []).some((u) => map.has(u))) { skipped++; continue; }
  const doc = await get(`${registry}/filters/${encodeURIComponent(entry.name)}/${entry.version}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bevara-republish-${short}-`));
  try {
    const tgz = path.join(dir, 'p.tgz');
    fs.writeFileSync(tgz, await get(doc.dist.tarball, 'buffer'));
    await tar.extract({ file: tgz, cwd: dir });
    const pkg = path.join(dir, 'package');
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'bevara.json'), 'utf8'));
    const [a, b, c] = manifest.version.split('.').map(Number);
    manifest.version = `${a}.${b}.${c + 1}`;
    manifest.using = [...new Set(manifest.using.flatMap((u) => map.get(u) ?? [u]))];
    manifest.main = doc.dist.file;
    fs.writeFileSync(path.join(pkg, 'bevara.json'), JSON.stringify(manifest, null, 2) + '\n');
    const args = [cli, 'publish', '-y', '-r', registry, ...(o['dry-run'] ? ['--dry-run'] : [])];
    const r = spawnSync(process.execPath, args, { cwd: pkg, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env });
    if (r.status === 0) { ok++; console.log(`✔ ${entry.name}@${manifest.version} using ${manifest.using.join(', ')}`); }
    else { failed++; console.log(`✖ ${entry.name}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`\n${ok} ${o['dry-run'] ? 'checked' : 'published'}, ${failed} failed, ${skipped} not using ${[...map.keys()].join(' or ')}`);
process.exit(failed ? 1 : 0);
