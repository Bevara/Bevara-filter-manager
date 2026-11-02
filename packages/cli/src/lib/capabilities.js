/* Which published accessors can play a probed file.
 *
 * The matching is the editor's (Editor/Interface, libraries.service.ts
 * setRecommended): MediaInfo names each track's format, and an accessor fits
 *
 *   - a track whose Format is one of its "Format" values ("formats" once
 *     published): "JPEG 2000", "AVC", "MPEG-4"…
 *   - the file, when the file's extension is one of its "extension" keys
 *     ({"jxl": "img"}), which also covers what MediaInfo does not recognise.
 *
 * Only accessors the registry carries are candidates, so a module is proposed
 * once someone has published it, whatever its name. On top of the editor's
 * union of matches, the file is broken into needs - a demultiplexer for the
 * container, a decoder per stream - so that a need nothing covers is reported
 * instead of silently dropped.
 */
import { VIDEO_TAIL } from './formats.js';

const key = (s) => String(s ?? '').trim().toLowerCase();

// Containers the solver demultiplexes itself (m2tsdmx, m2psdmx, its WAV reader).
const SOLVER_CONTAINERS = new Set(['mpeg-ts', 'mpeg-ps', 'wave']);
const STREAM_TYPES = { Video: 'video', Audio: 'audio', Image: 'image' };

/* The needs of a file, from MediaInfo's tracks (null when MediaInfo could not
 * read it) and its extension. */
export function needsOf(tracks, { ext = '' } = {}) {
  const general = tracks?.find((t) => t['@type'] === 'General');
  const streams = (tracks ?? []).filter((t) => STREAM_TYPES[t['@type']]);
  const container = general?.Format ?? null;
  const needs = [];
  // Unrecognised: only the extension can say which accessor reads it.
  if (!container && !streams.length) return [{ role: 'read', format: null, ext, byExtension: true }];
  // An elementary stream (a .j2k, an .mp3) is its own container.
  const elementary = streams.length > 0 && streams.every((s) => key(s.Format) === key(container));
  if (container && !elementary && !SOLVER_CONTAINERS.has(key(container))) needs.push({ role: 'demux', format: container, ext, byExtension: true });
  for (const s of streams) {
    const type = STREAM_TYPES[s['@type']];
    // A stream MediaInfo does not name (the audio of a .mod): only the file's
    // extension can say which accessor plays it.
    if (!s.Format) { needs.push({ role: 'decode', type, format: null, unidentified: true, ext, byExtension: true }); continue; }
    if (needs.some((n) => n.role === 'decode' && key(n.format) === key(s.Format))) continue;
    needs.push({ role: 'decode', type, format: s.Format, codec: s.CodecID, profile: s.Format_Profile, ext, byExtension: elementary });
  }
  return needs;
}

/* The fragmented MP4 / H.264 / Opus tail a <video> element needs to play what
 * was decoded. Encoders declare no "Format" to match, so these are looked up by
 * name - and still only taken when published. */
export const videoTailNeeds = () => VIDEO_TAIL.map((m) => ({ role: 'encode', module: m }));

const ROLE_LABEL = { read: 'read', demux: 'demultiplex', decode: 'decode', encode: 'remux/encode with' };
export function describeNeed(n) {
  if (n.unidentified) return `decode the unidentified ${n.type} stream`;
  if (n.role === 'encode') return `${ROLE_LABEL.encode} ${n.module}`;
  if (!n.format) return `read .${n.ext || '?'} files`;
  return `${ROLE_LABEL[n.role]} ${n.format}`;
}

/* How an accessor answers a need: 'format' (it declares the format MediaInfo
 * names, or the stream's codec ID - MediaInfo calls UtVideo "YUV", its codec
 * ID ULY0 tells it apart), 'extension' (only the file's extension matches),
 * or false. */
function fits(entry, need) {
  if (need.role === 'encode') return entry.file === `${need.module}.wasm` ? 'format' : false;
  const declares = (v) => v && (entry.formats ?? []).some((f) => key(f) === key(v));
  if (declares(need.format) || declares(need.codec)) return 'format';
  if (!need.byExtension || !need.ext) return false;
  // Before "extension" was published, a manifest without "Format" had its
  // extension keys published as "formats": they still name extensions.
  const exts = entry.extension ? Object.keys(entry.extension) : entry.formats ?? [];
  return exts.some((e) => key(e) === key(need.ext)) ? 'extension' : false;
}

/* An accessor is a side module: it links against the solver the page loads
 * (using="…"), and only some solvers export what it imports - isobmff needs
 * mm_solver_1.0.1, libtta mm_solver_minimal_1.0.1. Its manifest says which in "using"; an
 * accessor that does not say is taken to work with any. */
export const fitsSolver = (entry, solver) => !entry.using?.length || entry.using.includes(solver);

import { KNOWN_SOLVERS } from './solvers.js';
import { splitModule } from './manifest.js';

export { SOLVER, SOLVER_MINIMAL, KNOWN_SOLVERS, solverDir } from './solvers.js';

/* The GPAC priority that matters for a need (lower is preferred): that of the
 * accessor's filter doing the work - for a decode, the one that outputs raw
 * media (ffmpeg's ffdec at 128, not its reframer at 0); for a demultiplex,
 * the one that reads a file. Without published caps, the accessor's own. */
const outputsRaw = (c) => (c.bundles ?? []).some((b) => (b.outputs ?? []).some((o) => o.property === 'GF_PROP_PID_CODECID' && !o.excluded && o.format === 'GF_CODECID_RAW'));
const decodes = (entry) => Array.isArray(entry.caps) && entry.caps.some(outputsRaw);

function priorityFor(entry, need) {
  const caps = Array.isArray(entry.caps) ? entry.caps : [];
  const readsFiles = (c) => (c.bundles ?? []).some((b) => (b.inputs ?? []).some((i) => i.property === 'GF_PROP_PID_STREAM_TYPE' && !i.excluded && i.format === 'GF_STREAM_FILE'));
  const doing = caps.filter(need.role === 'decode' ? outputsRaw : need.role === 'demux' || need.role === 'read' ? readsFiles : () => false);
  if (doing.length) return Math.min(...doing.map((c) => c.priority ?? 0));
  return entry.priority ?? 50;
}

/**
 * Answers each need from the registry index, among the accessors that link
 * against `solver` when one is given.
 * @returns {{ needs: Array<need & { candidates: object[], chosen: object|null }>, with: string[], missing: object[] }}
 */
export function resolveNeeds(needs, index, { solver } = {}) {
  const entries = (index?.filters ?? []).map((e) => ({ ...e, module: e.file.replace(/\.wasm$/, '') }))
    .filter((e) => !solver || fitsSolver(e, solver));
  // An accessor that declares the format comes before one whose extension
  // merely matches: the Ogg demultiplexer, not the Opus decoder, reads a .opus.
  const rank = { format: 0, extension: 1 };
  const prio = (e, need) => priorityFor(e, need);
  const resolved = needs.map((need) => {
    const candidates = entries.map((e) => ({ ...e, match: fits(e, need) })).filter((e) => e.match)
      .sort((a, b) => rank[a.match] - rank[b.match] || prio(a, need) - prio(b, need) || a.module.localeCompare(b.module));
    return { ...need, candidates, chosen: candidates[0] ?? null };
  });
  /* An image file is read and decoded by one accessor: libtiff takes the LZW,
   * PackBits or fax strips MediaInfo lists as the image's format, libdds its
   * DXT blocks, qdbmp its RLE. When the accessor that reads the file outputs
   * decoded pictures, it answers the image streams - rather than libraw for
   * the "Raw" of a BMP, or nothing for the LZW of a TIFF. */
  const reader = resolved.find((n) => (n.role === 'demux' || n.role === 'read') && n.chosen)?.chosen;
  if (reader && decodes(reader)) {
    for (const [i, n] of resolved.entries()) {
      if (n.role !== 'decode' || n.type !== 'image') continue;
      resolved[i] = { ...n, candidates: [{ ...reader, match: 'container' }, ...n.candidates.filter((c) => c.module !== reader.module)], chosen: { ...reader, match: 'container' } };
    }
  }
  const withList = [];
  for (const n of resolved) if (n.chosen && !withList.includes(n.chosen.module)) withList.push(n.chosen.module);
  // Needs MediaInfo named but only an extension answered: what tells a good
  // resolution from a makeshift one.
  const byExtension = resolved.filter((n) => n.format && n.chosen?.match === 'extension').length;
  return { needs: resolved, with: withList, missing: resolved.filter((n) => !n.chosen), byExtension };
}

/* The runtimes the registry publishes (its index lists them), or null for a
 * registry that predates runtime packages. */
export const publishedRuntimes = (index) => (Array.isArray(index?.runtimes) ? index.runtimes.map((r) => r.module) : null);

/* Whether the registry serves runtime `m`: the index lists only the latest
 * release of each runtime, but /accessors/ serves any release pinned by
 * version, so mm_solver_1.0.1 is served once mm_solver_1.0.2 is published. */
export function servesRuntime(published, m) {
  if (published.includes(m)) return true;
  const id = splitModule(m);
  return !!id?.version && published.some((p) => splitModule(p)?.base === id.base);
}

/* The runtimes every list allows: the intersection of the "using" of the
 * accessors of one combination. Accessors that declare none are left out of
 * the intersection (they are reported apart). */
export function commonRuntimes(usings) {
  const declared = usings.filter((u) => Array.isArray(u) && u.length);
  if (!declared.length) return null;
  return declared.reduce((a, b) => a.filter((x) => b.includes(x)));
}

/* Every solver worth trying, `prefer` first. With a registry that lists its
 * runtimes, only those: a page cannot load a solver nobody publishes. Before
 * runtime packages, the solvers the player ships and those accessors name. */
export function solverOrder(index, prefer) {
  const published = publishedRuntimes(index);
  if (published) return [...new Set([prefer, ...KNOWN_SOLVERS, ...published].filter((s) => s && servesRuntime(published, s)))];
  const all = [prefer, ...KNOWN_SOLVERS, ...(index?.filters ?? []).flatMap((e) => e.using ?? [])].filter(Boolean);
  return [...new Set(all)];
}

/**
 * Resolves the needs and picks the solver: the first, in solverOrder(), under
 * which every need finds an accessor.
 * @returns {resolveNeeds() & { using: string, fits: string[], bySolver: Map, conflict: Array<{module, using}>|null }}
 *   fits: every solver that serves all needs. conflict: when each need has an
 *   accessor but no single solver serves them all, the accessors that restrict it.
 *   With `only`, that solver and no other (update-page --using): "missing" are
 *   then the needs no accessor linking against it answers.
 */
export function resolvePipeline(needs, index, { prefer, only } = {}) {
  if (only) {
    const r = resolveNeeds(needs, index, { solver: only });
    return { ...r, using: only, fits: r.missing.length ? [] : [only], bySolver: new Map([[only, r]]), noRuntimes: false,
      conflict: null, unpublishedRuntimes: null,
      undeclared: r.needs.map((n) => n.chosen).filter((e) => e && !e.using?.length).map((e) => e.module) };
  }
  const bySolver = new Map(solverOrder(index, prefer).map((s) => [s, resolveNeeds(needs, index, { solver: s })]));
  // Every solver that serves all needs, the one that answers them by format
  // rather than by extension first (then in solverOrder).
  const fitsAll = [...bySolver].filter(([, r]) => !r.missing.length).map(([s]) => s)
    .map((s, i) => ({ s, i, ext: bySolver.get(s).byExtension })).sort((a, b) => a.ext - b.ext || a.i - b.i).map((x) => x.s);
  if (fitsAll.length) {
    const r = bySolver.get(fitsAll[0]);
    return { ...r, using: fitsAll[0], fits: fitsAll, bySolver, conflict: null, unpublishedRuntimes: null,
      undeclared: r.needs.map((n) => n.chosen).filter((e) => e && !e.using?.length).map((e) => e.module) };
  }
  // No solver serves everything: either something is not published at all, or
  // the accessors that exist disagree on the solver.
  const free = resolveNeeds(needs, index);
  const conflict = free.missing.length ? null
    : free.needs.map((n) => n.chosen).filter((e) => e.using?.length).map((e) => ({ module: e.module, using: e.using }));
  // Reported without the solver filter, so "missing" means "not published".
  // Accessors that agree on a runtime the registry does not publish are not
  // in conflict: that runtime is missing.
  const chosen = free.needs.map((n) => n.chosen).filter(Boolean);
  const shared = free.missing.length ? null : commonRuntimes(chosen.map((e) => e.using));
  const published = publishedRuntimes(index);
  const unpublished = shared?.length && published ? shared.filter((s) => !servesRuntime(published, s)) : null;
  const noRuntimes = !!published && !published.length && !free.missing.length;
  return { ...free, using: prefer ?? KNOWN_SOLVERS[0], fits: [], bySolver, noRuntimes,
    conflict: unpublished?.length || noRuntimes || !conflict?.length ? null : conflict, unpublishedRuntimes: unpublished?.length ? unpublished : null,
    undeclared: chosen.filter((e) => !e.using?.length).map((e) => e.module) };
}

/* One solver for a whole page: the loader keeps the first solver it loads, so
 * an element asking for another one fails. `pipelines` are resolvePipeline()
 * results; `present` the solvers the page already uses. Returns the solver
 * every pipeline fits, or null. */
export function pageSolver(pipelines, present = []) {
  const order = [...new Set([...present, ...pipelines.map((p) => p.using), ...pipelines.flatMap((p) => p.fits)])];
  return order.find((s) => pipelines.every((p) => p.fits.includes(s)) && present.every((x) => x === s)) ?? null;
}

/* The element to use, as the editor picks it (tags.service.ts): a video track
 * draws on a <canvas>, then image, then audio; failing tracks, the tag the
 * matching accessor's "extension" gives the extension. */
export function elementFor(tracks, resolved, fallbackKind) {
  const has = (t) => tracks?.some((x) => x['@type'] === t);
  if (has('Video')) return 'canvas';
  if (has('Image')) return 'img';
  if (has('Audio')) return 'audio';
  for (const n of resolved?.needs ?? []) {
    const tag = n.chosen?.extension?.[n.ext];
    if (tag) return tag === 'image' ? 'img' : tag;
  }
  return { image: 'img', audio: 'audio', video: 'canvas' }[fallbackKind] ?? null;
}
