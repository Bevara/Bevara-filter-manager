/* An Emscripten SDK for a build, when none suitable is active.
 *
 * The version wanted is the one the repository pins
 * (third_parties/emsdk_vers.txt), or the latest stable release when it pins
 * none. If the active SDK is that one, nothing happens. Otherwise the CLI
 * offers to download it into its own emsdk checkout (~/.bevara/emsdk, or
 * BEVARA_EMSDK_HOME) and builds with that SDK's environment - computed from
 * its emsdk_env.sh for the build process only; the user's shell and any other
 * emsdk are left alone. Declining shows the commands to use one's own emsdk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { CliError, log, color, confirm } from './ui.js';
import { activeEmsdk, expectedEmsdk, which } from './emsdk.js';

export const managedHome = (env = process.env) => env.BEVARA_EMSDK_HOME || path.join(os.homedir(), '.bevara', 'emsdk');
const EMSDK_REPO = 'https://github.com/emscripten-core/emsdk.git';

/* The Emscripten version installed in an emsdk checkout, or null. */
export function installedVersion(home) {
  try { return /(\d+\.\d+\.\d+)/.exec(fs.readFileSync(path.join(home, 'upstream', 'emscripten', 'emscripten-version.txt'), 'utf8'))?.[1] ?? null; }
  catch { return null; }
}

/* The environment emsdk_env.sh sets, for child processes. */
export function environmentOf(home, base = process.env) {
  const out = execFileSync('bash', ['-c', 'source ./emsdk_env.sh >/dev/null 2>&1; env -0'], { cwd: home, env: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const env = {};
  for (const kv of out.split('\0')) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
  return env;
}

function run(cmd, args, cwd) {
  log.step(color.dim(`${cmd} ${args.join(' ')}`));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new CliError(`${cmd} ${args.join(' ')} failed (exit ${code})`))));
  });
}

/* Downloads (once) emsdk itself, then the SDK version, and activates it in
 * the CLI's own checkout. Returns the version installed. */
export async function provision(version, { home = managedHome() } = {}) {
  for (const tool of ['git', 'python3']) {
    if (!which(tool)) throw new CliError(`${tool} is needed to download the Emscripten SDK`, { hint: `install ${tool}, or install emsdk yourself: https://emscripten.org/docs/getting_started/downloads.html` });
  }
  if (!fs.existsSync(path.join(home, 'emsdk'))) {
    fs.mkdirSync(path.dirname(home), { recursive: true });
    await run('git', ['clone', '--depth', '1', EMSDK_REPO, home], path.dirname(home));
  } else if (version === 'latest') {
    await run('git', ['pull', '--ff-only', '-q'], home);           // "latest" is what this checkout knows
  }
  await run('./emsdk', ['install', version], home);
  await run('./emsdk', ['activate', version], home);
  const got = installedVersion(home);
  if (!got) throw new CliError(`emsdk ${version} did not install in ${home}`);
  return got;
}

/* The commands to use an emsdk one already has, for the version wanted. */
export function ownEmsdkCommands(version) {
  return [
    `<your emsdk>/emsdk install ${version}`,
    `<your emsdk>/emsdk activate ${version}`,
    'source <your emsdk>/emsdk_env.sh',
  ];
}

/**
 * Makes sure a build gets the SDK it wants.
 * @param {string} root  the repository
 * @param {{yes?: boolean, interactive?: boolean, env?: object, deps?: object}} opts
 *   yes: download without asking; interactive: whether to ask (a TTY).
 *   deps: replacements for tests (activeEmsdk, installedVersion, provision, environmentOf, confirm).
 * @returns {Promise<{ env: object, version: string|null, source: 'active'|'managed'|'downloaded'|'mismatch' }>}
 */
export async function ensureEmsdk(root, { yes = false, interactive = process.stdin.isTTY, env = process.env, deps = {} } = {}) {
  const d = { activeEmsdk, installedVersion, provision, environmentOf, confirm, expectedEmsdk, ...deps };
  const expected = d.expectedEmsdk(root);
  const want = expected?.version ?? 'latest';
  const active = d.activeEmsdk(env);
  if (active?.version && (!expected || active.version === expected.version)) return { env, version: active.version, source: 'active' };

  const home = managedHome(env);
  const managed = d.installedVersion(home);
  if (managed && (expected ? managed === expected.version : !active)) {
    log.step(`using emsdk ${managed} from ${home}`);
    return { env: { ...env, ...d.environmentOf(home, env) }, version: managed, source: 'managed' };
  }

  const what = expected ? `emsdk ${want}, which ${path.relative(process.cwd(), expected.file) || expected.file} pins` : 'the latest stable emsdk';
  const why = active ? `the active Emscripten SDK is ${active.version ?? 'of unknown version'}` : 'no Emscripten SDK is active';
  log.warn(`${why}; this build wants ${what}`);
  const accept = yes || (interactive && await d.confirm(`download it into ${home} (a few hundred MB) and use it for the build?`, true));
  if (accept) {
    const version = await d.provision(want, { home });
    log.ok(`emsdk ${version} installed in ${home}; builds use it from now on`);
    return { env: { ...env, ...d.environmentOf(home, env) }, version, source: 'downloaded' };
  }
  const commands = ownEmsdkCommands(want);
  if (active) {
    log.info(`building with emsdk ${active.version} anyway. To build with ${want} from an emsdk you have:\n${commands.map((c) => `    ${c}`).join('\n')}`);
    return { env, version: active.version, source: 'mismatch' };
  }
  throw new CliError('no Emscripten SDK to build with', {
    hint: `with an emsdk you already have:\n    ${commands.join('\n    ')}\n  then run the command again${interactive ? '' : ' - or pass --yes to let bevara download it'}`,
  });
}
