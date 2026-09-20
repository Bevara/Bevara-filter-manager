import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import semver from 'semver';
import { CliError, log, color } from './ui.js';
import { RegistryError } from './registry-client.js';

// Parses "theora", "theora@^1.2", "theora@1.0.0", "theora@latest".
export function parseSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec, range: 'latest' };
  return { name: spec.slice(0, at), range: spec.slice(at + 1) || 'latest' };
}

export function pickVersion(packument, range) {
  const versions = Object.keys(packument.versions ?? {});
  if (!versions.length) return null;
  if (range === 'latest' || range === '*' || range === '') {
    const latest = packument['dist-tags']?.latest;
    return latest && packument.versions[latest] ? latest : semver.maxSatisfying(versions, '*');
  }
  if (packument.versions[range]) return range;
  if (!semver.validRange(range)) throw new CliError(`"${range}" is not a valid version or range for ${packument.name}`);
  return semver.maxSatisfying(versions, range) ?? semver.maxSatisfying(versions, range, { includePrerelease: true });
}

// Flat resolution: every filter ends up as exactly one version in the
// accessors directory (the player loads them by <name>_<abi>.wasm). Ranges
// coming from different requesters must all be satisfied by the chosen version.
export async function resolveTree(client, roots, { lock = {}, prefer = 'lock' } = {}) {
  const chosen = new Map();     // name -> { version, doc, requestedBy: [range...] }
  const packuments = new Map();
  const queue = Object.entries(roots).map(([name, range]) => ({ name, range, by: 'root' }));

  const getPackument = async (name) => {
    if (!packuments.has(name)) {
      try { packuments.set(name, await client.packument(name)); }
      catch (e) {
        if (e instanceof RegistryError && e.status === 404) throw new CliError(`filter "${name}" does not exist on ${client.base}`, { hint: 'check the name with `bevara search`' });
        throw e;
      }
    }
    return packuments.get(name);
  };

  while (queue.length) {
    const { name, range, by } = queue.shift();
    const p = await getPackument(name);
    const wanted = range === 'latest' ? '*' : range;
    const current = chosen.get(name);
    if (current) {
      if (range === 'latest' || semver.satisfies(current.version, wanted, { includePrerelease: true })) { current.requestedBy.push(`${by}:${range}`); continue; }
      const combined = [...current.requestedBy.map((r) => r.split(':').slice(1).join(':')), range].filter((r) => r !== 'latest');
      const candidates = Object.keys(p.versions).filter((v) => combined.every((r) => semver.satisfies(v, r, { includePrerelease: true })));
      const v = semver.maxSatisfying(candidates, '*', { includePrerelease: true });
      if (!v) throw new CliError(`cannot satisfy ${name}: ${by} wants ${range} but ${current.requestedBy.join(', ')} already chose ${current.version}`);
      current.version = v; current.doc = p.versions[v]; current.requestedBy.push(`${by}:${range}`);
      for (const [d, r] of Object.entries(current.doc.dependencies ?? {})) queue.push({ name: d, range: r, by: `${name}@${v}` });
      continue;
    }
    let version = null;
    if (prefer === 'lock' && lock[name] && semver.satisfies(lock[name].version, wanted, { includePrerelease: true }) && p.versions[lock[name].version]) version = lock[name].version;
    else version = pickVersion(p, range);
    if (!version) throw new CliError(`no version of ${name} satisfies "${range}" (available: ${Object.keys(p.versions).join(', ') || 'none'})`);
    const doc = p.versions[version];
    chosen.set(name, { version, doc, requestedBy: [`${by}:${range}`], packument: p });
    for (const [d, r] of Object.entries(doc.dependencies ?? {})) queue.push({ name: d, range: r, by: `${name}@${version}` });
  }
  return chosen;
}

export async function installResolved(client, project, chosen, { registry, quiet = false } = {}) {
  fs.mkdirSync(project.accessorsDir, { recursive: true });
  const installed = [];
  for (const [name, { version, doc, packument }] of chosen) {
    const target = path.join(project.accessorsDir, doc.dist.file);
    const lockEntry = project.lock.filters[name];
    const upToDate = lockEntry?.version === version && fs.existsSync(target) && project.localIntegrity(name) === doc.dist.integrity;
    if (!upToDate) {
      const buf = await client.download(doc.dist.wasm);
      const got = 'sha256-' + createHash('sha256').update(buf).digest('base64');
      if (got !== doc.dist.integrity) throw new CliError(`integrity check failed for ${name}@${version}: expected ${doc.dist.integrity}, got ${got}`);
      // Remove a previous build of the same filter with another ABI suffix.
      if (lockEntry?.file && lockEntry.file !== doc.dist.file) fs.rmSync(path.join(project.accessorsDir, lockEntry.file), { force: true });
      fs.writeFileSync(target, buf);
      fs.writeFileSync(path.join(project.accessorsDir, `${name}.json`), JSON.stringify(stripDist(doc), null, 2) + '\n');
      installed.push({ name, version, from: lockEntry?.version ?? null });
    }
    project.lock.filters[name] = {
      version, abi: doc.abi, file: doc.dist.file, integrity: doc.dist.integrity, resolved: doc.dist.wasm,
      license: doc.license, dependencies: doc.dependencies ?? {},
    };
    if (packument?.deprecated && !quiet) log.warn(`${name} is deprecated: ${packument.deprecated}`);
    if (doc.deprecated && !quiet) log.warn(`${name}@${version} is deprecated: ${doc.deprecated}`);
    if (doc.licence_required && !quiet) log.warn(`${name}@${version} requires a licence (${doc.license ?? 'see filter documentation'})`);
  }
  // Drop lock entries (and files) for filters nobody references any more.
  for (const name of Object.keys(project.lock.filters)) {
    if (chosen.has(name)) continue;
    const entry = project.lock.filters[name];
    fs.rmSync(path.join(project.accessorsDir, entry.file), { force: true });
    fs.rmSync(path.join(project.accessorsDir, `${name}.json`), { force: true });
    delete project.lock.filters[name];
    if (!quiet) log.step(`removed ${color.bold(name)} (no longer required)`);
  }
  project.saveLock(registry);
  return installed;
}

function stripDist(doc) {
  const { dist, wasm, downloads, ...rest } = doc;
  return { ...rest, integrity: dist.integrity, resolved: dist.wasm };
}
