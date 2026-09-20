import { log, color, CliError } from '../lib/ui.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';

export const help = `  bevara owner ls <filter>
  bevara owner add <user> <filter>
  bevara owner rm <user> <filter>`;

export async function run({ args, opts }) {
  const [action, ...rest] = args;
  const { client } = clientFor(opts, Project.load({ required: false }));
  if (action === 'ls' || action === 'list') {
    const [name] = rest;
    if (!name) throw new CliError('usage: bevara owner ls <filter>');
    const { owners } = await client.get(`/filters/${encodeURIComponent(name)}/owners`);
    return console.log(owners.join('\n'));
  }
  if (action === 'add' || action === 'rm' || action === 'remove') {
    const [user, name] = rest;
    if (!user || !name) throw new CliError(`usage: bevara owner ${action} <user> <filter>`);
    requireLogin(client);
    const p = `/filters/${encodeURIComponent(name)}/owners/${encodeURIComponent(user)}`;
    const { owners } = action === 'add' ? await client.put(p, {}) : await client.delete(p);
    return log.ok(`owners of ${color.bold(name)}: ${owners.join(', ')}`);
  }
  throw new CliError(help);
}
