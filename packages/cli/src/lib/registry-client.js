import { CliError } from './ui.js';

/* The oldest registry this CLI works with: 1.1.0 introduced signed publishing,
 * the transparency log and namespaces, which publish/audit/key/log rely on. */
export const MIN_REGISTRY_VERSION = '1.1.0';

const versionLt = (a, b) => {
  const pa = String(a).split(/[.-]/).map(Number), pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
};

/* Throws when the registry is older than this CLI needs, explaining it. */
export function assertRegistryVersion(info, base) {
  if (info?.version && !versionLt(info.version, MIN_REGISTRY_VERSION)) return;
  throw new CliError(`the registry at ${base} runs version ${info?.version ?? 'unknown'}, older than this CLI needs (${MIN_REGISTRY_VERSION} or later)`, {
    hint: 'it predates signed publishing: redeploy it from packages/registry (deploy/k8s/build.sh, then apply deploy/k8s/registry.yaml)',
  });
}
export const isRegistryTooOld = (info) => !info?.version || versionLt(info.version, MIN_REGISTRY_VERSION);

export class RegistryError extends CliError {
  constructor(status, message, { extra = {}, hint, details = [] } = {}) {
    super(message, { hint });
    this.status = status;
    this.details = details;      // context lines, printed dim
    this.extra = extra;          // extra.errors are the server's own validation errors
  }
}

/* What an HTTP status means for someone talking to a registry, and what they
 * can do about it. 5xx are split out because they almost always mean the
 * request never reached the registry itself. */
const STATUS = {
  400: { what: 'the registry rejected the request' },
  401: { what: 'authentication required', hint: 'run `bevara login`, or set BEVARA_TOKEN' },
  403: { what: 'not allowed for this account', hint: '`bevara whoami` shows who you are; ownership is listed by `bevara owner ls <filter>`' },
  404: { what: 'not found on this registry' },
  405: { what: 'the server does not implement this route', hint: 'is this URL really a Bevara registry? `bevara ping` prints what answers' },
  409: { what: 'conflict with what is already published' },
  413: { what: 'the upload is larger than the server accepts', hint: 'raise MAX_TARBALL_BYTES on the registry and nginx.ingress.kubernetes.io/proxy-body-size on its ingress' },
  429: { what: 'too many requests', hint: 'wait a moment and retry' },
  500: { what: 'the registry hit an internal error', hint: 'its logs have the stack trace (e.g. `kubectl logs deploy/bevara-registry`)' },
  502: { what: 'a proxy reached the registry but got an invalid response from it' },
  503: { what: 'the service behind the proxy is down, still starting, or not deployed' },
  504: { what: 'the registry did not answer the proxy in time' },
};
const UNREACHABLE = new Set([502, 503, 504]);

const STATUS_TEXT = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 413: 'Payload Too Large', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/* A short, readable excerpt of an HTML or text error page: what nginx, a load
 * balancer or a captive portal put in the body is often the real explanation. */
export function bodyExcerpt(text, limit = 140, { drop = [] } = {}) {
  if (!text) return null;
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  // Error pages repeat themselves (<title> then <h1>); keep one copy.
  const words = stripped.split(' ');
  for (let n = Math.floor(words.length / 2); n >= 2; n--) {
    if (words.slice(0, n).join(' ') === words.slice(n, 2 * n).join(' ')) { words.splice(n, n); break; }
  }
  // Drop what the caller already shows on its own line (status, server).
  let out = words.join(' ');
  for (const d of drop) if (d) out = out.split(d).join(' ');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.replace(/[^A-Za-z0-9]/g, '').length < 3) return null;
  // An excerpt that only restates the status ("Service Temporarily
  // Unavailable" under a 503 Service Unavailable) is noise.
  const tok = (x) => new Set(String(x).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const known = new Set(drop.flatMap((d) => [...tok(d)]));
  const mine = [...tok(out)];
  if (mine.length && mine.filter((w) => known.has(w)).length / mine.length >= 0.6) return null;
  return out.length > limit ? out.slice(0, limit - 1) + '…' : out;
}

/**
 * Builds the message, detail lines and hint for a failed HTTP response.
 * Pure, so the wording is covered by tests.
 */
export function describeHttpFailure({ status, statusText, base, method, path, server, bodyText, json }) {
  const info = STATUS[status] ?? {};
  const label = `${status}${statusText || STATUS_TEXT[status] ? ' ' + (statusText || STATUS_TEXT[status]) : ''}`;
  const details = [`${method} ${base}${path}`];
  const hints = [];

  // The registry answers errors as JSON: that message is the precise one, keep
  // it and only add the context the user cannot see.
  let message;
  if (status === 404 && /^no route for /.test(json?.error ?? '')) {
    message = `${base} does not support ${method} ${path.split('?')[0]}: it is probably an older registry than this CLI expects`;
    details.push(`the registry answered ${label} (${json.error})`);
    hints.push('`bevara ping` shows the registry version; redeploy it from packages/registry if it is older than this CLI');
  } else if (json?.error) {
    message = json.error;
    details.push(`the registry answered ${label}`);
  } else if (UNREACHABLE.has(status)) {
    message = `registry ${base} is not answering (${label})`;
    details.push(info.what);
    hints.push('`bevara ping` retests it, `bevara config list` shows which registry is configured');
    hints.push('use `-r <url>` or BEVARA_REGISTRY to point at another one, e.g. a local `npm run registry`');
  } else {
    message = `${base} replied ${label}${info.what ? `: ${info.what}` : ''}`;
  }

  if (server) details.push(`served by ${server}`);
  const excerpt = json ? null : bodyExcerpt(bodyText, 140, { drop: [String(status), statusText, STATUS_TEXT[status], server] });
  if (excerpt) details.push(`response body: ${excerpt}`);
  if (info.hint) hints.unshift(info.hint);
  if (typeof json?.hint === 'string') hints.unshift(json.hint);   // the registry knows best

  return { message, details, hint: hints.length ? hints.join('\n        ') : undefined };
}

/* fetch() failures: DNS, TCP, TLS. The cause carries the useful code. */
export function describeNetworkFailure(err, url) {
  const cause = err?.cause ?? err;
  const code = cause?.code ?? err?.code;
  let host = url;
  try { const u = new URL(url); host = u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { /* keep the raw string */ }
  const map = {
    ENOTFOUND: [`the host ${host} does not resolve`, 'check the registry URL with `bevara config list`, and your DNS or VPN'],
    EAI_AGAIN: [`the host ${host} could not be resolved (temporary DNS failure)`, 'check your network connection'],
    ECONNREFUSED: [`nothing is listening on ${host}`, 'start a registry (`npm run registry`) or point at another one with `-r <url>`'],
    ECONNRESET: [`the connection to ${host} was reset`],
    EPIPE: [`the connection to ${host} was closed early`],
    ETIMEDOUT: [`${host} did not answer in time`],
    UND_ERR_CONNECT_TIMEOUT: [`${host} did not answer in time`],
    UND_ERR_HEADERS_TIMEOUT: [`${host} accepted the connection but sent no response in time`],
    CERT_HAS_EXPIRED: [`the TLS certificate of ${host} has expired`],
    DEPTH_ZERO_SELF_SIGNED_CERT: [`${host} uses a self-signed TLS certificate`, 'trust it through NODE_EXTRA_CA_CERTS, or use http:// for a local registry'],
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: [`the TLS certificate of ${host} cannot be verified`, 'trust the issuing CA through NODE_EXTRA_CA_CERTS'],
    ERR_TLS_CERT_ALTNAME_INVALID: [`the TLS certificate of ${host} is for another host name`],
  };
  const [what, hint] = map[code] ?? [`cannot reach ${host}: ${cause?.message ?? err.message}`];
  let origin = url;
  try { origin = new URL(url).origin; } catch { /* keep the raw string */ }
  return { message: `cannot reach registry ${origin}: ${what}`, hint, code };
}

export class RegistryClient {
  constructor(base, token = null) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
  }

  async request(method, p, { body, headers = {}, raw = false, auth = true } = {}) {
    const h = { ...headers };
    if (auth && this.token) h.authorization = `Bearer ${this.token}`;
    let payload = body;
    if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(this.base + p, { method, headers: h, body: payload });
    } catch (e) {
      const d = describeNetworkFailure(e, this.base + p);
      throw new RegistryError(0, d.message, { hint: d.hint });
    }
    if (!res.ok) throw await httpError(res, { base: this.base, method, path: p });
    if (raw) return res;
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('json') ? res.json() : res.text();
  }

  get(p, o) { return this.request('GET', p, o); }
  post(p, body, o) { return this.request('POST', p, { ...o, body }); }
  put(p, body, o) { return this.request('PUT', p, { ...o, body }); }
  delete(p, o) { return this.request('DELETE', p, o); }

  ping() { return this.get('/-/ping', { auth: false }); }
  whoami() { return this.get('/-/whoami'); }
  packument(name) { return this.get(`/filters/${encodeURIComponent(name)}`); }
  version(name, v) { return this.get(`/filters/${encodeURIComponent(name)}/${encodeURIComponent(v)}`); }
  search(params) { return this.get('/filters?' + new URLSearchParams(params)); }
  audit(filters) { return this.post('/-/audit', { filters }); }

  async download(url) {
    let res;
    try { res = await fetch(url); }
    catch (e) {
      const d = describeNetworkFailure(e, url);
      throw new RegistryError(0, `download failed: ${d.message}`, { hint: d.hint });
    }
    if (!res.ok) {
      const base = url.replace(/^(https?:\/\/[^/]+).*$/, '$1');
      throw await httpError(res, { base, method: 'GET', path: url.slice(base.length), prefix: 'download failed: ' });
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

async function httpError(res, { base, method, path, prefix = '' }) {
  const ct = res.headers.get('content-type') ?? '';
  let json = null, bodyText = null;
  try {
    if (ct.includes('json')) json = await res.json();
    else bodyText = (await res.text()).slice(0, 4096);
  } catch { /* a body we cannot read adds nothing */ }
  const d = describeHttpFailure({
    status: res.status, statusText: res.statusText, base, method, path,
    server: res.headers.get('server'), bodyText, json,
  });
  return new RegistryError(res.status, prefix + d.message, { extra: json ?? {}, details: d.details, hint: d.hint });
}
