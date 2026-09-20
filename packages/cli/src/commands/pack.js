import { log, color, table, formatBytes } from '../lib/ui.js';
import { Project } from '../lib/ctx.js';
import { packFilter, buildFilter } from '../lib/pack.js';

export const options = { build: { type: 'boolean', short: 'b' }, 'dry-run': { type: 'boolean' } };
export const help = `Options:
  -b, --build    run the build first
  --dry-run      only list what would be packed`;

export async function run({ opts }) {
  const project = Project.load();
  if (opts.build) buildFilter(project);
  const r = await packFilter(project, { dryRun: opts['dry-run'] });
  console.log(table(r.entries.map((e) => [color.dim(e.path), formatBytes(e.size)])));
  if (opts['dry-run']) return log.ok(`${r.manifest.name}@${r.manifest.version}: ${r.entries.length} files (dry run)`);
  log.ok(`${color.bold(r.tgzName)} (${formatBytes(r.size)})`);
}
