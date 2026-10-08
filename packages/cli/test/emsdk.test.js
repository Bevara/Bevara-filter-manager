import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which, activeEmsdk, configuredToolchain, resetIfOtherToolchain, expectedEmsdk, diagnoseBuildFailure, sdkOf } from '../src/lib/emsdk.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-emsdk-test-')));
const toolchainOf = (sdk) => path.join(sdk, 'upstream', 'emscripten', 'cmake', 'Modules', 'Platform', 'Emscripten.cmake');

// A fake SDK: emcmake and an emcc that reports a version.
function fakeSdk(version) {
  const sdk = tmp();
  const bin = path.join(sdk, 'upstream', 'emscripten');
  fs.mkdirSync(path.dirname(toolchainOf(sdk)), { recursive: true });
  fs.writeFileSync(toolchainOf(sdk), '');
  fs.writeFileSync(path.join(bin, 'emcmake'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'emcc'), `#!/bin/sh\necho "emcc (Emscripten gcc/clang-like replacement) ${version} (abc)"\n`, { mode: 0o755 });
  return { sdk, bin };
}

// A build directory as CMake leaves it after configuring with a toolchain.
function configured(buildDir, sdk) {
  fs.mkdirSync(path.join(buildDir, 'CMakeFiles', '3.28.1'), { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'CMakeFiles', '3.28.1', 'CMakeSystem.cmake'), `set(CMAKE_SYSTEM "Emscripten-1")\n\ninclude("${toolchainOf(sdk)}")\n`);
  fs.writeFileSync(path.join(buildDir, 'CMakeCache.txt'), `CMAKE_TOOLCHAIN_FILE:UNINITIALIZED=${toolchainOf(sdk)}\n`);
  fs.writeFileSync(path.join(buildDir, 'libjxl_1.wasm'), 'previous build');
}

describe('the active SDK', () => {
  test('found through emcmake on PATH, with its version', () => {
    const { sdk, bin } = fakeSdk('6.0.8');
    const a = activeEmsdk({ ...process.env, PATH: bin });
    assert.equal(a.version, '6.0.8');
    assert.equal(a.toolchain, toolchainOf(sdk));
    assert.equal(sdkOf(a.toolchain), sdk);
  });
  test('none when emcmake is not on PATH', () => {
    assert.equal(activeEmsdk({ PATH: tmp() }), null);
    assert.equal(which('emcmake', { PATH: '' }), null);
  });
});

describe('a build directory configured with another SDK', () => {
  test('the configured toolchain is read from CMakeSystem.cmake', () => {
    const b = tmp(); const { sdk } = fakeSdk('4.0.15');
    configured(b, sdk);
    assert.equal(configuredToolchain(b), toolchainOf(sdk));
    assert.equal(configuredToolchain(tmp()), null, 'an empty directory is not configured');
  });

  test('is reset: CMake state removed, everything else kept', () => {
    const b = tmp(); const old = fakeSdk('4.0.15'); const now = fakeSdk('6.0.8');
    configured(b, old.sdk);
    const r = resetIfOtherToolchain(b, toolchainOf(now.sdk));
    assert.deepEqual(r, { from: old.sdk, to: now.sdk });
    assert.ok(!fs.existsSync(path.join(b, 'CMakeCache.txt')));
    assert.ok(!fs.existsSync(path.join(b, 'CMakeFiles')));
    assert.ok(fs.existsSync(path.join(b, 'libjxl_1.wasm')), 'only CMake\'s own files go');
  });

  test('is left alone when the SDK is the same, or nothing is configured', () => {
    const b = tmp(); const { sdk } = fakeSdk('6.0.8');
    configured(b, sdk);
    assert.equal(resetIfOtherToolchain(b, toolchainOf(sdk)), null);
    assert.ok(fs.existsSync(path.join(b, 'CMakeCache.txt')));
    assert.equal(resetIfOtherToolchain(tmp(), toolchainOf(sdk)), null);
  });
});

describe('the SDK a repository expects', () => {
  test('third_parties/emsdk_vers.txt is found above the repository', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'third_parties'));
    fs.writeFileSync(path.join(root, 'third_parties', 'emsdk_vers.txt'), 'EMSDK_VERS=6.0.8\n');
    fs.mkdirSync(path.join(root, 'libjxl'));
    const e = expectedEmsdk(path.join(root, 'libjxl'));
    assert.equal(e.version, '6.0.8');
    assert.equal(e.sdk, path.join(root, 'third_parties', 'emsdk'));
  });
  test('none for a standalone clone', () => {
    assert.equal(expectedEmsdk(tmp()), null);
  });
});

describe('build failures', () => {
  // The output of the failure this was written for, as printed by CMake.
  const MIXED = `CMake Error at /Users/x/project/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake:102 (message):
  Failed to fetch Emscripten version information with command
  "'/Users/x/project/emsdk/upstream/emscripten/emcc' -v"!
  emcc: error: ''$CFGDIR/upstream/bin/clang' -v -target
  wasm32-unknown-emscripten' failed: [Errno 2] No such file or directory:
-- Configuring incomplete, errors occurred!`;
  const expected = { version: '6.0.8', file: '/r/third_parties/emsdk_vers.txt', sdk: '/r/third_parties/emsdk' };

  test('mixed SDKs are named, with the SDK to activate', () => {
    const why = diagnoseBuildFailure(MIXED, { active: { version: '6.0.8' }, expected });
    assert.match(why, /two Emscripten SDKs are mixed/);
    assert.match(why, /source \/r\/third_parties\/emsdk\/emsdk_env\.sh/);
  });
  test('a missing emcmake says to activate the SDK', () => {
    assert.match(diagnoseBuildFailure('sh: emcmake: command not found', { active: null }), /emcmake is not on PATH/);
  });
  test('an ordinary compile error is not given a wrong explanation', () => {
    assert.equal(diagnoseBuildFailure("dec_jxl.c:12:3: error: use of undeclared identifier 'x'", { active: { version: '6.0.8' }, expected }), null);
  });
});
