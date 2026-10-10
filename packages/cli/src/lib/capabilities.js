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
    if (!s.Format) { needs.push({ role: 'decode', type, format: null, unidentified: true }); continue; }
    if (needs.some((n) => n.role === 'decode' && key(n.format) === key(s.Format))) continue;
    needs.push({ role: 'decode', type, format: s.Format, profile: s.Format_Profile, ext, byExtension: elementary });
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

function fits(entry, need) {
  if (need.role === 'encode') return entry.file === `${need.module}.wasm`;
  if (need.format && (entry.formats ?? []).some((f) => key(f) === key(need.format))) return true;
  if (!need.byExtension || !need.ext) return false;
  // Before "extension" was published, a manifest without "Format" had its
  // extension keys published as "formats": they still name extensions.
  const exts = entry.extension ? Object.keys(entry.extension) : entry.formats ?? [];
  return exts.some((e) => key(e) === key(need.ext));
}

/* An accessor is a side module: it links against the solver the page loads
 * (using="…"), and only some solvers export what it imports - isobmff needs
 * solver_1, libtta solver_minimal_1. Its manifest says which in "using"; an
 * accessor that does not say is taken to work with any. */
export const fitsSolver = (entry, solver) => !entry.using?.length || entry.using.includes(solver);

// The solvers the player ships, most capable for the fewest bytes first.
export const KNOWN_SOLVERS = ['solver_minimal_1', 'solver_1'];

/**
 * Answers each need from the registry index, among the accessors that link
 * against `solver` when one is given.
 * @returns {{ needs: Array<need & { candidates: object[], chosen: object|null }>, with: string[], missing: object[] }}
 */
export function resolveNeeds(needs, index, { solver } = {}) {
  const entries = (index?.filters ?? []).map((e) => ({ ...e, module: e.file.replace(/\.wasm$/, '') }))
    .filter((e) => !solver || fitsSolver(e, solver));
  const resolved = needs.map((need) => {
    const candidates = need.unidentified ? [] : entries.filter((e) => fits(e, need))
      .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50) || a.module.localeCompare(b.module));
    return { ...need, candidates, chosen: candidates[0] ?? null };
  });
  const withList = [];
  for (const n of resolved) if (n.chosen && !withList.includes(n.chosen.module)) withList.push(n.chosen.module);
  return { needs: resolved, with: withList, missing: resolved.filter((n) => !n.chosen) };
}

/* Every solver worth trying, `prefer` first, then those the player ships, then
 * any other a published accessor names. */
export function solverOrder(index, prefer) {
  const all = [prefer, ...KNOWN_SOLVERS, ...(index?.filters ?? []).flatMap((e) => e.using ?? [])].filter(Boolean);
  return [...new Set(all)];
}

/**
 * Resolves the needs and picks the solver: the first, in solverOrder(), under
 * which every need finds an accessor.
 * @returns {resolveNeeds() & { using: string, fits: string[], bySolver: Map, conflict: Array<{module, using}>|null }}
 *   fits: every solver that serves all needs. conflict: when each need has an
 *   accessor but no single solver serves them all, the accessors that restrict it.
 */
export function resolvePipeline(needs, index, { prefer } = {}) {
  const bySolver = new Map(solverOrder(index, prefer).map((s) => [s, resolveNeeds(needs, index, { solver: s })]));
  const fitsAll = [...bySolver].filter(([, r]) => !r.missing.length).map(([s]) => s);
  if (fitsAll.length) return { ...bySolver.get(fitsAll[0]), using: fitsAll[0], fits: fitsAll, bySolver, conflict: null };
  // No solver serves everything: either something is not published at all, or
  // the accessors that exist disagree on the solver.
  const free = resolveNeeds(needs, index);
  const conflict = free.missing.length ? null
    : free.needs.map((n) => n.chosen).filter((e) => e.using?.length).map((e) => ({ module: e.module, using: e.using }));
  // Reported without the solver filter, so "missing" means "not published".
  return { ...free, using: prefer ?? KNOWN_SOLVERS[0], fits: [], bySolver, conflict };
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
