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

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;

/* Accepts what people type: `registry.bevara.ddns.net` gets https://, a bare
 * local address (`127.0.0.1:8080`, `localhost:8080`) gets http://, and a
 * trailing slash is dropped so tokens and keys are stored under one key. */
export function normalizeRegistry(u) {
  let url = String(u).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = (LOCAL_HOST.test(url) ? 'http://' : 'https://') + url;
  return url.replace(/\/+$/, '');
}

/* Where the registry comes from, highest precedence first:
 *   --registry flag > BEVARA_REGISTRY > "registry" in the project's manifest
 *   > ~/.bevararc (bevara config set registry) > the built-in default. */
export function resolveRegistrySource({ flag, project, projectFile = 'bevara.json' } = {}) {
  const candidates = [
    [flag, '--registry'],
    [process.env.BEVARA_REGISTRY, 'BEVARA_REGISTRY'],
    [project?.registry, projectFile],
    [readConfig().registry, CONFIG_PATH],
  ];
  for (const [value, source] of candidates) if (value) return { url: normalizeRegistry(value), source };
  return { url: DEFAULT_REGISTRY, source: 'default' };
}

export function resolveRegistry(opts = {}) {
  return resolveRegistrySource(opts).url;
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

// Publisher signing key per (registry, account): { publicKey, privateKey, keyId }.
// The key is the user's identity towards the log, so it follows the login.
export function currentUser(registry) {
  return readConfig().users?.[normalizeRegistry(registry)] ?? null;
}
const keySlot = (registry) => `${normalizeRegistry(registry)}#${currentUser(registry) ?? ''}`;
export function getKey(registry) {
  return readConfig().keys?.[keySlot(registry)] ?? null;
}
export function setKey(registry, key) {
  const cfg = readConfig();
  cfg.keys ??= {};
  cfg.keys[keySlot(registry)] = key;
  writeConfig(cfg);
}
export function clearKey(registry) {
  const cfg = readConfig();
  delete cfg.keys?.[keySlot(registry)];
  writeConfig(cfg);
}
