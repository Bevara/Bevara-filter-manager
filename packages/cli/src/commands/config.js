import { log, color, CliError } from '../lib/ui.js';
import { readConfig, writeConfig, CONFIG_PATH, resolveRegistry, normalizeRegistry } from '../lib/config.js';
import { clientFor, Project } from '../lib/ctx.js';

export const help = `  bevara config set registry https://registry.example.org
  bevara config get registry
  bevara config list
Settings live in ${CONFIG_PATH} (override with BEVARA_CONFIG). The registry can also
be set per project ("registry" in bevara.json), with -r/--registry or BEVARA_REGISTRY.`;

const KEYS = ['registry'];

export async function run({ args }) {
  const [action, key, value] = args;
  const cfg = readConfig();
  if (!action || action === 'list' || action === 'ls') {
    console.log(color.dim(`# ${CONFIG_PATH}`));
    console.log(`registry = ${resolveRegistry()}`);
    for (const [r, u] of Object.entries(cfg.users ?? {})) console.log(`login    = ${u} @ ${r}`);
    return;
  }
  if (!KEYS.includes(key)) throw new CliError(`unknown key "${key}" (known: ${KEYS.join(', ')})`);
  if (action === 'get') return console.log(action === 'get' && key === 'registry' ? resolveRegistry() : cfg[key] ?? '');
  if (action === 'set') {
    if (!value) throw new CliError(`usage: bevara config set ${key} <value>`);
    cfg[key] = key === 'registry' ? normalizeRegistry(value) : value;
    writeConfig(cfg);
    return log.ok(`${key} = ${cfg[key]}`);
  }
  if (action === 'delete' || action === 'unset') { delete cfg[key]; writeConfig(cfg); return log.ok(`${key} unset`); }
  throw new CliError(help);
}

export async function ping({ opts }) {
  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  const t = Date.now();
  const r = await client.ping();
  log.ok(`${registry} — ${r.name} v${r.version} (${Date.now() - t} ms, auth: ${r.oidc ? 'OIDC' : 'local accounts'}, signup: ${r.signup ? 'open' : 'closed'})`);
}
