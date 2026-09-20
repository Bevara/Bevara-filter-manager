import { CliError } from './ui.js';

export class RegistryError extends CliError {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
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
      throw new RegistryError(0, `cannot reach registry ${this.base}: ${e.cause?.message ?? e.message}`);
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      let extra = {};
      try { const j = await res.json(); msg = j.error ?? msg; extra = j; } catch { /* non-JSON error */ }
      throw new RegistryError(res.status, msg, extra);
    }
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
    catch (e) { throw new RegistryError(0, `download failed for ${url}: ${e.cause?.message ?? e.message}`); }
    if (!res.ok) throw new RegistryError(res.status, `download failed for ${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
