import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import semver from 'semver';
import { normalizeQuery, selectAccessors } from './select.js';
import { openDb } from './db.js';
import { Auth } from './auth.js';
import { Oidc } from './oidc.js';
import { Store } from './store.js';
import { Ledger } from './ledger.js';
import { extractTarball } from './tarball.js';
import { inspectWasm, accessorFileName } from './wasm.js';
import { validateManifest, normalizeManifest, publicManifest, NAME_RE, PART_RE, fullName, splitName, shortName } from './manifest.js';
import { verifyRecord, keyIdOf } from './sig.js';
import { Router, HttpError, json, html, redirect, readBody, readJson, readForm, sendFile, bearer } from './http.js';
import { catalogPage, loginFormPage, tokenPage } from './ui.js';

// The registry's version is the package's: one place to bump, and the image tag
// (deploy/k8s) follows it.
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
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
    defaultNamespace: config.defaultNamespace ?? 'bevara',
    requireSignatures: config.requireSignatures ?? true,
    keyFile: config.keyFile,               // registry signing key; ephemeral when dbFile is ':memory:'
    log: config.log ?? (() => {}),
  };
  const db = openDb(cfg.dbFile ?? path.join(cfg.dataDir, 'registry.sqlite'));
  const auth = new Auth(db, { adminUsers: cfg.adminUsers });
  const store = new Store(path.join(cfg.dataDir, 'store'));
  const ledger = new Ledger(db, { dataDir: cfg.dbFile === ':memory:' ? null : cfg.dataDir, keyFile: cfg.keyFile });
  const oidc = cfg.oidc?.issuer ? new Oidc({ ...cfg.oidc, publicUrl: cfg.publicUrl ?? 'http://localhost:8080' }) : null;
  const router = new Router();

  // "theora_1.wasm" -> "theora": the name a page uses, without its generation, any case.
  const accessorKey = (wasmFile) => wasmFile.replace(/_\d+\.wasm$/, '').toLowerCase();

  /* Namespaces that must exist whatever happened before: the default one, so
   * that administrators can grant it (bevara namespace add <user> bevara), and
   * each account's own, which accounts created before namespaces lacked. */
  db.prepare('INSERT OR IGNORE INTO namespaces (name, created_by) VALUES (?, ?)').run(cfg.defaultNamespace, 'registry');
  for (const u of db.prepare('SELECT id, name FROM users').all()) {
    if (!PART_RE.test(u.name) || u.name === cfg.defaultNamespace) continue;
    db.prepare('INSERT OR IGNORE INTO namespaces (name, created_by) VALUES (?, ?)').run(u.name, u.name);
    db.prepare('INSERT OR IGNORE INTO namespace_owners (namespace, user_id) VALUES (?, ?)').run(u.name, u.id);
  }

  /* Registries created before accessor names were reserved: fill the table
   * from what is published, and report clashes that already exist (the first
   * publisher keeps the name; the others keep working but are listed). */
  {
    const rows = db.prepare('SELECT name, wasm_file FROM versions ORDER BY published_at').all();
    const claim = db.prepare('INSERT OR IGNORE INTO accessor_names (key, name) VALUES (?, ?)');
    const owner = db.prepare('SELECT name FROM accessor_names WHERE key = ?');
    const clashes = new Set();
    for (const r of rows) {
      const key = accessorKey(r.wasm_file);
      claim.run(key, r.name);
      const holder = owner.get(key)?.name;
      if (holder && holder !== r.name) clashes.add(`${key}: ${holder} and ${r.name}`);
    }
    for (const c of clashes) cfg.log(`warning: accessor name already used by two packages (${c}); only the first may publish new versions`);
  }

  const baseUrl = (req) => cfg.publicUrl ?? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const requireAuth = (req) => {
    const user = auth.userForToken(bearer(req));
    if (!user) throw new HttpError(401, 'authentication required: run `bevara login`');
    return user;
  };
  const isAdmin = (user) => auth.isAdmin(user);
  const requireAdmin = (user) => { if (!isAdmin(user)) throw new HttpError(403, 'admin role required'); };
  const isOwner = (name, user) => isAdmin(user) || !!db.prepare('SELECT 1 FROM owners WHERE name = ? AND user_id = ?').get(name, user.id);
  const requireOwner = (name, user) => { if (!isOwner(name, user)) throw new HttpError(403, `you are not an owner of "${name}"`); };
  const ownsNamespace = (ns, user) => isAdmin(user) || !!db.prepare('SELECT 1 FROM namespace_owners WHERE namespace = ? AND user_id = ?').get(ns, user.id);
  // Canonical, namespaced name. Bare names go to the default namespace.
  const validName = (name) => {
    if (!NAME_RE.test(name ?? '')) throw new HttpError(400, `invalid filter name "${name}" (expected <namespace>:<package>)`);
    return fullName(name, cfg.defaultNamespace);
  };
  const validVersion = (v) => { if (!semver.valid(v)) throw new HttpError(400, `invalid version "${v}"`); return v; };
  const sha256 = (buf) => createHash('sha256').update(buf).digest();
  const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

  // ---------------------------------------------------------------- queries
  const q = {
    filter: db.prepare('SELECT * FROM filters WHERE name = ?'),
    versions: db.prepare('SELECT * FROM versions WHERE name = ? ORDER BY published_at'),
    version: db.prepare('SELECT * FROM versions WHERE name = ? AND version = ?'),
    owners: db.prepare('SELECT u.name FROM owners o JOIN users u ON u.id = o.user_id WHERE o.name = ? ORDER BY u.name'),
    nsOwners: db.prepare('SELECT u.name FROM namespace_owners o JOIN users u ON u.id = o.user_id WHERE o.namespace = ? ORDER BY u.name'),
    advisories: db.prepare('SELECT * FROM advisories WHERE name = ? ORDER BY id'),
    downloads: db.prepare('SELECT COALESCE(SUM(downloads),0) AS n FROM versions WHERE name = ?'),
    bumpDownloads: db.prepare('UPDATE versions SET downloads = downloads + 1 WHERE name = ? AND version = ?'),
    key: db.prepare('SELECT k.*, u.name AS user_name FROM user_keys k JOIN users u ON u.id = k.user_id WHERE k.key_id = ?'),
    userKeys: db.prepare('SELECT key_id, public_key, label, created_at, revoked_at FROM user_keys WHERE user_id = ? ORDER BY created_at'),
    logEntry: db.prepare('SELECT seq, hash FROM log WHERE seq = ?'),
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
    const sig = row.wasm_info ? JSON.parse(row.wasm_info).signature : null;
    return {
      ...m,
      name: row.name,
      abi: row.abi,
      dist: {
        file: row.wasm_file,
        wasm: `${base}/accessors/${encodeURIComponent(row.name)}/${row.version}/${row.wasm_file}`,
        tarball: `${base}/filters/${encodeURIComponent(row.name)}/-/${shortName(row.name)}-${row.version}.tgz`,
        integrity: 'sha256-' + b64(row.wasm_sha256),
        sha256: row.wasm_sha256,
        size: row.wasm_size,
        brSize: row.wasm_br_size,
        tarballIntegrity: 'sha256-' + b64(row.tarball_sha256),
        tarballSize: row.tarball_size,
      },
      signature: sig ?? null,   // { record, signature, keyId, publicKey, logSeq, logHash }
      wasm: row.wasm_info ? (({ signature, ...rest }) => rest)(JSON.parse(row.wasm_info)) : undefined,
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
      name, namespace: splitName(name).namespace, description: filter.description, 'dist-tags': { latest: filter.latest },
      versions, time, owners: q.owners.all(name).map((o) => o.name),
      deprecated: filter.deprecated, downloads: q.downloads.get(name).n,
      advisories: q.advisories.all(name),
    };
  }

  // ------------------------------------------------------------------- UI
  router.get('/', (req, res) => html(res, 200, catalogPage({ name: cfg.name, oidc: !!oidc, version: VERSION })));
  const publicConfig = (req) => ({ ok: true, name: cfg.name, version: VERSION, oidc: !!oidc, signup: cfg.allowSignup, defaultNamespace: cfg.defaultNamespace, requireSignatures: cfg.requireSignatures, registryKeyId: ledger.keyId, registryKey: ledger.key.publicKey, publicUrl: baseUrl(req) });
  router.get('/-/ping', (req, res) => json(res, 200, publicConfig(req)));
  router.get('/-/config', (req, res) => json(res, 200, publicConfig(req)));

  // ------------------------------------------------------------ accounts
  const claimOwnNamespace = (user) => {
    // Each user owns the namespace named after them (like npm scopes) - except
    // the default namespace, which only administrators hand out.
    if (!PART_RE.test(user.name) || user.name === cfg.defaultNamespace) return;
    db.prepare('INSERT OR IGNORE INTO namespaces (name, created_by) VALUES (?, ?)').run(user.name, user.name);
    db.prepare('INSERT OR IGNORE INTO namespace_owners (namespace, user_id) VALUES (?, ?)').run(user.name, user.id);
  };

  router.post('/-/user', async (req, res) => {
    if (!cfg.allowSignup) throw new HttpError(403, 'self-registration is disabled on this registry');
    const { name, password, email } = await readJson(req);
    if (!name || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) throw new HttpError(400, 'invalid username (lowercase, digits, . _ -)');
    if (!password || password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
    if (auth.getUser(name)) throw new HttpError(409, `user "${name}" already exists`);
    const user = auth.createUser({ name, email, password });
    claimOwnNamespace(user);
    const token = auth.createToken(user.id, 'cli');
    json(res, 201, { ok: true, user: { name: user.name, role: user.role }, token });
  });

  router.post('/-/login', async (req, res) => {
    const { name, password, label } = await readJson(req);
    const user = auth.login(name ?? '', password ?? '');
    if (!user) throw new HttpError(401, 'invalid username or password');
    claimOwnNamespace(user);
    json(res, 200, { ok: true, user: { name: user.name, role: user.role }, token: auth.createToken(user.id, label ?? 'cli') });
  });

  router.get('/-/whoami', (req, res) => {
    const user = requireAuth(req);
    const namespaces = db.prepare('SELECT namespace FROM namespace_owners WHERE user_id = ? ORDER BY namespace').all(user.id).map((r) => r.namespace);
    json(res, 200, { name: user.name, email: user.email, role: user.role, tokens: auth.listTokens(user.id).length, namespaces, keys: q.userKeys.all(user.id).filter((k) => !k.revoked_at).map((k) => k.key_id) });
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
    claimOwnNamespace(user);
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

  // ------------------------------------------------------------- keys
  router.get('/-/keys/:keyId', (req, res, { params }) => {
    const k = q.key.get(params.keyId);
    if (!k) throw new HttpError(404, 'unknown key');
    json(res, 200, { keyId: k.key_id, publicKey: k.public_key, user: k.user_name, label: k.label, createdAt: k.created_at, revokedAt: k.revoked_at });
  });
  router.get('/-/keys', (req, res) => {
    const user = requireAuth(req);
    json(res, 200, { keys: q.userKeys.all(user.id).map((k) => ({ keyId: k.key_id, publicKey: k.public_key, label: k.label, createdAt: k.created_at, revokedAt: k.revoked_at })) });
  });
  router.put('/-/keys', async (req, res) => {
    const user = requireAuth(req);
    const { publicKey, label } = await readJson(req);
    if (!publicKey || !/^[A-Za-z0-9+/=]{40,120}$/.test(publicKey)) throw new HttpError(400, 'publicKey must be an Ed25519 SPKI DER key, base64');
    if (!isEd25519Spki(publicKey)) throw new HttpError(400, 'not an Ed25519 public key');
    const keyId = keyIdOf(publicKey);
    const existing = q.key.get(keyId);
    if (existing && existing.user_id !== user.id) throw new HttpError(409, 'this key is registered to another user');
    if (!existing) db.prepare('INSERT INTO user_keys (key_id, user_id, public_key, label) VALUES (?, ?, ?, ?)').run(keyId, user.id, publicKey, label ?? null);
    else if (existing.revoked_at) throw new HttpError(409, 'this key was revoked; generate a new one');
    json(res, existing ? 200 : 201, { ok: true, keyId });
  });
  router.delete('/-/keys/:keyId', (req, res, { params }) => {
    const user = requireAuth(req);
    const k = q.key.get(params.keyId);
    if (!k || (k.user_id !== user.id && !isAdmin(user))) throw new HttpError(404, 'unknown key');
    db.prepare("UPDATE user_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key_id = ?").run(params.keyId);
    json(res, 200, { ok: true, revoked: params.keyId });
  });

  // ------------------------------------------------------------- namespaces
  router.get('/-/namespaces', (req, res) => {
    const rows = db.prepare('SELECT name, created_by, created_at FROM namespaces ORDER BY name').all();
    json(res, 200, { defaultNamespace: cfg.defaultNamespace, namespaces: rows.map((r) => ({ name: r.name, owners: q.nsOwners.all(r.name).map((o) => o.name), createdAt: r.created_at, filters: db.prepare("SELECT COUNT(*) AS n FROM filters WHERE name LIKE ? || ':%'").get(r.name).n })) });
  });
  const nsMutation = (req, params, add) => {
    const user = requireAuth(req);
    const ns = params.ns;
    if (!PART_RE.test(ns)) throw new HttpError(400, 'invalid namespace');
    if (!db.prepare('SELECT 1 FROM namespaces WHERE name = ?').get(ns)) throw new HttpError(404, `namespace "${ns}" does not exist`);
    if (!ownsNamespace(ns, user)) throw new HttpError(403, `you do not own namespace "${ns}"`);
    const target = auth.getUser(params.user);
    if (!target) throw new HttpError(404, `user "${params.user}" not found`);
    if (add) db.prepare('INSERT OR IGNORE INTO namespace_owners (namespace, user_id) VALUES (?, ?)').run(ns, target.id);
    else {
      if (q.nsOwners.all(ns).length <= 1) throw new HttpError(400, 'a namespace must keep at least one owner');
      db.prepare('DELETE FROM namespace_owners WHERE namespace = ? AND user_id = ?').run(ns, target.id);
    }
    return { namespace: ns, owners: q.nsOwners.all(ns).map((o) => o.name) };
  };
  router.put('/-/namespaces/:ns/owners/:user', (req, res, { params }) => json(res, 200, nsMutation(req, params, true)));
  router.delete('/-/namespaces/:ns/owners/:user', (req, res, { params }) => json(res, 200, nsMutation(req, params, false)));

  // ------------------------------------------------------------- catalog
  router.get('/filters', (req, res, { url }) => {
    const term = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const support = url.searchParams.get('support');
    const format = url.searchParams.get('format')?.toLowerCase();
    const ns = url.searchParams.get('namespace');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1000);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    const rows = db.prepare('SELECT f.*, v.manifest, v.abi, v.wasm_file, v.wasm_size, v.wasm_br_size FROM filters f LEFT JOIN versions v ON v.name = f.name AND v.version = f.latest ORDER BY f.name').all();
    let out = rows.map((r) => {
      const m = r.manifest ? JSON.parse(r.manifest) : {};
      return {
        name: r.name, namespace: splitName(r.name).namespace, latest: r.latest, description: r.description, deprecated: r.deprecated,
        abi: r.abi, file: r.wasm_file, size: r.wasm_size, brSize: r.wasm_br_size,
        filters: m.filters ?? [], support: m.support ?? [], formats: m.formats ?? [], keywords: m.keywords ?? [],
        license: m.license, licence_required: !!m.licence_required, priority: m.priority,
        downloads: q.downloads.get(r.name).n, updated: r.updated_at,
      };
    });
    if (term) out = out.filter((f) => [f.name, f.description, ...f.filters, ...f.formats, ...f.keywords].join(' ').toLowerCase().includes(term));
    if (support) out = out.filter((f) => f.support.includes(support));
    if (format) out = out.filter((f) => f.formats.some((x) => x.toLowerCase() === format));
    if (ns) out = out.filter((f) => f.namespace === ns);
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
    const m = new RegExp(`^${shortName(name).replace(/[.]/g, '\\.')}-(.+)\\.tgz$`).exec(params.file);
    const row = m && q.version.get(name, m[1]);
    if (!row) throw new HttpError(404, 'tarball not found');
    q.bumpDownloads.run(name, row.version);
    await sendFile(req, res, store.path(name, row.version, params.file), 'application/gzip', { 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
  });

  // ------------------------------------------------- accessors for players
  // /accessors/theora_1.wasm                     -> latest of bevara:theora (default namespace) with abi 1
  // /accessors/acme:theora_1.wasm                -> another namespace
  // /accessors/bevara:theora/1.2.0/theora_1.wasm -> exact version
  const wasmHeaders = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' };
  router.get('/accessors/:name/:version/:file', async (req, res, { params }) => {
    const row = q.version.get(validName(params.name), params.version);
    if (!row || row.wasm_file !== params.file) throw new HttpError(404, 'accessor not found');
    q.bumpDownloads.run(row.name, row.version);
    await sendFile(req, res, store.path(row.name, row.version, row.wasm_file), 'application/wasm', { ...wasmHeaders, 'cache-control': 'public, max-age=31536000, immutable', 'x-bevara-version': row.version });
  });

  // The latest version of every filter that is not deprecated, as players and
  // the selector see it.
  const indexEntries = (req) => {
    const base = baseUrl(req);
    return db.prepare('SELECT v.* FROM filters f JOIN versions v ON v.name = f.name AND v.version = f.latest WHERE f.deprecated IS NULL ORDER BY f.name').all()
      .map((r) => { const m = JSON.parse(r.manifest); const info = r.wasm_info ? JSON.parse(r.wasm_info) : {}; return { name: r.name, version: r.version, abi: r.abi, file: r.wasm_file, url: `${base}/accessors/${encodeURIComponent(r.name)}/${r.version}/${r.wasm_file}`, filters: m.filters, support: m.support, formats: m.formats, extension: m.extension, using: m.using, inputs: m.inputs, outputs: m.outputs, priority: m.priority, caps: m.caps, projects: m.projects, language: m.language ?? 'wasm', license: m.license, licence_required: !!m.licence_required, georestrictions: m.georestrictions, dependencies: m.dependencies, size: r.wasm_size, brSize: r.wasm_br_size, integrity: 'sha256-' + b64(r.wasm_sha256), keyId: info.signature?.keyId, logSeq: info.signature?.logSeq }; });
  };

  router.get('/accessors/index.json', (req, res) => {
    json(res, 200, { registry: baseUrl(req), generated: new Date().toISOString(), checkpoint: ledger.checkpoint(), filters: indexEntries(req) }, wasmHeaders);
  });

  // Capability-driven selection (paper, Section 5): every accessor whose
  // declared inputs satisfy the query's, under its side conditions. POST takes
  // the query as the body; GET as ?query=<JSON> or as plain parameters
  // (?pixfmt=rgba&maxpriority=50), for a player that cannot POST.
  const runSelect = (req, res, query) => {
    let q;
    try { q = normalizeQuery(query); } catch (e) { throw new HttpError(400, `invalid query: ${e.message}`, { hint: 'see docs/REGISTRY_API.md, "Selection"' }); }
    const { matches, excluded, uncharacterised } = selectAccessors(indexEntries(req), q);
    json(res, 200, { query: q, total: matches.length, matches, excluded, uncharacterised }, wasmHeaders);
  };
  router.post('/-/select', async (req, res) => {
    const body = await readBody(req, { limit: 64 * 1024 });
    let query;
    try { query = JSON.parse(body.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'the body must be the query as JSON'); }
    runSelect(req, res, query);
  });
  router.get('/-/select', (req, res, { url }) => {
    const p = url.searchParams;
    if (p.has('query')) {
      let query;
      try { query = JSON.parse(p.get('query')); } catch { throw new HttpError(400, '"query" must be JSON'); }
      return runSelect(req, res, query);
    }
    const inputs = [];
    for (const [k, v] of p) if (!['maxpriority', 'version', 'projectname', 'project', 'language', 'maxsize', 'license', 'geocode', 'filter', 'output'].includes(k)) inputs.push({ property: k, format: v });
    runSelect(req, res, {
      inputs, outputs: p.getAll('output').map((o) => { const [property, format] = o.split('='); return { property, format }; }),
      version: p.get('version'), projectname: p.get('projectname') ?? p.get('project'), language: p.get('language'), filter: p.get('filter'),
      maxpriority: p.get('maxpriority'),
      size: p.has('maxsize') ? { condition: true, maxsize: p.get('maxsize') } : undefined,
      IP: p.has('license') || p.has('geocode') ? { condition: true, license: p.get('license'), geocode: p.get('geocode') } : undefined,
    });
  });

  // Same shape as filters/filter_list.json in the Bevara filters repository.
  router.get('/accessors/filter_list.json', (req, res) => {
    const names = db.prepare('SELECT name FROM filters WHERE deprecated IS NULL ORDER BY name').all().map((r) => shortName(r.name));
    json(res, 200, { tag: TAG_BLOCK, using: ['core'], with: [...new Set(names)] }, wasmHeaders);
  });

  router.get('/accessors/:file', async (req, res, { params }) => {
    const m = /^((?:[a-z0-9][a-z0-9._-]*:)?[A-Za-z0-9][A-Za-z0-9._-]*)_(\d+)\.wasm$/.exec(params.file);
    if (!m) throw new HttpError(404, 'accessor not found (expected [namespace:]<module>_<abi>.wasm)');
    // The file name carries the module name, which equals the package name up
    // to case (libOpenVVC_1.wasm -> bevara:libopenvvc). A namespace prefix may
    // precede it in the URL but never appears in the stored file name.
    const row = latestFor(validName(m[1].toLowerCase()), { abi: parseInt(m[2], 10) });
    if (!row) throw new HttpError(404, `no published version of "${m[1]}" with abi ${m[2]}`);
    const wanted = `${shortName(m[1])}_${m[2]}.wasm`;
    if (row.wasm_file !== wanted) throw new HttpError(404, `this accessor is published as ${row.wasm_file}`);
    q.bumpDownloads.run(row.name, row.version);
    await sendFile(req, res, store.path(row.name, row.version, row.wasm_file), 'application/wasm', { ...wasmHeaders, 'cache-control': 'public, max-age=300', 'x-bevara-version': row.version, 'x-bevara-name': row.name });
  });

  // ------------------------------------------------------------- publish
  // Headers: x-bevara-record (base64 canonical JSON), x-bevara-signature (base64 Ed25519).
  router.put('/filters/:name/:version', async (req, res, { params }) => {
    const user = requireAuth(req);
    const name = validName(params.name);
    const version = validVersion(params.version);
    const { namespace } = splitName(name);
    const tarball = await readBody(req, { limit: cfg.maxTarball });
    if (!tarball.length) throw new HttpError(400, 'empty body: expected a gzipped tarball');
    const files = await extractTarball(tarball);
    const manifestBuf = files.get('package/bevara.json');
    if (!manifestBuf) throw new HttpError(400, 'tarball must contain package/bevara.json');
    let manifest;
    try { manifest = normalizeManifest(JSON.parse(manifestBuf.toString('utf8'))); } catch { throw new HttpError(400, 'package/bevara.json is not valid JSON'); }
    manifest.name = fullName(manifest.name ?? '', cfg.defaultNamespace);
    const { errors, warnings } = validateManifest(manifest, { forPublish: true });
    if (errors.length) throw new HttpError(400, 'invalid manifest', { errors, warnings });
    if (manifest.name !== name || manifest.version !== version) throw new HttpError(400, `manifest is ${manifest.name}@${manifest.version} but URL is ${name}@${version}`);

    const wasmName = accessorFileName(name, manifest.abi, manifest.module);
    const wasm = files.get(`package/${wasmName}`);
    if (!wasm) throw new HttpError(400, `tarball must contain package/${wasmName}`);
    const info = inspectWasm(wasm);
    if (!info.valid) throw new HttpError(400, `${wasmName}: ${info.error}`);
    if (!info.sideModule) throw new HttpError(400, `${wasmName} is not an Emscripten side module (no dylink section). Link with -sSIDE_MODULE=2`);
    const wasmSha = sha256(wasm).toString('hex');
    const tarSha = sha256(tarball).toString('hex');

    /* Who may publish what. Reading needs no account; publishing does, and:
     *  - the default namespace is open: any authenticated account may publish
     *    a new filter in it, and becomes that package's owner;
     *  - a package, once published, takes new versions from its owners only
     *    (and administrators) - otherwise any account could replace a decoder
     *    every page links;
     *  - other namespaces belong to their owners (an account owns its own). */
    const nsRow = db.prepare('SELECT 1 FROM namespaces WHERE name = ?').get(namespace);
    const existing = q.filter.get(name);
    if (existing) {
      if (!isOwner(name, user)) {
        const owners = q.owners.all(name).map((o) => o.name);
        throw new HttpError(403, `${name} belongs to ${owners.join(', ')}: only its owners publish new versions`, {
          hint: `ask one of them to add you (bevara owner add ${user.name} ${name}), or publish your own filter under another name`,
        });
      }
      if (q.version.get(name, version)) throw new HttpError(409, `${name}@${version} is already published; bump the version`);
    } else if (nsRow && namespace !== cfg.defaultNamespace && !ownsNamespace(namespace, user)) {
      const owners = q.nsOwners.all(namespace).map((o) => o.name);
      throw new HttpError(403, `namespace "${namespace}" belongs to ${owners.join(', ') || 'the administrators'}`, {
        hint: `one of them can add you (bevara namespace add ${user.name} ${namespace}), or publish it in the default namespace with a bare name: "${shortName(name)}"`,
      });
    }

    // Signature: the record must describe exactly this upload.
    let sigInfo = null;
    const recordB64 = req.headers['x-bevara-record'];
    const signature = req.headers['x-bevara-signature'];
    if (recordB64 && signature) {
      let record;
      try { record = JSON.parse(Buffer.from(String(recordB64), 'base64').toString('utf8')); } catch { throw new HttpError(400, 'x-bevara-record is not base64 JSON'); }
      const key = q.key.get(record.keyId ?? '');
      if (!key) throw new HttpError(400, `unknown signing key ${record.keyId}; run \`bevara key register\``);
      if (key.user_id !== user.id) throw new HttpError(403, 'signing key belongs to another user');
      if (key.revoked_at) throw new HttpError(403, 'signing key was revoked');
      const expected = { type: 'publish', name, version, abi: manifest.abi, file: wasmName, wasmSha256: wasmSha, tarballSha256: tarSha };
      for (const [k, v] of Object.entries(expected)) if (record[k] !== v) throw new HttpError(400, `signed record does not match the upload (${k}: ${JSON.stringify(record[k])} vs ${JSON.stringify(v)})`);
      if (!verifyRecord(record, String(signature), key.public_key)) throw new HttpError(400, 'invalid signature');
      sigInfo = { record, signature: String(signature), keyId: key.key_id, publicKey: key.public_key };
    } else if (cfg.requireSignatures) {
      throw new HttpError(400, 'this registry requires signed publishes (upgrade the bevara CLI or run `bevara key generate`)');
    }

    // Accessor names are unique across the registry (see accessor_names).
    const key = accessorKey(wasmName);
    const holder = db.prepare('SELECT name FROM accessor_names WHERE key = ?').get(key)?.name;
    if (holder && holder !== name) {
      throw new HttpError(409, `the accessor name "${key}" is already taken by ${holder}: pages load accessors by file name (${wasmName}), so two packages cannot provide it`, {
        hint: `pick another name (or "module") for this accessor, or ask the owners of ${holder} to add you: bevara owner add <you> ${holder}`,
      });
    }
    // Two packages registering the same GPAC filter would clash if a page linked both.
    const mine = new Set(manifest.filters);
    for (const other of db.prepare('SELECT f.name, v.manifest FROM filters f JOIN versions v ON v.name = f.name AND v.version = f.latest WHERE f.name != ?').all(name)) {
      const shared = (JSON.parse(other.manifest).filters ?? []).filter((f) => mine.has(f));
      if (shared.length) warnings.push(`GPAC filter${shared.length > 1 ? 's' : ''} ${shared.join(', ')} also registered by ${other.name}: a page linking both would register ${shared.length > 1 ? 'them' : 'it'} twice`);
    }

    for (const [dep, range] of Object.entries(manifest.dependencies)) {
      if (!semver.validRange(range)) throw new HttpError(400, `dependency "${dep}": invalid range "${range}"`);
      if (dep !== name && !q.filter.get(fullName(dep, cfg.defaultNamespace))) warnings.push(`dependency "${dep}" is not published on this registry`);
    }

    const tarballName = `${shortName(name)}-${version}.tgz`;
    const { brSize } = await store.save(name, version, { tarball, tarballName, wasm, wasmName });
    db.exec('BEGIN');
    try {
      if (!nsRow) {
        db.prepare('INSERT INTO namespaces (name, created_by) VALUES (?, ?)').run(namespace, user.name);
        db.prepare('INSERT INTO namespace_owners (namespace, user_id) VALUES (?, ?)').run(namespace, user.id);
      }
      if (!existing) {
        db.prepare('INSERT INTO filters (name, description) VALUES (?, ?)').run(name, manifest.description ?? '');
        db.prepare('INSERT INTO owners (name, user_id) VALUES (?, ?)').run(name, user.id);
      }
      // Re-checked here, synchronously inside the transaction: two concurrent
      // publishes of the same accessor name cannot both get past this point.
      db.prepare('INSERT OR IGNORE INTO accessor_names (key, name) VALUES (?, ?)').run(key, name);
      const claimed = db.prepare('SELECT name FROM accessor_names WHERE key = ?').get(key).name;
      if (claimed !== name) throw new HttpError(409, `the accessor name "${key}" was just taken by ${claimed}`);
      if (sigInfo) {
        const { seq, hash } = ledger.append(sigInfo.record, sigInfo.signature, sigInfo.keyId);
        sigInfo.logSeq = seq; sigInfo.logHash = hash;
      }
      const wasmInfo = { exports: info.exports.map((e) => e.name), imports: info.imports.length, needed: info.dylink?.needed ?? [], customSections: info.customSections, signature: sigInfo };
      db.prepare(`INSERT INTO versions (name, version, abi, manifest, wasm_file, wasm_sha256, wasm_size, wasm_br_size, tarball_sha256, tarball_size, wasm_info, published_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(name, version, manifest.abi, JSON.stringify(publicManifest(manifest)), wasmName, wasmSha, wasm.length, brSize, tarSha, tarball.length, JSON.stringify(wasmInfo), user.name);
      refreshLatest(name);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      await store.remove(name, version);     // the files were written before the transaction
      throw e;
    }
    cfg.log(`published ${name}@${version} by ${user.name}${sigInfo ? ` (log #${sigInfo.logSeq})` : ' (unsigned)'}`);
    const doc = versionDoc(req, q.version.get(name, version));
    json(res, 201, { ok: true, name, version, warnings, dist: doc.dist, signature: doc.signature, checkpoint: ledger.checkpoint() });
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
    ledger.appendOwn({ type: 'yank', name, version: params.version, wasmSha256: row.wasm_sha256, by: user.name });
    if (q.versions.all(name).length === 0) db.prepare('DELETE FROM filters WHERE name = ?').run(name);
    else refreshLatest(name);
    json(res, 200, { ok: true, removed: `${name}@${params.version}` });
  });

  router.delete('/filters/:name', async (req, res, { params }) => {
    const user = requireAuth(req);
    const name = validName(params.name);
    if (!q.filter.get(name)) throw new HttpError(404, `filter "${name}" not found`);
    requireOwner(name, user);
    for (const row of q.versions.all(name)) {
      await store.remove(name, row.version);
      ledger.appendOwn({ type: 'yank', name, version: row.version, wasmSha256: row.wasm_sha256, by: user.name });
    }
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
      ledger.appendOwn({ type: 'deprecate', name, versions: targets, message: msg, by: user.name });
      return json(res, 200, { ok: true, deprecated: msg, versions: targets });
    }
    db.prepare('UPDATE filters SET deprecated = ? WHERE name = ?').run(msg, name);
    ledger.appendOwn({ type: 'deprecate', name, message: msg, by: user.name });
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

  // ------------------------------------------------------- transparency log
  router.get('/-/log', (req, res, { url }) => {
    const since = parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '1000', 10) || 1000, 5000);
    const name = url.searchParams.get('name') ? validName(url.searchParams.get('name')) : undefined;
    const entries = ledger.entries({ since, limit, name });
    json(res, 200, { entries, checkpoint: ledger.checkpoint(), more: entries.length === limit });
  });
  router.get('/-/log/checkpoint', (req, res) => json(res, 200, ledger.checkpoint()));
  router.get('/-/log/:seq', (req, res, { params }) => {
    const p = ledger.proof(parseInt(params.seq, 10));
    if (!p) throw new HttpError(404, 'no such log entry');
    json(res, 200, { ...p, checkpoint: ledger.checkpoint() });
  });
  // Public keys referenced by the log (publishers + the registry itself).
  router.get('/-/log/keys/all', (req, res) => {
    const keys = db.prepare('SELECT key_id, public_key, revoked_at, u.name AS user FROM user_keys k JOIN users u ON u.id = k.user_id').all()
      .map((k) => ({ keyId: k.key_id, publicKey: k.public_key, user: k.user, revokedAt: k.revoked_at }));
    keys.push({ keyId: ledger.keyId, publicKey: ledger.key.publicKey, user: null, registry: true });
    json(res, 200, { keys });
  });

  // ------------------------------------------------------- audit & advisories
  router.get('/-/advisories', (req, res, { url }) => {
    const names = (url.searchParams.get('names') ?? '').split(',').filter(Boolean).map(validName);
    const rows = names.length ? names.flatMap((n) => q.advisories.all(n)) : db.prepare('SELECT * FROM advisories ORDER BY id').all();
    json(res, 200, { advisories: rows });
  });

  router.post('/-/advisories', async (req, res) => {
    const user = requireAuth(req);
    requireAdmin(user);
    const body = await readJson(req);
    const name = validName(body.name ?? '');
    const { range, severity, title, url } = body;
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
    for (const [rawName, version] of Object.entries(filters)) {
      if (!NAME_RE.test(rawName)) continue;
      const name = fullName(rawName, cfg.defaultNamespace);
      const filter = q.filter.get(name);
      if (!filter) { report[rawName] = { found: false }; continue; }
      const rows = q.versions.all(name);
      const row = rows.find((r) => r.version === version);
      const advisories = q.advisories.all(name).filter((a) => version && semver.valid(version) && semver.satisfies(version, a.range));
      const m = row ? JSON.parse(row.manifest) : null;
      const sig = row?.wasm_info ? JSON.parse(row.wasm_info).signature : null;
      report[rawName] = {
        found: true, name, latest: filter.latest, deprecated: filter.deprecated,
        versions: rows.map((r) => ({ version: r.version, abi: r.abi, deprecated: r.deprecated })),
        version: row ? { version: row.version, integrity: 'sha256-' + b64(row.wasm_sha256), deprecated: row.deprecated, publishedAt: row.published_at, license: m.license, licence_required: !!m.licence_required, signature: sig } : null,
        advisories,
      };
    }
    json(res, 200, { report, checkpoint: ledger.checkpoint() });
  });

  // ------------------------------------------------------------- server
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': url.pathname === '/-/select' ? 'GET,POST,OPTIONS' : 'GET,HEAD,OPTIONS', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '86400' });
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
      // The request body may still be in flight (an upload we refused): ask for
      // the connection to be closed once this response is written.
      json(res, status, { error: e.message, ...(e.extra ?? {}) }, status === 413 ? { connection: 'close' } : {});
    }
  }

  const server = http.createServer(handle);
  server.requestTimeout = 10 * 60_000;
  return { server, db, auth, store, ledger, config: cfg, handle };
}

// Ed25519 SPKI DER is 44 bytes and starts with the fixed OID prefix.
function isEd25519Spki(b64) {
  const buf = Buffer.from(b64, 'base64');
  return buf.length === 44 && buf.subarray(0, 12).equals(Buffer.from('302a300506032b6570032100', 'hex'));
}
