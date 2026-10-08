import { log, color, CliError } from '../lib/ui.js';
import { readConfig, writeConfig, CONFIG_PATH, resolveRegistry, resolveRegistrySource, normalizeRegistry, DEFAULT_REGISTRY } from '../lib/config.js';
import { clientFor, Project } from '../lib/ctx.js';
import { isRegistryTooOld, MIN_REGISTRY_VERSION } from '../lib/registry-client.js';

export const help = `The registry defaults to ${DEFAULT_REGISTRY}; nothing needs to be configured
to use it. To point elsewhere:

  bevara config set registry http://127.0.0.1:8080   for every command, stored in ${CONFIG_PATH}
  bevara config unset registry                       back to the default
  bevara config get registry                         prints the registry in use and why

Precedence, highest first: -r/--registry, BEVARA_REGISTRY, "registry" in the
project's manifest, ${CONFIG_PATH}, the default. A bare host is accepted
(registry.example.org means https://, 127.0.0.1:8080 means http://).
BEVARA_CONFIG moves the settings file.`;

const KEYS = ['registry'];

const describeSource = (s) => (s === 'default' ? 'built-in default' : s.endsWith('.json') && !s.includes('/') ? `this project's ${s}` : s);

export async function run({ args, opts }) {
  const [action, key, value] = args;
  const cfg = readConfig();
  const project = Project.load({ required: false });
  const resolved = resolveRegistrySource({ flag: opts.registry, project: project.manifest, projectFile: project.manifestName });
  if (!action || action === 'list' || action === 'ls') {
    console.log(color.dim(`# ${CONFIG_PATH}`));
    console.log(`registry = ${resolved.url}  ${color.dim(`(${describeSource(resolved.source)})`)}`);
    if (resolved.source !== 'default') console.log(color.dim(`           default would be ${DEFAULT_REGISTRY}`));
    for (const [r, u] of Object.entries(cfg.users ?? {})) console.log(`login    = ${u} @ ${r}`);
    return;
  }
  if (!KEYS.includes(key)) throw new CliError(`unknown key "${key}" (known: ${KEYS.join(', ')})`);
  if (action === 'get') {
    if (key !== 'registry') return console.log(cfg[key] ?? '');
    console.log(resolved.url);
    // The source goes to stderr so `$(bevara config get registry)` stays a bare URL.
    if (process.stderr.isTTY) console.error(color.dim(`(${describeSource(resolved.source)})`));
    return;
  }
  if (action === 'set') {
    if (!value) throw new CliError(`usage: bevara config set ${key} <value>`);
    cfg[key] = key === 'registry' ? normalizeRegistry(value) : value;
    writeConfig(cfg);
    log.ok(`${key} = ${cfg[key]}`);
    // A higher-precedence source would silently win over what was just saved.
    const now = resolveRegistrySource({ flag: opts.registry, project: project.manifest, projectFile: project.manifestName });
    if (key === 'registry' && now.source !== CONFIG_PATH) log.warn(`but ${describeSource(now.source)} takes precedence: commands here use ${now.url}`);
    return;
  }
  if (action === 'delete' || action === 'unset') {
    delete cfg[key]; writeConfig(cfg);
    return log.ok(key === 'registry' ? `registry unset, back to ${resolveRegistry({ flag: opts.registry, project: project.manifest })}` : `${key} unset`);
  }
  throw new CliError(help);
}

export async function ping({ opts }) {
  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  const t = Date.now();
  const r = await client.ping();
  log.ok(`${registry} — ${r.name} v${r.version} (${Date.now() - t} ms, auth: ${r.oidc ? 'OIDC' : 'local accounts'}, signup: ${r.signup ? 'open' : 'closed'})`);
  if (isRegistryTooOld(r)) log.warn(`this registry is older than this CLI needs (${MIN_REGISTRY_VERSION} or later): publishing, keys and the log will not work until it is redeployed`);
}
