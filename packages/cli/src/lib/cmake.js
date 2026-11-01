/* Reads the add_filter() calls of a filter repository's CMakeLists.txt.
 *
 * The filter repositories declare each accessor with
 *
 *   add_filter(<name> <sources> <libs> <entry fns> <definitions> <includes> <link flags> <generation>)
 *
 * and the build writes <name>_<generation>.wasm. That file name is what pages
 * load (with="libjxl_1"), and the generation is "appropriately incremented as
 * modifications are made to the module". Both facts already live here, so the
 * CLI reads them instead of asking for them again in <name>.json.
 *
 * Only literal values are understood; an argument that is a CMake variable
 * (${VERSION}) is reported as unknown and the caller falls back to the build
 * output.
 */
import fs from 'node:fs';
import path from 'node:path';

// Argument positions of add_filter, from filters.cmake.
const NAME = 0;
const GENERATION = 7;

function stripComments(text) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === '\\') { out += text[++i] ?? ''; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return out;
}

function splitArgs(body) {
  const args = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    if (body[i] === '"') {
      let j = i + 1, v = '';
      while (j < body.length && body[j] !== '"') { if (body[j] === '\\') j++; v += body[j++]; }
      args.push({ value: v, quoted: true });
      i = j + 1;
    } else {
      let j = i, depth = 0;
      while (j < body.length && (depth > 0 || !/\s/.test(body[j]))) { if (body[j] === '(') depth++; else if (body[j] === ')') depth--; j++; }
      args.push({ value: body.slice(i, j), quoted: false });
      i = j;
    }
  }
  return args;
}

/* Every add_filter() call, as { name, generation, line }. generation is a
 * number, or null when it is not a literal. */
export function readAddFilters(root) {
  const file = path.join(root, 'CMakeLists.txt');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const src = stripComments(text);
  const calls = [];
  const re = /\badd_filter\s*\(/gi;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1, inStr = false;
    const start = i;
    for (; i < src.length && depth; i++) {
      const c = src[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    const args = splitArgs(src.slice(start, i - 1));
    const name = args[NAME] && !args[NAME].value.includes('${') ? args[NAME].value : null;
    const g = args[GENERATION]?.value;
    calls.push({
      name,
      generation: g !== undefined && /^\d+$/.test(g) ? parseInt(g, 10) : null,
      rawGeneration: g ?? null,
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return calls;
}

/* The add_filter() call that builds a given accessor: the one whose name
 * matches (letter case aside), or the only one. */
export function addFilterFor(root, name) {
  const calls = readAddFilters(root);
  const want = String(name ?? '').toLowerCase();
  return calls.find((c) => c.name && c.name.toLowerCase() === want) ?? (calls.length === 1 ? calls[0] : null);
}

/* The executables a solver's CMakeLists.txt builds as <base>_${VERSION}
 * (add_executable(mm_solver_minimal_${VERSION} …) with set(VERSION "1.0.1")):
 * each is <base>_<x.y.z>.js plus <base>_<x.y.z>.wasm, whose generation is the
 * major. Same shape as add_filter() calls. */
export function readExecutables(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8'); } catch { return []; }
  const src = stripComments(text);
  const version = /\bset\s*\(\s*VERSION\s+"?([^")\s]+)"?\s*\)/i.exec(src)?.[1];
  const out = [];
  for (const m of src.matchAll(/\badd_executable\s*\(\s*([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)_(\$\{VERSION\}|\d+(?:\.\d+\.\d+)?)(?=[\s)])/gi)) {
    const raw = m[2] === '${VERSION}' ? version ?? null : m[2];
    const g = raw && /^(\d+)(?:\.\d+\.\d+)?$/.exec(raw);
    out.push({ name: m[1], generation: g ? parseInt(g[1], 10) : null, version: g && raw.includes('.') ? raw : null, rawGeneration: raw, line: src.slice(0, m.index).split('\n').length, via: 'add_executable' });
  }
  return out;
}

export function executableFor(root, name) {
  const calls = readExecutables(root);
  const want = String(name ?? '').toLowerCase();
  return calls.find((c) => c.name.toLowerCase() === want) ?? (calls.length === 1 ? calls[0] : null);
}
