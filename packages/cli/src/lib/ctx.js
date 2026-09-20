import { resolveRegistry, getToken } from './config.js';
import { RegistryClient } from './registry-client.js';
import { Project } from './project.js';
import { CliError } from './ui.js';

export function clientFor(opts, project) {
  const registry = resolveRegistry({ flag: opts.registry, project: project?.manifest });
  return { registry, client: new RegistryClient(registry, getToken(registry)) };
}

export function requireLogin(client) {
  if (!client.token) throw new CliError(`not logged in to ${client.base}`, { hint: 'run `bevara login` (or `bevara adduser` to create an account)' });
}

export { Project };
