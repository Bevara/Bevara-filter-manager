import { log, color, table, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { verifyLogSince, fetchKeys } from '../lib/logcheck.js';
import { GENESIS } from '../lib/sig.js';

export const options = { since: { type: 'string' }, verify: { type: 'boolean', short: 'v' }, limit: { type: 'string', short: 'n' } };
export const help = `Shows the registry's append-only log of signed publish/yank/deprecate records.
  bevara log                      last 50 entries
  bevara log theora               entries about one filter
  bevara log --verify             re-derive the whole hash chain and check every signature
  bevara log --since 120 -n 20
Options:
  -v, --verify   verify the whole chain from genesis and every signature (\`bevara audit\` does the
                 incremental check from the checkpoint pinned in bevara-lock.json)`;

export async function run({ args, opts }) {
  const project = Project.load({ required: false });
  const { registry, client } = clientFor(opts, project);
  if (opts.verify) {
    // Full verification from genesis (the incremental, pinned check is what `bevara audit` does).
    const pinned = project.lock.log?.registryKeyId ? { seq: 0, registryKeyId: project.lock.log.registryKeyId } : null;
    const t = Date.now();
    const { findings, entries, checkpoint } = await verifyLogSince(client, pinned);
    const ms = Date.now() - t;
    if (opts.json) return console.log(JSON.stringify({ findings, verified: entries.length, checkpoint }, null, 2));
    for (const f of findings) log.error(f.message);
    if (findings.length) { process.exitCode = 1; return; }
    return log.ok(`verified ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (from genesis${pinned ? ', registry key pinned' : ''}) in ${ms} ms — head #${checkpoint.seq} ${color.dim(checkpoint.head.slice(0, 16) + '…')} signed by ${color.dim(checkpoint.keyId)}`);
  }
  const params = new URLSearchParams();
  const limit = parseInt(opts.limit ?? '50', 10);
  if (args[0]) params.set('name', args[0]);
  let since = opts.since ? parseInt(opts.since, 10) : null;
  if (since === null) { const cp = await client.get('/-/log/checkpoint'); since = Math.max(0, cp.seq - limit); }
  params.set('since', String(since)); params.set('limit', String(limit));
  const { entries, checkpoint } = await client.get('/-/log?' + params);
  if (opts.json) return console.log(JSON.stringify({ entries, checkpoint }, null, 2));
  if (!entries.length) return log.info(`log is empty ${color.dim(`(${registry})`)}`);
  const keys = await fetchKeys(client);
  console.log(table(entries.map((e) => {
    const r = e.record; const k = keys.get(e.keyId);
    const what = r.type === 'publish' ? `${r.name}@${r.version} ${color.dim(r.wasmSha256.slice(0, 12) + '…')}` : r.type === 'yank' ? color.yellow(`${r.name}@${r.version} yanked by ${r.by}`) : `${r.name}${r.versions ? '@' + r.versions.join(',') : ''} ${r.message ? 'deprecated: ' + r.message : 'un-deprecated'} by ${r.by}`;
    return [color.dim('#' + e.seq), r.type, what, k?.registry ? color.dim('registry') : (k?.user ?? '?'), color.dim(e.createdAt.slice(0, 19))];
  })));
  console.log(color.dim(`\nhead #${checkpoint.seq} ${checkpoint.head.slice(0, 16)}… (${registry})`));
}

export { GENESIS, CliError };
