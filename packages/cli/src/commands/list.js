import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, formatBytes } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';

export const options = { remote: { type: 'boolean', short: 'a' }, support: { type: 'string' }, format: { type: 'string' }, long: { type: 'boolean', short: 'l' } };
export const help = `Without arguments lists the filters installed in the current project. Outside a
project (or with --remote) lists every filter published on the registry.
Options:
  -a, --remote            list the registry catalog
  -l, --long              show more columns
  --support <kind>        registry only: filter by media kind (image, audio, video…)
  --format <name>         registry only: filter by handled format (e.g. Theora)`;

export async function run({ opts }) {
  const project = Project.load({ required: false });
  const inProject = !!project.manifestFile && !project.isFilter;
  if (!opts.remote && inProject) return listInstalled(project, opts);
  return listRemote(project, opts);
}

function listInstalled(project, opts) {
  const entries = Object.entries(project.lock.filters);
  if (opts.json) return console.log(JSON.stringify(project.lock.filters, null, 2));
  const rel = path.relative(process.cwd(), project.accessorsDir) || '.';
  if (!entries.length) return log.info(`no filters installed in ${rel}/ ${color.dim('(bevara install <filter>)')}`);
  const direct = new Set(Object.keys(project.manifest.dependencies ?? {}));
  console.log(`${color.bold(project.manifest.name ?? path.basename(project.root))} ${color.dim(project.root)}`);
  console.log(table(entries.map(([name, e]) => {
    const file = path.join(project.accessorsDir, e.file);
    const present = fs.existsSync(file);
    const row = [direct.has(name) ? color.bold(name) : color.dim(name), e.version, present ? color.dim(e.file) : color.red(`${e.file} missing`)];
    if (opts.long) row.push(present ? formatBytes(fs.statSync(file).size) : '', e.license ?? '', Object.keys(e.dependencies ?? {}).join(', '));
    return row;
  }), { indent: '  ' }));
  console.log(color.dim(`\n  with="${entries.map(([, e]) => e.file.replace(/\.wasm$/, '')).join(';')}"`));
}

async function listRemote(project, opts) {
  const { registry, client } = clientFor(opts, project);
  const params = { limit: 1000 };
  if (opts.support) params.support = opts.support;
  if (opts.format) params.format = opts.format;
  const { filters, total } = await client.search(params);
  if (opts.json) return console.log(JSON.stringify(filters, null, 2));
  if (!total) return log.info(`no filters published on ${registry} yet`);
  console.log(`${total} filter${total === 1 ? '' : 's'} on ${color.dim(registry)}\n`);
  const header = ['Filter', 'Version', 'Description', 'Formats', 'Support'];
  if (opts.long) header.push('Size', 'Brotli', 'License', 'Downloads');
  console.log(table(filters.map((f) => {
    const row = [f.deprecated ? color.yellow(f.name) : color.bold(f.name), f.latest ?? '', (f.description ?? '').slice(0, 60), (f.formats ?? []).join(','), (f.support ?? []).join(',')];
    if (opts.long) row.push(formatBytes(f.size), formatBytes(f.brSize), (f.license ?? '') + (f.licence_required ? '*' : ''), String(f.downloads));
    return row;
  }), { header: header.map(color.bold) }));
  if (filters.some((f) => f.deprecated)) console.log(color.dim('\nyellow = deprecated'));
}
