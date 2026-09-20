import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prompt, log, color, CliError } from '../lib/ui.js';
import { NAME_RE, SUPPORT_VALUES } from '../lib/manifest.js';
import { MANIFEST, writeJsonFile } from '../lib/project.js';
import { accessorFileName } from '../lib/wasm.js';

export const options = {
  name: { type: 'string', short: 'n' },
  force: { type: 'boolean', short: 'f' },
  site: { type: 'boolean' },
};

export const help = `Options:
  -n, --name <name>   filter name (default: current directory name)
  -y, --yes           accept all defaults
  -f, --force         overwrite an existing ${MANIFEST}
  --site              initialise a consumer project (a web site that installs filters) instead of a filter`;

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'filter');

export async function run({ args, opts }) {
  const dir = path.resolve(args[0] ?? '.');
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, MANIFEST);
  if (fs.existsSync(manifestPath) && !opts.force) throw new CliError(`${MANIFEST} already exists in ${dir}`, { hint: 'use --force to overwrite' });

  if (opts.site) {
    writeJsonFile(manifestPath, { name: path.basename(dir).toLowerCase().replace(/[^a-z0-9._-]/g, '-'), accessorsDir: 'accessors', dependencies: {} });
    log.ok(`created ${MANIFEST} for a site project. Next: ${color.bold('bevara install <filter>')}`);
    return;
  }

  const defName = (opts.name ?? path.basename(dir)).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const ask = async (q, def, extra) => (opts.yes ? def : prompt(q, { default: def, ...extra }));
  const name = await ask('Filter name', defName, { validate: (v) => (NAME_RE.test(v) ? null : 'lowercase letters, digits, ". _ -" only') });
  const description = await ask('Description', `${name} accessor`);
  const gpacFilter = await ask('GPAC filter name(s) registered by the module (comma separated)', `${name}dec`);
  const support = await ask(`Media kinds (${SUPPORT_VALUES.slice(0, 4).join(', ')}…, comma separated)`, 'video');
  const formats = await ask('Formats handled (comma separated)', name);
  const license = await ask('License (SPDX)', 'MIT');
  const sources = await ask('Sources URL', `https://github.com/Bevara/${name}`);
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const manifest = {
    name, version: '1.0.0', abi: 1, description,
    filters: split(gpacFilter), support: split(support), formats: split(formats),
    keywords: [], license, licence_required: false, georestrictions: false, priority: 50,
    inputs: [{ stream_type: 'visual', codec: name }], outputs: [{ stream_type: 'visual', codec: 'raw' }],
    sources, filter_source: Object.fromEntries(split(gpacFilter).map((f) => [f, `src/${name}.c`])),
    main: `build/${accessorFileName(name, 1)}`,
    scripts: { build: 'emcmake cmake -S . -B build && cmake --build build' },
    dependencies: {},
  };
  writeJsonFile(manifestPath, manifest);

  const vars = { NAME: name, NAME_UPPER: name.toUpperCase().replace(/[^A-Z0-9]/g, '_'), FILTER: split(gpacFilter)[0], DESCRIPTION: description, YEAR: String(new Date().getFullYear()) };
  const render = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  for (const rel of ['CMakeLists.txt', 'filters.cmake', 'README.md', 'gitignore', 'src/filter.c', 'include/gpac/config.h']) {
    const dest = rel === 'gitignore' ? '.gitignore' : rel === 'src/filter.c' ? `src/${name}.c` : rel;
    const target = path.join(dir, dest);
    if (fs.existsSync(target) && !opts.force) { log.warn(`kept existing ${dest}`); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, render(fs.readFileSync(path.join(TEMPLATES, rel), 'utf8')));
  }
  log.ok(`created filter project ${color.bold(name)} in ${dir}`);
  log.info(`
  ${color.dim('src/' + name + '.c')}   GPAC filter skeleton (GF_FilterRegister + caps)
  ${color.dim('CMakeLists.txt')}  builds build/${accessorFileName(name, 1)} as an Emscripten side module
  ${color.dim(MANIFEST)}     package manifest read by the registry

Next steps:
  export GPAC_DIR=/path/to/gpac         ${color.dim('# headers of the GPAC version used by the solver')}
  bevara build                          ${color.dim('# needs the Emscripten SDK (emcmake in PATH)')}
  bevara publish`);
}
