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
  if (opts.build) await buildFilter(project, { buildDir });
  const r = await packFilter(project, { buildDir });
  const m = r.manifest;
  console.log(`${color.bold(m.name)}@${color.green(m.version)} → ${color.dim(registry)}  ${color.dim(`(${path.relative(process.cwd(), project.manifestFile) || project.manifestName})`)}`);
  if (m.derived?.version) console.log(color.dim(`  version ${m.version} = generation ${m.abi}, from ${m.derived.generation ?? 'the default'}`));
  console.log(color.dim(`  module ${m.main}`));
  if (m.derived?.license) console.log(color.dim(`  licence ${m.license}, from ${m.derived.license}`));
  if (m.derived?.caps) console.log(color.dim(`  capabilities of ${m.caps.map((c) => `${c.filter} (priority ${c.priority})`).join(', ')}, from ${m.derived.caps}`));
  if (m.derived?.projects) console.log(color.dim(`  projects ${m.projects.join(', ')}, from ${m.derived.projects}`));
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
      const wasmFile = accessorFileName(m.name, m.abi, m.module);
      const record = {
        type: 'publish', name: fullName, version: m.version, abi: m.abi, file: wasmFile,
        wasmSha256: createHash('sha256').update(r.wasmBuffer).digest('hex'),
        tarballSha256: createHash('sha256').update(tarball).digest('hex'),
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
