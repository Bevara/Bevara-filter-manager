import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { patentNotice } from '../lib/manifest.js';
import { clientFor, Project } from '../lib/ctx.js';
import { parseSpec, pickVersion } from '../lib/resolve.js';

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara info <filter[@version]>');
  const { client } = clientFor(opts, Project.load({ required: false }));
  const { name, range } = parseSpec(args[0]);
  const p = await client.packument(name);
  const version = pickVersion(p, range);
  if (!version) throw new CliError(`no version of ${name} matches "${range}"`);
  const v = p.versions[version];
  if (opts.json) return console.log(JSON.stringify({ ...v, owners: p.owners, versions: Object.keys(p.versions), advisories: p.advisories }, null, 2));
  console.log(`${color.bold(name)}@${color.green(version)} ${color.dim(`abi ${v.abi} · ${v.license ?? 'no license'} · patents ${v.patents?.status ?? 'undeclared'}`)}`);
  if (patentNotice(v.patents)) log.warn(patentNotice(v.patents));
  if (p.deprecated) console.log(color.yellow(`DEPRECATED: ${p.deprecated}`));
  if (v.deprecated) console.log(color.yellow(`DEPRECATED ${version}: ${v.deprecated}`));
  console.log(v.description ?? '');
  if (v.help) console.log(color.dim(v.help));
  console.log();
  const rows = [
    ['GPAC filters', (v.filters ?? []).join(', ')],
    ['Formats', (v.formats ?? []).join(', ')],
    ['Support', (v.support ?? []).join(', ')],
    ['Inputs', (v.inputs ?? []).map(cap).join(' | ')],
    ['Outputs', (v.outputs ?? []).map(cap).join(' | ')],
    ['Priority', v.priority],
    ['Dependencies', Object.entries(v.dependencies ?? {}).map(([k, r]) => `${k}@${r}`).join(', ') || color.dim('none')],
    ['Sources', v.sources ?? ''],
    ['Wasm', `${v.dist.file}  ${formatBytes(v.dist.size)} (${formatBytes(v.dist.brSize)} brotli)`],
    ['URL', v.dist.wasm],
    ['Integrity', v.dist.integrity],
    ['Exports', (v.wasm?.exports ?? []).slice(0, 12).join(', ') + ((v.wasm?.exports?.length ?? 0) > 12 ? ` … (${v.wasm.exports.length})` : '')],
    ['Published', `${v.publishedAt} by ${v.publishedBy}`],
    ['Signature', v.signature ? `${v.signature.keyId} · log #${v.signature.logSeq} ${color.dim(v.signature.logHash?.slice(0, 16) + '…')}` : color.yellow('unsigned')],
    ['Owners', p.owners.join(', ')],
    ['Versions', Object.keys(p.versions).map((x) => (x === version ? color.green(x) : x)).join(', ')],
    ['Downloads', p.downloads],
  ];
  console.log(table(rows.map(([k, val]) => [color.dim(k), val])));
  if (p.advisories?.length) {
    console.log(`\n${color.red('Advisories:')}`);
    for (const a of p.advisories) console.log(`  ${color.bold(a.severity)} ${a.range}: ${a.title}${a.url ? ' ' + color.dim(a.url) : ''}`);
  }
  console.log(color.dim(`\n<video is="universal-video_1" using="mm_solver_1.0.1" with="${v.dist.file.replace(/\.wasm$/, '')}" src="…">`));
}

const cap = (c) => [c.stream_type, c.codec].filter(Boolean).join('/');
