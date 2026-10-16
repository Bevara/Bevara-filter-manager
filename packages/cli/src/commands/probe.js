import { isRestricted, patentNotice } from '../lib/manifest.js';
import path from 'node:path';
import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { sniff } from '../lib/sniff.js';
import { extensionOf } from '../lib/formats.js';
import { readSource, HEAD_DEFAULT } from '../lib/source.js';
import { resolveTree, installResolved } from '../lib/resolve.js';
import { mediaTracks, closeMediaInfo } from '../lib/mediainfo.js';
import { needsOf, resolveNeeds, resolvePipeline, describeNeed, elementFor } from '../lib/capabilities.js';

export const options = {
  install: { type: 'boolean', short: 'i' },
  offline: { type: 'boolean' },
  bytes: { type: 'string', short: 'b' },
  all: { type: 'boolean', short: 'a' },
};

export const help = `Identifies what a media file contains with MediaInfo - container and tracks -
and picks the accessors that play it among those the registry carries, as the
editor does: an accessor fits a track whose Format is in its "Format" list, or
the file when its extension is one of its "extension" keys. A container or
stream that no published accessor declares is reported as missing. The solver
(using="…") is one every chosen accessor links against, from their "using".

  bevara probe movie.ogv
  bevara probe *.mp4 --json
  bevara probe https://example.org/clip.mkv
  bevara probe movie.ogv --install     install the accessors it needs into this project

Options:
  -i, --install    install the matched accessors (needs a project and a registry)
  -b, --bytes <n>  head window to read, default 262144
  -a, --all        also list the other accessors that fit each need
  --offline        do not query the registry: print the built-in suggestion,
                   which may name accessors nobody has published
  --json           machine-readable report`;

async function probeOne(target, opts, index) {
  const headBytes = Math.max(4096, parseInt(opts.bytes ?? String(HEAD_DEFAULT), 10) || HEAD_DEFAULT);
  const source = await readSource(target, headBytes);
  if (!source.head.length) throw new CliError(`${target} is empty`);
  const report = sniff({ head: source.head, tail: source.tail, name: target, mime: source.mime, size: source.size });
  const tracks = await mediaTracks(target, source);
  if (!index) return { target, report, tracks, match: null, element: elementFor(tracks, null, report.kind) };
  const needs = needsOf(tracks, { ext: extensionOf(target) });
  // The element decides the solver to prefer (a canvas uses solver_1, as in the
  // editor); the accessors' "using" may then impose another.
  const element = elementFor(tracks, resolveNeeds(needs, index), report.kind);
  const match = resolvePipeline(needs, index, { prefer: element === 'canvas' ? 'solver_1' : report.using });
  return { target, report, tracks, match, element };
}

const trackDetails = (t) => [
  t.Format_Profile && `profile ${t.Format_Profile}`,
  t.CodecID && `codec id ${t.CodecID}`,
  t.Width && t.Height && `${t.Width}×${t.Height}`,
  t.Channels && `${t.Channels} ch`,
  t.SamplingRate && `${t.SamplingRate} Hz`,
  t.Duration && `${Number(t.Duration).toFixed(1)} s`,
].filter(Boolean).join(' · ');

function print(result, opts, registry) {
  const { target, report: r, tracks, match } = result;
  const name = path.basename(target.split('?')[0]);
  const general = tracks?.find((t) => t['@type'] === 'General');
  console.log(`${color.bold(name)} ${color.dim(r.size != null ? formatBytes(r.size) : '')}`);

  const rows = [
    ['format', general?.Format
      ? `${color.bold(general.Format)}${general.Format_Profile ? color.dim(` (${general.Format_Profile})`) : ''}`
      : color.yellow(`not recognised by MediaInfo${r.format ? color.dim(` (looks like ${r.format})`) : ''}`)],
    ['browsers', r.native === null ? color.dim('unknown')
      : r.native ? color.dim('decoded natively by at least one engine; the pipeline is the fallback')
                 : color.yellow('no engine decodes this natively; a pipeline is required')],
    ['detected by', color.dim(general?.Format ? 'MediaInfo' : r.evidence.join(', ') || 'nothing')],
  ];
  console.log(table(rows.map(([k, v]) => [color.dim(k), v]), { indent: '  ' }));

  const streams = (tracks ?? []).filter((t) => t['@type'] !== 'General');
  if (streams.length) {
    console.log(`\n  ${color.bold('tracks')}`);
    console.log(table(streams.map((t) => [t['@type'].toLowerCase(), t.Format ? color.bold(t.Format) : color.yellow('unidentified'), color.dim(trackDetails(t))]), { indent: '    ' }));
  }

  if (match) printResolved(match, opts, registry);
  else {
    console.log(`\n  ${color.bold('pipeline')} ${color.dim('(built-in suggestion, not checked against a registry)')}`);
    console.log(`    using="${r.using}" with="${r.with.join(';')}"`);
  }

  for (const w of r.warnings) if (!tracks) log.warn(w);

  const el = result.element;
  if (!match || match.missing.length || match.conflict || match.unpublishedRuntimes || match.noRuntimes || !match.with.length || !el) return console.log();
  const attrs = `${el === 'canvas' ? 'data-url' : 'src'}="${name}" using="${match.using}" with="${match.with.join(';')}"${el === 'audio' ? ' controls' : ''}`;
  console.log(`\n  ${color.dim(`<${el} is="universal-${el}_1" ${attrs}>`)}\n`);
}

function printResolved(match, opts, registry) {
  console.log(`\n  ${color.bold('accessors')} ${color.dim(registry)}`);
  console.log(table(match.needs.map((n) => {
    const e = n.chosen;
    return e
      ? [color.green('✓'), describeNeed(n), color.bold(e.module), e.name, e.version, formatBytes(e.brSize ?? e.size), color.dim(e.using?.length ? `${e.using.join('|')} only` : ''), (e.license ?? '') + (isRestricted(e.patents) ? color.yellow(` ${e.patents.status}`) : '')]
      : [color.red('✗'), describeNeed(n), color.dim(n.unidentified ? 'MediaInfo could not identify it' : 'no published accessor declares it'), '', '', '', '', ''];
  }), { indent: '    ' }));
  for (const e of [...new Set(match.needs.map((n) => n.chosen).filter((e) => isRestricted(e?.patents)))]) log.warn(`${e.module}: ${patentNotice(e.patents)}`);
  if (opts.all) {
    const alt = match.needs.flatMap((n) => n.candidates.slice(1).map((c) => [describeNeed(n), c.module, c.name, c.version, color.dim(`priority ${c.priority ?? 50}`)]));
    if (alt.length) {
      console.log(`\n  ${color.bold('other accessors that fit')}`);
      console.log(table(alt, { indent: '    ' }));
    }
  }
  if (match.noRuntimes && !match.unpublishedRuntimes) {
    log.warn('this registry publishes no runtime (solver) yet: no page can load these accessors from it');
    log.info(color.dim('  publish one: bevara publish --build in Editor/Interface/player/solver_minimal or solver'));
  } else if (match.unpublishedRuntimes) {
    log.warn(`these accessors link against ${match.unpublishedRuntimes.join(' or ')}, which this registry does not publish: no page could load them together`);
    log.info(color.dim(`  publish the runtime: bevara publish --build in its directory (Editor/Interface/player/${match.unpublishedRuntimes[0].replace(/_\d+$/, '')})`));
  } else if (match.conflict) {
    log.warn(`no solver links all these accessors: ${match.conflict.map((c) => `${c.module} needs ${c.using.join(' or ')}`).join(', ')}`);
    log.info(color.dim('  a page loads one solver: publish a variant of one of them for the other solver, or widen its "using"'));
  } else if (match.with.length && !match.missing.length) console.log(color.dim(`    solver ${match.using}${match.fits.length > 1 ? ` (also fits ${match.fits.slice(1).join(', ')})` : ''}`));
  if (match.undeclared?.length) log.warn(`${match.undeclared.join(', ')} ${match.undeclared.length > 1 ? 'declare' : 'declares'} no runtime ("using"): ${match.undeclared.length > 1 ? 'their' : 'its'} compatibility with ${match.using} is assumed - republish ${match.undeclared.length > 1 ? 'them' : 'it'}`);
  if (match.missing.length) {
    log.warn(`this registry cannot play the file yet: nothing published can ${match.missing.map(describeNeed).join(', ')}`);
    const formats = [...new Set(match.missing.filter((n) => n.format).map((n) => n.format))];
    const ext = match.missing.find((n) => n.byExtension && n.ext)?.ext;
    const how = [formats.length && `"Format": [${formats.map((f) => JSON.stringify(f)).join(', ')}]`, ext && `"extension": {"${ext}": …}`].filter(Boolean);
    if (how.length) log.info(color.dim(`  an accessor is found by its manifest: ${how.join(' or ')}`));
  }
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
  try {
    for (const target of args) {
      try { results.push(await probeOne(target, opts, index)); }
      catch (e) {
        if (opts.json) results.push({ target, error: e.message });
        else { log.error(`${target}: ${e.message}`); process.exitCode = 1; }
      }
    }
  } finally {
    await closeMediaInfo();
  }

  if (opts.json) {
    console.log(JSON.stringify(results.map((r) => r.error ? r : {
      file: r.target, ...r.report, tracks: r.tracks,
      ...(r.match ? {
        using: r.match.using, solvers: r.match.fits, conflict: r.match.conflict,
        with: r.match.with,
        accessors: r.match.needs.map((n) => ({ need: n.role, format: n.format, type: n.type, module: n.chosen?.module ?? null, name: n.chosen?.name, version: n.chosen?.version, using: n.chosen?.using, candidates: n.candidates.map((c) => c.module) })),
        missing: r.match.missing.map(describeNeed),
      } : {}),
    }), null, 2));
  } else {
    for (const r of results) print(r, opts, registry);
  }

  if (opts.install) {
    const names = [...new Set(results.flatMap((r) => r.match?.needs.filter((n) => n.chosen).map((n) => n.chosen.name) ?? []))];
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
