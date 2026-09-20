import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import semver from 'semver';
import { openDb } from './db.js';
import { Auth } from './auth.js';
import { Oidc } from './oidc.js';
import { Store } from './store.js';
import { extractTarball } from './tarball.js';
import { inspectWasm, accessorFileName } from './wasm.js';
import { validateManifest, normalizeManifest, publicManifest, NAME_RE } from './manifest.js';
import { Router, HttpError, json, html, redirect, readBody, readJson, readForm, sendFile, bearer } from './http.js';
import { catalogPage, loginFormPage, tokenPage, doneRedirectPage } from './ui.js';

const VERSION = '1.0.0';
const TAG_BLOCK = {
  image: "img is='universal-img_1'",
  audio: "audio is='universal-audio_1'",
  video: "video is='universal-video_1'",
  canvas: "canvas is='universal-canvas_1'",
};

export function createApp(config = {}) {
  const cfg = {
    name: config.name ?? 'Bevara filter registry',
    dataDir: config.dataDir ?? path.resolve('data'),
    dbFile: config.dbFile,                 // defaults to <dataDir>/registry.sqlite, ':memory:' for tests
    publicUrl: config.publicUrl ?? null,   // e.g. https://registry.bevara.ddns.net
    allowSignup: config.allowSignup ?? true,
    adminUsers: config.adminUsers ?? [],
    oidc: config.oidc ?? null,             // { issuer, clientId, clientSecret }
    maxTarball: config.maxTarball ?? 256 * 1024 * 1024,
    log: config.log ?? (() => {}),
  };
  const db = openDb(cfg.dbFile ?? path.join(cfg.dataDir, 'registry.sqlite'));
  const auth = new Auth(db, { adminUsers: cfg.adminUsers });
  const store = new Store(path.join(cfg.dataDir, 'store'));
  const oidc = cfg.oidc?.issuer ? new Oidc({ ...cfg.oidc, publicUrl: cfg.publicUrl ?? 'http://localhost:8080' }) : null;
  const router = new Router();

  const baseUrl = (req) => cfg.publicUrl ?? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const requireAuth = (req) => {
    const user = auth.userForToken(bearer(req));
    if (!user) throw new HttpError(401, 'authentication required: run `bevara login`');
    return user;
  };
  const isOwner = (name, user) => user.role === 'admin' || !!db.prepare('SELECT 1 FROM owners WHERE name = ? AND user_id = ?').get(name, user.id);
  const requireOwner = (name, user) => { if (!isOwner(name, user)) throw new HttpError(403, `you are not an owner of "${name}"`); };
  const requireAdmin = (user) => { if (user.role !== 'admin') throw new HttpError(403, 'admin role required'); };
  const validName = (name) => { if (!NAME_RE.test(name)) throw new HttpError(400, `invalid filter name "${name}"`); return name; };
  const validVersion = (v) => { if (!semver.valid(v)) throw new HttpError(400, `invalid version "${v}"`); return v; };
  const sha256 = (buf) => createHash('sha256').update(buf).digest();
  const sri = (buf) => 'sha256-' + sha256(buf).toString('base64');

  // ---------------------------------------------------------------- queries
  const q = {
    filter: db.prepare('SELECT * FROM filters WHERE name = ?'),
    versions: db.prepare('SELECT * FROM versions WHERE name = ? ORDER BY published_at'),
    version: db.prepare('SELECT * FROM versions WHERE name = ? AND version = ?'),
    owners: db.prepare('SELECT u.name FROM owners o JOIN users u ON u.id = o.user_id WHERE o.name = ? ORDER BY u.name'),
    advisories: db.prepare('SELECT * FROM advisories WHERE name = ? ORDER BY id'),
    downloads: db.prepare('SELECT COALESCE(SUM(downloads),0) AS n FROM versions WHERE name = ?'),
    bumpDownloads: db.prepare('UPDATE versions SET downloads = downloads + 1 WHERE name = ? AND version = ?'),
  };

  function latestFor(name, { abi } = {}) {
    const rows = q.versions.all(name).filter((r) => !r.deprecated && (abi === undefined || r.abi === abi));
    const versions = rows.map((r) => r.version);
    const best = semver.maxSatisfying(versions, '*') ?? semver.maxSatisfying(versions, '*', { includePrerelease: true });
    return rows.find((r) => r.version === best) ?? null;
  }

  function refreshLatest(name) {
    const latest = latestFor(name);
    const filter = q.filter.get(name);
    if (!filter) return;
    db.prepare("UPDATE filters SET latest = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?")
      .run(latest?.version ?? null, latest ? JSON.parse(latest.manifest).description ?? filter.description : filter.description, name);
  }

  function versionDoc(req, row) {
    const m = JSON.parse(row.manifest);
    const base = baseUrl(req);
    return {
      ...m,
      abi: row.abi,
      dist: {
        file: row.wasm_file,
        wasm: `${base}/accessors/${row.name}/${row.version}/${row.wasm_file}`,
        tarball: `${base}/filters/${row.name}/-/${row.name}-${row.version}.tgz`,
        integrity: 'sha256-' + Buffer.from(row.wasm_sha256, 'hex').toString('base64'),
        sha256: row.wasm_sha256,
        size: row.wasm_size,
        brSize: row.wasm_br_size,
        tarballIntegrity: 'sha256-' + Buffer.from(row.tarball_sha256, 'hex').toString('base64'),
        tarballSize: row.tarball_size,
      },
      wasm: row.wasm_info ? JSON.parse(row.wasm_info) : undefined,
      publishedAt: row.published_at,
      publishedBy: row.published_by,
      deprecated: row.deprecated,
      downloads: row.downloads,
    };
  }

  function packument(req, name) {
    const filter = q.filter.get(name);
    if (!filter) throw new HttpError(404, `filter "${name}" not found`);
    const versions = {};
    const time = { created: filter.created_at, modified: filter.updated_at };
    for (const row of q.versions.all(name)) { versions[row.version] = versionDoc(req, row); time[row.version] = row.published_at; }
    return {
      name, description: filter.description, 'dist-tags': { latest: filter.latest },
      versions, time, owners: q.owners.all(name).map((o) => o.name),
      deprecated: filter.deprecated, downloads: q.downloads.get(name).n,
      advisories: q.advisories.all(name),
    };
  }

  // ------------------------------------------------------------------- UI
  router.get('/', (req, res) => html(res, 200, catalogPage({ name: cfg.name, oidc: !!oidc, version: VERSION })));
  router.get('/-/ping', (req, res) => json(res, 200, { ok: true, name: cfg.name, version: VERSION, oidc: !!oidc, signup: cfg.allowSignup }));
  router.get('/-/config', (req, res) => json(res, 200, { name: cfg.name, version: VERSION, oidc: !!oidc, signup: cfg.allowSignup, publicUrl: baseUrl(req) }));

  // ------------------------------------------------------------ accounts
  router.post('/-/user', async (req, res) => {
    if (!cfg.allowSignup) throw new HttpError(403, 'self-registration is disabled on this registry');
    const { name, password, email } = await readJson(req);
    if (!name || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) throw new HttpError(400, 'invalid username (lowercase, digits, . _ -)');
    if (!password || password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
    if (auth.getUser(name)) throw new HttpError(409, `user "${name}" already exists`);
    const user = auth.createUser({ name, email, password });
    const token = auth.createToken(user.id, 'cli');
    json(res, 201, { ok: true, user: { name: user.name, role: user.role }, token });
  });

  router.post('/-/login', async (req, res) => {
    const { name, password, label } = await readJson(req);
    const user = auth.login(name ?? '', password ?? '');
    if (!user) throw new HttpError(401, 'invalid username or password');
    json(res, 200, { ok: true, user: { name: user.name, role: user.role }, token: auth.createToken(user.id, label ?? 'cli') });
  });

  router.get('/-/whoami', (req, res) => {
    const user = requireAuth(req);
    json(res, 200, { name: user.name, email: user.email, role: user.role, tokens: auth.listTokens(user.id).length });
  });

  router.delete('/-/token', (req, res) => {
    requireAuth(req);
    auth.revokeToken(bearer(req));
    json(res, 200, { ok: true });
  });

  // Browser login used by `bevara login` (OIDC when configured, local form otherwise).
  const validCallback = (cb) => {
    if (!cb) return null;
    let u;
    try { u = new URL(cb); } catch { throw new HttpError(400, 'invalid callback'); }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new HttpError(400, 'callback must point to the local machine');
    return u.toString();
  };
  const finishWebLogin = (res, user, callback) => {
    const token = auth.createToken(user.id, 'cli-web');
    if (!callback) return html(res, 200, tokenPage(token));
    const u = new URL(callback);
    u.searchParams.set('token', token);
    u.searchParams.set('user', user.name);
    redirect(res, u.toString());
  };

  router.get('/-/login/web', async (req, res, { url }) => {
    const callback = validCallback(url.searchParams.get('callback'));
    if (oidc) return redirect(res, await oidc.authorizationUrl(callback));
    html(res, 200, loginFormPage({ callback: callback ?? '' }));
  });

  router.post('/-/login/web', async (req, res) => {
    const form = await readForm(req);
    const callback = validCallback(form.callback || null);
    const user = auth.login(form.name ?? '', form.password ?? '');
    if (!user) return html(res, 401, loginFormPage({ callback: callback ?? '', error: 'Invalid username or password' }));
    finishWebLogin(res, user, callback);
  });

  router.get('/-/login/web/callback', async (req, res, { url }) => {
    if (!oidc) throw new HttpError(404, 'OIDC is not configured');
    const err = url.searchParams.get('error');
    if (err) throw new HttpError(401, `identity provider error: ${err} ${url.searchParams.get('error_description') ?? ''}`);
    const identity = await oidc.exchange(url.searchParams.get('code'), url.searchParams.get('state'));
    const user = auth.upsertOidcUser(identity);
    finishWebLogin(res, user, identity.callback);
  });

  // ------------------------------------------------------------- catalog
  router.get('/filters', (req, res, { url }) => {
    const term = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const support = url.searchParams.get('support');
    const format = url.searchParams.get('format')?.toLowerCase();
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1000);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    const rows = db.prepare('SELECT f.*, v.manifest, v.abi, v.wasm_file, v.wasm_size, v.wasm_br_size FROM filters f LEFT JOIN versions v ON v.name = f.name AND v.version = f.latest ORDER BY f.name').all();
    let out = rows.map((r) => {
      const m = r.manifest ? JSON.parse(r.manifest) : {};
      return {
        name: r.name, latest: r.latest, description: r.description, deprecated: r.deprecated,
        abi: r.abi, file: r.wasm_file, size: r.wasm_size, brSize: r.wasm_br_size,
        filters: m.filters ?? [], support: m.support ?? [], formats: m.formats ?? [], keywords: m.keywords ?? [],
        license: m.license, licence_required: !!m.licence_required, priority: m.priority,
        downloads: q.downloads.get(r.name).n, updated: r.updated_at,
      };
    });
    if (term) out = out.filter((f) => [f.name, f.description, ...f.filters, ...f.formats, ...f.keywords].join(' ').toLowerCase().includes(term));
    if (support) out = out.filter((f) => f.support.includes(support));
    if (format) out = out.filter((f) => f.formats.some((x) => x.toLowerCase() === format));
    json(res, 200, { total: out.length, filters: out.slice(offset, offset + limit) });
  });

  router.get('/filters/:name', (req, res, { params }) => json(res, 200, packument(req, validName(params.name))));

  // Must be registered before /filters/:name/:version.
  router.get('/filters/:name/owners', (req, res, { params }) => json(res, 200, { owners: q.owners.all(validName(params.name)).map((o) => o.name) }));

  router.get('/filters/:name/:version', (req, res, { params }) => {
    const name = validName(params.name);
    let version = params.version;
    if (version === 'latest') version = q.filter.get(name)?.latest;
    else if (!semver.valid(version)) {
      const p = packument(req, name);
      version = semver.maxSatisfying(Object.keys(p.versions), version);
    }
    const row = version && q.version.get(name, version);
    if (!row) throw new HttpError(404, `no version of "${name}" matches "${params.version}"`);
    json(res, 200, versionDoc(req, row));
  });

  router.get('/filters/:name/-/:file', async (req, res, { params }) => {
    const name = validName(params.name);
    const m = new RegExp(`^${name.replace(/[.]/g, '\\.')}-(.+)\\.tgz$`).exec(params.file);
    const row = m && q.version.get(name, m[1]);
    if (!row) throw new HttpError(404, 'tarball not found');
    q.bumpDownloads.run(name, row.version);
    await sendFile(req, res, store.path(name, row.version, params.file), 'application/gzip', { 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
  });

  // ------------------------------------------------- accessors for players
  // /accessors/theora_1.wasm            -> latest non-deprecated version with abi 1
  // /accessors/theora/1.2.0/theora_1.wasm -> that exact version
  const wasmHeaders = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' };
  router.get('/accessors/:name/:version/:file', async (req, res, { params }) => {
    const row = q.version.get(validName(params.name), params.version);
    if (!row || row.wasm_file !== params.file) throw new HttpError(404, 'accessor not found');
    q.bumpDownloads.run(row.name, row.version);
    await sendFile(req, res, store.path(row.name, row.version, row.wasm_file), 'application/wasm', { ...wasmHeaders, 'cache-control': 'public, max-age=31536000, immutable' });
  });

  router.get('/accessors/index.json', (req, res) => {
    const base = baseUrl(req);
    const filters = db.prepare('SELECT v.* FROM filters f JOIN versions v ON v.name = f.name AND v.version = f.latest WHERE f.deprecated IS NULL ORDER BY f.name').all()
      .map((r) => { const m = JSON.parse(r.manifest); return { name: r.name, version: r.version, abi: r.abi, file: r.wasm_file, url: `${base}/accessors/${r.wasm_file}`, filters: m.filters, support: m.support, formats: m.formats, priority: m.priority, license: m.license, integrity: 'sha256-' + Buffer.from(r.wasm_sha256, 'hex').toString('base64') }; });
    json(res, 200, { registry: base, generated: new Date().toISOString(), filters }, wasmHeaders);
  });

  // Same shape as filters/filter_list.json in the Bevara filters repository.
  router.get('/accessors/filter_list.json', (req, res) => {
    const names = db.prepare('SELECT name FROM filters WHERE deprecated IS NULL ORDER BY name').all().map((r) => r.name);
    json(res, 200, { tag: TAG_BLOCK, using: ['core'], with: names }, wasmHeaders);
  });

  router.get('/accessors/:file', async (req, res, { params }) => {
    const m = /^([a-z0-9][a-z0-9._-]*)_(\d+)\.wasm$/.exec(params.file);
    if (!m) throw new HttpError(404, 'accessor not found (expected <name>_<abi>.wasm)');
    const row = latestFor(validName(m[1]), { abi: parseInt(m[2], 10) });
    if (!row) throw new HttpError(404, `no published version of "${m[1]}" with abi ${m[2]}`);
    q.bumpDownloads.run(row.name, row.version);
    await sendFile(req, res, store.path(row.name, row.version, row.wasm_file), 'application/wasm', { ...wasmHeaders, 'cache-control': 'public, max-age=300', 'x-bevara-version': row.version });
  });

  // ------------------------------------------------------------- publish
  router.put('/filters/:name/:version', async (req, res, { params }) => {
    const user = requireAuth(req);
    const name = validName(params.name);
    const version = validVersion(params.version);
    const tarball = await readBody(req, { limit: cfg.maxTarball });
    if (!tarball.length) throw new HttpError(400, 'empty body: expected a gzipped tarball');
    const files = await extractTarball(tarball);
    const manifestBuf = files.get('package/bevara.json');
    if (!manifestBuf) throw new HttpError(400, 'tarball must contain package/bevara.json');
    let manifest;
    try { manifest = normalizeManifest(JSON.parse(manifestBuf.toString('utf8'))); } catch { throw new HttpError(400, 'package/bevara.json is not valid JSON'); }
    const { errors, warnings } = validateManifest(manifest, { forPublish: true });
    if (errors.length) throw new HttpError(400, 'invalid manifest', { errors, warnings });
    if (manifest.name !== name || manifest.version !== version) throw new HttpError(400, `manifest is ${manifest.name}@${manifest.version} but URL is ${name}@${version}`);

    const wasmName = accessorFileName(name, manifest.abi);
    const wasm = files.get(`package/${wasmName}`);
    if (!wasm) throw new HttpError(400, `tarball must contain package/${wasmName}`);
    const info = inspectWasm(wasm);
    if (!info.valid) throw new HttpError(400, `${wasmName}: ${info.error}`);
    if (!info.sideModule) throw new HttpError(400, `${wasmName} is not an Emscripten side module (no dylink section). Link with -sSIDE_MODULE=2`);

    const existing = q.filter.get(name);
    if (existing) {
      requireOwner(name, user);
      if (q.version.get(name, version)) throw new HttpError(409, `${name}@${version} is already published; bump the version`);
    }
    for (const [dep, range] of Object.entries(manifest.dependencies)) {
      if (!semver.validRange(range)) throw new HttpError(400, `dependency "${dep}": invalid range "${range}"`);
      if (dep !== name && !q.filter.get(dep)) warnings.push(`dependency "${dep}" is not published on this registry`);
    }

    const tarballName = `${name}-${version}.tgz`;
    const { brSize } = await store.save(name, version, { tarball, tarballName, wasm, wasmName });
    const wasmInfo = { exports: info.exports.map((e) => e.name), imports: info.imports.length, needed: info.dylink?.needed ?? [], customSections: info.customSections };
    db.exec('BEGIN');
    try {
      if (!existing) {
        db.prepare('INSERT INTO filters (name, description) VALUES (?, ?)').run(name, manifest.description ?? '');
        db.prepare('INSERT INTO owners (name, user_id) VALUES (?, ?)').run(name, user.id);
      }
      db.prepare(`INSERT INTO versions (name, version, abi, manifest, wasm_file, wasm_sha256, wasm_size, wasm_br_size, tarball_sha256, tarball_size, wasm_info, published_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(name, version, manifest.abi, JSON.stringify(publicManifest(manifest)), wasmName, sha256(wasm).toString('hex'), wasm.length, brSize, sha256(tarball).toString('hex'), tarball.length, JSON.stringify(wasmInfo), user.name);
      refreshLatest(name);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    cfg.log(`published ${name}@${version} by ${user.name}`);
    json(res, 201, { ok: true, name, version, warnings, dist: versionDoc(req, q.version.get(name, version)).dist });
  });

  router.delete('/filters/:name/:version', async (req, res, { params }) => {
    const user = requireAuth(req);
    const name = validName(params.name);
    if (!q.filter.get(name)) throw new HttpError(404, `filter "${name}" not found`);
    requireOwner(name, user);
    const row = q.version.get(name, params.version);
    if (!row) throw new HttpError(404, `${name}@${params.version} not found`);
    db.prepare('DELETE FROM versions WHERE name = ? AND version = ?').run(name, params.version);
    await store.remove(name, params.version);
    if (q.versions.all(name).length === 0) db.prepare('DELETE FROM filters WHERE name = ?').run(name);
    else refreshLatest(name);
    json(res, 200, { ok: true, removed: `${name}@${params.version}` });
  });

  router.delete('/filters/:name', async (req, res, { params }) => {
    const user = requireAuth(req);
    const name = validName(params.name);
    if (!q.filter.get(name)) throw new HttpError(404, `filter "${name}" not found`);
    requireOwner(name, user);
    for (const row of q.versions.all(name)) await store.remove(name, row.version);
    db.prepare('DELETE FROM filters WHERE name = ?').run(name);
    json(res, 200, { ok: true, removed: name });
  });

  router.post('/filters/:name/deprecate', async (req, res, { params }) => {
    const user = requireAuth(req);
    const name = validName(params.name);
    if (!q.filter.get(name)) throw new HttpError(404, `filter "${name}" not found`);
    requireOwner(name, user);
    const { version, message } = await readJson(req);
    const msg = typeof message === 'string' && message.trim() ? message.trim() : null;
    if (version) {
      const p = packument(req, name);
      const targets = Object.keys(p.versions).filter((v) => semver.satisfies(v, version));
      if (!targets.length) throw new HttpError(404, `no version of "${name}" matches "${version}"`);
      for (const v of targets) db.prepare('UPDATE versions SET deprecated = ? WHERE name = ? AND version = ?').run(msg, name, v);
      refreshLatest(name);
      return json(res, 200, { ok: true, deprecated: msg, versions: targets });
    }
    db.prepare('UPDATE filters SET deprecated = ? WHERE name = ?').run(msg, name);
    json(res, 200, { ok: true, deprecated: msg, name });
  });

  router.put('/filters/:name/owners/:user', (req, res, { params }) => {
    const user = requireAuth(req);
    const name = validName(params.name);
    if (!q.filter.get(name)) throw new HttpError(404, `filter "${name}" not found`);
    requireOwner(name, user);
    const target = auth.getUser(params.user);
    if (!target) throw new HttpError(404, `user "${params.user}" not found`);
    db.prepare('INSERT OR IGNORE INTO owners (name, user_id) VALUES (?, ?)').run(name, target.id);
    json(res, 200, { owners: q.owners.all(name).map((o) => o.name) });
  });
  router.delete('/filters/:name/owners/:user', (req, res, { params }) => {
    const user = requireAuth(req);
    const name = validName(params.name);
    if (!q.filter.get(name)) throw new HttpError(404, `filter "${name}" not found`);
    requireOwner(name, user);
    const target = auth.getUser(params.user);
    if (!target) throw new HttpError(404, `user "${params.user}" not found`);
    if (q.owners.all(name).length <= 1) throw new HttpError(400, 'a filter must keep at least one owner');
    db.prepare('DELETE FROM owners WHERE name = ? AND user_id = ?').run(name, target.id);
    json(res, 200, { owners: q.owners.all(name).map((o) => o.name) });
  });

  // ------------------------------------------------------- audit & advisories
  router.get('/-/advisories', (req, res, { url }) => {
    const names = (url.searchParams.get('names') ?? '').split(',').filter(Boolean);
    const rows = names.length ? names.flatMap((n) => q.advisories.all(n)) : db.prepare('SELECT * FROM advisories ORDER BY id').all();
    json(res, 200, { advisories: rows });
  });

  router.post('/-/advisories', async (req, res) => {
    const user = requireAuth(req);
    requireAdmin(user);
    const { name, range, severity, title, url } = await readJson(req);
    validName(name ?? '');
    if (!semver.validRange(range ?? '')) throw new HttpError(400, 'invalid semver range');
    if (!['low', 'moderate', 'high', 'critical'].includes(severity)) throw new HttpError(400, 'severity must be low|moderate|high|critical');
    if (!title) throw new HttpError(400, 'title is required');
    const r = db.prepare('INSERT INTO advisories (name, range, severity, title, url, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(name, range, severity, title, url ?? null, user.name);
    json(res, 201, { ok: true, id: Number(r.lastInsertRowid) });
  });

  router.delete('/-/advisories/:id', (req, res, { params }) => {
    requireAdmin(requireAuth(req));
    const r = db.prepare('DELETE FROM advisories WHERE id = ?').run(Number(params.id));
    if (!r.changes) throw new HttpError(404, 'advisory not found');
    json(res, 200, { ok: true });
  });

  // Body: { filters: { name: version } }  ->  per filter status used by `bevara audit`.
  router.post('/-/audit', async (req, res) => {
    const { filters = {} } = await readJson(req);
    const report = {};
    for (const [name, version] of Object.entries(filters)) {
      if (!NAME_RE.test(name)) continue;
      const filter = q.filter.get(name);
      if (!filter) { report[name] = { found: false }; continue; }
      const rows = q.versions.all(name);
      const row = rows.find((r) => r.version === version);
      const advisories = q.advisories.all(name).filter((a) => version && semver.valid(version) && semver.satisfies(version, a.range));
      report[name] = {
        found: true, latest: filter.latest, deprecated: filter.deprecated,
        versions: rows.map((r) => ({ version: r.version, abi: r.abi, deprecated: r.deprecated })),
        version: row ? { version: row.version, integrity: 'sha256-' + Buffer.from(row.wasm_sha256, 'hex').toString('base64'), deprecated: row.deprecated, publishedAt: row.published_at, license: JSON.parse(row.manifest).license, licence_required: !!JSON.parse(row.manifest).licence_required } : null,
        advisories,
      };
    }
    json(res, 200, { report });
  });

  // ------------------------------------------------------------- server
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,HEAD,OPTIONS', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '86400' });
      return res.end();
    }
    const m = router.match(req.method, url.pathname);
    try {
      if (!m) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
      if (m.status === 405) throw new HttpError(405, 'method not allowed');
      await m.handler(req, res, { params: m.params, url });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) cfg.log(`error ${req.method} ${url.pathname}: ${e.stack}`);
      if (res.headersSent) return res.end();
      json(res, status, { error: e.message, ...(e.extra ?? {}) });
    }
  }

  const server = http.createServer(handle);
  server.requestTimeout = 10 * 60_000;
  return { server, db, auth, store, config: cfg, handle };
}
