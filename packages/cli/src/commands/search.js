import { log, color, table, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara search <query>');
  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  const { filters } = await client.search({ q: args.join(' '), limit: 200 });
  if (opts.json) return console.log(JSON.stringify(filters, null, 2));
  if (!filters.length) return log.info(`no filter matching "${args.join(' ')}" on ${registry}`);
  console.log(table(filters.map((f) => [color.bold(f.name), f.latest, (f.description ?? '').slice(0, 70), color.dim((f.filters ?? []).join(','))]), { header: ['Filter', 'Version', 'Description', 'GPAC filters'].map(color.bold) }));
}
