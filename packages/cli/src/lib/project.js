import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from './ui.js';

/* Two kinds of projects carry a manifest:
 *
 *  - a filter repository describes its accessor in <name>.json (libjxl.json),
 *    the file its CMake build already reads into filter_list.json and the
 *    editor ships. That file stays the single source of truth: the CLI reads
 *    it and writes back into it, adding only what a registry needs (version,
 *    license);
 *  - a site that installs accessors has no filter name to put in a file name,
 *    so it uses bevara.json.
 *
 * bevara.json also wins when both exist, so it can override a filter manifest.
 */
export const MANIFEST = 'bevara.json';
export const LOCKFILE = 'bevara-lock.json';
export const DEFAULT_ACCESSORS_DIR = 'accessors';

// JSON files that are never a filter manifest, whatever they contain.
const NOT_MANIFESTS = new Set([MANIFEST, LOCKFILE, 'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json']);

const shortName = (n) => (typeof n === 'string' && n.includes(':') ? n.slice(n.indexOf(':') + 1) : n);

/* A filter manifest is a <name>.json whose "name" is <name> (a namespace
 * prefix is allowed: "bevara:libjxl" in libjxl.json) and which lists the GPAC
 * filters it registers. That rule matches every existing filter repository
 * and nothing else they contain (filter_list.json, recommended.json…). */
export function filterManifestsIn(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const found = [];
  for (const f of entries) {
    if (!f.endsWith('.json') || NOT_MANIFESTS.has(f)) continue;
    const file = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (data && shortName(data.name) === f.slice(0, -5) && Array.isArray(data.filters)) found.push(file);
  }
  return found.sort();
}

/* The manifest of one directory, or null. Throws when several filter
 * manifests make the choice ambiguous. */
export function manifestIn(dir) {
  const site = path.join(dir, MANIFEST);
  const legacy = filterManifestsIn(dir);
  if (fs.existsSync(site)) return { file: site, shadowed: legacy };
  if (legacy.length > 1) {
    throw new CliError(`several filter manifests in ${dir}: ${legacy.map((f) => path.basename(f)).join(', ')}`, {
      hint: 'run the command from the directory of the filter you mean',
    });
  }
  return legacy.length ? { file: legacy[0], shadowed: [] } : null;
}

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const m = manifestIn(dir);
    if (m) return { root: dir, ...m };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new CliError(`cannot parse ${file}: ${e.message}`);
  }
}

/* Indentation of an existing JSON document, so rewriting it does not reformat
 * a file people maintain by hand (the filter manifests use four spaces). */
export function detectIndent(text, fallback = 2) {
  const line = (text ?? '').split('\n').slice(1).find((l) => /^\s+\S/.test(l));
  if (!line) return fallback;
  const ws = /^(\s+)/.exec(line)[1];
  return ws.includes('\t') ? '\t' : ws.length;
}

/* Top-level entries of a JSON object document, with the exact text span of
 * each key and value. Returns null for anything that is not a plain object. */
export function scanTopLevel(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => {                       // text[i] === '"'
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return start;
  };
  const value = () => {
    if (text[i] === '"') { str(); return; }
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') { str(); continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) { i++; return; } }
        i++;
      }
      return;
    }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;   // number, true, false, null
  };
  ws();
  if (text[i] !== '{') return null;
  const open = i++;
  const entries = [];
  for (;;) {
    ws();
    if (text[i] === '}') return { open, close: i, entries };
    if (text[i] !== '"') return null;
    const keyStart = str();
    let key;
    try { key = JSON.parse(text.slice(keyStart, i)); } catch { return null; }
    ws();
    if (text[i++] !== ':') return null;
    ws();
    const valueStart = i;
    value();
    entries.push({ key, keyStart, valueStart, valueEnd: i });
    ws();
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '}') return { open, close: i, entries };
    return null;
  }
}

/* Rewrites only the top-level entries that changed between `before` and
 * `after`, leaving every other byte of a hand-formatted file untouched. Returns
 * null when the document is not something we can edit that way. */
export function updateJsonText(text, before, after, indent = 2) {
  const doc = scanTopLevel(text);
  if (!doc) return null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const lineIndent = (pos) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', pos) + 1))[0];
  // Continuation lines of a multi-line value start at the entry's own indentation.
  const render = (v, pad) => JSON.stringify(v, null, indent).replace(/\n/g, '\n' + pad);
  const edits = [];
  const present = new Set(doc.entries.map((e) => e.key));
  doc.entries.forEach((e, n) => {
    if (!(e.key in after)) {
      // Remove the entry together with the comma that separates it.
      const from = n > 0 ? doc.entries[n - 1].valueEnd : e.keyStart;
      const to = n > 0 ? e.valueEnd : (doc.entries[n + 1]?.keyStart ?? e.valueEnd);
      edits.push({ from, to, text: '' });
    } else if (!same(before[e.key], after[e.key])) {
      edits.push({ from: e.valueStart, to: e.valueEnd, text: render(after[e.key], lineIndent(e.keyStart)) });
    }
  });
  const added = Object.keys(after).filter((k) => !present.has(k));
  if (added.length) {
    const last = doc.entries[doc.entries.length - 1];
    const pad = last ? lineIndent(last.keyStart) : (typeof indent === 'number' ? ' '.repeat(indent) : indent);
    const at = last ? last.valueEnd : doc.open + 1;
    const body = added.map((k) => `${pad}${JSON.stringify(k)}: ${render(after[k], pad)}`).join(',\n');
    edits.push({ from: at, to: at, text: (last ? ',\n' : '\n') + body + (last ? '' : '\n') });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  try { JSON.parse(out); } catch { return null; }   // never leave a broken file behind
  return out;
}

export function writeJsonFile(file, data, { indent = 2 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, indent) + '\n');
}

export class Project {
  /* `manifestFile` is null when the directory has no manifest yet. */
  constructor(root, manifestFile = null, { shadowed = [] } = {}) {
    this.root = root;
    this.manifestFile = manifestFile;
    this.shadowed = shadowed;
    this.manifestText = manifestFile && fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : null;
    this.manifest = this.manifestText ? readJsonFile(manifestFile) ?? {} : {};
    this.lock = readJsonFile(path.join(root, LOCKFILE)) ?? { lockfileVersion: 1, filters: {} };
    this.lock.filters ??= {};
  }

  /* `dir` names the project explicitly (bevara publish ../libjxl). Its
   * manifest must be in that very directory: walking up from a directory the
   * user named could silently pick a parent project. */
  static load({ required = true, dir } = {}) {
    if (dir !== undefined) {
      const root = path.resolve(dir);
      let st = null;
      try { st = fs.statSync(root); } catch { /* reported below */ }
      if (!st) throw new CliError(`${dir}: no such directory`);
      if (!st.isDirectory()) throw new CliError(`${dir} is not a directory`, { hint: 'pass the filter repository, e.g. `bevara publish ../libjxl`' });
      const m = manifestIn(root);
      if (!m) throw new CliError(`no manifest in ${root}`, { hint: 'a filter repository has a <name>.json (e.g. libjxl.json) whose "name" is <name>' });
      return new Project(root, m.file, { shadowed: m.shadowed });
    }
    const found = findProjectRoot();
    if (!found) {
      if (required) throw new CliError('no manifest found in this directory or its parents', {
        hint: 'a filter repository needs its <name>.json (e.g. libjxl.json), a site a bevara.json: `bevara init` creates one, `bevara install <filter>` starts a site',
      });
      return new Project(process.cwd());
    }
    return new Project(found.root, found.file, { shadowed: found.shadowed });
  }

  static create(dir, manifest, file = MANIFEST, { indent = 2 } = {}) {
    const target = path.join(dir, file);
    writeJsonFile(target, manifest, { indent });
    return new Project(dir, target);
  }

  /* File name used in messages: "libjxl.json" or "bevara.json". */
  get manifestName() { return this.manifestFile ? path.basename(this.manifestFile) : MANIFEST; }
  /* True for <name>.json filter manifests (the file shared with CMake). */
  get isFilterManifest() { return !!this.manifestFile && path.basename(this.manifestFile) !== MANIFEST; }

  get accessorsDir() { return path.resolve(this.root, this.manifest.accessorsDir ?? DEFAULT_ACCESSORS_DIR); }
  get isFilter() { return Array.isArray(this.manifest.filters) && this.manifest.filters.length > 0; }

  /* Writes back into the file it came from. Only the entries that changed are
   * rewritten, so a hand-formatted <name>.json keeps its layout and a diff
   * shows exactly what the command changed. */
  saveManifest() {
    const file = this.manifestFile ?? path.join(this.root, MANIFEST);
    const indent = detectIndent(this.manifestText);
    const before = this.manifestText ? JSON.parse(this.manifestText) : null;
    const surgical = before ? updateJsonText(this.manifestText, before, this.manifest, indent) : null;
    if (surgical !== null) fs.writeFileSync(file, surgical);
    else writeJsonFile(file, this.manifest, { indent });
    this.manifestFile = file;
    this.manifestText = fs.readFileSync(file, 'utf8');
  }
  saveLock(registry) {
    this.lock.lockfileVersion = 1;
    if (registry) this.lock.registry = registry;
    const sorted = {};
    for (const k of Object.keys(this.lock.filters).sort()) sorted[k] = this.lock.filters[k];
    this.lock.filters = sorted;
    writeJsonFile(path.join(this.root, LOCKFILE), this.lock);
  }

  // Range declared in the manifest for a (canonical) filter name, accepting the bare alias.
  rangeFor(name) {
    const deps = this.manifest.dependencies ?? {};
    const short = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    return deps[name] ?? deps[short];
  }

  installedFile(name) {
    const entry = this.lock.filters[name];
    return entry ? path.join(this.accessorsDir, entry.file) : null;
  }

  localIntegrity(name) {
    const file = this.installedFile(name);
    if (!file || !fs.existsSync(file)) return null;
    return 'sha256-' + createHash('sha256').update(fs.readFileSync(file)).digest('base64');
  }
}
