// Tiny dependency-free HTTP router with the helpers the registry needs.
import { promises as fs, createReadStream } from 'node:fs';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)\*/g, (_, k) => { keys.push(k); return '(.+)'; })
      .replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { methodMismatch = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return methodMismatch ? { status: 405 } : null;
  }
}

export function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

export function html(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

export function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

export function readBody(req, { limit = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `body exceeds ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, opts) {
  const buf = await readBody(req, { limit: 4 * 1024 * 1024, ...opts });
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON body'); }
}

export async function readForm(req) {
  const buf = await readBody(req, { limit: 64 * 1024 });
  return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
}

// Serves a stored file, preferring a pre-compressed `.br` sibling when the
// client accepts brotli. `Vary` keeps caches honest.
export async function sendFile(req, res, file, contentType, extraHeaders = {}) {
  const acceptsBr = /\bbr\b/.test(req.headers['accept-encoding'] || '');
  let target = file, encoding = null;
  if (acceptsBr) {
    try { await fs.access(file + '.br'); target = file + '.br'; encoding = 'br'; } catch { /* no .br copy */ }
  }
  let stat;
  try { stat = await fs.stat(target); } catch { throw new HttpError(404, 'file not found'); }
  const headers = { 'content-type': contentType, 'content-length': stat.size, vary: 'Accept-Encoding', ...extraHeaders };
  if (encoding) headers['content-encoding'] = encoding;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(target).pipe(res);
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
