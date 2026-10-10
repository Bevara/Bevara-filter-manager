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

  if (!isStrArray(m.filters) || m.filters.length === 0) errors.push('"filters" must list the GPAC filter names registered by the module (e.g. ["theoradec"])');

  if (m.support !== undefined) {
    if (!isStrArray(m.support)) errors.push('"support" must be an array of strings');
    else for (const s of m.support) if (!SUPPORT_VALUES.includes(s)) warnings.push(`unknown "support" value ${JSON.stringify(s)} (known: ${SUPPORT_VALUES.join(', ')})`);
  }
  if (m.formats !== undefined && !isStrArray(m.formats)) errors.push('"formats" must be an array of strings');
  if (m.extension !== undefined && (!m.extension || typeof m.extension !== 'object' || Array.isArray(m.extension) || !Object.values(m.extension).every(isStr)))
    errors.push('"extension" must map file extensions to the element that shows them ({"jxl": "img"})');
  if (m.keywords !== undefined && !isStrArray(m.keywords)) errors.push('"keywords" must be an array of strings');
  if (m.using !== undefined) {
    if (!isStrArray(m.using) || !m.using.length || !m.using.every((u) => /^[A-Za-z0-9][A-Za-z0-9._-]*_\d+$/.test(u)))
      errors.push('"using" must list the solvers the module links against, as pages name them (["solver_1"], ["solver_minimal_1", "solver_1"])');
  } else if (forPublish) warnings.push('"using" is not set: the module is taken to link against any solver (list the ones it works with, e.g. ["solver_1"])');
  if (m.license !== undefined && !isStr(m.license)) errors.push('"license" must be a string (SPDX identifier)');
  if (m.license === undefined && forPublish) warnings.push('no licence: add a LICENCE file (an "SPDX-License-Identifier:" line makes it exact)');
  if (m.licence_required !== undefined && typeof m.licence_required !== 'boolean') errors.push('"licence_required" must be a boolean');
  if (m.georestrictions !== undefined && typeof m.georestrictions !== 'boolean' && !isStrArray(m.georestrictions)) errors.push('"georestrictions" must be false or an array of ISO country codes');
  if (m.priority !== undefined && !(Number.isInteger(m.priority) && m.priority >= 0 && m.priority <= 255)) errors.push('"priority" must be an integer in [0, 255] (lower = preferred)');
  if (m.projects !== undefined && !isStrArray(m.projects)) errors.push('"projects" must list the upstream projects the module is built from (["ffmpeg"])');
  if (m.project !== undefined && !isStr(m.project)) errors.push('"project" must be a string');
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
    licence_required: false,
    georestrictions: false,
    dependencies: {},
    ...m,
  };
}

// Fields that are meaningful once published (everything a consumer needs).
export const PUBLIC_FIELDS = ['name', 'version', 'abi', 'module', 'description', 'filters', 'support', 'formats', 'extension', 'using', 'keywords', 'license', 'licence_required', 'georestrictions', 'priority', 'caps', 'projects', 'language', 'inputs', 'outputs', 'sources', 'homepage', 'filter_source', 'dependencies', 'help', 'author'];

export function publicManifest(m) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (m[k] !== undefined) out[k] = m[k];
  return out;
}
