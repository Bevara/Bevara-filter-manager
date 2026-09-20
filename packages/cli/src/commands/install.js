import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { log, color, table } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { parseSpec, resolveTree, installResolved } from '../lib/resolve.js';
import { MANIFEST } from '../lib/project.js';

export const options = {
  'no-save': { type: 'boolean' },
  exact: { type: 'boolean', short: 'E' },
  dir: { type: 'string', short: 'd' },
};

export const help = `Examples:
  bevara install                    install everything listed in ${MANIFEST} (honours bevara-lock.json)
  bevara install theora ogg         add filters to the project and install them
  bevara install theora@^1.2        with a semver range
  bevara install theora -E          pin the exact version in ${MANIFEST}
Options:
  -d, --dir <path>   accessors directory (default: "accessorsDir" in ${MANIFEST}, or ./accessors)
  --no-save          do not record the filters in ${MANIFEST}`;

export async function run({ args, opts }) {
  let project = Project.load({ required: false });
  if (!fs.existsSync(path.join(project.root, MANIFEST))) {
    if (!args.length) { log.warn(`no ${MANIFEST} here and nothing to install`); return; }
    project = Project.create(process.cwd(), { name: path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9._-]/g, '-'), accessorsDir: opts.dir ?? 'accessors', dependencies: {} });
    log.step(`created ${MANIFEST}`);
  }
  if (opts.dir) project.manifest.accessorsDir = opts.dir;
  const { registry, client } = clientFor(opts, project);

  const roots = { ...(project.manifest.dependencies ?? {}) };
  const specs = args.map(parseSpec);
  for (const { name, range } of specs) roots[name] = range;

  log.step(`resolving against ${color.dim(registry)}`);
  const chosen = await resolveTree(client, roots, { lock: project.lock.filters, prefer: specs.length ? 'lock' : 'lock' });

  // Record requested filters in bevara.json with a caret range (or exact with -E).
  if (specs.length && !opts['no-save']) {
    project.manifest.dependencies ??= {};
    for (const { name, range } of specs) {
      const v = chosen.get(name).version;
      project.manifest.dependencies[name] = opts.exact ? v : range === 'latest' ? `^${v}` : range;
    }
    project.saveManifest();
  }

  const installed = await installResolved(client, project, chosen, { registry });
  const rel = path.relative(process.cwd(), project.accessorsDir) || '.';
  if (installed.length) {
    log.info(table(installed.map((i) => [color.green('+'), color.bold(i.name), i.from && i.from !== i.version ? `${i.from} → ${i.version}` : i.version, color.dim(chosen.get(i.name).doc.dist.file)])));
  }
  log.ok(`${chosen.size} filter${chosen.size === 1 ? '' : 's'} in ${color.bold(rel + '/')} (${installed.length} downloaded)`);
  if (chosen.size) {
    const withAttr = [...chosen.values()].map((c) => c.doc.dist.file.replace(/\.wasm$/, '')).join(';');
    log.info(color.dim(`  with="${withAttr}"`));
  }
  if (opts.json) console.log(JSON.stringify(Object.fromEntries([...chosen].map(([n, c]) => [n, c.version])), null, 2));
}

export { semver };
