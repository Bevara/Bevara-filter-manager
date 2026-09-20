import { log, color, table, CliError } from '../lib/ui.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';

export const options = { severity: { type: 'string', short: 's' }, url: { type: 'string', short: 'u' } };
export const help = `Advisories are what \`bevara audit\` reports to sites using an affected version.
  bevara advisory ls [filter]
  bevara advisory add <filter> <range> "<title>" --severity high [--url https://…]
  bevara advisory rm <id>
Severity: low | moderate | high | critical. Admin role required to add/remove.`;

export async function run({ args, opts }) {
  const [action, ...rest] = args;
  const { client } = clientFor(opts, Project.load({ required: false }));
  if (!action || action === 'ls' || action === 'list') {
    const { advisories } = await client.get('/-/advisories' + (rest[0] ? `?names=${encodeURIComponent(rest[0])}` : ''));
    if (opts.json) return console.log(JSON.stringify(advisories, null, 2));
    if (!advisories.length) return log.info('no advisories');
    return console.log(table(advisories.map((a) => [String(a.id), color.bold(a.name), a.range, a.severity, a.title, color.dim(a.url ?? '')]), { header: ['ID', 'Filter', 'Range', 'Severity', 'Title', 'URL'].map(color.bold) }));
  }
  requireLogin(client);
  if (action === 'add') {
    const [name, range, ...title] = rest;
    if (!name || !range || !title.length || !opts.severity) throw new CliError('usage: bevara advisory add <filter> <range> "<title>" --severity <level>');
    const res = await client.post('/-/advisories', { name, range, title: title.join(' '), severity: opts.severity, url: opts.url });
    return log.ok(`advisory #${res.id} created for ${color.bold(name)} ${range}`);
  }
  if (action === 'rm' || action === 'remove') {
    if (!rest[0]) throw new CliError('usage: bevara advisory rm <id>');
    await client.delete(`/-/advisories/${encodeURIComponent(rest[0])}`);
    return log.ok(`advisory #${rest[0]} removed`);
  }
  throw new CliError(help);
}
