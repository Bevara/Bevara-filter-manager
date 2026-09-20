import { log, color, CliError } from '../lib/ui.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';
import { parseSpec } from '../lib/resolve.js';

export const help = `Examples:
  bevara deprecate theora "use theora2 instead"      whole filter
  bevara deprecate theora@"<1.2.0" "buggy demuxer"   a version range
  bevara deprecate theora ""                         undo`;

export async function run({ args, opts }) {
  if (args.length < 2) throw new CliError('usage: bevara deprecate <filter[@range]> <message>');
  const { client } = clientFor(opts, Project.load({ required: false }));
  requireLogin(client);
  const { name, range } = parseSpec(args[0]);
  const message = args.slice(1).join(' ');
  const res = await client.post(`/filters/${encodeURIComponent(name)}/deprecate`, { version: range === 'latest' ? undefined : range, message });
  if (!message) log.ok(`removed deprecation on ${color.bold(name)}${res.versions ? ' ' + res.versions.join(', ') : ''}`);
  else log.ok(`deprecated ${color.bold(name)}${res.versions ? '@' + res.versions.join(', ') : ''}: ${message}`);
}
