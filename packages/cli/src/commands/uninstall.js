import { log, color, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { resolveTree, installResolved } from '../lib/resolve.js';

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara uninstall <filter...>');
  const project = Project.load();
  const { registry, client } = clientFor(opts, project);
  project.manifest.dependencies ??= {};
  for (const name of args) {
    // accept the canonical name or the bare alias
    const key = Object.keys(project.manifest.dependencies).find((k) => k === name || k.endsWith(`:${name}`) || name.endsWith(`:${k}`));
    if (!key) log.warn(`${name} is not a direct dependency`);
    else delete project.manifest.dependencies[key];
  }
  project.saveManifest();
  const chosen = await resolveTree(client, project.manifest.dependencies, { lock: project.lock.filters });
  await installResolved(client, project, chosen, { registry });
  log.ok(`removed ${args.map((a) => color.bold(a)).join(', ')}`);
}
