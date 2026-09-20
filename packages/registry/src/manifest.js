// bevara.json schema (see docs/PACKAGE_FORMAT.md). Kept dependency-free so the
// same file is used by the CLI and the registry.

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const SUPPORT_VALUES = ['image', 'audio', 'video', 'canvas', 'text', 'subtitle', 'container', 'other'];
export const STREAM_TYPES = ['visual', 'audio', 'text', 'file', 'scene', 'od', 'metadata', 'font', 'unknown'];

const isStr = (v) => typeof v === 'string';
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);

export function validateManifest(m, { forPublish = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { errors: ['manifest must be a JSON object'], warnings };

  if (!isStr(m.name)) errors.push('"name" is required');
  else if (!NAME_RE.test(m.name)) errors.push(`"name" must match ${NAME_RE} (lowercase, digits, . _ -)`);

  if (!isStr(m.version)) errors.push('"version" is required');
  else if (!SEMVER_RE.test(m.version)) errors.push(`"version" must be a valid semver (got ${JSON.stringify(m.version)})`);

  if (m.abi !== undefined && !(Number.isInteger(m.abi) && m.abi >= 1)) errors.push('"abi" must be a positive integer (it is the _N suffix of the .wasm file)');

  if (!isStr(m.description) || !m.description.trim()) warnings.push('"description" is empty');

  if (!isStrArray(m.filters) || m.filters.length === 0) errors.push('"filters" must list the GPAC filter names registered by the module (e.g. ["theoradec"])');

  if (m.support !== undefined) {
    if (!isStrArray(m.support)) errors.push('"support" must be an array of strings');
    else for (const s of m.support) if (!SUPPORT_VALUES.includes(s)) warnings.push(`unknown "support" value ${JSON.stringify(s)} (known: ${SUPPORT_VALUES.join(', ')})`);
  }
  if (m.formats !== undefined && !isStrArray(m.formats)) errors.push('"formats" must be an array of strings');
  if (m.keywords !== undefined && !isStrArray(m.keywords)) errors.push('"keywords" must be an array of strings');
  if (m.license !== undefined && !isStr(m.license)) errors.push('"license" must be a string (SPDX identifier)');
  if (m.license === undefined && forPublish) warnings.push('"license" is not set');
  if (m.licence_required !== undefined && typeof m.licence_required !== 'boolean') errors.push('"licence_required" must be a boolean');
  if (m.georestrictions !== undefined && typeof m.georestrictions !== 'boolean' && !isStrArray(m.georestrictions)) errors.push('"georestrictions" must be false or an array of ISO country codes');
  if (m.priority !== undefined && !(Number.isInteger(m.priority) && m.priority >= 0 && m.priority <= 255)) errors.push('"priority" must be an integer in [0, 255] (lower = preferred)');
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

export function normalizeManifest(m) {
  return {
    abi: 1,
    support: [],
    formats: [],
    keywords: [],
    licence_required: false,
    georestrictions: false,
    priority: 50,
    dependencies: {},
    ...m,
  };
}

// Fields that are meaningful once published (everything a consumer needs).
export const PUBLIC_FIELDS = ['name', 'version', 'abi', 'description', 'filters', 'support', 'formats', 'keywords', 'license', 'licence_required', 'georestrictions', 'priority', 'inputs', 'outputs', 'sources', 'homepage', 'filter_source', 'dependencies', 'help', 'author'];

export function publicManifest(m) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (m[k] !== undefined) out[k] = m[k];
  return out;
}
