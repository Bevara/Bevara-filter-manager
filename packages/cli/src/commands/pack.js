import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { Project } from '../lib/ctx.js';
import { packFilter, buildFilter } from '../lib/pack.js';

export const options = { build: { type: 'boolean', short: 'b' }, 'build-dir': { type: 'string', short: 'B' }, 'dry-run': { type: 'boolean' } };
export const help = `Options:
  -b, --build    run the build first
  --dry-run      only list what would be packed
Arguments:
  [dir]                    the filter repository (default: the current directory or
                           the nearest parent holding a manifest)
  -B, --build-dir <dir>    build directory, relative to the repository like CMake's -B
                           (default: .bevara/.build). Where --build writes, and where the
                           module is looked for unless "main" names it - without -B,
                           build/ and the repository root are looked in too. A custom
                           "scripts.build" receives it as $BEVARA_BUILD_DIR.`;

export async function run({ args, opts }) {
  if (args.length > 1) throw new CliError('pack takes one directory at most');
  const project = Project.load({ dir: args[0] });
  const buildDir = opts['build-dir'];
  if (opts.build) await buildFilter(project, { buildDir, yes: opts.yes });
  const r = await packFilter(project, { dryRun: opts['dry-run'], buildDir });
  console.log(table(r.entries.map((e) => [color.dim(e.path), formatBytes(e.size)])));
  if (opts['dry-run']) return log.ok(`${r.manifest.name}@${r.manifest.version}: ${r.entries.length} files from ${project.manifestName} (dry run)`);
  log.ok(`${color.bold(r.tgzName)} (${formatBytes(r.size)})`);
}
