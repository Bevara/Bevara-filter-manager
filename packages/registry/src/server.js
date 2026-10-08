import { createApp } from './app.js';

const env = process.env;
const port = parseInt(env.PORT ?? '8080', 10);
const host = env.HOST ?? '0.0.0.0';

const app = createApp({
  name: env.REGISTRY_NAME,
  dataDir: env.DATA_DIR ?? './data',
  publicUrl: env.PUBLIC_URL,
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  adminUsers: (env.ADMIN_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  oidc: env.OIDC_ISSUER ? { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, scope: env.OIDC_SCOPE } : null,
  maxTarball: env.MAX_TARBALL_BYTES ? parseInt(env.MAX_TARBALL_BYTES, 10) : undefined,
  defaultNamespace: env.DEFAULT_NAMESPACE,
  requireSignatures: env.REQUIRE_SIGNATURES !== 'false',
  log: (msg) => console.log(new Date().toISOString(), msg),
});

// Bootstrap an admin account from the environment (used by the k8s Secret).
if (env.BOOTSTRAP_ADMIN_USER) app.auth.addAdmin(env.BOOTSTRAP_ADMIN_USER);
if (env.BOOTSTRAP_ADMIN_USER && env.BOOTSTRAP_ADMIN_PASSWORD && !app.auth.getUser(env.BOOTSTRAP_ADMIN_USER)) {
  app.auth.createUser({ name: env.BOOTSTRAP_ADMIN_USER, password: env.BOOTSTRAP_ADMIN_PASSWORD });
  console.log(`created bootstrap admin user "${env.BOOTSTRAP_ADMIN_USER}"`);
}
console.log(`administrators: ${[...app.auth.adminUsers].join(', ') || '(the first account only)'}`);

app.server.listen(port, host, () => {
  console.log(`${app.config.name} listening on http://${host}:${port} (data: ${app.config.dataDir}, oidc: ${app.config.oidc ? app.config.oidc.issuer : 'off'}, registry key: ${app.ledger.keyId}, signatures ${app.config.requireSignatures ? 'required' : 'optional'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.server.close(); app.db.close(); process.exit(0); });
