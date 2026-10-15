import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import * as tar from 'tar';
import { inspectWasm, accessorFileName } from './wasm.js';
import { validateManifest, normalizeManifest, fromLegacy, shortName } from './manifest.js';
import { addFilterFor, executableFor } from './cmake.js';
import { licenceFromRepository, LICENCE_FILES } from './license.js';
import { extractCaps, projectsOf, runtimeBuiltins } from './caps.js';
import { activeEmsdk, expectedEmsdk, resetIfOtherToolchain, diagnoseBuildFailure, sdkOf, emsdkOfBuild } from './emsdk.js';
import { ensureEmsdk } from './emsdk-provision.js';
import { CliError, log, color } from './ui.js';

// Docs and licence files travel with the module: the licences require it.
const ALWAYS_INCLUDE = ['README.md', 'README', 'CHANGELOG.md', 'NOTICE', 'PATENTS', ...LICENCE_FILES];

/* The manifest as the registry needs it: legacy keys mapped, defaults filled
 * in, and "main" pointing at the built module. "main" is optional: the default
 * build writes build/<name>_<abi>.wasm, an in-source build (the filter
 * repositories' README) writes it next to CMakeLists.txt; checkArtifact looks
 * in both places when "main" was not declared. */
/* Builds go under .bevara/, which filter repositories ignore in git, in a
 * dot-named subdirectory: the bevara-access editor lists every other
 * subdirectory of .bevara/ as one of its own compilation runs, and its "delete
 * all" removes them; it skips names starting with a dot. */
export const DEFAULT_BUILD_DIR = '.bevara/.build';
// Where a module built by hand is found when no -B is given: CMake's usual
// out-of-tree directory, then an in-source build (the repositories' READMEs).
const FALLBACK_BUILD_DIRS = ['build', '.'];

/* `buildDir` (relative to the project directory, like CMake's -B) is where the
 * default build writes and where a defaulted "main" is looked for. An explicit
 * "main" in the manifest always wins. */
/* What the manifest leaves out is read from where it already is:
 *
 *  - the generation (the _1 of libjxl_1.wasm) from "main" if it names the file,
 *    else from the add_filter() call in CMakeLists.txt, else from the single
 *    <module>_<N>.wasm the build produced;
 *  - the version, when absent, is that generation: "<N>.0.0". A "version" in
 *    the manifest still wins, for releases finer than a generation;
 *  - the file name keeps the spelling of add_filter() / "name" (libOpenVVC),
 *    while the package name is lowercase (bevara:libopenvvc);
 *  - the licence from the repository's licence file (license.js).
 *
 * `derived` records where each value came from, for the messages. */
export function filterManifest(project, { buildDir: requested } = {}) {
  const buildDir = requested ?? DEFAULT_BUILD_DIR;
  const m = fromLegacy(project.manifest);
  const derived = { notes: [] };
  const short = m.name ? shortName(String(m.name)) : null;

  if (m.name && /[A-Z]/.test(m.name)) {
    m.module ??= short;
    m.name = m.name.toLowerCase();
    derived.module = `"name" in ${project.manifestName}`;
  }
  // A runtime (a solver) is an add_executable(<name>_${VERSION}); a filter an add_filter().
  const runtime = m.kind === 'runtime';
  const call = short ? (runtime ? executableFor(project.root, short) : addFilterFor(project.root, short)) : null;
  const via = runtime ? 'add_executable' : 'add_filter';
  if (call?.name && short && call.name.toLowerCase() !== short.toLowerCase()) {
    derived.notes.push(`CMakeLists.txt builds ${call.name}_${call.rawGeneration ?? '?'}.wasm (${via}, line ${call.line}) but ${project.manifestName} names the ${runtime ? 'runtime' : 'filter'} "${short}"`);
  } else if (call?.name && !m.module && call.name !== short) {
    m.module = call.name;
    derived.module = `${via} in CMakeLists.txt, line ${call.line}`;
  }

  if (m.abi === undefined) {
    const fromMain = typeof m.main === 'string' ? /_(\d+)\.wasm$/.exec(m.main) : null;
    if (fromMain) { m.abi = parseInt(fromMain[1], 10); derived.generation = `"main" in ${project.manifestName}`; }
    else if (call?.generation != null) { m.abi = call.generation; derived.generation = `${via} in CMakeLists.txt, line ${call.line}`; }
    else {
      const built = builtGenerations(project.root, requested ? [buildDir, '.'] : [buildDir, ...FALLBACK_BUILD_DIRS], m.module ?? short);
      if (built.length === 1) { m.abi = built[0]; derived.generation = `the built module in ${buildDir}`; }
      else if (built.length > 1) derived.notes.push(`several generations built (${built.map((g) => `_${g}`).join(', ')}); set the generation in CMakeLists.txt`);
      if (call && call.generation == null && call.rawGeneration) derived.notes.push(`the generation in CMakeLists.txt is "${call.rawGeneration}", which the CLI cannot evaluate`);
    }
  }
  if (m.version === undefined && m.name) {
    m.version = `${m.abi ?? 1}.0.0`;
    derived.version = `generation ${m.abi ?? 1}`;
  }

  const lic = licenceFromRepository(project.root);
  if (m.license === undefined && lic) {
    m.license = lic.spdx;
    derived.license = `${path.basename(lic.file)}${lic.how === 'SPDX-License-Identifier' ? ' (SPDX-License-Identifier)' : ''}`;
    derived.notes.push(...lic.notes);
  } else if (m.license !== undefined && lic && lic.how !== 'fallback' && lic.spdx !== m.license) {
    derived.notes.push(`"license" in ${project.manifestName} (${m.license}) differs from ${path.basename(lic.file)} (${lic.spdx}); the manifest wins - better keep the licence in one place`);
  }

  // What the filters accept and produce, from their C source (caps.js); the
  // manifest's "runtime" completes what the source decides at run time.
  if (m.caps === undefined && Array.isArray(m.filters)) {
    const found = extractCaps(project.root, m);
    derived.capsReport = found;
    if (found.caps.length) {
      m.caps = found.caps;
      derived.caps = [...new Set(found.caps.map((c) => c.source))].join(', ');
      m.priority ??= Math.min(...found.caps.map((c) => c.priority));
    }
    for (const f of found.missing) derived.notes.push(`no GF_FilterRegister named "${f}" in the sources: its capabilities are not published`);
    for (const u of found.unresolved) {
      derived.notes.push(`${u.filter} sets ${u.property} from ${u.expression} at run time (${u.file}:${u.line}): declare the formats in "runtime" (bevara caps --write)`);
    }
    derived.notes.push(...found.notes.filter((x) => !/ registers it as /.test(x)));
  }
  if (runtime && m.builtins === undefined) {
    const builtins = runtimeBuiltins(project.root);
    if (builtins) { m.builtins = builtins; derived.builtins = 'loader.js'; }
  }
  if (m.projects === undefined) {
    if (typeof m.project === 'string') m.projects = [m.project];
    else { m.projects = projectsOf(project.root); derived.projects = m.projects.length > 1 ? 'the libraries in lib/' : 'no third-party library in lib/'; }
  }
  m.language ??= 'wasm';

  const n = normalizeManifest(m);
  if (!n.main && n.name) {
    n.main = path.join(buildDir, accessorFileName(n.name, n.abi, n.module));
    n.mainDefaulted = true;
    // With -B the user named the directory; otherwise hand-made builds count too.
    n.mainCandidates = [buildDir, ...(requested ? ['.'] : FALLBACK_BUILD_DIRS)].map((d) => path.join(d, path.basename(n.main)));
  }
  n.derived = derived;
  return n;
}

// Generations of <module>_<N>.wasm present in the given directories.
function builtGenerations(root, dirs, module) {
  if (!module) return [];
  const re = new RegExp(`^${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)\\.wasm$`, 'i');
  const found = new Set();
  for (const d of [...new Set(dirs.map((x) => path.resolve(root, x)))]) {
    let entries = [];
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const f of entries) { const g = re.exec(f); if (g) found.add(parseInt(g[1], 10)); }
  }
  return [...found].sort((a, b) => a - b);
}

export function checkFilterManifest(project, { buildDir } = {}) {
  const file = project.manifestName;
  const m = filterManifest(project, { buildDir });
  for (const note of m.derived.notes) log.warn(note);
  m.derived.notesShown = m.derived.notes.length;      // packFilter shows the ones it adds
  const { errors, warnings } = validateManifest(m, { forPublish: true });
  if (errors.length) throw new CliError(`${file} is invalid:\n  - ${errors.join('\n  - ')}`);
  for (const w of warnings) log.warn(`${file}: ${w}`);
  project.manifestWarnings = warnings;     // the registry repeats them; publish shows each once
  return m;
}

export const defaultBuildCommand = (dir = DEFAULT_BUILD_DIR) => {
  const q = /^[\w./-]+$/.test(dir) ? dir : JSON.stringify(dir);
  return `emcmake cmake -S . -B ${q} && cmake --build ${q}`;
};

/* A custom "scripts.build" receives the build directory as BEVARA_BUILD_DIR,
 * so it can honour --build-dir too. */
export async function buildFilter(project, { script, buildDir, yes = false } = {}) {
  const m = project.manifest;
  const custom = script ?? m.scripts?.build;
  const dir = buildDir ?? DEFAULT_BUILD_DIR;
  const cmd = custom ?? defaultBuildCommand(buildDir);
  if (custom && buildDir && !/BEVARA_BUILD_DIR/.test(custom)) {
    log.warn(`--build-dir only reaches a custom build command through $BEVARA_BUILD_DIR, which "${custom}" does not use`);
  }

  // The SDK the repository pins (third_parties/emsdk_vers.txt): the active one
  // if it is that one, else offered for download (emsdk-provision.js).
  // A custom build command may bring its own toolchain: without an SDK it runs as is.
  let sdk;
  try { sdk = await ensureEmsdk(project.root, { yes }); }
  catch (e) {
    if (!custom || !(e instanceof CliError)) throw e;
    log.warn(`no Emscripten SDK: running "${custom}" as it is`);
    sdk = { env: process.env, version: null, source: 'none' };
  }
  const active = activeEmsdk(sdk.env);
  const expected = expectedEmsdk(project.root);
  if (!custom) {
    warnIfTracked(project.root, dir);
    // A build directory configured by another SDK keeps loading that SDK's toolchain.
    const reset = active && resetIfOtherToolchain(path.resolve(project.root, dir), active.toolchain);
    if (reset) log.step(`${dir} was configured with ${reset.from}; reconfiguring it for ${reset.to}`);
  }

  log.step(`build: ${color.dim(cmd)}${project.root !== process.cwd() ? color.dim(`  (in ${path.relative(process.cwd(), project.root) || '.'})`) : ''}`);
  // Shown as it runs, and kept (the end of it) to explain a failure.
  const tail = [];
  const keep = (chunk) => { tail.push(String(chunk)); if (tail.length > 400) tail.splice(0, tail.length - 400); };
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, { cwd: project.root, shell: true, env: { ...sdk.env, BEVARA_BUILD_DIR: dir }, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { process.stdout.write(d); keep(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); keep(d); });
    child.on('error', () => resolve(127));
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    const why = diagnoseBuildFailure(tail.join(''), { active, expected });
    throw new CliError(`build failed (exit ${code})`, {
      hint: why ?? (active ? 'see the compiler output above' : 'is the Emscripten SDK activated? (source <emsdk>/emsdk_env.sh)'),
    });
  }
}

export function checkArtifact(project, m) {
  const candidates = m.mainDefaulted ? m.mainCandidates : [m.main];
  const hit = candidates.find((c) => fs.existsSync(path.resolve(project.root, c)));
  if (!hit) {
    throw new CliError(`built module not found: ${path.basename(m.main)}`, {
      hint: m.mainDefaulted
        ? `looked for ${candidates.join(', ')} in ${project.root}; run \`bevara build\` (or \`bevara publish --build\`), pass --build-dir, or set "main" in ${project.manifestName}`
        : `"main" in ${project.manifestName} is ${m.main}; run \`bevara build\` first, or \`bevara publish --build\``,
    });
  }
  m.main = path.normalize(hit);
  const file = path.resolve(project.root, hit);
  const buf = fs.readFileSync(file);
  const info = inspectWasm(buf);
  if (!info.valid) throw new CliError(`${m.main}: ${info.error}`);
  if (!info.sideModule) throw new CliError(`${m.main} is not an Emscripten side module (no dylink section)`, { hint: 'link with -sSIDE_MODULE=2 (see the generated filters.cmake)' });
  // A runtime's JavaScript loads its .wasm: they are built, and shipped, together.
  let js = null;
  if (m.kind === 'runtime') {
    const jsFile = file.replace(/\.wasm$/, '.js');
    if (!fs.existsSync(jsFile)) throw new CliError(`${path.basename(jsFile)} not found next to ${m.main}`, { hint: 'a runtime is built as <name>_<N>.js and <name>_<N>.wasm (-sMODULARIZE): rebuild it' });
    js = fs.readFileSync(jsFile);
  }
  return { file, buf, info, js };
}

// Creates <name>-<version>.tgz with the npm-style "package/" prefix:
//   package/bevara.json, package/<name>_<abi>.wasm, docs and "files" entries.
export async function packFilter(project, { outDir = project.root, dryRun = false, buildDir } = {}) {
  const m = checkFilterManifest(project, { buildDir });
  const { buf, js, file } = checkArtifact(project, m);
  // The SDK it was built with, from the build directory it was found in.
  if (m.emsdk === undefined) {
    const built = emsdkOfBuild(path.dirname(file));
    if (built) {
      m.emsdk = built.version;
      m.derived.emsdk = `the CMake configuration of ${path.relative(project.root, path.dirname(file)) || '.'}`;
      const expected = expectedEmsdk(project.root);
      if (expected && expected.version !== built.version) m.derived.notes.push(`built with emsdk ${built.version}, but the repository pins ${expected.version} (${expected.file})`);
    }
  }
  const stageRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bevara-pack-'));
  const stage = path.join(stageRoot, 'package');
  fs.mkdirSync(stage);
  const entries = [];
  const add = (rel, data) => { const dest = path.join(stage, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data); entries.push({ path: `package/${rel}`, size: data.length }); };

  // Build-time keys and legacy aliases stay out of the published manifest.
  // "runtime" is folded into "caps"; "project" into "projects".
  const { main, mainDefaulted, mainCandidates, derived, scripts, accessorsDir, registry, Format, runtime, project: _project, ...published } = m;
  for (const n of derived.notes.slice(derived.notesShown ?? 0)) log.warn(n);
  add('bevara.json', Buffer.from(JSON.stringify(published, null, 2) + '\n'));
  add(accessorFileName(m.name, m.abi, m.module), buf);
  if (js) add(accessorFileName(m.name, m.abi, m.module).replace(/\.wasm$/, '.js'), js);
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
  return { manifest: m, tgzPath, tgzName, entries, size: dryRun ? null : fs.statSync(tgzPath).size, wasmBuffer: buf, jsBuffer: js };
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}


/* A build directory git would track turns every build into untracked noise.
 * Said once, at build time; nothing is changed in .gitignore. */
function warnIfTracked(root, dir) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: root, stdio: 'ignore' });
  } catch { return; }                                  // not a git repository
  try {
    execSync(`git check-ignore -q ${JSON.stringify(path.join(dir, 'probe'))}`, { cwd: root, stdio: 'ignore' });
  } catch {
    const top = dir.split(/[\\/]/)[0];
    log.warn(`${dir}/ is not ignored by git in this repository: add "${top}/" to .gitignore`);
  }
}
