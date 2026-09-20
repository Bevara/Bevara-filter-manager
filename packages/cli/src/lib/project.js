import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from './ui.js';

export const MANIFEST = 'bevara.json';
export const LOCKFILE = 'bevara-lock.json';
export const DEFAULT_ACCESSORS_DIR = 'accessors';

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, MANIFEST))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new CliError(`cannot parse ${file}: ${e.message}`);
  }
}

export function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export class Project {
  constructor(root) {
    this.root = root;
    this.manifest = readJsonFile(path.join(root, MANIFEST)) ?? {};
    this.lock = readJsonFile(path.join(root, LOCKFILE)) ?? { lockfileVersion: 1, filters: {} };
    this.lock.filters ??= {};
  }

  static load({ required = true } = {}) {
    const root = findProjectRoot();
    if (!root) {
      if (required) throw new CliError(`no ${MANIFEST} found in this directory or its parents`, { hint: 'run `bevara init` to create a filter, or `bevara install <filter>` to start a project' });
      return new Project(process.cwd());
    }
    return new Project(root);
  }

  static create(dir, manifest) {
    writeJsonFile(path.join(dir, MANIFEST), manifest);
    return new Project(dir);
  }

  get accessorsDir() { return path.resolve(this.root, this.manifest.accessorsDir ?? DEFAULT_ACCESSORS_DIR); }
  get isFilter() { return Array.isArray(this.manifest.filters) && this.manifest.filters.length > 0; }

  saveManifest() { writeJsonFile(path.join(this.root, MANIFEST), this.manifest); }
  saveLock(registry) {
    this.lock.lockfileVersion = 1;
    if (registry) this.lock.registry = registry;
    const sorted = {};
    for (const k of Object.keys(this.lock.filters).sort()) sorted[k] = this.lock.filters[k];
    this.lock.filters = sorted;
    writeJsonFile(path.join(this.root, LOCKFILE), this.lock);
  }

  installedFile(name) {
    const entry = this.lock.filters[name];
    return entry ? path.join(this.accessorsDir, entry.file) : null;
  }

  localIntegrity(name) {
    const file = this.installedFile(name);
    if (!file || !fs.existsSync(file)) return null;
    return 'sha256-' + createHash('sha256').update(fs.readFileSync(file)).digest('base64');
  }
}
