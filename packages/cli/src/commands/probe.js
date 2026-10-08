import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { sniff } from '../lib/sniff.js';
import { readSource, HEAD_DEFAULT } from '../lib/source.js';
import { resolveTree, installResolved } from '../lib/resolve.js';

export const options = {
  install: { type: 'boolean', short: 'i' },
  offline: { type: 'boolean' },
  bytes: { type: 'string', short: 'b' },
  all: { type: 'boolean', short: 'a' },
};

export const help = `Identifies what a media file really contains - container, elementary streams and
codecs - and reports the accessors needed to play it, checking each against the
registry. Only the head and tail of the file are read, so probing a multi-gigabyte
capture costs a few hundred kilobytes.

  bevara probe movie.ogv
  bevara probe *.mp4 --json
  bevara probe https://example.org/clip.mkv
  bevara probe movie.ogv --install     install the accessors it needs into this project

Options:
  -i, --install    install the matched accessors (needs a project and a registry)
  -b, --bytes <n>  head window to read, default 262144
  -a, --all        also list accessors the registry offers for the same codecs
  --offline        do not query the registry, report the built-in pipeline only
  --json           machine-readable report`;

// "AC-3" / "JPEG 2000" / "h.264" all normalise to a comparable token.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* Matches what the file needs against the registry's capability index:
 * by accessor file name first (the names the pipeline actually loads), then
 * by declared capability for anything left over. */
function matchRegistry(report, index) {
  if (!index) return null;
  const byFile = new Map(index.filters.map((f) => [f.file, f]));
  const modules = report.with.map((m) => {
    const entry = byFile.get(`${m}.wasm`);
    return { module: m, entry: entry ?? null };
  });
  const covered = new Set();
  for (const { entry } of modules) {
    if (!entry) continue;
    for (const f of entry.formats ?? []) covered.add(norm(f));
    for (const cap of entry.inputs ?? []) if (cap.codec) covered.add(norm(cap.codec));
  }
  const alternatives = {};
  for (const codec of report.required.decode) {
    const hits = index.filters.filter((f) =>
      (f.formats ?? []).some((x) => norm(x) === norm(codec)) ||
      (f.inputs ?? []).some((c) => norm(c.codec) === norm(codec)) ||
      (f.filters ?? []).some((x) => norm(x) === norm(codec)));
    if (hits.length) alternatives[codec] = hits.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  }
  return { modules, alternatives, covered };
}

async function probeOne(target, opts, index) {
  const headBytes = Math.max(4096, parseInt(opts.bytes ?? String(HEAD_DEFAULT), 10) || HEAD_DEFAULT);
  const { head, tail, size, mime } = await readSource(target, headBytes);
  if (!head.length) throw new CliError(`${target} is empty`);
  const report = sniff({ head, tail, name: target, mime, size });
  return { target, report, match: matchRegistry(report, index) };
}

function print(result, opts, registry) {
  const { target, report: r, match } = result;
  const name = path.basename(target.split('?')[0]);
  console.log(`${color.bold(name)} ${color.dim(r.size != null ? formatBytes(r.size) : '')}`);

  const rows = [
    ['format', r.format ? `${color.bold(r.format)}${r.mime ? color.dim(` (${r.mime})`) : ''}` : color.red('unrecognised')],
    ['container', r.container ? r.container + (r.brands?.length ? color.dim(` · brands ${r.brands.filter(Boolean).join(', ')}`) : '') + (r.fragmented ? color.dim(' · fragmented') : '') : color.dim('none (elementary stream)')],
    ['browsers', r.native === null ? color.dim('unknown')
      : r.native ? color.dim('decoded natively by at least one engine; the pipeline is the fallback')
                 : color.yellow('no engine decodes this natively; a pipeline is required')],
    ['detected by', color.dim(r.evidence.join(', ') || 'nothing')],
  ];
  console.log(table(rows.map(([k, v]) => [color.dim(k), v]), { indent: '  ' }));

  console.log(`\n  ${color.bold('streams')}`);
  console.log(table(r.streams.map((s) => [
    s.type,
    s.codec ? color.bold(s.codec) : color.yellow('unidentified'),
    color.dim([s.sampleEntry && `sample entry ${s.sampleEntry}`, s.codecId, s.fourcc && `fourcc ${s.fourcc}`, s.formatTag && `format tag ${s.formatTag}`, s.pid != null && `PID ${s.pid}`, s.id != null && `serial ${s.id}`, s.streamId, s.note].filter(Boolean).join(' · ')),
  ]), { indent: '    ' }));

  console.log(`\n  ${color.bold('pipeline')} ${color.dim(r.pipelineSource === 'assembled' ? '(from the streams found)' : '(curated default for this format)')}`);
  console.log(`    using="${r.using}" with="${r.with.join(';')}"`);

  if (match) {
    const missing = match.modules.filter((m) => !m.entry);
    console.log(`\n  ${color.bold('accessors')} ${color.dim(registry)}`);
    console.log(table(match.modules.map(({ module, entry }) => entry
      ? [color.green('✓'), color.bold(module), entry.name, entry.version, formatBytes(entry.brSize ?? entry.size), (entry.license ?? '') + (entry.licence_required ? color.yellow('*') : '')]
      : [color.red('✗'), color.bold(module), color.dim('not published on this registry'), '', '', '']),
      { indent: '    ' }));
    if (match.modules.some((m) => m.entry?.licence_required)) console.log(color.dim('    * requires a licence'));
    if (missing.length) log.warn(`${missing.length} accessor${missing.length === 1 ? '' : 's'} missing from the registry: ${missing.map((m) => m.module).join(', ')}`);
    if (opts.all) {
      const alt = Object.entries(match.alternatives);
      if (alt.length) {
        console.log(`\n  ${color.bold('other accessors declaring these codecs')}`);
        console.log(table(alt.flatMap(([codec, hits]) => hits.map((h) => [codec, h.name, h.version, color.dim(h.file), `priority ${h.priority ?? 50}`])), { indent: '    ' }));
      }
    }
  }

  for (const w of r.warnings) log.warn(w);

  const tag = r.kind === 'audio' ? 'audio' : r.kind === 'image' ? 'img' : 'video';
  const el = r.kind === 'image' ? `img is="universal-img_1"` : `${tag} is="universal-${tag}_1"`;
  console.log(`\n  ${color.dim(`<${el} src="${name}" using="${r.using}" with="${r.with.join(';')}"${r.kind === 'image' ? '' : ' controls'}>`)}\n`);
}

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara probe <file|url...>');
  const project = Project.load({ required: false });
  const { registry, client } = clientFor(opts, project);

  let index = null;
  if (!opts.offline) {
    try { index = await client.get('/accessors/index.json'); }
    catch (e) { log.warn(`registry unreachable (${e.message}); reporting the built-in pipeline only`); }
  }

  const results = [];
  for (const target of args) {
    try { results.push(await probeOne(target, opts, index)); }
    catch (e) {
      if (opts.json) results.push({ target, error: e.message });
      else { log.error(`${target}: ${e.message}`); process.exitCode = 1; }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results.map((r) => r.error ? r : {
      file: r.target, ...r.report,
      accessors: r.match?.modules.map((m) => ({ module: m.module, published: !!m.entry, name: m.entry?.name, version: m.entry?.version })),
    }), null, 2));
  } else {
    for (const r of results) print(r, opts, registry);
  }

  if (opts.install) {
    const names = [...new Set(results.flatMap((r) => r.match?.modules.filter((m) => m.entry).map((m) => m.entry.name) ?? []))];
    if (!index) throw new CliError('--install needs the registry', { hint: 'drop --offline, or check `bevara ping`' });
    if (!names.length) throw new CliError('none of the required accessors are published on this registry');
    if (!project.manifestFile)
      throw new CliError('no bevara.json here', { hint: 'run `bevara install` once, or `bevara init --site`' });
    log.step(`installing ${names.join(', ')}`);
    const roots = { ...(project.manifest.dependencies ?? {}) };
    for (const n of names) roots[n] ??= 'latest';
    const chosen = await resolveTree(client, roots, { lock: project.lock.filters });
    project.manifest.dependencies ??= {};
    for (const n of names) project.manifest.dependencies[n] ??= `^${chosen.get(n).version}`;
    project.saveManifest();
    const installed = await installResolved(client, project, chosen, { registry });
    log.ok(`${chosen.size} filters in ${path.relative(process.cwd(), project.accessorsDir) || '.'}/ (${installed.length} downloaded)`);
  }
}
