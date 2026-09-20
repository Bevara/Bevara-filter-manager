import fs from 'node:fs';
import { log, color, table, formatBytes, confirm } from '../lib/ui.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';
import { packFilter, buildFilter } from '../lib/pack.js';
import { RegistryError } from '../lib/registry-client.js';

export const options = { build: { type: 'boolean', short: 'b' }, 'dry-run': { type: 'boolean' }, tag: { type: 'string' } };
export const help = `Packs the filter in the current directory (bevara.json + the built .wasm + docs) and
uploads it. The registry validates the manifest and checks that the module is an
Emscripten side module before accepting it. Versions are immutable: bump "version"
in bevara.json to publish again.
Options:
  -b, --build    run the build before packing
  --dry-run      pack and validate, do not upload
  -y, --yes      do not ask for confirmation`;

export async function run({ opts }) {
  const project = Project.load();
  const { registry, client } = clientFor(opts, project);
  if (!opts['dry-run']) requireLogin(client);
  if (opts.build) buildFilter(project);
  const r = await packFilter(project);
  const m = r.manifest;
  console.log(`${color.bold(m.name)}@${color.green(m.version)} → ${color.dim(registry)}`);
  console.log(table(r.entries.map((e) => [color.dim(e.path), formatBytes(e.size)]), { indent: '  ' }));
  console.log(`  ${color.dim('tarball')} ${formatBytes(r.size)}`);
  try {
    if (opts['dry-run']) return log.ok('dry run: nothing uploaded');
    if (!opts.yes && process.stdin.isTTY && !(await confirm(`publish ${m.name}@${m.version}?`, true))) return log.info('aborted');
    let res;
    try {
      res = await client.put(`/filters/${encodeURIComponent(m.name)}/${encodeURIComponent(m.version)}`, fs.readFileSync(r.tgzPath), { headers: { 'content-type': 'application/gzip' } });
    } catch (e) {
      if (e instanceof RegistryError && e.status === 409) e.hint = 'bump "version" in bevara.json';
      if (e instanceof RegistryError && e.status === 401) e.hint = 'run `bevara login`';
      throw e;
    }
    for (const w of res.warnings ?? []) log.warn(w);
    log.ok(`published ${color.bold(`${res.name}@${res.version}`)}`);
    log.info(color.dim(`  ${res.dist.wasm}\n  with="${res.dist.file.replace(/\.wasm$/, '')}"`));
  } finally {
    fs.rmSync(r.tgzPath, { force: true });
  }
}
