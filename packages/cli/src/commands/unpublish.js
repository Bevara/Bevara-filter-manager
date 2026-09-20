import { log, color, confirm, CliError } from '../lib/ui.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';
import { parseSpec } from '../lib/resolve.js';

export const options = { force: { type: 'boolean', short: 'f' } };
export const help = `Examples:
  bevara unpublish theora@1.0.1     remove one version
  bevara unpublish theora --force   remove the filter and all its versions
Prefer \`bevara deprecate\`: unpublishing breaks sites that pin the version.`;

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara unpublish <filter[@version]>');
  const { client } = clientFor(opts, Project.load({ required: false }));
  requireLogin(client);
  const { name, range } = parseSpec(args[0]);
  const whole = range === 'latest';
  if (whole && !opts.force) throw new CliError(`refusing to remove every version of ${name}`, { hint: 'pass a version (bevara unpublish theora@1.0.1) or --force' });
  const what = whole ? `${name} (ALL versions)` : `${name}@${range}`;
  if (!opts.yes && process.stdin.isTTY && !(await confirm(`unpublish ${what}? This cannot be undone.`))) return log.info('aborted');
  const res = await client.delete(whole ? `/filters/${encodeURIComponent(name)}` : `/filters/${encodeURIComponent(name)}/${encodeURIComponent(range)}`);
  log.ok(`unpublished ${color.bold(res.removed)}`);
}
