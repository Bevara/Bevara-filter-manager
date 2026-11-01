// bevara.json schema (see docs/PACKAGE_FORMAT.md). Kept dependency-free so the
// same file is used by the CLI and the registry.

// Package names are namespaced like Warg/wkg packages: "<namespace>:<package>",
// e.g. "bevara:theora". A bare "theora" is resolved against the registry's
// default namespace. The .wasm keeps the short form: theora_1.wasm.
export const PART_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const NAME_RE = /^(?:[a-z0-9][a-z0-9._-]{0,63}:)?[a-z0-9][a-z0-9._-]{0,63}$/;

export function splitName(name) {
  const i = name.indexOf(':');
  return i < 0 ? { namespace: null, pkg: name } : { namespace: name.slice(0, i), pkg: name.slice(i + 1) };
}
export function fullName(name, defaultNamespace) {
  return name.includes(':') ? name : `${defaultNamespace}:${name}`;
}
export const shortName = (name) => splitName(name).pkg;
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// The .wasm base name, which the `with` attribute loads. Defaults to the
// package name; declared separately because package names are lowercase while
// an accessor file may not be (libOpenVVC_1.wasm).
export const MODULE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const KINDS = ['filter', 'runtime', 'tags'];
/* A module as pages name it in using="…" and with="…": <base>_<abi> for an
 * accessor (libpng_1), <base>_<x.y.z> for a runtime (mm_solver_1.0.1), whose
 * name carries its whole version so that a page pins the solver it was made
 * with. The ABI is the major either way. */
export const MODULE_ID_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*?)_(\d+)(?:\.(\d+)\.(\d+))?$/;
export function splitModule(id) {
  const m = MODULE_ID_RE.exec(String(id ?? ''));
  return m ? { base: m[1], abi: parseInt(m[2], 10), version: m[3] === undefined ? null : `${m[2]}.${m[3]}.${m[4]}` } : null;
}

/* Patent status of what a module implements. Every status is published and
 * served; the two restricted ones are announced to whoever installs, selects
 * or serves the module (CLI messages, index, HTTP headers). */
export const PATENT_STATUSES = ['royalty-free', 'expired', 'licence-required', 'under-review'];
export const isRestricted = (patents) => patents?.status === 'licence-required' || patents?.status === 'under-review';

/* The sentence an end user reads about a restricted module, or null. */
export function patentNotice(patents) {
  if (!isRestricted(patents)) return null;
  const where = patents.regions?.length ? ` in ${patents.regions.join(', ')}` : '';
  const what = patents.status === 'licence-required'
    ? `a patent licence may be required to use it${where}`
    : `its patent status is under review${where}: a licence may be required`;
  return `${what}${patents.note ? ` (${patents.note})` : ''}`;
}
// A tag script: the definition of a universal element, <name>_<generation>.js.
export const TAG_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*(?:_[A-Za-z0-9.-]+)*_\d+\.js$/;
export const SUPPORT_VALUES = ['image', 'audio', 'video', 'canvas', 'text', 'subtitle', 'container', 'other'];
export const STREAM_TYPES = ['visual', 'audio', 'text', 'file', 'scene', 'od', 'metadata', 'font', 'unknown'];

const isStr = (v) => typeof v === 'string';
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);

export function validateManifest(m, { forPublish = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { errors: ['manifest must be a JSON object'], warnings };

  if (!isStr(m.name)) errors.push('"name" is required');
  else if (!NAME_RE.test(m.name)) errors.push(`"name" must be "<namespace>:<package>" or "<package>" (lowercase, digits, . _ -), got ${JSON.stringify(m.name)}`);

  if (!isStr(m.version)) errors.push('"version" is required');
  else if (!SEMVER_RE.test(m.version)) errors.push(`"version" must be a valid semver (got ${JSON.stringify(m.version)})`);

  if (m.abi !== undefined && !(Number.isInteger(m.abi) && m.abi >= 1)) errors.push('"abi" must be a positive integer (it is the _N suffix of the .wasm file)');
  if (m.module !== undefined) {
    if (!isStr(m.module) || !MODULE_RE.test(m.module)) errors.push('"module" must be the base name of the built .wasm (letters, digits, . _ -)');
    else if (m.name && MODULE_RE.test(m.module) && m.module.toLowerCase() !== shortName(String(m.name)).toLowerCase())
      errors.push(`"module" (${m.module}) must match the package name (${shortName(String(m.name))}) up to case`);
  }

  if (!isStr(m.description) || !m.description.trim()) warnings.push('"description" is empty');

  // A runtime is a solver (a main module and its JavaScript), not a filter:
  // what it registers itself is "builtins", read from its loader.js.
  if (m.kind !== undefined && !KINDS.includes(m.kind)) errors.push(`"kind" must be one of ${KINDS.map((k) => JSON.stringify(k)).join(', ')} (got ${JSON.stringify(m.kind)})`);
  const runtime = m.kind === 'runtime';
  const tags = m.kind === 'tags';
  if (tags) {
    // The universal tags: the scripts that define the customised built-in
    // elements (universal-img_1.js…), which pages load with <script src>.
    if (m.filters !== undefined && !(Array.isArray(m.filters) && m.filters.length === 0)) errors.push('a tags package registers no "filters": it lists its scripts in "tags"');
    if (m.using !== undefined) errors.push('a tags package has no "using": the element names its solver in the page');
    if (!isStrArray(m.tags) || !m.tags.length || !m.tags.every((t) => TAG_FILE_RE.test(t))) errors.push('"tags" must list the scripts the package provides, as pages load them: ["universal-img_1.js", "universal-video_1.js"]');
    else if (new Set(m.tags.map((t) => /_(\d+)\.js$/.exec(t)[1])).size > 1) errors.push('the scripts in "tags" must all be of one generation (the _N of their names)');
    // A tag may build on another one (a customised universal-img_1): which, per script.
    if (m.extends !== undefined) {
      if (!m.extends || typeof m.extends !== 'object' || Array.isArray(m.extends)) errors.push('"extends" must map scripts of "tags" to the tag each one builds on: {"my-img_1.js": "universal-img_1"}');
      else for (const [script, base] of Object.entries(m.extends)) {
        if (Array.isArray(m.tags) && !m.tags.includes(script)) errors.push(`"extends" names ${script}, which is not in "tags"`);
        if (!isStr(base) || !/^[A-Za-z0-9][A-Za-z0-9._-]*_\d+$/.test(base)) errors.push(`"extends.${script}" must name a tag as pages do, e.g. "universal-img_1"`);
      }
    }
  } else if (runtime) {
    if (m.filters !== undefined && !(Array.isArray(m.filters) && m.filters.length === 0)) errors.push('a runtime registers no "filters": list what it registers itself in "builtins" (read from loader.js at publish)');
    if (m.using !== undefined) errors.push('a runtime is what accessors link against: it has no "using"');
    if (m.builtins !== undefined && !isStrArray(m.builtins)) errors.push('"builtins" must list GPAC filter names');
    if (isStr(m.version) && !/^\d+\.\d+\.\d+$/.test(m.version)) errors.push(`a runtime's "version" is part of its file name (mm_solver_1.0.1.wasm): x.y.z only (got ${JSON.stringify(m.version)})`);
  } else if (!isStrArray(m.filters) || m.filters.length === 0) errors.push('"filters" must list the GPAC filter names registered by the module (e.g. ["theoradec"])');

  if (m.support !== undefined) {
    if (!isStrArray(m.support)) errors.push('"support" must be an array of strings');
    else for (const s of m.support) if (!SUPPORT_VALUES.includes(s)) warnings.push(`unknown "support" value ${JSON.stringify(s)} (known: ${SUPPORT_VALUES.join(', ')})`);
  }
  if (m.formats !== undefined && !isStrArray(m.formats)) errors.push('"formats" must be an array of strings');
  if (m.extension !== undefined && (!m.extension || typeof m.extension !== 'object' || Array.isArray(m.extension) || !Object.values(m.extension).every(isStr)))
    errors.push('"extension" must map file extensions to the element that shows them ({"jxl": "img"})');
  if (m.keywords !== undefined && !isStrArray(m.keywords)) errors.push('"keywords" must be an array of strings');
  if (m.using !== undefined) {
    if (!isStrArray(m.using) || !m.using.length || !m.using.every((u) => splitModule(u)))
      errors.push('"using" must list the solvers the module links against, as pages name them (["mm_solver_1.0.1"], ["mm_solver_minimal_1.0.1", "mm_solver_1.0.1"])');
  } else if (forPublish && !runtime && !tags) errors.push('"using" must list the runtimes (solvers) the filter links against, as pages name them: ["mm_solver_minimal_1.0.1"], ["mm_solver_1.0.1"] - each must be published on the registry');
  if (m.license !== undefined && !isStr(m.license)) errors.push('"license" must be a string (SPDX identifier)');
  if (m.license === undefined && forPublish) warnings.push('no licence: add a LICENCE file (an "SPDX-License-Identifier:" line makes it exact)');
  // Patent status: any status is published and served, but users are told.
  if (m.licence_required !== undefined || m.georestrictions !== undefined) errors.push('"licence_required" and "georestrictions" are replaced by "patents": {"status": "royalty-free" | "expired" | "licence-required" | "under-review", "note", "regions", "checked"}');
  if (m.patents === undefined) { if (forPublish) errors.push(`"patents" must state the patent status of what the module implements: {"status": one of ${PATENT_STATUSES.join(', ')}}`); }
  else if (!m.patents || typeof m.patents !== 'object' || Array.isArray(m.patents)) errors.push('"patents" must be an object: {"status": ..., "note": ..., "regions": [...], "checked": "YYYY-MM-DD"}');
  else {
    if (!PATENT_STATUSES.includes(m.patents.status)) errors.push(`"patents.status" must be one of ${PATENT_STATUSES.join(', ')} (got ${JSON.stringify(m.patents.status)})`);
    if (m.patents.note !== undefined && !isStr(m.patents.note)) errors.push('"patents.note" must be a string (what is claimed, by whom)');
    if (m.patents.regions !== undefined && !(isStrArray(m.patents.regions) && m.patents.regions.every((r) => /^[A-Z]{2}$/.test(r)))) errors.push('"patents.regions" must list ISO 3166 country codes where the restriction applies (["US", "JP"]); absent means everywhere');
    if (m.patents.checked !== undefined && !(isStr(m.patents.checked) && /^\d{4}-\d{2}-\d{2}$/.test(m.patents.checked))) errors.push('"patents.checked" must be the date of the review, YYYY-MM-DD');
  }
  if (m.priority !== undefined && !(Number.isInteger(m.priority) && m.priority >= 0 && m.priority <= 255)) errors.push('"priority" must be an integer in [0, 255] (lower = preferred)');
  if (m.projects !== undefined && !isStrArray(m.projects)) errors.push('"projects" must list the upstream projects the module is built from (["ffmpeg"])');
  if (m.project !== undefined && !isStr(m.project)) errors.push('"project" must be a string');
  if (m.emsdk !== undefined && !(isStr(m.emsdk) && /^\d+\.\d+\.\d+$/.test(m.emsdk))) errors.push('"emsdk" is the Emscripten version the module was built with, e.g. "6.0.8" (derived from the build at publish)');
  if (m.language !== undefined && !['wasm', 'js'].includes(m.language)) errors.push('"language" must be "wasm" or "js"');
  if (m.runtime !== undefined) {
    if (!m.runtime || typeof m.runtime !== 'object' || Array.isArray(m.runtime)) errors.push('"runtime" must map GPAC filter names to {outputs: [{property, format}]}');
    else for (const [f, d] of Object.entries(m.runtime)) {
      if (Array.isArray(m.filters) && !m.filters.includes(f)) warnings.push(`"runtime" declares "${f}", which is not in "filters"`);
      for (const side of ['outputs', 'inputs']) {
        if (d?.[side] === undefined) continue;
        if (!Array.isArray(d[side]) || !d[side].every((c) => c && isStr(c.property) && (isStr(c.format) || isStrArray(c.format))))
          errors.push(`"runtime.${f}.${side}" must be a list of {property, format}, format a GPAC name or a list of them`);
      }
    }
  }
  if (m.caps !== undefined && (!Array.isArray(m.caps) || !m.caps.every((c) => c && isStr(c.filter) && Array.isArray(c.bundles))))
    errors.push('"caps" must list {filter, priority, bundles} (it is derived from the sources; do not write it by hand)');
  if (m.sources !== undefined && !isStr(m.sources)) errors.push('"sources" must be a URL string');
  if (m.homepage !== undefined && !isStr(m.homepage)) errors.push('"homepage" must be a URL string');
  if (m.main !== undefined && !isStr(m.main)) errors.push('"main" must be the path of the built .wasm');
  if (m.files !== undefined && !isStrArray(m.files)) errors.push('"files" must be an array of paths');

  for (const key of ['inputs', 'outputs']) {
    if (m[key] === undefined) continue;
    if (!Array.isArray(m[key])) { errors.push(`"${key}" must be an array of {stream_type, codec}`); continue; }
    m[key].forEach((cap, i) => {
      if (!cap || typeof cap !== 'object') return errors.push(`"${key}[${i}]" must be an object`);
      if (cap.stream_type !== undefined && !STREAM_TYPES.includes(cap.stream_type)) warnings.push(`"${key}[${i}].stream_type" ${JSON.stringify(cap.stream_type)} is not a known GPAC stream type`);
    });
  }

  if (m.dependencies !== undefined) {
    if (!m.dependencies || typeof m.dependencies !== 'object' || Array.isArray(m.dependencies)) errors.push('"dependencies" must be an object {name: range}');
    else for (const [k, v] of Object.entries(m.dependencies)) {
      if (!NAME_RE.test(k)) errors.push(`dependency name ${JSON.stringify(k)} is invalid`);
      if (!isStr(v)) errors.push(`dependency range for ${k} must be a string`);
    }
  }
  if (m.filter_source !== undefined && (typeof m.filter_source !== 'object' || Array.isArray(m.filter_source))) errors.push('"filter_source" must be an object {filter: source file}');
  if (m.scripts !== undefined && (typeof m.scripts !== 'object' || Array.isArray(m.scripts))) errors.push('"scripts" must be an object');

  return { errors, warnings };
}

/* The <name>.json manifests of the filter repositories predate the registry:
 * "Format" holds what the registry calls "formats" (or, failing that, the keys
 * of "extension"). The mapping is applied to
 * a copy when validating and publishing; the file itself keeps its own keys,
 * since its CMake build and the editor read them as they are. */
export function fromLegacy(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  if (out.formats === undefined && Array.isArray(m.Format)) out.formats = m.Format;
  // A few manifests have no "Format" but map file extensions to tags
  // ({"jxl": "img"}); the extensions are then the best format names we have.
  if (out.formats === undefined && m.extension && typeof m.extension === 'object' && !Array.isArray(m.extension)) out.formats = Object.keys(m.extension);
  return out;
}

export function normalizeManifest(m) {
  return {
    abi: 1,
    support: [],
    formats: [],
    keywords: [],
    dependencies: {},
    ...m,
  };
}

// Fields that are meaningful once published (everything a consumer needs).
export const PUBLIC_FIELDS = ['name', 'version', 'abi', 'kind', 'builtins', 'tags', 'extends', 'emsdk', 'module', 'description', 'filters', 'support', 'formats', 'extension', 'using', 'keywords', 'license', 'patents', 'priority', 'caps', 'projects', 'language', 'inputs', 'outputs', 'sources', 'homepage', 'filter_source', 'dependencies', 'help', 'author'];

export function publicManifest(m) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (m[k] !== undefined) out[k] = m[k];
  return out;
}
