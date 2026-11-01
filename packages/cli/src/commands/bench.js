import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { Project, clientFor } from '../lib/ctx.js';
import { registryCombinations, fetchModules, mediaKind } from '../lib/run-prep.js';
import { closeMediaInfo } from '../lib/mediainfo.js';
import { runSession, requireSolver, missingModules, verdict, median, solverForCombination } from '../lib/runner.js';
import { accessorsDirFor, probeFile } from './test.js';
import { SOLVER, SOLVER_MINIMAL } from '../lib/solvers.js';

export const options = {
  with: { type: 'string', multiple: true, short: 'W' },
  accessors: { type: 'string', short: 'a' },
  runs: { type: 'string', short: 'n' },
  warmup: { type: 'string' },
  timeout: { type: 'string' },
  solver: { type: 'string', short: 's' },
};

export const help = `Measures how fast a pipeline decodes a file.

Each run is a fresh process: the solver is instantiated, the accessors are
linked as side modules, the graph is resolved and the file is decoded to raw
samples. The report separates the costs the paper distinguishes - linking the
modules, resolving the graph, and the decoding itself - using the per-filter
process time GPAC accounts for.

  bevara bench clip.mp4
  bevara bench clip.mp4 -n 10
  bevara bench clip.mp4 -W "isobmff_1;h264bsd_1" -W "isobmff_1;ffmpeg-h26x_1"
  bevara bench samples/*.mp4 --json > results.json

Options:
  -W, --with "a_1;b_1"   combination to measure; repeat to compare several
  -n, --runs <n>         measured runs per combination (default 3, median reported)
      --warmup <n>       unmeasured runs first (default 1)
  -a, --accessors <dir>  run with the modules of this directory instead (default:
                         nothing to install - chosen on the registry and cached
                         in ~/.bevara/cache)
  -s, --solver <name>    ${SOLVER} (default) or ${SOLVER_MINIMAL}
      --timeout <s>      give up on a session after this long (default 120)
      --json             machine-readable results`;

// The filters that are not the pipeline under test: reading, writing, framing.
const PLUMBING = /^(fin|fout|writegen|writeuf|reframer|resample|httpin|dasher)\b/;

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara bench <file...>');
  const project = Project.load({ required: false });
  const local = opts.accessors ? accessorsDirFor(opts, project) : null;
  const { registry, client } = clientFor(opts, project);
  const index = local ? null : await client.get('/accessors/index.json', { auth: false });
  const runs = Math.max(1, parseInt(opts.runs ?? '3', 10) || 3);
  const warmup = Math.max(0, parseInt(opts.warmup ?? '1', 10) || 0);
  const timeoutMs = (parseInt(opts.timeout ?? '120', 10) || 120) * 1000;
  const results = [];

  for (const file of args) {
    if (!fs.existsSync(file)) { log.error(`${file}: not found`); process.exitCode = 1; continue; }
    const info = await probeFile(file);
    let combinations, dir = local;
    try {
      if (local) {
        combinations = opts.with?.length ? opts.with.map((w) => w.split(/[;,\s]+/).filter(Boolean)) : [info.decodeWith];
        if (!combinations[0]?.length) throw new CliError('format not identified, nothing to measure');
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
    const size = fs.statSync(file).size;
    if (!opts.json) console.log(`${color.bold(path.basename(file))} ${color.dim(`${info.format ?? '?'} · ${formatBytes(size)} · ${runs} run${runs === 1 ? '' : 's'}`)}`);

    const rows = [];
    for (const modules of combinations) {
      const missing = missingModules(dir, modules);
      if (missing.length) {
        if (!opts.json) log.error(`  ${modules.join(';')}: missing ${missing.join(', ')}`);
        results.push({ file, modules, missing, runs: [] });
        process.exitCode = 1;
        continue;
      }
      // A page loads one solver: the accessors must share a runtime, and the run uses it.
      let solver;
      try { ({ solver } = solverForCombination(dir, info.kind, opts.solver, modules)); }
      catch (e) {
        if (!(e instanceof CliError)) throw e;
        if (!opts.json) log.error(`  ${e.message}${e.hint ? ` (${e.hint})` : ''}`);
        results.push({ file, modules, missing: [], incompatible: e.message, runs: [] });
        process.exitCode = 1;
        continue;
      }
      const job = {
        accessorsDir: dir, solver, modules, inputFile: file,
        inputExt: path.extname(file).slice(1) || undefined, kind: info.kind ?? 'video',
      };
      const samples = [];
      for (let i = 0; i < warmup + runs; i++) {
        const r = await runSession(job, { timeoutMs });
        if (i >= warmup) samples.push(r);
      }
      const ok = samples.filter((s) => verdict(s).pass);
      const pick = (f) => median(samples.map(f).filter((x) => typeof x === 'number'));
      const decoderOf = (s) => (s.filters ?? []).filter((f) => !PLUMBING.test(f.name)).sort((a, b) => b.processUs - a.processUs)[0] ?? null;
      const decoders = samples.map(decoderOf).filter(Boolean);
      const decodeUs = median(decoders.map((d) => d.processUs));
      const packets = decoders.length ? decoders[0].packets : 0;
      const entry = {
        file, modules, missing: [], solver,
        ok: ok.length, attempted: samples.length,
        decoder: decoders[0]?.name ?? null,
        linkMs: pick((s) => s.instantiateUs) / 1000,
        sessionMs: pick((s) => s.sessionUs) / 1000,
        decodeMs: decodeUs != null ? decodeUs / 1000 : null,
        packets,
        fps: decodeUs ? packets / (decodeUs / 1e6) : null,
        inputMbps: decodeUs ? (size * 8) / (decodeUs / 1e6) / 1e6 : null,
        outputBytes: samples[0]?.outputBytes ?? null,
        outputSha256: samples.find((x) => x.outputSha256)?.outputSha256 ?? null,
        problems: ok.length === samples.length ? [] : verdict(samples[samples.length - 1]).problems.map((p) => p.text),
        samples: samples.map((s) => ({ sessionUs: s.sessionUs, instantiateUs: s.instantiateUs, filters: s.filters })),
      };
      results.push(entry);
      rows.push(entry);
    }

    if (!opts.json && rows.length) {
      const best = Math.min(...rows.filter((r) => r.decodeMs != null && r.ok).map((r) => r.decodeMs));
      console.log(table(rows.map((r) => [
        r.ok === r.attempted ? color.green('✔') : color.red('✖'),
        r.modules.join(';'),
        r.decoder ?? color.dim('—'),
        `${r.linkMs.toFixed(0)} ms`,
        r.decodeMs != null ? (r.decodeMs === best ? color.bold(`${r.decodeMs.toFixed(1)} ms`) : `${r.decodeMs.toFixed(1)} ms`) : color.dim('—'),
        `${r.sessionMs.toFixed(0)} ms`,
        r.packets ? `${r.packets} pkt` : color.dim('—'),
        r.fps ? `${r.fps.toFixed(0)}/s` : color.dim('—'),
        r.outputBytes ? formatBytes(r.outputBytes) : color.yellow('no output'),
      ]), { header: ['', 'combination', 'decoder', 'link', 'decode', 'session', 'packets', 'rate', 'output'].map(color.bold), indent: '  ' }));
      for (const r of rows) for (const p of r.problems) log.warn(`  ${r.modules.join(';')}: ${p}`);
      // Faster only counts if the samples are the same.
      const digests = new Set(rows.filter((r) => r.ok && r.outputSha256).map((r) => r.outputSha256));
      if (digests.size > 1) log.warn('  these combinations decode the file to different samples: compare their output before trusting the timings');
      else if (digests.size === 1 && rows.filter((r) => r.ok).length > 1) console.log(color.dim('  all combinations produced identical samples'));
      console.log(color.dim('  link = instantiating the solver and linking the accessors; decode = the decoder\'s own process time;\n  session = wall clock for the whole run. Medians over the measured runs.\n'));
    }
  }

  await closeMediaInfo();
  if (opts.json) console.log(JSON.stringify(results, null, 2));
}
