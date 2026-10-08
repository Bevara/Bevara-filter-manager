/* Drives pipeline runs for `bevara test` and `bevara bench`.
 *
 * Each run is a child process (see run-session.cjs) so that a crash or a hang
 * cannot take the CLI with it and so that successive runs do not share state.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './ui.js';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-session.cjs');

/* A run needs the player's main module next to the accessors: the registry
 * distributes accessors, not the solver, so we look for it where the page
 * would load it from. */
export function findSolver(dir, kind, forced) {
  // solver_1 first: solver_minimal_1 runs the same pipelines but prints no
  // session statistics, so a report made from it would have no per-filter data.
  const prefer = forced ? [forced] : ['solver_1', 'solver_minimal_1'];
  for (const s of prefer) if (fs.existsSync(path.join(dir, `${s}.js`)) && fs.existsSync(path.join(dir, `${s}.wasm`))) return s;
  return null;
}

export function requireSolver(dir, kind, forced) {
  const solver = findSolver(dir, kind, forced);
  if (!solver) throw new CliError(`${forced ? `solver "${forced}" not found` : 'no solver found'} in ${dir}`, {
    hint: 'the solver is the player\'s main module, not an accessor: copy solver_1.js/.wasm (and solver_minimal_1) next to the accessors, or pass --accessors <dir>',
  });
  return solver;
}

export function missingModules(dir, modules) {
  return modules.filter((m) => !fs.existsSync(path.join(dir, `${m}.wasm`)));
}

export async function runSession(job, { timeoutMs = 120_000 } = {}) {
  const jobFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-run-')), 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify({ timeoutMs, ...job }));
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [RUNNER, jobFile], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      const kill = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs + 15_000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code, signal) => {
        clearTimeout(kill);
        if (signal === 'SIGKILL') return resolve({ ok: false, exitCode: 'killed', errors: [`the session did not finish within ${Math.round(timeoutMs / 1000)}s and was killed`], filters: [], graph: [], notConnected: [] });
        try { resolve(JSON.parse(out)); }
        catch { resolve({ ok: false, exitCode: code, errors: [(err || out).trim().split('\n').slice(-6).join('\n') || 'the session produced no report'], filters: [], graph: [], notConnected: [] }); }
      });
    });
  } finally { fs.rmSync(path.dirname(jobFile), { recursive: true, force: true }); }
}

/* What the run tells us about the pipeline, in terms a user cares about. */
export function verdict(result, { expectDecoders = [] } = {}) {
  const problems = [];
  if (result.fatal) problems.push({ severity: 'error', text: result.fatal.split('\n')[0] });
  if (result.exitCode === 'timeout') problems.push({ severity: 'error', text: 'the session did not terminate' });
  else if (result.exitCode !== 0 && result.exitCode !== undefined) problems.push({ severity: 'error', text: `gpac exited with code ${result.exitCode}` });
  for (const nc of result.notConnected ?? []) problems.push({ severity: 'error', text: `filter never connected: ${nc}` });

  const decoders = (result.filters ?? []).filter((f) => !/^(fin|fout|writegen|reframer|resample|httpin|dasher)\b/.test(f.name));
  const decoded = decoders.filter((f) => f.packets > 0);
  if (!result.outputBytes) problems.push({ severity: 'error', text: 'the pipeline produced no output' });
  if (decoders.length && !decoded.length) problems.push({ severity: 'error', text: 'the graph resolved but no packet was decoded' });
  for (const want of expectDecoders) {
    if (!(result.filters ?? []).some((f) => f.name.split(/[\s:]/)[0] === want)) problems.push({ severity: 'error', text: `expected filter "${want}" is not in the resolved graph` });
  }
  for (const e of result.errors ?? []) if (/No filter chain found/.test(e)) problems.push({ severity: 'warning', text: e.trim() });

  return { pass: !problems.some((p) => p.severity === 'error'), problems, decoders, decoded };
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
