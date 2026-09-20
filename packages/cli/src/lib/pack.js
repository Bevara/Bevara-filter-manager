import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as tar from 'tar';
import { inspectWasm, accessorFileName } from './wasm.js';
import { validateManifest, normalizeManifest } from './manifest.js';
import { CliError, log, color } from './ui.js';

const ALWAYS_INCLUDE = ['README.md', 'README', 'LICENSE', 'LICENSE.md', 'LICENCE', 'CHANGELOG.md'];

export function checkFilterManifest(project) {
  const m = normalizeManifest(project.manifest);
  const { errors, warnings } = validateManifest(m, { forPublish: true });
  if (errors.length) throw new CliError(`bevara.json is invalid:\n  - ${errors.join('\n  - ')}`);
  for (const w of warnings) log.warn(w);
  if (!m.main) throw new CliError('bevara.json has no "main": set it to the built .wasm (e.g. "build/<name>_1.wasm")');
  return m;
}

export function buildFilter(project, { script } = {}) {
  const m = project.manifest;
  const cmd = script ?? m.scripts?.build ?? 'emcmake cmake -S . -B build && cmake --build build';
  log.step(`build: ${color.dim(cmd)}`);
  try {
    execSync(cmd, { cwd: project.root, stdio: 'inherit', env: process.env, shell: true });
  } catch (e) {
    throw new CliError(`build failed (exit ${e.status ?? '?'})`, { hint: 'is the Emscripten SDK activated? (source emsdk_env.sh)' });
  }
}

export function checkArtifact(project, m) {
  const file = path.resolve(project.root, m.main);
  if (!fs.existsSync(file)) throw new CliError(`built module not found: ${m.main}`, { hint: 'run `bevara build` first, or `bevara publish --build`' });
  const buf = fs.readFileSync(file);
  const info = inspectWasm(buf);
  if (!info.valid) throw new CliError(`${m.main}: ${info.error}`);
  if (!info.sideModule) throw new CliError(`${m.main} is not an Emscripten side module (no dylink section)`, { hint: 'link with -sSIDE_MODULE=2 (see the generated filters.cmake)' });
  return { file, buf, info };
}

// Creates <name>-<version>.tgz with the npm-style "package/" prefix:
//   package/bevara.json, package/<name>_<abi>.wasm, docs and "files" entries.
export async function packFilter(project, { outDir = project.root, dryRun = false } = {}) {
  const m = checkFilterManifest(project);
  const { buf } = checkArtifact(project, m);
  const stageRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bevara-pack-'));
  const stage = path.join(stageRoot, 'package');
  fs.mkdirSync(stage);
  const entries = [];
  const add = (rel, data) => { const dest = path.join(stage, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data); entries.push({ path: `package/${rel}`, size: data.length }); };

  const { main, scripts, accessorsDir, registry, ...published } = m;
  add('bevara.json', Buffer.from(JSON.stringify(published, null, 2) + '\n'));
  add(accessorFileName(m.name, m.abi), buf);
  const extra = new Set([...ALWAYS_INCLUDE, ...(m.files ?? [])]);
  for (const rel of extra) {
    const src = path.resolve(project.root, rel);
    if (!fs.existsSync(src)) continue;
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      for (const f of walk(src)) add(path.relative(project.root, f), fs.readFileSync(f));
    } else add(rel, fs.readFileSync(src));
  }
  const tgzName = `${m.name}-${m.version}.tgz`;
  const tgzPath = path.join(outDir, tgzName);
  if (!dryRun) {
    await tar.create({ gzip: true, cwd: stageRoot, file: tgzPath, portable: true, mtime: new Date('2000-01-01T00:00:00Z') }, ['package']);
  }
  fs.rmSync(stageRoot, { recursive: true, force: true });
  return { manifest: m, tgzPath, tgzName, entries, size: dryRun ? null : fs.statSync(tgzPath).size };
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

