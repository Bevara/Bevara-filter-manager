import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REGISTRY = 'https://registry.bevara.ddns.net';
export const CONFIG_PATH = process.env.BEVARA_CONFIG ?? path.join(os.homedir(), '.bevararc');

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

export function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export const normalizeRegistry = (u) => u.replace(/\/+$/, '');

// Precedence: --registry flag > BEVARA_REGISTRY > project bevara.json "registry" > ~/.bevararc > default.
export function resolveRegistry({ flag, project } = {}) {
  return normalizeRegistry(flag ?? process.env.BEVARA_REGISTRY ?? project?.registry ?? readConfig().registry ?? DEFAULT_REGISTRY);
}

export function getToken(registry) {
  if (process.env.BEVARA_TOKEN) return process.env.BEVARA_TOKEN;
  return readConfig().tokens?.[normalizeRegistry(registry)] ?? null;
}

export function setToken(registry, token, user) {
  const cfg = readConfig();
  cfg.tokens ??= {};
  cfg.users ??= {};
  cfg.tokens[normalizeRegistry(registry)] = token;
  if (user) cfg.users[normalizeRegistry(registry)] = user;
  writeConfig(cfg);
}

export function clearToken(registry) {
  const cfg = readConfig();
  delete cfg.tokens?.[normalizeRegistry(registry)];
  delete cfg.users?.[normalizeRegistry(registry)];
  writeConfig(cfg);
}
