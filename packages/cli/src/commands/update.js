import semver from 'semver';
import { log, color, table } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { resolveTree, installResolved } from '../lib/resolve.js';

export const options = { latest: { type: 'boolean', short: 'L' } };
export const help = `Options:
  -L, --latest   ignore the ranges in the manifest and move to the latest published versions (rewrites them)
Examples:
  bevara update            update all filters within their ranges
  bevara update theora     update one filter`;

export async function run({ args, opts }) {
  const project = Project.load();
  const { registry, client } = clientFor(opts, project);
  const deps = { ...(project.manifest.dependencies ?? {}) };
  if (opts.latest) for (const n of Object.keys(deps)) if (!args.length || args.includes(n)) deps[n] = 'latest';
  // Keep the lock for filters not being updated, re-resolve the others freshly.
  const lock = {};
  for (const [n, e] of Object.entries(project.lock.filters)) if (args.length && !args.includes(n)) lock[n] = e;
  const before = Object.fromEntries(Object.entries(project.lock.filters).map(([n, e]) => [n, e.version]));
  const chosen = await resolveTree(client, deps, { lock, prefer: 'lock' });
  if (opts.latest) {
    for (const [n, c] of chosen) if (deps[n] === 'latest') project.manifest.dependencies[n] = `^${c.version}`;
    project.saveManifest();
  }
  const installed = await installResolved(client, project, chosen, { registry });
  const changed = [...chosen].filter(([n, c]) => before[n] !== c.version);
  const repaired = installed.filter((i) => before[i.name] === i.version).map((i) => i.name);
  if (repaired.length) log.ok(`re-downloaded ${repaired.map((n) => color.bold(n)).join(', ')}`);
  if (!changed.length) return log.ok(repaired.length ? 'versions unchanged' : 'everything is up to date');
  log.info(table(changed.map(([n, c]) => [color.bold(n), before[n] ?? color.dim('new'), '→', color.green(c.version), semver.diff(before[n] ?? c.version, c.version) ?? ''])));
  log.ok(`updated ${changed.length} filter${changed.length === 1 ? '' : 's'}`);
}
