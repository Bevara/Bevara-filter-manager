import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import semver from 'semver';
import { CliError, log, color } from './ui.js';
import { RegistryError } from './registry-client.js';
import { verifyRecord, keyIdOf } from './sig.js';
import { shortName } from './manifest.js';

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
  const chosen = new Map();     // canonical name -> { version, doc, requestedBy: [range...], aliases: Set }
  const packuments = new Map();
  const queue = Object.entries(roots).map(([name, range]) => ({ name, range, by: 'root' }));

  const getPackument = async (name) => {
    if (!packuments.has(name)) {
      try { const p = await client.packument(name); packuments.set(name, p); packuments.set(p.name, p); }
      catch (e) {
        if (e instanceof RegistryError && e.status === 404) throw new CliError(`filter "${name}" does not exist on ${client.base}`, { hint: 'check the name with `bevara search`' });
        throw e;
      }
    }
    return packuments.get(name);
  };

  while (queue.length) {
    const { name: typed, range, by } = queue.shift();
    const p = await getPackument(typed);
    const name = p.name;               // canonical "<namespace>:<package>"
    const lockEntry = lock[name] ?? lock[typed];
    const wanted = range === 'latest' ? '*' : range;
    const current = chosen.get(name);
    if (current) {
      current.aliases.add(typed);
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
    if (prefer === 'lock' && lockEntry && semver.satisfies(lockEntry.version, wanted, { includePrerelease: true }) && p.versions[lockEntry.version]) version = lockEntry.version;
    else version = pickVersion(p, range);
    if (!version) throw new CliError(`no version of ${name} satisfies "${range}" (available: ${Object.keys(p.versions).join(', ') || 'none'})`);
    const doc = p.versions[version];
    chosen.set(name, { version, doc, requestedBy: [`${by}:${range}`], packument: p, aliases: new Set([typed]) });
    for (const [d, r] of Object.entries(doc.dependencies ?? {})) queue.push({ name: d, range: r, by: `${name}@${version}` });
  }
  // Two namespaces publishing the same package name would produce the same
  // <pkg>_<abi>.wasm file: refuse rather than silently overwrite.
  const byFile = new Map();
  for (const [name, c] of chosen) {
    const other = byFile.get(c.doc.dist.file);
    if (other) throw new CliError(`${name} and ${other} both produce ${c.doc.dist.file}; a page can only load one of them`);
    byFile.set(c.doc.dist.file, name);
  }
  return chosen;
}

export const findChosen = (chosen, typed) => chosen.get(typed) ?? [...chosen.values()].find((c) => c.aliases.has(typed));

// Verifies the publisher signature carried by a version document against the
// downloaded bytes. Returns the signature summary stored in the lockfile.
export function checkSignature(name, version, doc, wasmSha256Hex) {
  const sig = doc.signature;
  if (!sig) return null;
  if (keyIdOf(sig.publicKey) !== sig.keyId) throw new CliError(`${name}@${version}: signing key does not match its id`);
  if (sig.record.wasmSha256 !== wasmSha256Hex) throw new CliError(`${name}@${version}: signed record does not describe the downloaded module`);
  if (sig.record.name !== name || sig.record.version !== version) throw new CliError(`${name}@${version}: signed record is for ${sig.record.name}@${sig.record.version}`);
  if (!verifyRecord(sig.record, sig.signature, sig.publicKey)) throw new CliError(`${name}@${version}: invalid publisher signature`);
  return { keyId: sig.keyId, logSeq: sig.logSeq, logHash: sig.logHash, signedBy: doc.publishedBy };
}

export async function installResolved(client, project, chosen, { registry, quiet = false } = {}) {
  fs.mkdirSync(project.accessorsDir, { recursive: true });
  const installed = [];
  for (const [name, { version, doc, packument }] of chosen) {
    const target = path.join(project.accessorsDir, doc.dist.file);
    const lockEntry = project.lock.filters[name];
    const upToDate = lockEntry?.version === version && fs.existsSync(target) && project.localIntegrity(name) === doc.dist.integrity;
    let signature = lockEntry?.signature ?? null;
    if (!upToDate) {
      const buf = await client.download(doc.dist.wasm);
      const digest = createHash('sha256').update(buf).digest();
      const got = 'sha256-' + digest.toString('base64');
      if (got !== doc.dist.integrity) throw new CliError(`integrity check failed for ${name}@${version}: expected ${doc.dist.integrity}, got ${got}`);
      signature = checkSignature(name, version, doc, digest.toString('hex'));
      if (!signature && !quiet) log.warn(`${name}@${version} is not signed by its publisher`);
      // A runtime brings its JavaScript, covered by the same signed record.
      let jsBuf = null;
      if (doc.dist.js) {
        jsBuf = await client.download(doc.dist.js);
        const jsDigest = createHash('sha256').update(jsBuf).digest();
        if ('sha256-' + jsDigest.toString('base64') !== doc.dist.jsIntegrity) throw new CliError(`integrity check failed for ${name}@${version} (${doc.dist.jsFile})`);
        if (doc.signature && doc.signature.record.jsSha256 !== jsDigest.toString('hex')) throw new CliError(`${name}@${version}: signed record does not describe ${doc.dist.jsFile}`);
      }
      // Remove a previous build of the same filter from another generation (_1, _2…).
      if (lockEntry?.file && lockEntry.file !== doc.dist.file) {
        fs.rmSync(path.join(project.accessorsDir, lockEntry.file), { force: true });
        if (lockEntry.jsFile) fs.rmSync(path.join(project.accessorsDir, lockEntry.jsFile), { force: true });
      }
      fs.writeFileSync(target, buf);
      if (jsBuf) fs.writeFileSync(path.join(project.accessorsDir, doc.dist.jsFile), jsBuf);
      fs.writeFileSync(path.join(project.accessorsDir, `${shortName(name)}.json`), JSON.stringify(stripDist(doc), null, 2) + '\n');
      installed.push({ name, version, from: lockEntry?.version ?? null });
    }
    project.lock.filters[name] = {
      version, abi: doc.abi, file: doc.dist.file, integrity: doc.dist.integrity, resolved: doc.dist.wasm,
      ...(doc.dist.jsFile ? { jsFile: doc.dist.jsFile, jsIntegrity: doc.dist.jsIntegrity } : {}),
      license: doc.license, dependencies: doc.dependencies ?? {}, signature,
      ...(doc.kind === 'runtime' ? { kind: 'runtime' } : { using: doc.using ?? [] }),
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
    fs.rmSync(path.join(project.accessorsDir, `${shortName(name)}.json`), { force: true });
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
