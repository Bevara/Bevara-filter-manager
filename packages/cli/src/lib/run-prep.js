/* What test and bench run a file with, and where its modules come from.
 *
 * With --accessors, a local directory: the combinations come from -W or from
 * the built-in table, as before. Without it, nothing needs installing: the
 * file is identified with MediaInfo, the accessors that decode it and a
 * runtime they share are chosen among what the registry publishes (as probe
 * does), and those modules are downloaded - checked against their integrity -
 * into a cache, ~/.bevara/cache/<registry host>/, kept between runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, log } from './ui.js';
import { readSource } from './source.js';
import { mediaTracks } from './mediainfo.js';
import { needsOf, resolvePipeline, describeNeed, commonRuntimes, publishedRuntimes, servesRuntime, elementFor } from './capabilities.js';
import { extensionOf } from './formats.js';
import { locateSources, deployFiles } from './page-files.js';
import { SOLVER } from './solvers.js';

export const cacheDir = (registry, env = process.env) =>
  path.join(env.BEVARA_CACHE ?? path.join(os.homedir(), '.bevara', 'cache'), new URL(registry).host.replace(/[^A-Za-z0-9.-]/g, '_'));

/* The kind of media a file decodes to (video, image, audio), for files the
 * built-in table does not know: it names the raw sink. Video first, then
 * audio - the cover of an MP3 is an Image track - then image; failing tracks,
 * the element the matching accessor's "extension" gives. */
export async function mediaKind(file, tracks, match) {
  tracks ??= await mediaTracks(file, await readSource(file));
  const has = (t) => tracks?.some((x) => x['@type'] === t);
  if (has('Video')) return 'video';
  if (has('Audio')) return 'audio';
  if (has('Image')) return 'image';
  return KIND_OF_ELEMENT[elementFor(tracks, match)] ?? null;
}
const KIND_OF_ELEMENT = { canvas: 'video', video: 'video', img: 'image', audio: 'audio' };

/* The combinations to run on a file, from the registry: -W as given, else
 * the accessors that decode its streams; and the kind of media they output.
 * Throws a CliError saying why there is nothing to run. */
export async function registryCombinations(file, index, opts) {
  const tracks = await mediaTracks(file, await readSource(file));
  const needs = needsOf(tracks, { ext: extensionOf(file) });
  // mm_solver first: it reports the per-filter statistics the reports show.
  const match = resolvePipeline(needs, index, { prefer: opts.solver ?? SOLVER });
  const kind = await mediaKind(file, tracks, match);
  if (opts.with?.length) return { combinations: opts.with.map((w) => w.split(/[;,\s]+/).filter(Boolean)), kind };
  if (match.missing.length) throw new CliError(`nothing on the registry can ${match.missing.map(describeNeed).join(', ')}`, { hint: 'bevara probe shows what the file holds; -W "a_1;b_1" names a combination to try' });
  if (match.noRuntimes) throw new CliError('the registry publishes no runtime (solver) to run the accessors with');
  if (match.unpublishedRuntimes) throw new CliError(`its accessors link against ${match.unpublishedRuntimes.join(' or ')}, which the registry does not publish`);
  if (match.conflict) throw new CliError(`no runtime links all of ${match.with.join(', ')}: ${match.conflict.map((c) => `${c.module} needs ${c.using.join(' or ')}`).join(', ')}`);
  if (!match.with.length) throw new CliError('format not identified: nothing to run', { hint: 'bevara probe shows what the file holds' });
  return { combinations: [match.with], kind };
}

/* Downloads the modules of the combinations, and the runtimes they share,
 * into the cache; writes next to each accessor its "using", which the run
 * reads to pick the solver. Returns the cache directory. */
export async function fetchModules(combinations, index, { client, registry, solver }) {
  const dir = cacheDir(registry);
  const published = publishedRuntimes(index) ?? [];
  const reqs = new Map();
  for (const modules of combinations) {
    const entries = modules.map((m) => {
      const e = index.filters?.find((f) => f.file === `${m}.wasm`);
      if (!e) throw new CliError(`${m} is not published on ${registry}`, { hint: 'bevara filters lists what is' });
      return e;
    });
    const common = commonRuntimes(entries.map((e) => e.using)) ?? published;
    const runtimes = (solver ? [solver] : common).filter((r) => servesRuntime(published, r));
    if (!runtimes.length) throw new CliError(`${modules.join(';')}: no runtime ${common.length ? `among ${common.join(', ')} ` : ''}is published on ${registry}`);
    for (const e of entries) reqs.set(e.file, { kind: 'accessor', name: e.file, dest: path.join(dir, e.file), ref: e.file, using: e.using, base: e.name.split(':').pop() });
    for (const r of runtimes) for (const ext of ['js', 'wasm']) reqs.set(`${r}.${ext}`, { kind: 'solver', name: `${r}.${ext}`, dest: path.join(dir, `${r}.${ext}`), ref: `${r}.${ext}` });
  }
  fs.mkdirSync(dir, { recursive: true });
  const results = await deployFiles(locateSources([...reqs.values()], { index }), { client, refresh: true });
  for (const r of results) {
    if (r.status === 'failed' || r.status === 'missing') throw new CliError(`${r.name}: ${r.error ?? r.missing}`);
    if (r.status === 'added' || r.status === 'replaced') log.step(`${r.name} ← ${r.source.label}`);
  }
  for (const r of reqs.values()) if (r.kind === 'accessor') fs.writeFileSync(path.join(dir, `${r.base}.json`), JSON.stringify({ using: r.using ?? [] }) + '\n');
  return dir;
}
