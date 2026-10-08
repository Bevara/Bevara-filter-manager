import { log, color, formatBytes, CliError } from '../lib/ui.js';
import { Project } from '../lib/ctx.js';
import { buildFilter, filterManifest, checkArtifact } from '../lib/pack.js';

export const options = { script: { type: 'string', short: 's' }, 'build-dir': { type: 'string', short: 'B' } };
export const help = `Runs "scripts.build" from the filter's manifest (<name>.json), by default
emcmake cmake -S . -B .bevara/.build && cmake --build .bevara/.build, then checks that the module
it produced is a valid Emscripten side module. No "version" is needed to build.
Options:
  -s, --script <cmd>   override the build command
Arguments:
  [dir]                    the filter repository (default: the current directory or
                           the nearest parent holding a manifest)
  -B, --build-dir <dir>    build directory, relative to the repository like CMake's -B
                           (default: .bevara/.build). Where --build writes, and where the
                           module is looked for unless "main" names it - without -B,
                           build/ and the repository root are looked in too. A custom
                           "scripts.build" receives it as $BEVARA_BUILD_DIR.`;

export async function run({ args, opts }) {
  if (args.length > 1) throw new CliError('build takes one directory at most');
  const project = Project.load({ dir: args[0] });
  const buildDir = opts['build-dir'];
  if (!project.isFilter) throw new CliError(`${project.manifestName} does not describe a filter (no "filters")`);
  const m = filterManifest(project, { buildDir });
  await buildFilter(project, { script: opts.script, buildDir });
  const { info } = checkArtifact(project, m);
  log.ok(`built ${color.bold(m.main)} (${formatBytes(info.size)}, ${info.exports.length} exports, needs: ${info.dylink?.needed.join(', ') || 'none'})`);
}
