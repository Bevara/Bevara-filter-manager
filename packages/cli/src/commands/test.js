import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { Project, clientFor } from '../lib/ctx.js';
import { registryCombinations, fetchModules, mediaKind } from '../lib/run-prep.js';
import { closeMediaInfo } from '../lib/mediainfo.js';
import { sniff, CONTAINER_MODULES } from '../lib/sniff.js';
import { VIDEO_TAIL } from '../lib/formats.js';
import { readLocal } from '../lib/source.js';
import { runSession, requireSolver, missingModules, findSolver, solverForCombination } from '../lib/runner.js';
import { SOLVER, SOLVER_MINIMAL } from '../lib/solvers.js';

export const options = {
  with: { type: 'string', multiple: true, short: 'W' },
  accessors: { type: 'string', short: 'a' },
  expect: { type: 'string', multiple: true },
  timeout: { type: 'string' },
  solver: { type: 'string', short: 's' },
  verbose: { type: 'boolean', short: 'v' },
};

export const help = `Runs a real pipeline on a media file and reports whether it decodes.

The solver links the accessors as side modules exactly as a page does, GPAC
resolves the filter graph from the file's capabilities, and the result says
which filters connected, how many packets each one processed, and what came
out. A graph that resolves but decodes nothing is a failure, not a pass.

  bevara test clip.ogv                       accessors chosen on the registry for the file
  bevara test clip.ogv -W "ogg_1;theora_1"   test one explicit combination
  bevara test clip.mp4 -W "isobmff_1;h264bsd_1" -W "isobmff_1;ffmpeg-h26x_1"
  bevara test samples/*                      a whole corpus, one line per file

Options:
  -W, --with "a_1;b_1"   filter combination to test; repeat to test several
  -a, --accessors <dir>  run with the modules of this directory instead
                         (default: nothing to install - the file is identified,
                         its accessors and a runtime they share are chosen on
                         the registry and cached in ~/.bevara/cache)
      --expect <filter>  require this GPAC filter in the resolved graph (repeatable)
      --timeout <s>      give up on a session after this long (default 120)
  -s, --solver <name>    ${SOLVER} (default, reports statistics) or ${SOLVER_MINIMAL}
  -v, --verbose          print the full GPAC log
      --json             machine-readable report`;

export function accessorsDirFor(opts, project) {
  const dir = path.resolve(opts.accessors ?? project.accessorsDir);
  if (!fs.existsSync(dir)) throw new CliError(`accessors directory not found: ${dir}`, { hint: 'run `bevara install`, or pass --accessors <dir>' });
  return dir;
}

export async function probeFile(file) {
  const { head, tail, size } = await readLocal(file);
  const info = sniff({ head, tail, name: file, size });
  /* A page re-encodes the decoded frames to something the browser can play;
   * here the sink is raw, so the encoder tail is not part of what we test.
   * isobmff_1 belongs to that tail but is also the MP4 demultiplexer, so it
   * stays whenever the container needs it. */
  const demux = CONTAINER_MODULES[info.container] ?? [];
  return { ...info, decodeWith: info.with.filter((m) => demux.includes(m) || !VIDEO_TAIL.includes(m)) };
}

/* One run: returns { combination, result, verdict }. */
export async function runCase(file, modules, info, dir, opts) {
  const missing = missingModules(dir, modules);
  if (missing.length) return { modules, missing, result: null };
  // A page loads one solver: the accessors must share a runtime, and the run uses it.
  let solver, undeclared = [];
  try { ({ solver, undeclared } = solverForCombination(dir, info.kind, opts.solver, modules)); }
  catch (e) { if (e instanceof CliError) return { modules, missing: [], result: null, incompatible: e }; throw e; }
  const result = await runSession({
    accessorsDir: dir, solver, modules,
    inputFile: file, inputExt: path.extname(file).slice(1) || undefined,
    kind: info.kind ?? 'video', verbose: opts.verbose,
  }, { timeoutMs: (parseInt(opts.timeout ?? '120', 10) || 120) * 1000 });
  return { modules, missing: [], result, solver, undeclared };
}

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara test <file...>');
  const project = Project.load({ required: false });
  const local = opts.accessors ? accessorsDirFor(opts, project) : null;
  const { registry, client } = clientFor(opts, project);
  const index = local ? null : await client.get('/accessors/index.json', { auth: false });
  const { verdict } = await import('../lib/runner.js');
  const reports = [];

  for (const file of args) {
    if (!fs.existsSync(file)) { log.error(`${file}: not found`); process.exitCode = 1; continue; }
    const info = await probeFile(file);
    let combinations, dir = local;
    try {
      if (local) {
        combinations = opts.with?.length ? opts.with.map((w) => w.split(/[;,\s]+/).filter(Boolean)) : [info.decodeWith];
        if (!combinations[0]?.length) throw new CliError('no pipeline to test (format not identified)');
        info.kind ??= await mediaKind(file);
      } else {
        let kind;
        ({ combinations, kind } = await registryCombinations(file, index, opts));
        info.kind ??= kind;
        dir = await fetchModules(combinations, index, { client, registry, solver: opts.solver });
      }
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      log.error(`${file}: ${e.message}`); if (e.hint) console.log(color.dim(`  ${e.hint}`));
      process.exitCode = 1; continue;
    }

    for (const modules of combinations) {
      const c = await runCase(file, modules, info, dir, opts);
      const v = c.result ? verdict(c.result, { expectDecoders: opts.expect ?? [] }) : null;
      reports.push({ file, format: info.format, kind: info.kind, ...c, verdict: v });
      if (!opts.json) print({ file, info, ...c, verdict: v }, opts);
      if (c.missing.length || c.incompatible || !v?.pass) process.exitCode = 1;
    }
  }

  await closeMediaInfo();
  if (opts.json) {
    console.log(JSON.stringify(reports.map((r) => ({
      file: r.file, format: r.format, modules: r.modules, missing: r.missing,
      pass: r.verdict?.pass ?? false,
      problems: r.verdict?.problems ?? [],
      graph: r.result?.graph ?? [], filters: r.result?.filters ?? [],
      outputBytes: r.result?.outputBytes ?? null, outputSha256: r.result?.outputSha256 ?? null, sessionUs: r.result?.sessionUs ?? null,
    })), null, 2));
  } else {
    const passed = reports.filter((r) => r.verdict?.pass).length;
    console.log(`${passed}/${reports.length} combination${reports.length === 1 ? '' : 's'} decoded`);
  }
}

function print({ file, info, modules, missing, result, verdict: v, solver, incompatible, undeclared = [] }, opts) {
  const head = `${color.bold(path.basename(file))} ${color.dim(`${info.format ?? '?'} · ${modules.join(';')}`)}`;
  if (incompatible) {
    console.log(`${color.red('✖')} ${head}`);
    log.error(`  ${incompatible.message}`);
    if (incompatible.hint) console.log(color.dim(`  ${incompatible.hint}\n`));
    return;
  }
  if (undeclared.length) log.warn(`  ${undeclared.join(', ')}: no "using" next to ${undeclared.length > 1 ? 'them' : 'it'} in the accessors directory; compatibility with ${solver} assumed`);
  if (missing.length) {
    console.log(`${color.red('✖')} ${head}`);
    log.error(`  not in the accessors directory: ${missing.join(', ')}`);
    console.log(color.dim('  install them with `bevara install` or point --accessors at a directory that has them\n'));
    return;
  }
  console.log(`${v.pass ? color.green('✔') : color.red('✖')} ${head}`);
  if (result.graph?.length) {
    console.log(color.dim(`  solver ${solver} · graph:`));
    for (const l of result.graph) console.log(color.dim('    ' + l));
  }
  if (result.filters?.length) {
    console.log(table(result.filters.map((f) => [
      f.name, `${f.packets} pkt`, formatBytes(f.bytes), `${(f.processUs / 1000).toFixed(1)} ms`,
      f.packets ? color.dim(`${f.pps.toFixed(0)} pck/s · ${f.mbps.toFixed(1)} mbps`) : color.yellow('nothing processed'),
    ]), { indent: '    ' }));
  }
  console.log(`    ${color.dim(`output ${result.outputBytes ? formatBytes(result.outputBytes) : 'none'} · session ${(result.sessionUs / 1000).toFixed(0)} ms`)}`);
  for (const p of v.problems) (p.severity === 'error' ? log.error : log.warn)('  ' + p.text);
  if (opts.verbose && result.log) console.log(color.dim(result.log.split('\n').map((l) => '    ' + l).join('\n')));
  console.log();
}

export { findSolver };
