import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { log, color, prompt, CliError } from '../lib/ui.js';
import { setToken, clearToken, getToken, readConfig } from '../lib/config.js';
import { clientFor, requireLogin, Project } from '../lib/ctx.js';

export const options = {
  run: { password: { type: 'boolean', short: 'p' }, token: { type: 'boolean', short: 't' }, 'no-browser': { type: 'boolean' }, user: { type: 'string', short: 'u' } },
  adduser: { user: { type: 'string', short: 'u' }, email: { type: 'string', short: 'e' } },
};

export const help = (fn) => ({
  run: `By default opens the registry's login page in your browser (single sign-on when
the registry is connected to an identity provider such as Casdoor) and waits for
the token on a local callback.
Options:
  -p, --password    prompt for username/password in the terminal instead
  -t, --token       paste an existing token
  --no-browser      print the login URL instead of opening the browser
  -r, --registry    registry to log in to
Environment:
  BEVARA_PASSWORD   password for non-interactive use (CI); BEVARA_TOKEN overrides the stored token`,
  adduser: `Creates an account on the registry (if self-registration is enabled) and logs in.`,
  logout: 'Revokes the token on the registry and forgets it locally.',
  whoami: 'Prints the user associated with the stored token.',
}[fn] ?? '');

export async function run({ opts }) {
  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  const info = await client.ping();
  let token, user;
  if (opts.token) {
    token = await prompt('Token', { hidden: true });
    client.token = token;
    user = (await client.whoami()).name;
  } else if (opts.password || (!process.stdout.isTTY && !opts['no-browser'])) {
    const name = opts.user ?? await prompt('Username');
    const password = process.env.BEVARA_PASSWORD ?? await prompt('Password', { hidden: true });
    const res = await client.post('/-/login', { name, password, label: `cli@${hostname()}` }, { auth: false });
    token = res.token; user = res.user.name;
  } else {
    ({ token, user } = await webLogin(registry, info, opts));
  }
  setToken(registry, token, user);
  log.ok(`logged in to ${color.dim(registry)} as ${color.bold(user)}`);
}

function hostname() { return os.hostname(); }

async function webLogin(registry, info, opts) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback' || !url.searchParams.get('token')) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><body style="font:15px system-ui;padding:40px"><h2>Logged in to the Bevara registry</h2><p>You can close this tab and return to the terminal.</p></body>');
      clearTimeout(timer);
      server.close();
      resolve({ token: url.searchParams.get('token'), user: url.searchParams.get('user') ?? 'unknown' });
    });
    const timer = setTimeout(() => { server.close(); reject(new CliError('login timed out after 5 minutes')); }, 5 * 60_000);
    server.listen(0, '127.0.0.1', () => {
      const cb = `http://127.0.0.1:${server.address().port}/callback`;
      const loginUrl = `${registry}/-/login/web?callback=${encodeURIComponent(cb)}`;
      log.info(`${info.oidc ? 'Single sign-on' : 'Login'} via your browser: ${color.cyan(loginUrl)}`);
      log.info(color.dim('waiting for the browser… (Ctrl-C to abort, or use `bevara login --password`)'));
      if (!opts['no-browser']) openBrowser(loginUrl);
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* user opens it manually */ }
}

export async function adduser({ opts }) {
  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  const info = await client.ping();
  if (!info.signup) throw new CliError(`${registry} does not allow self-registration`, { hint: info.oidc ? 'use `bevara login` (single sign-on)' : 'ask the registry administrator for an account' });
  const name = opts.user ?? await prompt('Username', { validate: (v) => (/^[a-z0-9][a-z0-9._-]{1,63}$/.test(v) ? null : 'lowercase letters, digits, . _ -') });
  const email = opts.email ?? (process.stdin.isTTY ? await prompt('Email', { default: '' }) : '');
  const password = process.env.BEVARA_PASSWORD ?? await prompt('Password (min 8 chars)', { hidden: true, validate: (v) => (v.length >= 8 ? null : 'too short') });
  const res = await client.post('/-/user', { name, email: email || undefined, password }, { auth: false });
  setToken(registry, res.token, res.user.name);
  log.ok(`account ${color.bold(res.user.name)} created on ${color.dim(registry)} (role: ${res.user.role}); you are logged in`);
}

export async function logout({ opts }) {
  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  if (!getToken(registry)) return log.info(`not logged in to ${registry}`);
  await client.delete('/-/token').catch((e) => log.warn(`could not revoke the token on the registry (${e.message}); removing it locally`));
  clearToken(registry);
  log.ok(`logged out of ${color.dim(registry)}`);
}

export async function whoami({ opts }) {
  const { registry, client } = clientFor(opts, Project.load({ required: false }));
  requireLogin(client);
  const me = await client.whoami();
  if (opts.json) return console.log(JSON.stringify(me));
  console.log(`${color.bold(me.name)} ${color.dim(`(${me.role}${me.email ? ', ' + me.email : ''}) @ ${registry}`)}`);
}

export { readConfig };
