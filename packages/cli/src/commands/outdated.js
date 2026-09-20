import semver from 'semver';
import { log, color, table } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { pickVersion } from '../lib/resolve.js';

export async function run({ opts }) {
  const project = Project.load();
  const { client } = clientFor(opts, project);
  const rows = [];
  for (const [name, entry] of Object.entries(project.lock.filters)) {
    const p = await client.packument(name).catch(() => null);
    if (!p) { rows.push([name, entry.version, color.red('missing on registry'), '', '']); continue; }
    const range = project.manifest.dependencies?.[name] ?? '*';
    const wanted = pickVersion(p, range === 'latest' ? '*' : range) ?? entry.version;
    const latest = p['dist-tags'].latest;
    if (wanted === entry.version && latest === entry.version) continue;
    rows.push([color.bold(name), entry.version, wanted === entry.version ? color.dim(wanted) : color.green(wanted), latest === entry.version ? color.dim(latest) : color.magenta(latest), color.dim(range)]);
  }
  if (opts.json) return console.log(JSON.stringify(rows.map(([n, c, w, l, r]) => ({ name: n, current: c, wanted: w, latest: l, range: r })), null, 2));
  if (!rows.length) return log.ok('all filters are up to date');
  console.log(table(rows, { header: ['Filter', 'Current', 'Wanted', 'Latest', 'Range'].map(color.bold) }));
  console.log(color.dim('\n"Wanted" respects bevara.json ranges (bevara update); "Latest" needs bevara update --latest'));
}

export { semver };
