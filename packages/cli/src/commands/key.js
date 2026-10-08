import { log, color, table, CliError, confirm } from '../lib/ui.js';
import { getKey, setKey, clearKey } from '../lib/config.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';
import { generateKeyPair } from '../lib/sig.js';

export const options = { label: { type: 'string', short: 'l' }, force: { type: 'boolean', short: 'f' } };
export const help = `Publishing is signed with an Ed25519 key kept in ~/.bevararc (one per registry).
  bevara key generate [-l label]   create a key and register its public part on the registry
  bevara key register              (re)register the current public key
  bevara key ls                    keys known to the registry for your account
  bevara key revoke <keyId>        revoke a key on the registry (keeps the log history)
  bevara key show                  print the local public key
\`bevara publish\` runs "generate" automatically when no key exists yet.`;

export async function ensureKey(client, registry, { label } = {}) {
  let key = getKey(registry);
  if (!key) {
    key = generateKeyPair();
    setKey(registry, key);
    log.step(`generated signing key ${color.bold(key.keyId)}`);
  }
  await client.put('/-/keys', { publicKey: key.publicKey, label: label ?? `bevara-cli` });
  return key;
}

export async function run({ args, opts }) {
  const [action, arg] = args;
  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  if (!action || action === 'show') {
    const key = getKey(registry);
    if (!key) return log.info(`no signing key for ${registry} ${color.dim('(bevara key generate)')}`);
    return console.log(`${color.bold(key.keyId)}\n${key.publicKey}`);
  }
  requireLogin(client);
  if (action === 'generate' || action === 'gen') {
    if (getKey(registry)) {
      if (!opts.force && !opts.yes && !(process.stdin.isTTY && await confirm('a key already exists for this registry; replace it?'))) return log.info('kept the existing key');
      clearKey(registry);
    }
    const key = await ensureKey(client, registry, { label: opts.label });
    return log.ok(`key ${color.bold(key.keyId)} registered on ${color.dim(registry)}`);
  }
  if (action === 'register') {
    const key = await ensureKey(client, registry, { label: opts.label });
    return log.ok(`key ${color.bold(key.keyId)} registered`);
  }
  if (action === 'ls' || action === 'list') {
    const { keys } = await client.get('/-/keys');
    if (opts.json) return console.log(JSON.stringify(keys, null, 2));
    const local = getKey(registry)?.keyId;
    if (!keys.length) return log.info('no keys registered');
    return console.log(table(keys.map((k) => [k.keyId === local ? color.green(k.keyId) : k.keyId, k.label ?? '', k.createdAt, k.revokedAt ? color.red(`revoked ${k.revokedAt}`) : color.dim('active')]), { header: ['Key', 'Label', 'Created', 'Status'].map(color.bold) }));
  }
  if (action === 'revoke') {
    if (!arg) throw new CliError('usage: bevara key revoke <keyId>');
    await client.delete(`/-/keys/${encodeURIComponent(arg)}`);
    if (getKey(registry)?.keyId === arg) clearKey(registry);
    return log.ok(`revoked ${arg}`);
  }
  throw new CliError(help);
}
