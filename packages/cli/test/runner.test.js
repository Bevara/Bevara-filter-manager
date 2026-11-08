import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { verdict, median, findSolver, missingModules } from '../src/lib/runner.js';
import { SOLVER, SOLVER_MINIMAL } from '../src/lib/solvers.js';

const { parseStats } = createRequire(import.meta.url)('../src/lib/run-session.cjs');

/* A real GPAC report, trimmed: the filter whose name carries a colon and the
 * "not connected" section are the parts that used to break the parser. */
const REPORT = `Reading the file and constructing a filter pipeline, this may take some time... Ready
System info: 128 MB RAM - 1 cores - main thread ID 1440480

Filter stats - 5 filters
	Filter fin (src=input.png) : 0 input pids 1 output pids 3 tasks 1700 us process time
		1 packets processed 358400 bytes processed (1988 pck/sec 10687.9 mbps)
	Filter rfpng : 1 input pids 1 output pids 3 tasks 800 us process time
		1 packets processed 358400 bytes processed (1302 pck/sec 3734.3 mbps)
	Filter pngdec "pngdec:libpng" : 1 input pids 1 output pids 4 tasks 7000 us process time
		1 packets processed 358400 bytes processed (142 pck/sec 407.2 mbps)
	Filter writegen : 1 input pids 1 output pids 3 tasks 700 us process time
		1 packets processed 672000 bytes processed (1425 pck/sec 7658.1 mbps)
	Filter fout (dst=output.rgb) : 1 input pids 0 output pids 2 tasks 500 us process time
		1 packets processed 672000 bytes processed (1988 pck/sec 10687.9 mbps)
Session stats - threads 1
	Thread 1: run_time 20000 us active_time 19500 us nb_tasks 39

Total: run_time 20000 us active_time 19500 us nb_tasks 39

Filters connected:
fin (src=input.png) (idx=1)
-(PID input.png) rfpng (dyn_idx=3)
--(PID input.png) pngdec "pngdec:libpng" (dyn_idx=4)

Filters not connected:
aout (idx=7)
`;

describe('gpac report parsing', () => {
  const s = parseStats(REPORT);

  test('every filter is found, including names that contain a colon', () => {
    assert.deepEqual(s.filters.map((f) => f.name), ['fin (src=input.png)', 'rfpng', 'pngdec "pngdec:libpng"', 'writegen', 'fout (dst=output.rgb)']);
  });

  test('per-filter counters are read', () => {
    const dec = s.filters.find((f) => f.name.startsWith('pngdec'));
    assert.equal(dec.processUs, 7000);
    assert.equal(dec.packets, 1);
    assert.equal(dec.bytes, 358400);
    assert.equal(dec.pps, 142);
    assert.equal(dec.mbps, 407.2);
    assert.equal(dec.inputs, 1);
    assert.equal(dec.outputs, 1);
  });

  test('session totals', () => {
    assert.equal(s.runUs, 20000);
    assert.equal(s.activeUs, 19500);
    assert.equal(s.tasks, 39);
  });

  test('the graph stops at the blank line and never swallows later sections', () => {
    assert.deepEqual(s.graph, ['fin (src=input.png) (idx=1)', '-(PID input.png) rfpng (dyn_idx=3)', '--(PID input.png) pngdec "pngdec:libpng" (dyn_idx=4)']);
    assert.deepEqual(s.notConnected, ['aout (idx=7)']);
  });

  test('a report with no statistics yields empty structures, not a crash', () => {
    const e = parseStats('nothing useful here');
    assert.deepEqual(e.filters, []);
    assert.deepEqual(e.graph, []);
    assert.equal(e.runUs, null);
  });
});

describe('verdict', () => {
  const base = { exitCode: 0, outputBytes: 1000, filters: [], graph: [], notConnected: [], errors: [] };
  const dec = (packets) => ({ name: 'theoradec', packets, processUs: 100, bytes: 1, pps: 1, mbps: 1, inputs: 1, outputs: 1 });

  test('passes when the graph resolved, packets flowed and output exists', () => {
    const v = verdict({ ...base, filters: [dec(42)] });
    assert.equal(v.pass, true);
    assert.deepEqual(v.problems, []);
    assert.equal(v.decoded.length, 1);
  });

  test('a graph that resolves but decodes nothing is a failure', () => {
    const v = verdict({ ...base, filters: [dec(0)], outputBytes: 0 });
    assert.equal(v.pass, false);
    assert.ok(v.problems.some((p) => /no packet was decoded/.test(p.text)));
    assert.ok(v.problems.some((p) => /no output/.test(p.text)));
  });

  test('plumbing filters alone do not count as decoding', () => {
    const v = verdict({ ...base, filters: [{ name: 'fin (src=x)', packets: 10, processUs: 1 }, { name: 'fout (dst=y)', packets: 10, processUs: 1 }] });
    assert.equal(v.decoders.length, 0);
    assert.equal(v.pass, true);          // nothing to decode, but output was produced
  });

  test('unconnected filters, non-zero exit and timeouts are failures', () => {
    assert.equal(verdict({ ...base, notConnected: ['fout (dst=o.yuv)'] }).pass, false);
    assert.equal(verdict({ ...base, exitCode: 1 }).pass, false);
    assert.equal(verdict({ ...base, exitCode: 'timeout' }).pass, false);
    assert.equal(verdict({ ...base, fatal: 'boom\nstack' }).pass, false);
  });

  test('an expected filter missing from the graph is a failure', () => {
    const r = { ...base, filters: [dec(5)] };
    assert.equal(verdict(r, { expectDecoders: ['theoradec'] }).pass, true);
    assert.equal(verdict(r, { expectDecoders: ['vorbisdec'] }).pass, false);
  });

  test('"no filter chain" is reported as a warning, not a failure', () => {
    const v = verdict({ ...base, filters: [dec(5)], errors: ['No filter chain found for PID A1 in filter mp4dmx'] });
    assert.equal(v.pass, true);
    assert.ok(v.problems.some((p) => p.severity === 'warning'));
  });
});

describe('accessor directory checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-runner-test-'));
  test('findSolver prefers mm_solver_1.0.1 and needs both files', () => {
    assert.equal(findSolver(dir, 'video'), null);
    fs.writeFileSync(path.join(dir, SOLVER_MINIMAL + '.js'), '');
    assert.equal(findSolver(dir, 'image'), null, 'the .wasm is required too');
    fs.writeFileSync(path.join(dir, SOLVER_MINIMAL + '.wasm'), '');
    assert.equal(findSolver(dir, 'image'), SOLVER_MINIMAL);
    fs.writeFileSync(path.join(dir, SOLVER + '.js'), '');
    fs.writeFileSync(path.join(dir, SOLVER + '.wasm'), '');
    assert.equal(findSolver(dir, 'image'), SOLVER);
    assert.equal(findSolver(dir, 'image', SOLVER_MINIMAL), SOLVER_MINIMAL);
    assert.equal(findSolver(dir, 'image', 'solver_nope'), null);
  });

  test('missingModules lists what is not there', () => {
    fs.writeFileSync(path.join(dir, 'theora_1.wasm'), '');
    assert.deepEqual(missingModules(dir, ['theora_1', 'vorbis_1', 'ogg_1']), ['vorbis_1', 'ogg_1']);
    assert.deepEqual(missingModules(dir, ['theora_1']), []);
  });
});

describe('median', () => {
  test('middle value, single value, empty', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([7]), 7);
    assert.equal(median([]), null);
  });
});

/* The solver and the accessors are the player's distribution, not part of this
 * repository: run the real pipeline only when they are available. */
const ACCESSORS = path.resolve(process.env.BEVARA_ACCESSORS ?? '../../../Showcase/accessors');
const SAMPLE = path.resolve(process.env.BEVARA_SHOWCASE ?? '../../../Showcase', 'png/Freedom.png');
const haveRuntime = findSolver(ACCESSORS, 'image') && fs.existsSync(path.join(ACCESSORS, 'libpng_1.wasm')) && fs.existsSync(SAMPLE);

describe('running a real pipeline', { skip: !haveRuntime && 'solver or sample not available' }, () => {
  test('decodes a PNG through the solver and reports the graph it resolved', async () => {
    const { runSession } = await import('../src/lib/runner.js');
    const r = await runSession({
      accessorsDir: ACCESSORS, solver: findSolver(ACCESSORS, 'image'), modules: ['libpng_1'],
      inputFile: SAMPLE, inputExt: 'png', kind: 'image',
    }, { timeoutMs: 60_000 });

    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    assert.ok(r.outputBytes > 0, 'raw output should have been written');
    const v = verdict(r);
    assert.equal(v.pass, true, JSON.stringify(v.problems));
    // The decoder comes from the side module, linked and self-registered at run time.
    assert.ok(r.filters.some((f) => f.name.startsWith('pngdec')), JSON.stringify(r.filters.map((f) => f.name)));
    assert.ok(r.graph.some((l) => l.includes('pngdec')), JSON.stringify(r.graph));
    assert.ok(r.instantiateUs > 0 && r.sessionUs > 0);
  });

  test('a combination that cannot decode the file fails with a reason', async () => {
    const { runSession } = await import('../src/lib/runner.js');
    const r = await runSession({
      accessorsDir: ACCESSORS, solver: findSolver(ACCESSORS, 'image'), modules: [],   // no decoder at all
      inputFile: SAMPLE, inputExt: 'png', kind: 'image',
    }, { timeoutMs: 60_000 });
    const v = verdict(r);
    assert.equal(v.pass, false);
    assert.ok(v.problems.length > 0);
  });
});
