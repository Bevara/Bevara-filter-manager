/* Runs one pipeline in a GPAC/Wasm session and reports what happened.
 *
 * This is a CommonJS child process on purpose: the solver is an Emscripten
 * MAIN_MODULE that exports itself through `module.exports`, its EM_ASM code
 * resolves `libgpac` as a global, and two instances in one process interfere,
 * so each run gets a fresh process. The parent (lib/runner.js) passes a job as
 * JSON and reads a JSON report back from stdout.
 *
 * The pipeline is the real one: the solver links the accessors as side modules,
 * their constructors self-register into the session, and GPAC resolves the
 * graph from the source's capabilities exactly as it does in a page.
 */
const path = require('path');
const fs = require('fs');

// Built-in filters the core exports; registered from JS the way the player's
// loader does, because only the accessors self-register at link time.
const BUILTINS = [
  ['fin', '_fin_register'], ['fout', '_fout_register'], ['writegen', '_writegen_register'],
  ['reframer', '_reframer_register'], ['resample', '_resample_register'],
  ['httpin', '_httpin_register'], ['dasher', '_dasher_register'], ['writeuf', '_writeuf_register'],
];

// Raw output extension per media kind: it is what makes GPAC resolve a
// decoding chain. A sink that accepts compressed data (null, .ogg…) would be
// connected straight to the demultiplexer and nothing would be decoded.
const RAW_EXT = { video: 'yuv', image: 'rgb', audio: 'pcm' };

function parseStats(text) {
  const filters = [];
  // The name may hold colons (pngdec "pngdec:libpng"), so match lazily up to
  // the " : <n> input pids" that starts the fixed part. `.` excludes newlines.
  const re = /^[ \t]*Filter (.+?) : (\d+) input pids (\d+) output pids (\d+) tasks (\d+) us process time/gm;
  let m;
  while ((m = re.exec(text))) {
    const rest = text.slice(re.lastIndex, re.lastIndex + 400);
    const pk = /(\d+) packets processed (\d+) bytes processed \(([\d.]+) pck\/sec ([\d.]+) mbps\)/.exec(rest);
    filters.push({
      name: m[1].trim(), inputs: +m[2], outputs: +m[3], tasks: +m[4], processUs: +m[5],
      packets: pk ? +pk[1] : 0, bytes: pk ? +pk[2] : 0, pps: pk ? +pk[3] : 0, mbps: pk ? +pk[4] : 0,
    });
  }
  const total = /Total: run_time (\d+) us active_time (\d+) us nb_tasks (\d+)/.exec(text);
  // The graph block runs to the first blank line; everything after belongs to
  // other sections of the report.
  let graph = [];
  if (text.includes('Filters connected:')) {
    for (const l of text.split('Filters connected:')[1].split('\n')) {
      const t = l.trim();
      if (!t) { if (graph.length) break; continue; }
      if (t.startsWith('Filters not connected')) break;
      graph.push(t);
    }
  }
  const notConnected = /Filters not connected:\n([\s\S]*?)(\n\n|$)/.exec(text);
  return {
    filters,
    runUs: total ? +total[1] : null,
    activeUs: total ? +total[2] : null,
    tasks: total ? +total[3] : null,
    graph,
    notConnected: notConnected ? notConnected[1].split('\n').map((l) => l.trim()).filter(Boolean) : [],
  };
}

async function main() {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const dir = job.accessorsDir;
  const solverJs = path.join(dir, job.solver + '.js');
  if (!fs.existsSync(solverJs)) throw new Error(`solver not found: ${solverJs}`);

  const libgpac = require(solverJs);
  globalThis.libgpac = libgpac;          // EM_ASM bodies resolve it as a global

  const lines = [];
  let onDone;
  const done = new Promise((r) => { onDone = r; });
  const t0 = process.hrtime.bigint();
  const mod = await libgpac({
    gpac_done: (code) => onDone(code),
    locateFile: (p) => path.join(dir, p),
    dynamicLibraries: job.modules.map((m) => `${m}.wasm`),
    noInitialRun: true,
    print: (t) => lines.push(t),
    printErr: (t) => lines.push(t),
  });
  const instantiateUs = Number(process.hrtime.bigint() - t0) / 1000;

  const strPtr = (s) => { const n = mod.lengthBytesUTF8(s) + 1; const p = mod._malloc(n); mod.stringToUTF8(s, p, n); return p; };
  const registered = [];
  for (const [name, fn] of BUILTINS) {
    if (typeof mod[fn] !== 'function') continue;
    const np = strPtr(name);
    mod.ccall('gf_filter_auto_register', null, ['number', 'number'], [np, mod.addFunction(mod[fn], 'ip')]);
    mod._free(np);
    registered.push(name);
  }

  const inName = 'input' + (job.inputExt ? '.' + job.inputExt : '');
  mod.FS.writeFile(inName, new Uint8Array(fs.readFileSync(job.inputFile)));
  const outName = 'output.' + (RAW_EXT[job.kind] ?? 'yuv');

  const args = ['gpac', '-i', inName, '-o', outName, '-stats', '-graph', ...(job.extraArgs ?? [])];
  // Built with _malloc/setValue rather than the stack or a HEAP view: the two
  // solver builds do not export the same runtime helpers, these they share.
  const argv = mod._malloc((args.length + 1) * 4);
  args.forEach((a, i) => mod.setValue(argv + 4 * i, strPtr(a), 'i32'));
  mod.setValue(argv + 4 * args.length, 0, 'i32');

  const t1 = process.hrtime.bigint();
  let threw = null;
  try { mod._main(args.length, argv); }
  catch (e) { if (e !== 'unwind') threw = String(e && e.message ? e.message : e); }
  let timer;
  const code = await Promise.race([done, new Promise((r) => { timer = setTimeout(() => r('timeout'), job.timeoutMs ?? 120000); })]);
  clearTimeout(timer);
  const sessionUs = Number(process.hrtime.bigint() - t1) / 1000;

  let outputBytes = null, outputSha256 = null;
  try {
    outputBytes = mod.FS.stat(outName).size;
    // A digest of the decoded samples: two correct decoders of the same file
    // produce the same one, which is how bench tells "faster" from "different".
    outputSha256 = require('crypto').createHash('sha256').update(mod.FS.readFile(outName)).digest('hex');
  } catch { /* nothing written */ }

  const text = lines.join('\n');
  const stats = parseStats(text);
  process.stdout.write(JSON.stringify({
    ok: code === 0 && !threw,
    exitCode: code, threw,
    instantiateUs, sessionUs, outputBytes, outputSha256,
    args: args.slice(1), registered, modules: job.modules,
    ...stats,
    errors: text.split('\n').filter((l) => /\b(error|Error|failed|Failed|not found|No filter chain)\b/.test(l)).slice(0, 12),
    log: job.verbose ? text : undefined,
  }));
  process.exit(0);
}

// Only run when spawned as the child process; importing the file (the tests
// do, for parseStats) must not start a session.
if (require.main === module) {
  main().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, fatal: String((e && e.stack) || e) })); process.exit(1); });
}

module.exports = { parseStats, RAW_EXT, BUILTINS };
