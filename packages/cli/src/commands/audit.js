import fs from 'node:fs';
import semver from 'semver';
import { log, color, table, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { inspectWasm } from '../lib/wasm.js';

export const options = { fix: { type: 'boolean' }, 'audit-level': { type: 'string' } };
export const help = `Checks every installed filter against the registry:
  • integrity     the .wasm on disk matches the lockfile and the registry (sha256)
  • module        the file is a valid Emscripten side module
  • advisories    security/quality advisories published for the installed version
  • deprecated    filter or version marked deprecated by its owner
  • outdated      newer versions inside / outside the allowed range
  • licence       filters flagged "licence_required"
Options:
  --fix                     run \`bevara update\` for filters with fixable findings
  --audit-level <level>     exit with code 1 only from this severity: low|moderate|high|critical (default: low)`;

const SEV = { low: 1, moderate: 2, high: 3, critical: 4 };

export async function run({ opts }) {
  const project = Project.load();
  const { client } = clientFor(opts, project);
  const installed = Object.fromEntries(Object.entries(project.lock.filters).map(([n, e]) => [n, e.version]));
  if (!Object.keys(installed).length) { log.ok('no filters installed, nothing to audit'); return; }
  const { report } = await client.audit(installed);
  const findings = [];
  const add = (name, severity, kind, message, fixable = false) => findings.push({ name, severity, kind, message, fixable });

  for (const [name, entry] of Object.entries(project.lock.filters)) {
    const file = project.installedFile(name);
    if (!file || !fs.existsSync(file)) { add(name, 'high', 'missing', `${entry.file} is missing from the accessors directory`, true); continue; }
    const local = project.localIntegrity(name);
    if (local !== entry.integrity) add(name, 'critical', 'integrity', `${entry.file} does not match bevara-lock.json (tampered or corrupted)`, true);
    const info = inspectWasm(fs.readFileSync(file));
    if (!info.valid) add(name, 'critical', 'module', `${entry.file}: ${info.error}`, true);
    else if (!info.sideModule) add(name, 'high', 'module', `${entry.file} is not a side module; the solver cannot link it`, false);

    const r = report[name];
    if (!r?.found) { add(name, 'moderate', 'unpublished', `${name} no longer exists on the registry`); continue; }
    if (!r.version) add(name, 'moderate', 'unpublished', `${name}@${entry.version} was unpublished from the registry`, true);
    else if (r.version.integrity !== entry.integrity) add(name, 'critical', 'integrity', `${name}@${entry.version} on the registry differs from the lockfile (registry content changed)`);
    if (r.deprecated) add(name, 'moderate', 'deprecated', `${name} is deprecated: ${r.deprecated}`);
    if (r.version?.deprecated) add(name, 'moderate', 'deprecated', `${name}@${entry.version} is deprecated: ${r.version.deprecated}`, true);
    for (const a of r.advisories ?? []) add(name, a.severity, 'advisory', `${a.title} (affects ${a.range})${a.url ? ' ' + color.dim(a.url) : ''}`, true);
    const range = project.manifest.dependencies?.[name];
    const newer = r.versions.map((v) => v.version).filter((v) => semver.gt(v, entry.version) && !r.versions.find((x) => x.version === v)?.deprecated);
    const inRange = range && range !== 'latest' ? newer.filter((v) => semver.satisfies(v, range)) : newer;
    if (inRange.length) add(name, 'low', 'outdated', `${semver.maxSatisfying(inRange, '*')} is available (installed ${entry.version})`, true);
    else if (newer.length) add(name, 'low', 'outdated', `${semver.maxSatisfying(newer, '*')} is available outside the range ${range} (bevara update --latest)`);
    if (r.version?.licence_required) add(name, 'low', 'licence', `${name} requires a licence (${r.version.license ?? 'see documentation'})`);
  }

  if (opts.json) { console.log(JSON.stringify({ filters: installed, findings }, null, 2)); }
  else if (!findings.length) log.ok(`audited ${Object.keys(installed).length} filter${Object.keys(installed).length === 1 ? '' : 's'}: no issues found`);
  else {
    const paint = { low: color.cyan, moderate: color.yellow, high: color.red, critical: (s) => color.bold(color.red(s)) };
    console.log(table(findings.sort((a, b) => SEV[b.severity] - SEV[a.severity]).map((f) => [paint[f.severity](f.severity.padEnd(8)), color.bold(f.name), f.kind, f.message]), { header: ['Severity', 'Filter', 'Kind', 'Detail'].map(color.bold) }));
    const counts = Object.entries(findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] ?? 0) + 1), m), {})).map(([s, n]) => `${n} ${s}`).join(', ');
    console.log(`\n${findings.length} finding${findings.length === 1 ? '' : 's'} (${counts}) in ${Object.keys(installed).length} filters`);
    if (findings.some((f) => f.fixable) && !opts.fix) console.log(color.dim('run `bevara audit --fix` to update the affected filters'));
  }

  if (opts.fix && findings.some((f) => f.fixable)) {
    const names = [...new Set(findings.filter((f) => f.fixable).map((f) => f.name))];
    log.step(`updating ${names.join(', ')}`);
    const { run: update } = await import('./update.js');
    await update({ args: names, opts });
  }
  const threshold = SEV[opts['audit-level'] ?? 'low'];
  if (!threshold) throw new CliError('--audit-level must be low|moderate|high|critical');
  if (findings.some((f) => SEV[f.severity] >= threshold)) process.exitCode = 1;
}
