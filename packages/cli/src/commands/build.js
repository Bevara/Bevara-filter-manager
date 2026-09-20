import { log, color, formatBytes } from '../lib/ui.js';
import { Project } from '../lib/ctx.js';
import { buildFilter, checkFilterManifest, checkArtifact } from '../lib/pack.js';

export const options = { script: { type: 'string', short: 's' } };
export const help = `Runs "scripts.build" from bevara.json (default: emcmake cmake -S . -B build && cmake --build build)
then verifies that "main" is a valid Emscripten side module.
Options:
  -s, --script <cmd>   override the build command`;

export async function run({ opts }) {
  const project = Project.load();
  const m = checkFilterManifest(project);
  buildFilter(project, { script: opts.script });
  const { info } = checkArtifact(project, m);
  log.ok(`built ${color.bold(m.main)} (${formatBytes(info.size)}, ${info.exports.length} exports, needs: ${info.dylink?.needed.join(', ') || 'none'})`);
}
