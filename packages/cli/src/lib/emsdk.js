/* Which Emscripten SDK a build uses, and whether it is the one expected.
 *
 * A CMake build directory remembers the toolchain it was first configured with
 * (CMakeFiles/<version>/CMakeSystem.cmake includes that SDK's Emscripten.cmake)
 * and keeps loading it even when `emcmake` from another SDK passes a different
 * CMAKE_TOOLCHAIN_FILE. The old SDK's emcc then reads the new SDK's
 * environment, and fails in ways that look like a broken install. CMake's
 * answer is a fresh configuration; the CLI applies it when it sees the change.
 *
 * The filter repositories also pin their SDK: third_parties/emsdk_vers.txt
 * (EMSDK_VERS=6.0.8) next to them, which their CI uses as well.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function which(cmd, env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/* The SDK that `emcmake` on PATH belongs to. */
export function activeEmsdk(env = process.env) {
  const emcmake = which('emcmake', env);
  if (!emcmake) return null;
  const root = path.dirname(real(emcmake));                        // <emsdk>/upstream/emscripten
  const toolchain = path.join(root, 'cmake', 'Modules', 'Platform', 'Emscripten.cmake');
  let version = null;
  try {
    const out = execFileSync(path.join(root, 'emcc'), ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch { /* emcc unusable: the build will say so */ }
  return { emcmake, root, toolchain: real(toolchain), version };
}

/* The toolchain a CMake build directory is configured with, or null. */
export function configuredToolchain(buildDir) {
  const files = path.join(buildDir, 'CMakeFiles');
  let versions = [];
  try { versions = fs.readdirSync(files).filter((d) => /^\d/.test(d)); } catch { /* not configured */ }
  for (const v of versions) {
    try {
      const m = /include\("([^"]+Emscripten\.cmake)"\)/.exec(fs.readFileSync(path.join(files, v, 'CMakeSystem.cmake'), 'utf8'));
      if (m) return real(m[1]);
    } catch { /* keep looking */ }
  }
  try {
    const m = /^CMAKE_TOOLCHAIN_FILE:[A-Z]+=(.+)$/m.exec(fs.readFileSync(path.join(buildDir, 'CMakeCache.txt'), 'utf8'));
    if (m) return real(m[1].trim());
  } catch { /* no cache */ }
  return null;
}

/* Drops the CMake configuration of a build directory configured with another
 * toolchain. Only CMake's own files go; whatever else is there stays. */
export function resetIfOtherToolchain(buildDir, toolchain) {
  const before = configuredToolchain(buildDir);
  if (!before || !toolchain || before === toolchain) return null;
  fs.rmSync(path.join(buildDir, 'CMakeCache.txt'), { force: true });
  fs.rmSync(path.join(buildDir, 'CMakeFiles'), { recursive: true, force: true });
  return { from: sdkOf(before), to: sdkOf(toolchain) };
}

// .../emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake -> .../emsdk
export const sdkOf = (toolchain) => toolchain.replace(/\/upstream\/emscripten\/cmake\/Modules\/Platform\/Emscripten\.cmake$/, '');

/* The SDK version the repository expects: the nearest
 * third_parties/emsdk_vers.txt above it ("EMSDK_VERS=6.0.8"). */
export function expectedEmsdk(root) {
  let dir = path.resolve(root);
  for (;;) {
    const f = path.join(dir, 'third_parties', 'emsdk_vers.txt');
    try {
      const m = /EMSDK_VERS\s*=\s*([\w.-]+)/.exec(fs.readFileSync(f, 'utf8'));
      if (m) return { version: m[1], file: f, sdk: path.join(dir, 'third_parties', 'emsdk') };
    } catch { /* go up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/* Known failures, recognised in the build output, with what to do. */
export function diagnoseBuildFailure(output, { active, expected } = {}) {
  const fix = expected ? `source ${path.join(expected.sdk, 'emsdk_env.sh')}` : 'source <emsdk>/emsdk_env.sh';
  if (/\$CFGDIR|Failed to fetch Emscripten version information/.test(output)) {
    return `two Emscripten SDKs are mixed: the toolchain of one runs with the configuration (EM_CONFIG) of the other. Open a new terminal and activate a single SDK: ${fix}`;
  }
  if (/emcmake: (command )?not found|emcmake: No such file/.test(output) || (!active && /not found/.test(output))) {
    return `emcmake is not on PATH: activate the Emscripten SDK with ${fix}`;
  }
  if (/version mismatch|unknown target triple|invalid (?:feature|target)|wasm-ld: error: .*(?:incompatible|unknown)/i.test(output) && expected && active?.version !== expected.version) {
    return `the prebuilt libraries need emsdk ${expected.version} (${expected.file}), the build used ${active?.version ?? 'another version'}: ${fix}`;
  }
  return null;
}
