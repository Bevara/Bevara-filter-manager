/* What each GPAC filter of an accessor accepts and produces, read from its C
 * source: the capability bundles its register declares (SETCAPS), its
 * .priority, and the pixel and audio formats it sets on its output PIDs at
 * run time, which the static caps of a decoder usually leave open.
 *
 * This is what the registry selects on (paper, Section 5, "the full library"):
 * a client asks not for a named module but for every module whose declared
 * inputs satisfy the current output, under side conditions. The source is the
 * reference, as CMakeLists.txt is for the version and LICENCE for the licence:
 * nothing it says is copied into <name>.json. The manifest only declares what
 * the source cannot tell (see `runtime` in docs/PACKAGE_FORMAT.md).
 *
 * Values keep GPAC's symbolic names (GF_PROP_PID_PIXFMT, GF_PIXEL_RGBA), the
 * vocabulary of the paper's queries; no value is evaluated. Preprocessor
 * conditionals are not evaluated either: every branch is read.
 */
import fs from 'node:fs';
import path from 'node:path';

// GPAC's GF_CAPFLAG_* bits and the GF_CAPS_* combinations (filters.h).
// RECONFIG comes with newer GPAC releases, which some repositories carry.
const CAPFLAG = { IN_BUNDLE: 1, INPUT: 2, OUTPUT: 4, EXCLUDED: 8, LOADED_FILTER: 16, STATIC: 32, OPTIONAL: 64, RECONFIG: 128 };
const CAPS = {
  GF_CAPS_INPUT: ['INPUT'],
  GF_CAPS_INPUT_OPT: ['INPUT', 'OPTIONAL'],
  GF_CAPS_INPUT_STATIC: ['INPUT', 'STATIC'],
  GF_CAPS_INPUT_STATIC_OPT: ['INPUT', 'STATIC', 'OPTIONAL'],
  GF_CAPS_INPUT_EXCLUDED: ['INPUT', 'EXCLUDED'],
  GF_CAPS_INPUT_LOADED_FILTER: ['INPUT', 'LOADED_FILTER'],
  GF_CAPS_OUTPUT: ['OUTPUT'],
  GF_CAPS_OUTPUT_LOADED_FILTER: ['OUTPUT', 'LOADED_FILTER'],
  GF_CAPS_OUTPUT_EXCLUDED: ['OUTPUT', 'EXCLUDED'],
  GF_CAPS_OUTPUT_STATIC: ['OUTPUT', 'STATIC'],
  GF_CAPS_OUTPUT_STATIC_EXCLUDED: ['OUTPUT', 'EXCLUDED', 'STATIC'],
  GF_CAPS_INPUT_OUTPUT: ['INPUT', 'OUTPUT'],
  GF_CAPS_INPUT_OUTPUT_OPT: ['INPUT', 'OUTPUT', 'OPTIONAL'],
  GF_CAPS_IN_OUT_EXCLUDED: ['INPUT', 'OUTPUT', 'EXCLUDED'],
};

// Properties a filter sets at run time that select a pipeline: the raw formats.
export const RUNTIME_PROPS = ['GF_PROP_PID_PIXFMT', 'GF_PROP_PID_AUDIO_FORMAT'];
const RUNTIME_VALUE = { GF_PROP_PID_PIXFMT: /^GF_PIXEL_\w+$/, GF_PROP_PID_AUDIO_FORMAT: /^GF_AUDIO_FMT_\w+$/ };

const SKIP_DIRS = new Set(['.bevara', '.git', 'build', 'lib', 'include', 'third_parties', 'third_party', 'node_modules']);

/* Comments become spaces (offsets are kept, so line numbers stay right);
 * string and character literals are left alone. */
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && n === '/') {
      const j = src.indexOf('\n', i); const end = j < 0 ? src.length : j;
      out += ' '.repeat(end - i); i = end;
    } else if (c === '/' && n === '*') {
      const j = src.indexOf('*/', i + 2); const end = j < 0 ? src.length : j + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end;
    } else { out += c; i++; }
  }
  return out;
}

// Preprocessor lines go too: every branch of an #if is read.
const dropDirectives = (src) => src.replace(/^[ \t]*#.*$/gm, (l) => ' '.repeat(l.length));

/* The text between the brace at `open` and its match. */
function braced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1; i = j; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: src.slice(open + 1, i), end: i };
  }
  return null;
}

/* Splits on top-level commas (outside (), {} and literals). */
export function splitTop(s) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1; i = j; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const tidy = (v) => v.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ',').trim();
const unparen = (v) => { let s = v.trim(); while (/^\(.*\)$/.test(s) && braced(s.replace(/^\(/, '{').replace(/\)$/, '}'), 0)?.end === s.length - 1) s = s.slice(1, -1).trim(); return s; };

/* GF_CAPS_INPUT_OUTPUT, (GF_CAPFLAG_IN_BUNDLE|GF_CAPFLAG_INPUT)… -> flag names. */
export function parseFlags(expr) {
  const flags = new Set();
  for (const tok of unparen(expr).split('|').map((t) => t.trim()).filter(Boolean)) {
    if (CAPS[tok]) CAPS[tok].forEach((f) => flags.add(f));
    else if (/^GF_CAPFLAG_(\w+)$/.test(tok) && CAPFLAG[tok.slice(11)]) flags.add(tok.slice(11));
    else return null;
  }
  return flags;
}

/* One entry of a GF_FilterCapability array: a CAP_*() macro, a designated
 * initialiser, or {0} (end of bundle). */
export function parseCapEntry(entry) {
  const e = entry.trim();
  if (/^\{\s*(0\s*)?\}$/.test(e)) return { separator: true };
  let m = /^(CAP_\w+)\s*\(([\s\S]*)\)$/.exec(e);
  if (m) {
    const args = splitTop(m[2]);
    if (args.length < 3) return { unknown: e };
    const cap = { flags: args[0], property: tidy(args[1]), format: tidy(args.slice(2, m[1] === 'CAP_FRAC_INT' ? 4 : 3).join('/')) };
    if (m[1] === 'CAP_UINT_PRIORITY' && args[3]) cap.priority = tidy(args[3]);
    return cap;
  }
  m = /^\{([\s\S]*)\}$/.exec(e);
  if (m) {
    const fields = {};
    for (const part of splitTop(m[1])) {
      const f = /^\.(\w+)\s*=\s*([\s\S]+)$/.exec(part);
      if (f) fields[f[1]] = f[2].trim();
    }
    if (!Object.keys(fields).length) return positional(splitTop(m[1])) ?? { unknown: e };
    const value = /\.value(?:\.\w+)+\s*=\s*([^,}]+)/.exec(fields.val ?? '');
    if (!fields.code || !fields.flags || !value) return { unknown: e };
    const cap = { flags: fields.flags, property: tidy(fields.code), format: tidy(value[1]) };
    if (fields.priority) cap.priority = tidy(fields.priority);
    return cap;
  }
  return { unknown: e };
}

/* {flags, code, {type, {.uint = V}}, NULL, priority} and other positional
 * initialisers: each part is recognised by what it holds, not by its rank. */
function positional(parts) {
  const flags = parts.find((x) => /GF_CAPS_|GF_CAPFLAG_/.test(x));
  const property = parts.find((x) => /^GF_PROP_\w+$/.test(x) && !/^GF_PROP_(UINT|SINT|BOOL|STRING|NAME|4CC|FRACTION|FLOAT|DOUBLE|LUINT|LSINT)$/.test(x));
  const val = parts.find((x) => x.startsWith('{'));
  const value = val && /\.\w+\s*=\s*([^,}]+)/.exec(val);
  if (!flags || !property || !value) return null;
  const cap = { flags, property: tidy(property), format: tidy(value[1]) };
  const last = parts.at(-1);
  if (parts.length >= 5 && /^\d+$/.test(last) && last !== '0') cap.priority = last;
  return cap;
}

/* A cap as published: property, format, and what its flags make of it. */
function shapeCap(raw, side, flags) {
  const cap = { property: raw.property, format: raw.format };
  if (flags.has('EXCLUDED')) cap.excluded = true;
  if (flags.has('OPTIONAL')) cap.optional = true;
  if (flags.has('STATIC')) cap.static = true;
  if (flags.has('LOADED_FILTER')) cap.loaded_filter = true;
  if (raw.priority !== undefined) cap.priority = /^\d+$/.test(raw.priority) ? Number(raw.priority) : raw.priority;
  return cap;
}

/* GF_FilterCapability arrays of a source, by C name -> bundles. */
export function capArrays(src) {
  const arrays = new Map();
  const re = /GF_FilterCapability\s+(\w+)\s*\[\s*\w*\s*\]\s*=\s*\{/g;
  for (let m; (m = re.exec(src));) {
    const block = braced(src, m.index + m[0].length - 1);
    if (!block) continue;
    const bundles = [{ inputs: [], outputs: [] }];
    const unknown = [];
    for (const entry of splitTop(block.body)) {
      const cap = parseCapEntry(entry);
      if (cap.separator) { if (bundles.at(-1).inputs.length || bundles.at(-1).outputs.length) bundles.push({ inputs: [], outputs: [] }); continue; }
      const flags = cap.unknown ? null : parseFlags(cap.flags);
      if (!flags) { unknown.push(tidy(cap.unknown ?? entry)); continue; }
      if (flags.has('INPUT')) bundles.at(-1).inputs.push(shapeCap(cap, 'input', flags));
      if (flags.has('OUTPUT')) bundles.at(-1).outputs.push(shapeCap(cap, 'output', flags));
    }
    if (!bundles.at(-1).inputs.length && !bundles.at(-1).outputs.length) bundles.pop();
    arrays.set(m[1], { bundles, unknown, line: lineOf(src, m.index) });
  }
  return arrays;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/* GF_FilterRegister definitions: name, caps array, priority. */
export function registers(src) {
  const out = [];
  const re = /GF_FilterRegister\s+(\w+)\s*=\s*\{/g;
  for (let m; (m = re.exec(src));) {
    const block = braced(src, m.index + m[0].length - 1);
    if (!block) continue;
    const reg = { cname: m[1], line: lineOf(src, m.index) };
    for (const part of splitTop(block.body)) {
      let f;
      if ((f = /^\.name\s*=\s*"([^"]*)"/.exec(part))) reg.name = f[1];
      else if ((f = /^SETCAPS\s*\(\s*(\w+)\s*\)/.exec(part))) reg.caps = f[1];
      else if ((f = /^\.caps\s*=\s*(\w+)/.exec(part))) reg.caps = f[1];
      else if ((f = /^\.priority\s*=\s*([\s\S]+)$/.exec(part))) reg.priority = /^\d+$/.test(f[1].trim()) ? Number(f[1].trim()) : tidy(f[1]);
    }
    if (reg.name) out.push(reg);
  }
  return out;
}

/* Formats set on PIDs at run time: gf_filter_pid_set_property(…, GF_PROP_PID_PIXFMT,
 * &PROP_UINT(GF_PIXEL_RGB)) gives an output format; negotiate_property, the
 * format the filter asks of its input. A non-literal value (ctx->ofmt) is
 * reported as unresolved with the formats the code names near it. */
export function runtimeFormats(src) {
  const found = { outputs: [], inputs: [], unresolved: [] };
  const re = /gf_filter_pid_(set|negotiate)_property\s*\(\s*[^,;]+,\s*(GF_PROP_PID_\w+)\s*,\s*&\s*PROP_UINT\s*\(([^;]*?)\)\s*\)\s*;/g;
  for (let m; (m = re.exec(src));) {
    const property = m[2];
    if (!RUNTIME_PROPS.includes(property)) continue;
    const expr = tidy(m[3]);
    const side = m[1] === 'set' ? 'outputs' : 'inputs';
    // A literal, or a choice between literals (has_alpha ? GF_PIXEL_RGBA : GF_PIXEL_RGB).
    const literals = RUNTIME_VALUE[property].test(expr) ? [expr]
      : /^[^?]+\?\s*\w+\s*:\s*\w+$/.test(expr) ? expr.split('?')[1].split(':').map((x) => x.trim()) : [];
    if (literals.length && literals.every((x) => RUNTIME_VALUE[property].test(x))) {
      for (const format of literals) if (!found[side].some((c) => c.property === property && c.format === format)) found[side].push({ property, format });
    } else if (side === 'outputs' && !found.unresolved.some((u) => u.property === property && u.expression === expr)) {
      found.unresolved.push({ property, expression: expr, line: lineOf(src, m.index), candidates: candidatesFor(src, property, expr) });
    }
  }
  return found;
}

/* The formats a variable may hold: literal assignments to it, and the case
 * labels of the switches that dispatch on it. A hint for the author, never
 * published as such. */
function candidatesFor(src, property, expr) {
  const kind = property === 'GF_PROP_PID_PIXFMT' ? 'GF_PIXEL_' : 'GF_AUDIO_FMT_';
  const set = new Set();
  const v = expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\-\\>|->/g, '\\s*->\\s*');
  for (const m of src.matchAll(new RegExp(`${v}\\s*=\\s*(${kind}\\w+)`, 'g'))) set.add(m[1]);
  // v = helper(…) with the helper in the same file: the formats it returns.
  for (const m of src.matchAll(new RegExp(`${v}\\s*=\\s*(\\w+)\\s*\\(`, 'g'))) {
    const def = new RegExp(`\\b${m[1]}\\s*\\([^;{)]*\\)\\s*\\{`).exec(src);
    const body = def && braced(src, def.index + def[0].length - 1)?.body;
    for (const r of body?.matchAll(new RegExp(`\\b(${kind}\\w+)`, 'g')) ?? []) set.add(r[1]);
  }
  for (const m of src.matchAll(new RegExp(`switch\\s*\\(\\s*${v}\\s*\\)\\s*\\{`, 'g'))) {
    const block = braced(src, m.index + m[0].length - 1);
    for (const c of block?.body.matchAll(new RegExp(`case\\s+(${kind}\\w+)\\s*:`, 'g')) ?? []) set.add(c[1]);
  }
  return [...set];
}

/* Which run-time formats describe what the filter outputs. A parser (rfjpeg)
 * sets PIXFMT on a compressed stream as information only, so the formats count
 * when an output is raw or the codec is left open (a demultiplexer); and the
 * code ffmpeg wrappers share sets pixel formats in an audio-only build. */
const PROP_MEDIA = { GF_PROP_PID_PIXFMT: ['image', 'video', 'canvas'], GF_PROP_PID_AUDIO_FORMAT: ['audio'] };
export function relevantRuntime(rt, bundles, support) {
  const producing = bundles.filter((b) => b.outputs.some((c) => !c.excluded));
  const codecs = producing.map((b) => b.outputs.filter((c) => c.property === 'GF_PROP_PID_CODECID' && !c.excluded).map((c) => c.format));
  const raw = !producing.length || codecs.some((list) => !list.length || list.includes('GF_CODECID_RAW'));
  const media = Array.isArray(support) && support.length ? support : null;
  const keep = (x) => raw && (!media || PROP_MEDIA[x.property].some((k) => media.includes(k)));
  return { outputs: rt.outputs.filter(keep), inputs: rt.inputs.filter((x) => !media || PROP_MEDIA[x.property].some((k) => media.includes(k))), unresolved: rt.unresolved.filter(keep) };
}

/* The C files of a repository that may hold its filters. */
function sourceFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (depth < 3 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); }
      else if (/\.(c|cc|cpp)$/.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Extracts the capabilities of the filters a manifest lists.
 * @param {string} root      repository root
 * @param {object} manifest  <name>.json (filters, filter_source, runtime)
 * @returns {{ caps: object[], missing: string[], unresolved: object[], notes: string[] }}
 *   caps: one entry per GPAC filter, as published; missing: filters whose
 *   register was not found; unresolved: run-time formats the source does not
 *   name and the manifest does not declare.
 */
export function extractCaps(root, manifest) {
  const notes = [];
  const wanted = Array.isArray(manifest.filters) ? manifest.filters : [];
  const declared = manifest.runtime && typeof manifest.runtime === 'object' ? manifest.runtime : {};
  // Parse each file once; filter_source points at the register's file first.
  const parsed = new Map();
  const parse = (file) => {
    if (!parsed.has(file)) {
      let src = '';
      try { src = dropDirectives(stripComments(fs.readFileSync(file, 'utf8'))); } catch { /* unreadable */ }
      parsed.set(file, { src, arrays: capArrays(src), regs: registers(src) });
    }
    return parsed.get(file);
  };
  const hinted = (name) => {
    const rel = manifest.filter_source?.[name];
    if (typeof rel !== 'string') return [];
    return [path.join(root, rel), path.join(root, 'src', rel)].filter((f) => fs.existsSync(f));
  };
  let all = null;
  const caps = [], missing = [], unresolved = [];
  for (const name of wanted) {
    let hit = null;
    for (const file of [...hinted(name), ...(all ??= sourceFiles(root))]) {
      const p = parse(file);
      const reg = p.regs.find((r) => r.name === name);
      if (reg) { hit = { file, p, reg }; break; }
    }
    // The manifest may use the name the filter takes at run time (ffdec for
    // the register "ffdec-h26x", gf_filter_set_name) or an older one: a file
    // that filter_source names and that holds a single register is that filter.
    if (!hit) {
      for (const file of hinted(name)) {
        const p = parse(file);
        if (p.regs.length === 1) { hit = { file, p, reg: p.regs[0] }; notes.push(`${name}: ${path.relative(root, file)} registers it as "${p.regs[0].name}"`); break; }
      }
    }
    if (!hit) { missing.push(name); continue; }
    const { file, p, reg } = hit;
    const rel = path.relative(root, file);
    const entry = { filter: name, priority: typeof reg.priority === 'number' ? reg.priority : 0, source: rel };
    if (typeof reg.priority === 'string') { entry.priority = 0; notes.push(`${name}: .priority = ${reg.priority} is not a number; taken as 0, GPAC's default`); }
    const arr = reg.caps ? (p.arrays.get(reg.caps) ?? [...parsed.values()].map((x) => x.arrays.get(reg.caps)).find(Boolean)) : null;
    if (reg.caps && !arr) notes.push(`${name}: capability array ${reg.caps} not found`);
    if (!reg.caps) notes.push(`${name}: the register declares no static caps (SETCAPS); they are set at run time`);
    entry.bundles = arr?.bundles ?? [];
    for (const u of arr?.unknown ?? []) notes.push(`${name}: capability not understood in ${rel}: ${u}`);

    const rt = relevantRuntime(runtimeFormats(p.src), entry.bundles, manifest.support);
    const decl = declared[name] ?? {};
    const runtime = { outputs: [...rt.outputs], inputs: [...rt.inputs] };
    for (const side of ['outputs', 'inputs']) {
      for (const d of Array.isArray(decl[side]) ? decl[side] : []) {
        for (const format of [].concat(d.format ?? [])) {
          if (!runtime[side].some((c) => c.property === d.property && c.format === format)) runtime[side].push({ property: d.property, format, declared: true });
        }
      }
    }
    for (const u of rt.unresolved) {
      const covered = runtime.outputs.some((c) => c.declared && c.property === u.property);
      if (!covered) unresolved.push({ filter: name, file: rel, ...u });
    }
    if (runtime.outputs.length || runtime.inputs.length) entry.runtime = Object.fromEntries(Object.entries(runtime).filter(([, v]) => v.length));
    caps.push(entry);
  }
  return { caps, missing, unresolved, notes };
}

/* The run-time declarations to add to <name>.json for what the source leaves
 * unresolved: the candidate formats, per filter, merged with what is declared. */
export function runtimeDeclarations(manifest, unresolved) {
  const runtime = structuredClone(manifest.runtime ?? {});
  for (const u of unresolved) {
    if (!u.candidates.length) continue;
    const outs = (runtime[u.filter] ??= {}).outputs ??= [];
    let decl = outs.find((d) => d.property === u.property);
    if (!decl) outs.push(decl = { property: u.property, format: [] });
    decl.format = [...new Set([...[].concat(decl.format ?? []), ...u.candidates])];
  }
  return runtime;
}

/* The upstream projects an accessor is built from (the paper's
 * "projectname"), read from the static libraries it links in lib/: libavcodec
 * means FFmpeg, libjxl libjxl. Every accessor is also GPAC filter code. A
 * "projects" list in the manifest replaces this. */
const RUNTIME_LIBS = /^lib(c|c\+\+|c\+\+abi|m|pthread|compiler_rt|dl|rt|stdc\+\+)$/;
const LIB_PROJECT = {
  libgpac_static: 'gpac', libgpac: 'gpac',
  libavcodec: 'ffmpeg', libavformat: 'ffmpeg', libavutil: 'ffmpeg', libavfilter: 'ffmpeg', libswscale: 'ffmpeg', libswresample: 'ffmpeg', libavdevice: 'ffmpeg',
  libbrotlicommon: 'brotli', libbrotlidec: 'brotli', libbrotlienc: 'brotli', libhwy: 'highway',
  libpng16: 'libpng', libopenjp2: 'openjpeg', libflac: 'flac', libwebpdecoder: 'libwebp', libxvidcore: 'xvid',
  'libopencore-amrnb': 'opencore-amr', 'libopencore-amrwb': 'opencore-amr', libdjvulibre: 'djvulibre',
  libmac: 'monkeys-audio', libdcadec: 'dcadec', libg72x: 'g72x', libvvdec: 'vvdec', libmpcdec: 'musepack',
  libschroedinger: 'schroedinger', libskp_silk_sdk: 'silk', libxcftools: 'xcftools', libjpegxr: 'jxrlib', libjxrglue: 'jxrlib',
  libjbig2dec: 'jbig2dec', libflif_dec: 'flif', libbpgdec: 'libbpg', libtimidity_core: 'timidity', libarc: 'timidity', libunimod: 'timidity',
};
export function projectsOf(root) {
  let files = [];
  try { files = fs.readdirSync(path.join(root, 'lib')); } catch { /* no prebuilt libraries */ }
  const out = new Set(['gpac']);
  for (const f of files) {
    const m = /^(lib[\w+.-]+?)\.a$/.exec(f);
    if (!m || RUNTIME_LIBS.test(m[1])) continue;
    const base = m[1].toLowerCase().replace(/_version$|-third$/, '');
    if (base !== m[1].toLowerCase() && files.includes(`${base}.a`)) continue;   // libaom_version.a with libaom.a
    out.add(LIB_PROJECT[base] ?? base);
  }
  return [...out];
}

/* The GPAC filters a solver registers itself, from its loader.js
 * (Module._fin_register…, registered with addFunction): what an accessor need
 * not bring. */
export function runtimeBuiltins(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, 'loader.js'), 'utf8'); } catch { return null; }
  const names = new Set();
  for (const m of text.matchAll(/\b_([a-z0-9]+)_register\b/g)) if (m[1] !== 'auto') names.add(m[1]);
  return [...names].sort();
}
