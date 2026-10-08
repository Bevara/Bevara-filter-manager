import { log, color, table, CliError } from '../lib/ui.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';

export const help = `Filters are named "<namespace>:<package>" (e.g. bevara:theora). Every account owns
the namespace of its own username; the first publisher of a namespace claims it.
  bevara namespace ls
  bevara namespace add <user> <namespace>     grant publish rights
  bevara namespace rm <user> <namespace>`;

export async function run({ args, opts }) {
  const [action, user, ns] = args;
  const { client } = clientFor(opts, Project.load({ required: false }));
  if (!action || action === 'ls' || action === 'list') {
    const { namespaces, defaultNamespace } = await client.get('/-/namespaces');
    if (opts.json) return console.log(JSON.stringify(namespaces, null, 2));
    if (!namespaces.length) return log.info('no namespaces yet');
    return console.log(table(namespaces.map((n) => [n.name === defaultNamespace ? color.bold(n.name) + color.dim(' (default)') : color.bold(n.name), n.owners.join(', '), String(n.filters)]), { header: ['Namespace', 'Owners', 'Filters'].map(color.bold) }));
  }
  if (!user || !ns) throw new CliError(`usage: bevara namespace ${action} <user> <namespace>`);
  requireLogin(client);
  const p = `/-/namespaces/${encodeURIComponent(ns)}/owners/${encodeURIComponent(user)}`;
  const r = action === 'add' ? await client.put(p, {}) : (action === 'rm' || action === 'remove') ? await client.delete(p) : null;
  if (!r) throw new CliError(help);
  log.ok(`owners of ${color.bold(ns)}: ${r.owners.join(', ')}`);
}
