import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { isRestricted } from '../lib/manifest.js';

// The patent status, yellow when users must be told.
const patentCell = (p) => (!p?.status ? color.dim('?') : isRestricted(p) ? color.yellow(p.status) : p.status);

export const options = { remote: { type: 'boolean', short: 'a' }, support: { type: 'string' }, format: { type: 'string' }, long: { type: 'boolean', short: 'l' } };
export const help = `bevara filters    the filters (accessors)
bevara runtimes   the runtimes (solvers) filters link against
bevara tags       the tag scripts (universal elements) pages load

In a site project, what is installed; outside one (or with --remote), what the
registry publishes. For filters, the "Runtimes" column is the filter's "using",
in red when the registry does not publish that runtime; for runtimes, the name
pages give in using="…", the GPAC filters the runtime registers itself and how
many filters link against it. "emsdk" is the Emscripten version each module was
built with, recorded at publish from its build directory.
Options:
  -a, --remote            list the registry catalog
  -l, --long              show more columns
  --support <kind>        registry only: filter by media kind (image, audio, video…)
  --format <name>         registry only: filter by handled format (e.g. Theora)`;

// bevara filters (also: list, ls)
export async function run({ args = [], opts }) {
  if (args.length) {
    throw new CliError(`bevara filters takes no argument (got ${args.join(' ')})`, { hint: /^runtimes?$/i.test(args[0]) ? 'the runtimes are listed by `bevara runtimes`' : 'bevara filters lists the filters, bevara runtimes the runtimes' });
  }
  return listWhat(opts, 'filters');
}

// bevara tags
export async function tags({ args = [], opts }) {
  if (args.length) throw new CliError('bevara tags takes no argument');
  return listWhat(opts, 'tags');
}

// bevara runtimes
export async function runtimes({ args = [], opts }) {
  if (args.length) throw new CliError('bevara runtimes takes no argument');
  return listWhat(opts, 'runtimes');
}

async function listWhat(opts, what) {
  const project = Project.load({ required: false });
  const inProject = !!project.manifestFile && !project.isFilter;
  if (!opts.remote && inProject) return listInstalled(project, opts, what);
  return listRemote(project, opts, what);
}

function listInstalled(project, opts, what) {
  const KIND = { filters: 'filter', runtimes: 'runtime', tags: 'tags' };
  const wanted = (e) => (e.kind ?? 'filter') === KIND[what];
  const entries = Object.entries(project.lock.filters).filter(([, e]) => wanted(e));
  if (opts.json) return console.log(JSON.stringify(Object.fromEntries(entries), null, 2));
  const rel = path.relative(process.cwd(), project.accessorsDir) || '.';
  const one = { filters: 'filter', runtimes: 'runtime', tags: 'tags package' }[what];
  if (!entries.length) return log.info(`no ${one} installed in ${rel}/ ${color.dim(`(bevara install <${one}>)`)}`);
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
    const row = [direct.has(name) ? color.bold(name) : color.dim(name), e.version, present ? color.dim(e.file) : color.red(`${e.file} missing`)];
    if (what === 'filters') row.push(using.join(', ') || color.yellow('no "using"'));
    else if (what === 'runtimes') row.push(e.jsFile && fs.existsSync(path.join(project.accessorsDir, e.jsFile)) ? color.dim(e.jsFile) : color.red(`${e.jsFile ?? 'its .js'} missing`));
    else row.push((e.files ?? []).map((f) => (fs.existsSync(path.join(project.accessorsDir, f.file)) ? color.dim(f.file) : color.red(`${f.file} missing`))).join(', '));
    if (what !== 'tags') row.push(e.emsdk ? `emsdk ${e.emsdk}` : color.dim('emsdk ?'));
    if (opts.long) row.push(present ? formatBytes(fs.statSync(file).size) : '', e.license ?? '', Object.keys(e.dependencies ?? {}).join(', '));
    return row;
  }), { indent: '  ' }));
  if (what !== 'filters') return;
  const accessors = entries;
  console.log(color.dim(`\n  with="${accessors.map(([, e]) => e.file.replace(/\.wasm$/, '')).join(';')}"`));
  // The page loads one solver: one that every installed filter links against.
  const lists = accessors.map(([name, e]) => usingOf(name, e)).filter((u) => u.length);
  const common = lists.length ? lists.reduce((a, b) => a.filter((x) => b.includes(x))) : [];
  if (common.length) console.log(color.dim(`  using="${common[0]}"${common.length > 1 ? `  (or ${common.slice(1).join(', ')})` : ''}`));
  else if (lists.length) log.warn('  no runtime is shared by every installed filter: they cannot all go in one element (one solver per page)');
}

async function listRemote(project, opts, what) {
  const { registry, client } = clientFor(opts, project);
  const params = { limit: 1000 };
  if (opts.support) params.support = opts.support;
  if (opts.format) params.format = opts.format;
  const { filters: all, total } = await client.search(params);
  const KIND = { filters: 'filter', runtimes: 'runtime', tags: 'tags' };
  if (opts.json) return console.log(JSON.stringify(all.filter((f) => (f.kind ?? 'filter') === KIND[what]), null, 2));
  if (!total) return log.info(`nothing published on ${registry} yet`);
  const runtimes = all.filter((f) => f.kind === 'runtime');
  const filters = all.filter((f) => (f.kind ?? 'filter') === 'filter');
  const tagPkgs = all.filter((f) => f.kind === 'tags');
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

  if (what === 'tags') {
    if (!known || !tagPkgs.length) return log.info(`no tags package published on ${registry} yet ${color.dim('(bevara publish --build in the player, which holds universal-tags.json)')}`);
    console.log(`${tagPkgs.length} tags package${tagPkgs.length === 1 ? '' : 's'} on ${color.dim(registry)}\n`);
    const theader = ['Package', 'Version', 'Scripts', 'Extends', 'Description'];
    if (opts.long) theader.push('License', 'Downloads');
    console.log(table(tagPkgs.map((t) => {
      const ext = Object.entries(t.extends ?? {}).map(([s, b]) => `${s.replace(/\.js$/, '')} ← ${b}`).join(', ');
      const row = [t.deprecated ? color.yellow(t.name) : color.bold(t.name), t.latest ?? '', (t.tags ?? []).map((x) => x.replace(/\.js$/, '')).join(', '), ext || color.dim('-'), (t.description ?? '').slice(0, 50)];
      if (opts.long) row.push(t.license ?? '', String(t.downloads));
      return row;
    }), { header: theader.map(color.bold), shrink: [2, 3, 4, 5] }));
    return;
  }
  if (what === 'runtimes') {
    if (!known) return log.info(`${registry} predates runtime packages: it lists none`);
    if (!runtimes.length) return log.info(`no runtime published on ${registry} yet ${color.dim('(bevara publish --build in a solver directory)')}`);
    console.log(`${runtimes.length} runtime${runtimes.length === 1 ? '' : 's'} on ${color.dim(registry)}\n`);
    const used = (r) => filters.filter((f) => f.using?.includes(`${r.name.split(':').pop()}_${r.abi ?? 1}`)).length;
    const rheader = ['Runtime', 'Version', 'using=', 'emsdk', 'Built-in filters', 'Used by'];
    if (opts.long) rheader.push('Size', 'Brotli', 'License', 'Downloads');
    console.log(table(runtimes.map((r) => {
      const row = [r.deprecated ? color.yellow(r.name) : color.bold(r.name), r.latest ?? '', `${r.name.split(':').pop()}_${r.abi ?? 1}`, r.emsdk ?? color.dim('?'), (r.builtins ?? []).join(','), `${used(r)} filter${used(r) === 1 ? '' : 's'}`];
      if (opts.long) row.push(formatBytes(r.size), formatBytes(r.brSize), r.license ?? '', String(r.downloads));
      return row;
    }), { header: rheader.map(color.bold), shrink: [4, 8] }));
    return;
  }

  console.log(`${filters.length} filter${filters.length === 1 ? '' : 's'} on ${color.dim(registry)}\n`);
  const header = ['Filter', 'Version', 'Description', 'Formats', 'Support', 'Runtimes', 'emsdk', 'Patents'];
  if (opts.long) header.push('Size', 'Brotli', 'License', 'Downloads');
  console.log(table(filters.map((f) => {
    const row = [f.deprecated ? color.yellow(f.name) : color.bold(f.name), f.latest ?? '', (f.description ?? '').slice(0, 60), (f.formats ?? []).join(','), (f.support ?? []).join(','), runtimeCell(f), f.emsdk ?? color.dim('?'), patentCell(f.patents)];
    if (opts.long) row.push(formatBytes(f.size), formatBytes(f.brSize), f.license ?? '', String(f.downloads));
    return row;
  }), { header: header.map(color.bold), shrink: [2, 3, 4, 5, 10] }));

  if (known && !runtimes.length) console.log(color.dim('\nno runtime published: filters cannot be loaded until one is (bevara publish --build in a solver directory)'));
  if (!known) console.log(color.dim('\nthis registry predates runtime packages: "Runtimes" is unknown'));
  const notes = [filters.some((f) => f.deprecated) && 'yellow = deprecated', known && filters.some((f) => f.using?.some((u) => !published.has(u))) && 'red = runtime not on this registry',
    known && filters.some((f) => f.using === undefined) && '? = "using" not published with it (republish it)',
    filters.some((f) => !f.emsdk) && 'emsdk ? = published before the version was recorded',
    filters.some((f) => isRestricted(f.patents)) && 'yellow patents: a licence may be required (bevara info <filter> says why)'].filter(Boolean);
  if (notes.length) console.log(color.dim(`\n${notes.join(' · ')}`));
}
