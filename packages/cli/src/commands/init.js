import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prompt, log, color, CliError } from '../lib/ui.js';
import { NAME_RE, SUPPORT_VALUES, PATENT_STATUSES } from '../lib/manifest.js';
import { MANIFEST, writeJsonFile, filterManifestsIn } from '../lib/project.js';
import { accessorFileName } from '../lib/wasm.js';

export const options = {
  name: { type: 'string', short: 'n' },
  force: { type: 'boolean', short: 'f' },
  site: { type: 'boolean' },
  patents: { type: 'string' },
};

export const help = `Options:
  --patents <status>  patent status of the format: royalty-free, expired, licence-required,
                      under-review (default: asked; under-review with -y)
  -n, --name <name>   filter name (default: current directory name)
  -y, --yes           accept all defaults
  -f, --force         overwrite an existing manifest
  --site              initialise a consumer project (a web site that installs filters) instead of a filter

A filter is described by <name>.json - the file its CMake build reads into
filter_list.json - and nothing else; a site, which has no filter name, by bevara.json.`;

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'filter');

export async function run({ args, opts }) {
  const dir = path.resolve(args[0] ?? '.');
  fs.mkdirSync(dir, { recursive: true });
  if (opts.site) {
    const manifestPath = path.join(dir, MANIFEST);
    if (fs.existsSync(manifestPath) && !opts.force) throw new CliError(`${MANIFEST} already exists in ${dir}`, { hint: 'use --force to overwrite' });
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
  const license = await ask('Licence (SPDX identifier, written to LICENCE)', 'MIT');
  const holder = await ask('Copyright holder', 'Bevara Technologies, LLC');
  const sources = await ask('Sources URL', `https://github.com/Bevara/${name}`);
  // The patent status of the format: any is published, the restricted ones are announced to users.
  if (opts.patents !== undefined && !PATENT_STATUSES.includes(opts.patents)) throw new CliError(`--patents ${opts.patents}: one of ${PATENT_STATUSES.join(', ')}`);
  const patentStatus = opts.patents ?? await ask(`Patent status of the format (${PATENT_STATUSES.join(', ')})`, 'under-review', { validate: (v) => (PATENT_STATUSES.includes(v) ? null : `one of ${PATENT_STATUSES.join(', ')}`) });
  // Required to publish: the runtimes (solvers) the module links against, each
  // published on the registry (a registry may carry several, per environment).
  const using = await ask('Runtimes it links against, as pages name them (comma separated)', 'solver_1', { validate: (v) => (v.split(',').map((x) => x.trim()).filter(Boolean).every((u) => /^[A-Za-z0-9][A-Za-z0-9._-]*_\d+$/.test(u)) ? null : 'e.g. solver_1, solver_minimal_1') });
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

  // Same shape and indentation as the existing filter repositories' manifests
  // ("Format", four spaces). No "version": the generation in CMakeLists.txt
  // gives it. No "license": the LICENCE file written below gives it. "main" and
  // the build command default too.
  const manifestFile = `${name}.json`;
  const manifestPath = path.join(dir, manifestFile);
  if (fs.existsSync(manifestPath) && !opts.force) throw new CliError(`${manifestFile} already exists in ${dir}`, { hint: 'use --force to overwrite' });
  const others = filterManifestsIn(dir).filter((f) => f !== manifestPath);
  if (others.length && !opts.force) throw new CliError(`${dir} already holds a filter manifest (${others.map((f) => path.basename(f)).join(', ')})`, { hint: 'one filter per directory; use --force to add another anyway' });
  const manifest = {
    name, description,
    filters: split(gpacFilter),
    help: description,
    support: split(support),
    Format: split(formats),
    patents: { status: patentStatus, checked: new Date().toISOString().slice(0, 10) },
    using: split(using),
    sources, filter_source: Object.fromEntries(split(gpacFilter).map((f) => [f, `src/${name}.c`])),
    inputs: [{ stream_type: 'visual', codec: name }], outputs: [{ stream_type: 'visual', codec: 'raw' }],
  };
  writeJsonFile(manifestPath, manifest, { indent: 4 });
  const licencePath = path.join(dir, 'LICENCE');
  if (!fs.existsSync(licencePath) || opts.force) fs.writeFileSync(licencePath, licenceText(license, holder));
  else log.warn('kept existing LICENCE');

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
  ${color.dim('CMakeLists.txt')}  builds .bevara/.build/${accessorFileName(name, 1)} as an Emscripten side module
  ${color.dim(manifestFile)}${' '.repeat(Math.max(1, 15 - manifestFile.length))} manifest: read by the CMake build and by the registry

Next steps:
  export GPAC_DIR=/path/to/gpac         ${color.dim('# headers of the GPAC version used by the solver')}
  bevara build                          ${color.dim('# needs the Emscripten SDK (emcmake in PATH)')}
  bevara publish`);
}

/* LICENCE for a new filter: the SPDX tag the CLI reads, then the text. The
 * short permissive licences are written in full; for the others the tag points
 * to the official text, which should be pasted below it. */
function licenceText(spdx, holder) {
  const year = new Date().getFullYear();
  const head = `SPDX-License-Identifier: ${spdx}\n\n`;
  const texts = {
    MIT: `MIT License\n\nCopyright (c) ${year} ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`,
    'BSD-3-Clause': `BSD 3-Clause License\n\nCopyright (c) ${year}, ${holder}\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this\n   list of conditions and the following disclaimer.\n\n2. Redistributions in binary form must reproduce the above copyright notice,\n   this list of conditions and the following disclaimer in the documentation\n   and/or other materials provided with the distribution.\n\n3. Neither the name of the copyright holder nor the names of its\n   contributors may be used to endorse or promote products derived from\n   this software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"\nAND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE\nIMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE\nDISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE\nFOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL\nDAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR\nSERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER\nCAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,\nOR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE\nOF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n`,
  };
  return head + (texts[spdx] ?? `Copyright (c) ${year} ${holder}\n\nLicensed under ${spdx}. Paste the full licence text here:\nhttps://spdx.org/licenses/${encodeURIComponent(spdx)}.html\n`);
}
