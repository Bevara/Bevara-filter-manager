import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, formatBytes } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';

export const options = { remote: { type: 'boolean', short: 'a' }, support: { type: 'string' }, format: { type: 'string' }, long: { type: 'boolean', short: 'l' } };
export const help = `Without arguments lists the filters installed in the current project. Outside a
project (or with --remote) lists every filter published on the registry, then
the runtimes (solvers) the filters link against - the "Runtimes" column is the
filter's "using", in red when that runtime is not on the registry.
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
  // "using" of each installed filter: from the lock, or (installed by an older
  // CLI) from the manifest copy next to the module.
  const usingOf = (name, e) => {
    if (e.kind === 'runtime') return null;
    if (Array.isArray(e.using)) return e.using;
    try { return JSON.parse(fs.readFileSync(path.join(project.accessorsDir, `${name.split(':').pop()}.json`), 'utf8')).using ?? []; } catch { return []; }
  };
  console.log(`${color.bold(project.manifest.name ?? path.basename(project.root))} ${color.dim(project.root)}`);
  console.log(table(entries.map(([name, e]) => {
    const file = path.join(project.accessorsDir, e.file);
    const present = fs.existsSync(file);
    const using = usingOf(name, e);
    const row = [direct.has(name) ? color.bold(name) : color.dim(name), e.version, present ? color.dim(e.file) : color.red(`${e.file} missing`),
      using ? (using.join(', ') || color.yellow('no "using"')) : color.cyan('runtime')];
    if (opts.long) row.push(present ? formatBytes(fs.statSync(file).size) : '', e.license ?? '', Object.keys(e.dependencies ?? {}).join(', '));
    return row;
  }), { indent: '  ' }));
  const accessors = entries.filter(([, e]) => e.kind !== 'runtime');
  console.log(color.dim(`\n  with="${accessors.map(([, e]) => e.file.replace(/\.wasm$/, '')).join(';')}"`));
  // The page loads one solver: one that every installed filter links against.
  const lists = accessors.map(([name, e]) => usingOf(name, e)).filter((u) => u.length);
  const common = lists.length ? lists.reduce((a, b) => a.filter((x) => b.includes(x))) : [];
  if (common.length) console.log(color.dim(`  using="${common[0]}"${common.length > 1 ? `  (or ${common.slice(1).join(', ')})` : ''}`));
  else if (lists.length) log.warn('  no runtime is shared by every installed filter: they cannot all go in one element (one solver per page)');
}

async function listRemote(project, opts) {
  const { registry, client } = clientFor(opts, project);
  const params = { limit: 1000 };
  if (opts.support) params.support = opts.support;
  if (opts.format) params.format = opts.format;
  const { filters: all, total } = await client.search(params);
  if (opts.json) return console.log(JSON.stringify(all, null, 2));
  if (!total) return log.info(`no filters published on ${registry} yet`);
  const runtimes = all.filter((f) => f.kind === 'runtime');
  const filters = all.filter((f) => f.kind !== 'runtime');
  // A registry older than runtime packages lists no "kind" nor "using".
  const known = all.some((f) => f.kind);
  const published = new Set(runtimes.map((r) => `${r.name.split(':').pop()}_${r.abi ?? 1}`));
  // A registry that lists "kind" but not "using" in /filters has it in its index.
  if (known && filters.some((f) => f.using === undefined)) {
    try {
      const idx = await client.get('/accessors/index.json', { auth: false });
      const by = new Map((idx.filters ?? []).map((e) => [e.name, e.using]));
      for (const f of filters) if (f.using === undefined) f.using = by.get(f.name);
    } catch { /* shown as unknown */ }
  }
  const runtimeCell = (f) => {
    if (!known || f.using === undefined) return color.dim('?');
    if (!f.using?.length) return color.yellow('none');
    return f.using.map((u) => (published.has(u) ? u : color.red(u))).join(', ');
  };

  console.log(`${filters.length} filter${filters.length === 1 ? '' : 's'} on ${color.dim(registry)}\n`);
  const header = ['Filter', 'Version', 'Description', 'Formats', 'Support', 'Runtimes'];
  if (opts.long) header.push('Size', 'Brotli', 'License', 'Downloads');
  console.log(table(filters.map((f) => {
    const row = [f.deprecated ? color.yellow(f.name) : color.bold(f.name), f.latest ?? '', (f.description ?? '').slice(0, 60), (f.formats ?? []).join(','), (f.support ?? []).join(','), runtimeCell(f)];
    if (opts.long) row.push(formatBytes(f.size), formatBytes(f.brSize), (f.license ?? '') + (f.licence_required ? '*' : ''), String(f.downloads));
    return row;
  }), { header: header.map(color.bold) }));

  if (runtimes.length) {
    console.log(`\n${runtimes.length} runtime${runtimes.length === 1 ? '' : 's'}\n`);
    const used = (r) => filters.filter((f) => f.using?.includes(`${r.name.split(':').pop()}_${r.abi ?? 1}`)).length;
    const rheader = ['Runtime', 'Version', 'using=', 'Built-in filters', 'Used by'];
    if (opts.long) rheader.push('Size', 'Brotli', 'License', 'Downloads');
    console.log(table(runtimes.map((r) => {
      const row = [r.deprecated ? color.yellow(r.name) : color.bold(r.name), r.latest ?? '', `${r.name.split(':').pop()}_${r.abi ?? 1}`, (r.builtins ?? []).join(','), `${used(r)} filter${used(r) === 1 ? '' : 's'}`];
      if (opts.long) row.push(formatBytes(r.size), formatBytes(r.brSize), r.license ?? '', String(r.downloads));
      return row;
    }), { header: rheader.map(color.bold) }));
  } else if (known) console.log(color.dim('\nno runtime published: filters cannot be loaded until one is (bevara publish --build in a solver directory)'));
  if (!known) console.log(color.dim('\nthis registry predates runtime packages: "Runtimes" is unknown'));
  const notes = [filters.some((f) => f.deprecated) && 'yellow = deprecated', known && filters.some((f) => f.using?.some((u) => !published.has(u))) && 'red = runtime not on this registry',
    known && filters.some((f) => f.using === undefined) && '? = "using" not published with it (republish it)'].filter(Boolean);
  if (notes.length) console.log(color.dim(`\n${notes.join(' · ')}`));
}
