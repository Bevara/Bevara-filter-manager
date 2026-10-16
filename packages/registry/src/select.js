/* Capability-driven selection (paper, Section 5, "the full library"): instead
 * of naming modules, a client asks for every accessor whose declared inputs
 * satisfy the current output, under side conditions:
 *
 *   inputs:      - property: GF_PROP_PID_PIXFMT
 *                  format:   GF_PIXEL_RGBA
 *   version:     2.1
 *   IP:          { condition: false, license: , geocode: }
 *   projectname: "ffmpeg"
 *   language:    "wasm"
 *   size:        { condition: false, maxsize: }
 *   maxpriority: 50
 *
 * The same file is used by the CLI and the registry (packages/registry/src/
 * select.js is a copy, checked by a test), so that `bevara select` without a
 * registry endpoint and GET/POST /-/select answer alike. Dependency: semver.
 */
import semver from 'semver';

// GPAC property -> the prefix of its symbolic values.
const VALUE_PREFIX = {
  GF_PROP_PID_PIXFMT: 'GF_PIXEL_',
  GF_PROP_PID_AUDIO_FORMAT: 'GF_AUDIO_FMT_',
  GF_PROP_PID_STREAM_TYPE: 'GF_STREAM_',
  GF_PROP_PID_CODECID: 'GF_CODECID_',
};
// GPAC's display names (gpac -h props) for the common ones.
const PROP_ALIAS = {
  PIXELFORMAT: 'PIXFMT', PIXFMT: 'PIXFMT', AUDIOFORMAT: 'AUDIO_FORMAT', AFMT: 'AUDIO_FORMAT',
  STREAMTYPE: 'STREAM_TYPE', CODECID: 'CODECID', CODEC: 'CODECID',
};

/* GF_PROP_PID_PIXFMT, PIXFMT, PixelFormat -> GF_PROP_PID_PIXFMT. */
export function canonicalProperty(p) {
  const s = String(p ?? '').trim();
  if (/^GF_PROP_\w+$/.test(s)) return s;
  const key = s.toUpperCase().replace(/[^A-Z0-9_]/g, '');
  return `GF_PROP_PID_${PROP_ALIAS[key.replace(/_/g, '')] ?? key}`;
}

/* GF_PIXEL_RGBA, rgba, "jxl" -> one spelling to compare. */
export function canonicalValue(property, v) {
  let s = String(v ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/\s+/g, '');
  const prefix = VALUE_PREFIX[property];
  // A codec declared by its four characters, GF_4CC('J','X','L',' '), is
  // compared as GF_CODECID_JXL: queries name it as other codecs.
  const fourcc = /^GF_4CC\('(.?)','(.?)','(.?)','(.?)'\)$/.exec(s);
  if (fourcc && property === 'GF_PROP_PID_CODECID') s = prefix + fourcc.slice(1).join('');
  if (prefix && !/^GF_/.test(s) && /^\w+$/.test(s)) s = prefix + s;
  return /^GF_\w+$/.test(s) ? s.toUpperCase() : s.toLowerCase();
}

/* The values a cap allows: GPAC string caps list alternatives, "mp4|m4a". */
const capValues = (property, c) => canonicalValue(property, c.format).split('|');

/* "200kB", "1.5MB", 4096 -> bytes. */
export function parseSize(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const m = /^\s*([\d.]+)\s*(b|kb|kib|k|mb|mib|m)?\s*$/i.exec(String(v));
  if (!m) return NaN;
  const unit = { b: 1, k: 1e3, kb: 1e3, kib: 1024, m: 1e6, mb: 1e6, mib: 1048576 }[(m[2] ?? 'b').toLowerCase()];
  return Math.round(parseFloat(m[1]) * unit);
}

const pick = (q, ...keys) => { for (const k of Object.keys(q)) if (keys.includes(k.toLowerCase())) return q[k]; return undefined; };
const list = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * The paper's query, with its spellings (IP, projectname, maxpriority…),
 * brought to one shape. Throws Error with a message on a malformed query.
 */
export function normalizeQuery(q = {}) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error('the query must be an object');
  const caps = (key) => {
    const raw = pick(q, key);
    if (raw === undefined) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.flatMap((c, i) => {
      if (!c || typeof c !== 'object' || !c.property) throw new Error(`${key}[${i}] must be {property, format}`);
      const property = canonicalProperty(c.property);
      return list(c.format ?? c.value).map((f) => ({ property, format: canonicalValue(property, f) }));
    });
  };
  const ip = pick(q, 'ip') ?? {};
  const size = pick(q, 'size') ?? {};
  const out = {
    inputs: caps('inputs'),
    outputs: caps('outputs'),
    version: pick(q, 'version') == null || pick(q, 'version') === '' ? null : String(pick(q, 'version')).trim(),
    ip: { condition: truthy(ip.condition), license: list(ip.license ?? ip.licence), geocode: ip.geocode ? String(ip.geocode).trim().toUpperCase() : null },
    projects: list(pick(q, 'projectname', 'project', 'projects')),
    language: pick(q, 'language') ? String(pick(q, 'language')).trim().toLowerCase() : null,
    size: { condition: truthy(size.condition), maxsize: parseSize(size.maxsize) },
    maxpriority: pick(q, 'maxpriority') == null || pick(q, 'maxpriority') === '' ? null : Number(pick(q, 'maxpriority')),
    filter: pick(q, 'filter') ? String(pick(q, 'filter')) : null,
  };
  if (out.version) {
    // A bare version is a minimum, as the paper lists it with maxsize and
    // maxpriority; anything with an operator is a semver range.
    const bare = /^\d+(\.\d+){0,2}$/.test(out.version);
    out.range = bare ? `>=${semver.coerce(out.version).version}` : out.version;
    if (!semver.validRange(out.range)) throw new Error(`"version": ${JSON.stringify(out.version)} is neither a version nor a semver range`);
  }
  if (out.size.condition && !(typeof out.size.maxsize === 'number' && out.size.maxsize >= 0)) throw new Error('"size": condition is true but "maxsize" is missing or not a size (bytes, "200kB", "1.5MB")');
  if (out.maxpriority !== null && !Number.isFinite(out.maxpriority)) throw new Error('"maxpriority" must be a number (GPAC priority: 0-255, lower is preferred)');
  if (!out.inputs.length && !out.outputs.length && !out.filter && !out.projects.length) throw new Error('the query selects nothing: give "inputs" (what the modules must accept), "outputs", "projectname" or "filter"');
  return out;
}

// What a raw-format property says about the rest of the PID.
const IMPLIED = {
  GF_PROP_PID_PIXFMT: [['GF_PROP_PID_STREAM_TYPE', 'GF_STREAM_VISUAL'], ['GF_PROP_PID_CODECID', 'GF_CODECID_RAW']],
  GF_PROP_PID_AUDIO_FORMAT: [['GF_PROP_PID_STREAM_TYPE', 'GF_STREAM_AUDIO'], ['GF_PROP_PID_CODECID', 'GF_CODECID_RAW']],
};

/* The PID described by the query's inputs: property -> values (one property
 * may be listed with several formats, any of which may come). */
function pidOf(inputs) {
  const pid = new Map();
  for (const c of inputs) (pid.get(c.property) ?? pid.set(c.property, new Set()).get(c.property)).add(c.format);
  for (const c of inputs) for (const [p, v] of IMPLIED[c.property] ?? []) if (!pid.has(p)) pid.set(p, new Set([v]));
  return pid;
}

/* Does a capability bundle accept the PID? As GPAC does, per property: an
 * excluded value rejects, and when the bundle lists values the PID's must be
 * one of them. A property the query does not give is not held against the
 * bundle (the query describes the current output partially). A bundle with no
 * input cap is a source, not a candidate. */
export function bundleAccepts(bundle, statics, pid) {
  const caps = [...(bundle.inputs ?? []), ...statics].filter((c) => !c.loaded_filter);
  if (!caps.some((c) => !c.excluded)) return false;
  const byProp = new Map();
  for (const c of caps) (byProp.get(c.property) ?? byProp.set(c.property, []).get(c.property)).push(c);
  let explicit = false;
  for (const [prop, cs] of byProp) {
    const values = pid.get(prop);
    if (!values) continue;
    for (const v of values) {
      if (cs.some((c) => c.excluded && capValues(prop, c).includes(v))) return false;
      const allowed = cs.filter((c) => !c.excluded);
      if (allowed.some((c) => capValues(prop, c).includes(v))) { if (prop !== 'GF_PROP_PID_STREAM_TYPE' || onlyStreamType(pid)) explicit = true; }
      else if (allowed.length && !allowed.every((c) => c.optional)) return false;
    }
  }
  // Saying nothing against the query is not enough: the bundle must accept one
  // of its properties by name. The stream type alone does not count, unless it
  // is all the query gives - every demultiplexer takes "a file".
  return explicit;
}
const onlyStreamType = (pid) => [...pid.keys()].every((p) => p === 'GF_PROP_PID_STREAM_TYPE');

/* Outputs a filter declares, statically in a bundle or at run time. */
function produces(bundle, statics, runtime, wanted) {
  const outs = [...(bundle?.outputs ?? []), ...statics, ...(runtime?.outputs ?? [])].filter((c) => !c.excluded);
  return wanted.every((w) => outs.some((c) => c.property === w.property && capValues(w.property, c).includes(w.format)));
}

const bare = (s) => String(s).toLowerCase().replace(/^lib/, '');

/* Side conditions on the accessor as a whole; returns the reason it is left
 * out, or null. */
export function sideConditions(entry, q) {
  if (q.range && !semver.satisfies(entry.version, q.range)) return `version ${entry.version} outside ${q.range}`;
  if (q.language && (entry.language ?? 'wasm').toLowerCase() !== q.language) return `language ${entry.language ?? 'wasm'}`;
  if (q.projects.length && !(entry.projects ?? []).some((p) => q.projects.some((w) => bare(w) === bare(p)))) return `projects ${(entry.projects ?? []).join(', ') || 'unknown'}`;
  if (q.size.condition && !(entry.size <= q.size.maxsize)) return `size ${entry.size} > ${q.size.maxsize}`;
  if (q.ip.condition) {
    // Patent status: a licence required, or a status under review, rules the
    // accessor out where it applies (everywhere, or the regions listed that
    // contain geocode); an undeclared status is not assumed free.
    const p = entry.patents;
    if (!p?.status) return 'patent status undeclared';
    if (p.status === 'licence-required' || p.status === 'under-review') {
      const where = p.regions?.length ? p.regions.map((g) => String(g).toUpperCase()) : null;
      if (!where || !q.ip.geocode || where.includes(q.ip.geocode)) return `patents ${p.status}${where ? ` in ${where.join(', ')}` : ''}${p.note ? ` (${p.note})` : ''}`;
    }
    if (q.ip.license.length && !q.ip.license.some((l) => l.toLowerCase() === String(entry.license ?? '').toLowerCase())) return `licence ${entry.license ?? 'unknown'}`;
  }
  return null;
}

/**
 * Selects the accessors of an index (entries as /accessors/index.json lists
 * them, with "caps") that answer the query.
 * @returns {{ matches: object[], excluded: object[], uncharacterised: string[] }}
 *   matches: one per accessor filter that fits, most preferred first (GPAC
 *   priority, then size); excluded: accessors whose caps fit but a side
 *   condition rules out, with the reason; uncharacterised: accessors published
 *   without caps, which no capability query can select.
 */
export function selectAccessors(entries, query) {
  const q = query.inputs && query.ip ? query : normalizeQuery(query);
  const pid = pidOf(q.inputs);
  const matches = [], excluded = [], uncharacterised = [];
  for (const e of entries) {
    if (!Array.isArray(e.caps) || !e.caps.length) { if (q.inputs.length || q.outputs.length) { uncharacterised.push(e.name); continue; } }
    const hits = [];
    for (const f of e.caps ?? [{ filter: null, priority: e.priority ?? 0, bundles: [] }]) {
      if (q.filter && f.filter !== q.filter) continue;
      const bundles = f.bundles ?? [];
      // Static caps hold in every bundle of the filter.
      const statics = bundles.flatMap((b) => (b.inputs ?? []).filter((c) => c.static));
      const staticOuts = bundles.flatMap((b) => (b.outputs ?? []).filter((c) => c.static));
      const fit = !q.inputs.length && !q.outputs.length ? 0
        : bundles.findIndex((b) => (!q.inputs.length || bundleAccepts({ ...b, inputs: (b.inputs ?? []).filter((c) => !c.static) }, statics, pid))
          && (!q.outputs.length || produces({ ...b, outputs: (b.outputs ?? []).filter((c) => !c.static) }, staticOuts, f.runtime, q.outputs)));
      if (fit < 0) continue;
      if (q.maxpriority !== null && (f.priority ?? 0) > q.maxpriority) { excluded.push({ name: e.name, filter: f.filter, reason: `priority ${f.priority} > ${q.maxpriority}` }); continue; }
      hits.push({ f, bundle: bundles[fit] });
    }
    if (!hits.length) continue;
    const why = sideConditions(e, q);
    if (why) { excluded.push({ name: e.name, filter: hits.map((h) => h.f.filter).join(', '), reason: why }); continue; }
    for (const { f, bundle } of hits) {
      matches.push({
        name: e.name, version: e.version, file: e.file, url: e.url, filter: f.filter, priority: f.priority ?? 0,
        size: e.size, brSize: e.brSize, projects: e.projects, language: e.language ?? 'wasm', license: e.license,
        patents: e.patents ?? null, using: e.using,
        accepts: bundle?.inputs ?? [], produces: [...(bundle?.outputs ?? []), ...(f.runtime?.outputs ?? [])].filter((c) => !c.excluded),
      });
    }
  }
  matches.sort((a, b) => a.priority - b.priority || (a.size ?? Infinity) - (b.size ?? Infinity) || a.name.localeCompare(b.name));
  return { query: q, matches, excluded, uncharacterised };
}
