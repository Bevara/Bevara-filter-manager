import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, formatBytes, confirm, progress, CliError } from '../lib/ui.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';
import { createHash } from 'node:crypto';
import { packFilter, buildFilter } from '../lib/pack.js';
import { RegistryError, assertRegistryVersion } from '../lib/registry-client.js';
import { ensureKey } from './key.js';
import { signRecord, canonicalize } from '../lib/sig.js';
import { accessorFileName, inspectWasm } from '../lib/wasm.js';
import { solverDir } from '../lib/solvers.js';

export const options = { build: { type: 'boolean', short: 'b' }, 'build-dir': { type: 'string', short: 'B' }, 'dry-run': { type: 'boolean' }, tag: { type: 'string' }, 'no-sign': { type: 'boolean' } };
export const help = `Packs the filter in the current directory - its manifest (libjxl.json in the
libjxl repository), the built .wasm and docs - and uploads it. The registry
validates the manifest and checks that the module is an Emscripten side module
before accepting it. Versions are immutable: bump "version" in the manifest to
publish again.
The upload is signed with your Ed25519 key (generated on first use, see \`bevara key\`);
the registry verifies the signature and appends the record to its append-only log.
Options:
  -b, --build    run the build before packing
  --dry-run      pack and validate, do not upload
  --no-sign      upload unsigned (only if the registry allows it)
  -y, --yes      do not ask for confirmation
Arguments:
  [dir]                    the filter repository (default: the current directory or
                           the nearest parent holding a manifest)
  -B, --build-dir <dir>    build directory, relative to the repository like CMake's -B
                           (default: .bevara/.build). Where --build writes, and where the
                           module is looked for unless "main" names it - without -B,
                           build/ and the repository root are looked in too. A custom
                           "scripts.build" receives it as $BEVARA_BUILD_DIR.

Examples:
  bevara publish --build
  bevara publish ../libjxl --build
  bevara publish --build -B out             builds into out/ instead of .bevara/.build/`;

export async function run({ args, opts }) {
  if (args.length > 1) throw new CliError('publish takes one directory at most', { hint: 'publish each filter repository separately' });
  const project = Project.load({ dir: args[0] });
  const buildDir = opts['build-dir'];
  const { registry, client } = clientFor(opts, project);
  if (!opts['dry-run']) {
    requireLogin(client);
    // Before building: a registry that cannot take the upload makes the build pointless.
    assertRegistryVersion(await client.ping(), registry);
  }
  // At least one runtime "using" names must be published: the registry refuses
  // the upload otherwise, so say it before building. The others only warn.
  const using = ['runtime', 'tags'].includes(project.manifest.kind) ? [] : project.manifest.using ?? [];
  if (using.length) {
    let runtimes = null;
    try { runtimes = (await client.get('/accessors/index.json', { auth: false })).runtimes ?? null; } catch { /* checked by the registry at upload */ }
    if (runtimes) {
      const missing = using.filter((u) => !runtimes.some((r) => r.module === u));
      const hint = `publish a runtime first: bevara publish --build in its directory (Editor/Interface/player/${solverDir(missing[0])}); published runtimes: ${runtimes.map((r) => r.module).join(', ') || 'none'}`;
      if (missing.length === using.length) {
        const e = new CliError(`none of the runtimes in "using" (${using.join(', ')}) is published on ${registry}`, { hint });
        if (!opts['dry-run']) throw e;
        log.warn(`${e.message} - the upload would be refused`);
      } else if (missing.length) log.warn(`"using" names ${missing.join(', ')}, not published on ${registry}: pages using ${missing.length > 1 ? 'them' : 'it'} cannot load this accessor from there`);
    }
  }
  if (opts.build) await buildFilter(project, { buildDir, yes: opts.yes });
  const r = await packFilter(project, { buildDir });
  const m = r.manifest;
  console.log(`${color.bold(m.name)}@${color.green(m.version)} → ${color.dim(registry)}  ${color.dim(`(${path.relative(process.cwd(), project.manifestFile) || project.manifestName})`)}`);
  if (m.derived?.version) console.log(color.dim(`  version ${m.version} = generation ${m.abi}, from ${m.derived.generation ?? 'the default'}`));
  console.log(color.dim(m.kind === 'tags' ? `  scripts ${m.tags.join(', ')} from ${m.main}` : `  module ${m.main}`));
  if (m.derived?.license) console.log(color.dim(`  licence ${m.license}, from ${m.derived.license}`));
  if (m.derived?.caps) console.log(color.dim(`  capabilities of ${m.caps.map((c) => `${c.filter} (priority ${c.priority})`).join(', ')}, from ${m.derived.caps}`));
  if (m.derived?.projects) console.log(color.dim(`  projects ${m.projects.join(', ')}, from ${m.derived.projects}`));
  if (m.derived?.builtins) console.log(color.dim(`  runtime with built-in filters ${m.builtins.join(', ')}, from ${m.derived.builtins}`));
  if (m.emsdk) console.log(color.dim(`  built with emsdk ${m.emsdk}, from ${m.derived?.emsdk ?? '"emsdk" in the manifest'}`));
  else if (m.kind !== 'tags') log.warn('the Emscripten version of this build is unknown (no CMake configuration next to the module): it is published without "emsdk"');
  console.log(table(r.entries.map((e) => [color.dim(e.path), formatBytes(e.size)]), { indent: '  ' }));
  console.log(`  ${color.dim('tarball')} ${formatBytes(r.size)}`);
  try {
    if (opts['dry-run']) return log.ok('dry run: nothing uploaded');
    if (!opts.yes && process.stdin.isTTY && !(await confirm(`publish ${m.name}@${m.version}?`, true))) return log.info('aborted');
    const info = await client.ping();
    assertRegistryVersion(info, registry);
    const fullName = m.name.includes(':') ? m.name : `${info.defaultNamespace}:${m.name}`;
    const tarball = fs.readFileSync(r.tgzPath);
    const headers = { 'content-type': 'application/gzip' };
    if (!opts['no-sign']) {
      // Registering is idempotent: it also repairs a key the registry no longer
      // knows (a reset database, another registry behind the same URL).
      const key = await ensureKey(client, registry);
      const wasmFile = m.kind === 'tags' ? m.tags[0] : accessorFileName(m.name, m.abi, m.module, m.kind === 'runtime' ? m.version : undefined);
      const record = {
        type: 'publish', name: fullName, version: m.version, abi: m.abi, file: wasmFile,
        wasmSha256: createHash('sha256').update(r.wasmBuffer).digest('hex'),
        tarballSha256: createHash('sha256').update(tarball).digest('hex'),
        ...(r.jsBuffer ? { jsSha256: createHash('sha256').update(r.jsBuffer).digest('hex') } : {}),
        ...(r.scripts ? { tagsSha256: Object.fromEntries(r.scripts.map((x) => [x.file, createHash('sha256').update(x.data).digest('hex')])) } : {}),
        keyId: key.keyId, timestamp: new Date().toISOString(),
      };
      headers['x-bevara-record'] = Buffer.from(canonicalize(record)).toString('base64');
      headers['x-bevara-signature'] = signRecord(record, key.privateKey);
    } else if (info.requireSignatures) log.warn('this registry requires signatures; the upload will be refused');
    let res;
    const bar = progress(`upload ${formatBytes(tarball.length)}`);
    try {
      res = await client.put(`/filters/${encodeURIComponent(fullName)}/${encodeURIComponent(m.version)}`, tarball, { headers, onProgress: bar.update });
      bar.done();
    } catch (e) {
      bar.fail();
      // 409 covers two different conflicts: only a version clash is fixed by bumping it.
      if (e instanceof RegistryError && e.status === 409 && /already published/.test(e.message)) {
        e.hint = m.derived?.version
          ? `increment the generation (the last argument of add_filter in CMakeLists.txt, _${m.abi} -> _${m.abi + 1}), or set "version" in ${project.manifestName} for a release within generation ${m.abi}`
          : `bump "version" in ${project.manifestName}`;
      }
      if (e instanceof RegistryError && e.status === 401) e.hint = 'run `bevara login`';
      if (e instanceof RegistryError && /signing key/.test(e.message)) e.hint = /revoked|another user/.test(e.message) ? 'run `bevara key generate --force`' : 'run `bevara key register`';
      throw e;
    }
    for (const w of res.warnings ?? []) if (!(project.manifestWarnings ?? []).includes(w)) log.warn(w);
    log.ok(`published ${color.bold(`${res.name}@${res.version}`)}${res.signature ? color.dim(` · signed ${res.signature.keyId} · log #${res.signature.logSeq}`) : color.yellow(' (unsigned)')}`);
    log.info(color.dim(`  ${res.dist.wasm}\n  with="${res.dist.file.replace(/\.wasm$/, '')}"`));
  } finally {
    fs.rmSync(r.tgzPath, { force: true });
  }
}
