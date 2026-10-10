import { log, color, table, CliError } from '../lib/ui.js';
import { Project } from '../lib/ctx.js';
import { extractCaps, runtimeDeclarations, projectsOf } from '../lib/caps.js';
import { fromLegacy } from '../lib/manifest.js';

export const options = { write: { type: 'boolean', short: 'w' }, all: { type: 'boolean', short: 'a' } };
export const help = `Shows what each GPAC filter of the accessor accepts and produces, as the
registry will publish it for capability-driven selection (bevara select):

  - the capability bundles of its register (SETCAPS) and its .priority, read
    from the C source - never copied into <name>.json, the source is the
    reference, as CMakeLists.txt is for the version and LICENCE for the licence;
  - the pixel and audio formats it sets on its output at run time
    (gf_filter_pid_set_property(…, GF_PROP_PID_PIXFMT, …)), which a decoder's
    static caps usually leave open.

When the format comes from a variable (ctx->ofmt), the source does not say
which formats it takes: the command lists the candidates it finds (literal
assignments, switch cases, the helper that computes it) and --write declares
them in <name>.json under "runtime", for you to review:

  "runtime": { "jxldec": { "outputs": [
    { "property": "GF_PROP_PID_PIXFMT", "format": ["GF_PIXEL_RGB", "GF_PIXEL_RGBA"] } ] } }

  bevara caps                 this repository
  bevara caps ../libjxl --write

Options:
  -w, --write    declare the unresolved run-time formats in <name>.json
  -a, --all      list every capability, not only the ones that select
      --json     the caps as they will be published`;

// The properties that tell pipelines apart; the rest is shown with --all.
const SELECTING = new Set(['GF_PROP_PID_STREAM_TYPE', 'GF_PROP_PID_CODECID', 'GF_PROP_PID_PIXFMT', 'GF_PROP_PID_AUDIO_FORMAT', 'GF_PROP_PID_FILE_EXT', 'GF_PROP_PID_MIME']);
const short = (s) => String(s).replace(/^GF_PROP_PID_|^GF_(PIXEL|AUDIO_FMT|STREAM|CODECID)_/, '');

function describe(caps, all) {
  const shown = caps.filter((c) => all || SELECTING.has(c.property));
  return shown.map((c) => `${c.excluded ? color.red('!') : ''}${short(c.property)}=${short(c.format)}${c.optional ? color.dim('?') : ''}${c.static ? color.dim('*') : ''}`).join(' ') || color.dim('-');
}

export async function run({ args, opts }) {
  if (args.length > 1) throw new CliError('caps takes one directory at most');
  const project = Project.load({ dir: args[0] });
  const m = fromLegacy(project.manifest);
  if (!Array.isArray(m.filters) || !m.filters.length) throw new CliError(`${project.manifestName} lists no "filters"`, { hint: 'caps reads the GPAC filters a filter repository declares; a site has none' });
  const found = extractCaps(project.root, m);
  const projects = typeof m.project === 'string' ? [m.project] : m.projects ?? projectsOf(project.root);

  if (opts.json) return console.log(JSON.stringify({ caps: found.caps, projects, unresolved: found.unresolved, missing: found.missing, notes: found.notes }, null, 2));

  for (const c of found.caps) {
    console.log(`${color.bold(c.filter)}  ${color.dim(`priority ${c.priority}`)}  ${color.dim(c.source)}`);
    const rows = c.bundles.map((b, i) => [color.dim(`#${i + 1}`), describe(b.inputs, opts.all), '→', describe(b.outputs, opts.all)]);
    if (rows.length) console.log(table(rows, { indent: '  ' }));
    for (const side of ['outputs', 'inputs']) {
      const rt = c.runtime?.[side];
      if (rt?.length) console.log(`  ${color.dim(side === 'outputs' ? 'at run time, outputs' : 'at run time, asks its input for')} ${rt.map((x) => short(x.format) + (x.declared ? color.dim(` (${project.manifestName})`) : '')).join(', ')}`);
    }
  }
  console.log(`${color.dim('projects')} ${projects.join(', ')}`);
  for (const f of found.missing) log.warn(`no GF_FilterRegister named "${f}" in the sources`);
  for (const n of found.notes) log.info(n);

  if (!found.unresolved.length) return log.ok(`every output format is known${found.caps.some((c) => c.runtime?.outputs?.some((x) => x.declared)) ? ` (with the declarations of ${project.manifestName})` : ''}`);
  for (const u of found.unresolved) {
    log.warn(`${u.filter} sets ${short(u.property)} from ${color.bold(u.expression)} at run time (${u.file}:${u.line})${u.candidates.length ? ` - candidates: ${u.candidates.map(short).join(', ')}` : ' - no candidate found: declare it by hand'}`);
  }
  if (!opts.write) return log.info(`declare them in ${project.manifestName} under "runtime": bevara caps --write proposes the candidates`);
  const runtime = runtimeDeclarations(project.manifest, found.unresolved);
  if (JSON.stringify(runtime) === JSON.stringify(project.manifest.runtime ?? {})) return log.warn('nothing to write: no candidate found');
  project.manifest.runtime = runtime;
  project.saveManifest();
  log.ok(`declared in ${project.manifestName} under "runtime" - review them: they are what the code names, not what it was seen to output`);
}
