import fs from 'node:fs';
import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { normalizeQuery, selectAccessors } from '../lib/select.js';

export const options = {
  input: { type: 'string', short: 'i', multiple: true },
  output: { type: 'string', short: 'o', multiple: true },
  'max-priority': { type: 'string', short: 'p' },
  project: { type: 'string', multiple: true },
  'max-size': { type: 'string' },
  version: { type: 'string' },
  language: { type: 'string' },
  license: { type: 'string', multiple: true },
  geocode: { type: 'string' },
  filter: { type: 'string' },
  local: { type: 'boolean' },
};

export const help = `Selects accessors by capability (paper, Section 5): not by name, but every
accessor whose declared inputs accept the current output, under side
conditions. The query is the paper's, as a JSON (or YAML-like) file or flags:

  inputs:
    - property: GF_PROP_PID_PIXFMT
      format:   GF_PIXEL_RGBA
  version:     2.1                                 minimum version (or a semver range)
  IP:          { condition: false, license: , geocode: }
  projectname: "ffmpeg"
  language:    "wasm"
  size:        { condition: false, maxsize: }      bytes, or "200kB", "1.5MB"
  maxpriority: 50                                  GPAC .priority, lower is preferred

  bevara select query.json
  bevara select -i PIXFMT=RGBA -p 50
  bevara select -i CODECID=JXL                     who decodes JPEG XL
  bevara select -o PIXFMT=RGBA                     who can produce RGBA
  bevara select -i PIXFMT=YUV --project ffmpeg --max-size 2MB
  bevara select -i AUDIO_FORMAT=S16 --license MIT --geocode FR

Values take GPAC's names, with or without their prefix (GF_PIXEL_RGBA, RGBA).
A raw format implies a raw stream: PIXFMT=RGBA also means a visual stream with
GF_CODECID_RAW, so decoders of compressed streams are left out. The answer
comes from the registry (GET/POST /-/select); --local, or a registry older
than the endpoint, runs the same selection on its index.

Options:
  -i, --input PROP=VALUE     a property of the current output (repeatable)
  -o, --output PROP=VALUE    a property the module must produce (repeatable)
  -p, --max-priority <n>     GPAC priority bound
      --project <name>       upstream project (repeatable)
      --max-size <size>      size bound on the .wasm
      --version <v|range>    accessor version
      --language <wasm|js>
      --license <spdx>       accepted licences (repeatable); turns the IP condition on
      --geocode <CC>         jurisdiction for patent licences; turns the IP condition on
      --filter <name>        only this GPAC filter
      --local                select on the index, without the registry endpoint
      --json                 machine-readable answer`;

/* "PIXFMT=RGBA" -> {property, format}. */
function cap(spec, flag) {
  const m = /^([^=]+)=(.+)$/.exec(spec);
  if (!m) throw new CliError(`${flag} ${spec}: expected PROPERTY=VALUE, e.g. ${flag} PIXFMT=RGBA`);
  return { property: m[1].trim(), format: m[2].split(',').map((x) => x.trim()) };
}

/* The paper prints the query in a YAML-like notation; JSON is accepted, and so
 * is that notation for the subset it uses (key: value, { a: b , c: }, - list items). */
export function parseQueryText(text) {
  try { return JSON.parse(text); } catch { /* not JSON */ }
  const scalar = (v) => {
    const s = v.trim();
    if (s === '') return null;
    if (/^".*"$|^'.*'$/.test(s)) return s.slice(1, -1).trim();
    if (s === 'true' || s === 'false') return s === 'true';
    if (/^-?\d+(\.\d+)?$/.test(s) && !/^\d+\.\d+\.\d+/.test(s)) return /\./.test(s) ? s : Number(s);
    if (/^\{.*\}$/.test(s)) return Object.fromEntries(s.slice(1, -1).split(',').map((kv) => kv.split(':')).filter((kv) => kv[0].trim()).map(([k, ...v]) => [k.trim(), scalar(v.join(':'))]));
    return s;
  };
  const TOP = new Set(['inputs', 'outputs', 'version', 'ip', 'projectname', 'project', 'projects', 'language', 'size', 'maxpriority', 'filter']);
  const out = {};
  let list = null, item = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const dash = /^\s*-\s*(.*)$/.exec(raw);
    const kv = /^(\s*)([\w.-]+)\s*:\s*(.*)$/.exec(dash ? dash[1] : raw);
    if (dash && list) { item = {}; list.push(item); if (kv) item[kv[2]] = scalar(kv[3]); continue; }
    if (!kv) throw new CliError(`cannot read the query line: ${raw.trim()}`, { hint: 'write the query as JSON, or as "key: value" lines as in the paper' });
    // An item's next keys are indented - or not, once pasted from a PDF.
    if (item && (kv[1].length || !TOP.has(kv[2].toLowerCase()))) { item[kv[2]] = scalar(kv[3]); continue; }
    item = null; list = null;
    if (kv[3].trim() === '') { list = out[kv[2]] = []; continue; }
    out[kv[2]] = scalar(kv[3]);
  }
  return out;
}

export async function run({ args, opts }) {
  if (args.length > 1) throw new CliError('select takes one query file at most');
  let query = {};
  if (args[0]) {
    let text;
    try { text = args[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args[0], 'utf8'); } catch { throw new CliError(`${args[0]}: cannot read the query file`); }
    query = parseQueryText(text);
  }
  if (opts.input) query.inputs = [...(query.inputs ?? []), ...opts.input.map((s) => cap(s, '-i'))];
  if (opts.output) query.outputs = [...(query.outputs ?? []), ...opts.output.map((s) => cap(s, '-o'))];
  if (opts['max-priority'] !== undefined) query.maxpriority = opts['max-priority'];
  if (opts.project) query.projectname = opts.project;
  if (opts['max-size']) query.size = { condition: true, maxsize: opts['max-size'] };
  if (opts.version) query.version = opts.version;
  if (opts.language) query.language = opts.language;
  if (opts.filter) query.filter = opts.filter;
  if (opts.license || opts.geocode) query.IP = { condition: true, license: opts.license, geocode: opts.geocode };
  try { normalizeQuery(query); } catch (e) { throw new CliError(`invalid query: ${e.message}`, { hint: 'bevara select --help shows the query format' }); }

  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  let answer = null, where = registry;
  if (!opts.local) {
    try { answer = await client.post('/-/select', query, { auth: false }); } catch (e) {
      if (e.status !== 404 && e.status !== 405) throw e;
      where = `${registry} (its index: the registry predates /-/select)`;
    }
  }
  if (!answer) {
    const index = await client.get('/accessors/index.json', { auth: false });
    answer = selectAccessors(index.filters ?? [], query);
  }
  if (opts.json) return console.log(JSON.stringify(answer, null, 2));

  const { matches, excluded = [], uncharacterised = [] } = answer;
  if (matches.length) {
    console.log(table(matches.map((x) => [
      color.bold(x.file?.replace(/\.wasm$/, '') ?? x.name), x.filter ?? '', String(x.priority), x.size != null ? formatBytes(x.size) : '?',
      (x.projects ?? []).filter((p) => p !== 'gpac').join(',') || 'gpac', x.license ?? color.dim('?'), x.licence_required ? color.yellow('patent') : '',
    ]), { header: ['Accessor', 'GPAC filter', 'Priority', 'Size', 'Projects', 'Licence', ''].map(color.bold) }));
    log.ok(`${matches.length} match${matches.length > 1 ? 'es' : ''} on ${where}, most preferred first`);
  } else log.warn(`no accessor on ${where} answers this query`);
  for (const x of excluded) log.info(`${color.dim('excluded')} ${x.name}${x.filter ? ` (${x.filter})` : ''}: ${x.reason}`);
  if (uncharacterised.length) log.info(`${uncharacterised.length} accessor${uncharacterised.length > 1 ? 's were' : ' was'} published without capabilities and cannot be selected this way (republish them with this CLI): ${uncharacterised.slice(0, 8).join(', ')}${uncharacterised.length > 8 ? '…' : ''}`);
}
