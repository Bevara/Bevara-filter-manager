// Usage statistics for the administrators' dashboard (dashboard.bevara.ddns.net).
//
// Every request worth counting adds 1 to a daily counter keyed by package,
// version and channel (stats_daily). Counts only: no address, no account. The
// report below joins them with what the registry already knows (packages,
// versions, accounts, the transparency log).
//
// Channels:
//   tarball          GET /filters/:name/-/:file          (bevara install)
//   accessor         GET /accessors/:name/:version/:file (a pinned module)
//   accessor-latest  GET /accessors/:file                (a page loading the latest)
//   metadata         GET /filters/:name[/:version]       (info, install resolution)
//   search           GET /filters
//   index            GET /accessors/index.json
//   filter-list      GET /accessors/filter_list.json
//   select           GET|POST /-/select
//   audit            POST /-/audit
//   publish, unpublish, deprecate, login
export const DOWNLOAD_CHANNELS = ['tarball', 'accessor', 'accessor-latest'];
export const CHANNELS = [...DOWNLOAD_CHANNELS, 'metadata', 'search', 'index', 'filter-list', 'select', 'audit', 'publish', 'unpublish', 'deprecate', 'login'];

// What the MCP server may report (POST /-/stats/mcp): anything else is refused.
export const MCP_EVENTS = ['request', 'tool'];
const MCP_FIELD = /^[A-Za-z0-9._\/ -]{0,48}$/;
export const MCP_MAX_ROWS = 2000;

const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (iso) => String(iso ?? '').slice(0, 10);

export class Stats {
  constructor(db, { log = () => {} } = {}) {
    this.db = db;
    this.log = log;
    this.bump = db.prepare(`INSERT INTO stats_daily (day, name, version, channel, n) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (day, name, version, channel) DO UPDATE SET n = n + 1`);
  }

  /* Adds the counters the MCP server sends. Throws a message on the first
   * row that is not one it may send (the batch is then refused whole). */
  ingestMcp(rows) {
    if (!Array.isArray(rows) || rows.length > MCP_MAX_ROWS) throw new Error(`"counts" must be an array of at most ${MCP_MAX_ROWS} rows`);
    const now = Date.now();
    const earliest = new Date(now - 7 * 86400_000).toISOString().slice(0, 10);
    const latest = new Date(now + 86400_000).toISOString().slice(0, 10);
    const clean = rows.map((r, i) => {
      const bad = (why) => new Error(`counts[${i}]: ${why}`);
      if (!r || typeof r !== 'object') throw bad('not an object');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day ?? '') || r.day < earliest || r.day > latest) throw bad('"day" must be a date of the last 7 days');
      if (!MCP_EVENTS.includes(r.event)) throw bad(`"event" must be one of ${MCP_EVENTS.join(', ')}`);
      if (!Number.isInteger(r.n) || r.n < 1 || r.n > 1_000_000) throw bad('"n" must be a positive integer');
      const f = {};
      for (const k of ['name', 'ext', 'target', 'source', 'outcome', 'client']) {
        const v = r[k] ?? '';
        if (typeof v !== 'string' || !MCP_FIELD.test(v)) throw bad(`"${k}" must be at most 48 letters, digits or . _ / - space`);
        f[k] = v;
      }
      return { day: r.day, event: r.event, ...f, n: r.n };
    });
    const add = this.db.prepare(`INSERT INTO mcp_daily (day, event, name, ext, target, source, outcome, client, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, event, name, ext, target, source, outcome, client) DO UPDATE SET n = n + excluded.n`);
    this.db.exec('BEGIN');
    try {
      for (const r of clean) add.run(r.day, r.event, r.name, r.ext, r.target, r.source, r.outcome, r.client, r.n);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.mcpReportedAt = new Date().toISOString();
    return clean.length;
  }

  // The MCP server's use over [from, to], one entry per day of `axis`.
  mcpReport(axis, from, to) {
    const rows = this.db.prepare('SELECT * FROM mcp_daily WHERE day >= ? AND day <= ?').all(from, to);
    const daily = new Map(axis.map((d) => [d, { day: d, sessions: 0, requests: 0, toolCalls: 0, errors: 0, tools: {} }]));
    const sum = (m, k, n) => m.set(k, (m.get(k) ?? 0) + n);
    const methods = new Map(), clients = new Map(), tools = new Map(), exts = new Map(), targets = new Map(), sources = new Map();
    const period = { sessions: 0, requests: 0, toolCalls: 0, errors: 0, conversions: 0 };
    for (const r of rows) {
      const d = daily.get(r.day);
      if (r.event === 'request') {
        period.requests += r.n;
        sum(methods, r.name, r.n);
        if (d) d.requests += r.n;
        if (r.name === 'initialize') {
          period.sessions += r.n;
          sum(clients, r.client || '(inconnu)', r.n);
          if (d) d.sessions += r.n;
        }
        continue;
      }
      // event "tool"
      const err = r.outcome === 'error';
      period.toolCalls += r.n;
      if (err) period.errors += r.n;
      const t = tools.get(r.name) ?? tools.set(r.name, { name: r.name, calls: 0, errors: 0 }).get(r.name);
      t.calls += r.n;
      if (err) t.errors += r.n;
      if (r.ext) {
        const e = exts.get(r.ext) ?? exts.set(r.ext, { ext: r.ext, show: 0, convert: 0, formats: 0, errors: 0 }).get(r.ext);
        if (r.name === 'bevara_show') e.show += r.n;
        else if (r.name === 'bevara_convert') e.convert += r.n;
        else if (r.name === 'bevara_formats') e.formats += r.n;
        if (err) e.errors += r.n;
      }
      if (r.target && !err) { sum(targets, r.target, r.n); period.conversions += r.n; }
      if (r.source) sum(sources, r.source, r.n);
      if (d) {
        d.toolCalls += r.n;
        if (err) d.errors += r.n;
        d.tools[r.name] = (d.tools[r.name] ?? 0) + r.n;
      }
    }
    const list = (m, key) => [...m.entries()].map(([k, n]) => ({ [key]: k, n })).sort((a, b) => b.n - a.n);
    const ever = this.db.prepare('SELECT MIN(day) AS first, MAX(day) AS last FROM mcp_daily').get();
    return {
      firstDay: ever.first ?? null, lastDay: ever.last ?? null, reportedAt: this.mcpReportedAt ?? null,
      period, daily: [...daily.values()],
      tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
      extensions: [...exts.values()].sort((a, b) => (b.show + b.convert + b.formats) - (a.show + a.convert + a.formats)).slice(0, 40),
      targets: list(targets, 'target'), sources: list(sources, 'source'), clients: list(clients, 'client'), methods: list(methods, 'method'),
    };
  }

  // Counting never fails the request it counts. HEAD requests are not counted.
  track(req, channel, name = '', version = '') {
    if (req?.method === 'HEAD') return;
    try { this.bump.run(today(), name, version ?? '', channel); } catch (e) { this.log(`stats: ${e.message}`); }
  }

  /* The report the dashboard renders, over the last `days` days (today
   * included). `kindOf(manifestJson)` gives a version's kind. */
  report({ days = 30, kindOf, admins = [] } = {}) {
    const db = this.db;
    const to = today();
    const fromDate = new Date(Date.now() - (days - 1) * 86400_000);
    const from = fromDate.toISOString().slice(0, 10);
    const axis = Array.from({ length: days }, (_, i) => new Date(fromDate.getTime() + i * 86400_000).toISOString().slice(0, 10));
    const zero = () => Object.fromEntries(CHANNELS.map((c) => [c, 0]));

    // ---- current state
    const latest = db.prepare('SELECT f.name, f.latest, f.deprecated, f.created_at, f.updated_at, v.manifest, v.published_by, v.published_at, v.wasm_size, v.wasm_br_size FROM filters f LEFT JOIN versions v ON v.name = f.name AND v.version = f.latest').all();
    const versionRows = db.prepare('SELECT name, version, manifest, published_by, published_at, downloads, deprecated, tarball_size, wasm_size, wasm_br_size FROM versions').all();
    const kinds = new Map();
    for (const r of versionRows) if (!kinds.has(r.name)) kinds.set(r.name, kindOf(r.manifest));
    for (const r of latest) if (r.manifest) kinds.set(r.name, kindOf(r.manifest));
    const kind = (name) => (name ? kinds.get(name) ?? 'removed' : null);
    const owners = new Map();
    for (const o of db.prepare('SELECT o.name, u.name AS user FROM owners o JOIN users u ON u.id = o.user_id ORDER BY u.name').all()) {
      owners.set(o.name, [...(owners.get(o.name) ?? []), o.user]);
    }
    const nsOf = (name) => (name.includes(':') ? name.slice(0, name.indexOf(':')) : '');

    const byKind = { filter: 0, runtime: 0, tags: 0 };
    for (const r of latest) byKind[kind(r.name)] = (byKind[kind(r.name)] ?? 0) + 1;
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
    const totals = {
      packages: latest.length,
      byKind,
      deprecatedPackages: latest.filter((r) => r.deprecated).length,
      versions: versionRows.length,
      namespaces: count('SELECT COUNT(*) AS n FROM namespaces'),
      users: count('SELECT COUNT(*) AS n FROM users'),
      admins: count(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'${admins.length ? ` OR name IN (${admins.map(() => '?').join(',')})` : ''}`, ...admins),
      ssoUsers: count('SELECT COUNT(*) AS n FROM users WHERE oidc_sub IS NOT NULL'),
      publishers: count('SELECT COUNT(DISTINCT published_by) AS n FROM versions WHERE published_by IS NOT NULL'),
      activeAccounts30d: count('SELECT COUNT(DISTINCT user_id) AS n FROM tokens WHERE last_used_at >= ?', since30),
      signingKeys: count('SELECT COUNT(*) AS n FROM user_keys WHERE revoked_at IS NULL'),
      advisories: count('SELECT COUNT(*) AS n FROM advisories'),
      logEntries: count('SELECT COUNT(*) AS n FROM log'),
      storageBytes: versionRows.reduce((s, r) => s + r.tarball_size + r.wasm_size + (r.wasm_br_size ?? 0), 0),
      downloadsAllTime: versionRows.reduce((s, r) => s + r.downloads, 0),
    };

    // ---- daily series
    const daily = new Map(axis.map((d) => [d, { day: d, ...zero(), signup: 0, downloads: 0 }]));
    const period = zero();
    for (const r of db.prepare('SELECT day, channel, SUM(n) AS n FROM stats_daily WHERE day >= ? AND day <= ? GROUP BY day, channel').all(from, to)) {
      const d = daily.get(r.day);
      if (d && r.channel in d) d[r.channel] += r.n;
      if (r.channel in period) period[r.channel] += r.n;
    }
    for (const r of db.prepare('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day').all(from)) {
      const d = daily.get(r.day);
      if (d) d.signup += r.n;
    }
    /* Publishes before counting began are still known: from the versions
     * published and from the log (which keeps unpublished ones). Each day
     * shows the larger of the counter and what they say. */
    const published = new Map();
    for (const r of versionRows) published.set(`${r.name}@${r.version}`, dayOf(r.published_at));
    for (const e of db.prepare('SELECT record, created_at FROM log').all()) {
      const rec = JSON.parse(e.record);
      if (rec.type === 'publish' && !published.has(`${rec.name}@${rec.version}`)) published.set(`${rec.name}@${rec.version}`, dayOf(e.created_at));
    }
    const publishesByDay = new Map();
    for (const day of published.values()) publishesByDay.set(day, (publishesByDay.get(day) ?? 0) + 1);
    let publishes = 0;
    for (const d of daily.values()) {
      d.publish = Math.max(d.publish, publishesByDay.get(d.day) ?? 0);
      publishes += d.publish;
      d.downloads = DOWNLOAD_CHANNELS.reduce((s, c) => s + d[c], 0);
    }
    period.publish = publishes;
    const trackingSince = db.prepare('SELECT MIN(day) AS d FROM stats_daily').get().d ?? null;

    // ---- per package and per version, over the period
    const perPkg = new Map();
    const perVersion = new Map();
    for (const r of db.prepare("SELECT name, version, channel, SUM(n) AS n FROM stats_daily WHERE day >= ? AND day <= ? AND name != '' GROUP BY name, version, channel").all(from, to)) {
      const p = perPkg.get(r.name) ?? perPkg.set(r.name, zero()).get(r.name);
      p[r.channel] += r.n;
      if (DOWNLOAD_CHANNELS.includes(r.channel)) {
        const k = `${r.name}@${r.version}`;
        perVersion.set(k, (perVersion.get(k) ?? 0) + r.n);
      }
    }
    const downloadsOf = (c) => DOWNLOAD_CHANNELS.reduce((s, ch) => s + c[ch], 0);
    const allTime = new Map();
    const versionCount = new Map();
    for (const r of versionRows) {
      allTime.set(r.name, (allTime.get(r.name) ?? 0) + r.downloads);
      versionCount.set(r.name, (versionCount.get(r.name) ?? 0) + 1);
    }
    const names = new Set([...latest.map((r) => r.name), ...perPkg.keys()]);
    const latestOf = new Map(latest.map((r) => [r.name, r]));
    const packages = [...names].map((name) => {
      const l = latestOf.get(name);
      const c = perPkg.get(name) ?? zero();
      const m = l?.manifest ? JSON.parse(l.manifest) : {};
      return {
        name, namespace: nsOf(name), kind: kind(name), latest: l?.latest ?? null, versions: versionCount.get(name) ?? 0,
        deprecated: l?.deprecated ?? null, license: m.license ?? null, patents: m.patents?.status ?? null,
        size: l?.wasm_size ?? null, brSize: l?.wasm_br_size ?? null,
        owners: owners.get(name) ?? [], publishedBy: l?.published_by ?? null, lastPublished: l?.published_at ?? null, created: l?.created_at ?? null,
        downloadsAllTime: allTime.get(name) ?? 0,
        period: { tarball: c.tarball, accessor: c.accessor, accessorLatest: c['accessor-latest'], metadata: c.metadata, downloads: downloadsOf(c) },
      };
    }).sort((a, b) => b.period.downloads - a.period.downloads || b.downloadsAllTime - a.downloadsAllTime || a.name.localeCompare(b.name));

    const versionsTop = [...perVersion.entries()].map(([k, n]) => {
      const at = k.lastIndexOf('@');
      const name = k.slice(0, at), version = k.slice(at + 1);
      return { name, version, kind: kind(name), downloads: n, current: versionRows.some((r) => r.name === name && r.version === version) };
    }).sort((a, b) => b.downloads - a.downloads).slice(0, 50);

    const namespaces = db.prepare('SELECT name FROM namespaces ORDER BY name').all().map(({ name }) => {
      const pkgs = packages.filter((p) => p.namespace === name);
      return { name, packages: pkgs.filter((p) => p.kind !== 'removed').length, downloads: pkgs.reduce((s, p) => s + p.period.downloads, 0), downloadsAllTime: pkgs.reduce((s, p) => s + p.downloadsAllTime, 0) };
    }).filter((n) => n.packages || n.downloads).sort((a, b) => b.downloads - a.downloads || b.packages - a.packages);

    const publishers = db.prepare(`SELECT published_by AS user, COUNT(*) AS versions, COUNT(DISTINCT name) AS packages, MAX(published_at) AS last,
      SUM(CASE WHEN published_at >= ? THEN 1 ELSE 0 END) AS inPeriod FROM versions WHERE published_by IS NOT NULL GROUP BY published_by ORDER BY versions DESC`).all(from);

    const activity = db.prepare('SELECT seq, record, created_at FROM log ORDER BY seq DESC LIMIT 40').all().map((e) => {
      const r = JSON.parse(e.record);
      return { seq: e.seq, type: r.type, name: r.name, version: r.version ?? (r.versions ? r.versions.join(', ') : null), by: r.by ?? null, keyId: r.keyId, at: e.created_at };
    });

    const channelsByKind = {};
    for (const p of packages) {
      const k = (channelsByKind[p.kind] ??= { tarball: 0, accessor: 0, accessorLatest: 0, metadata: 0, downloads: 0 });
      for (const c of Object.keys(k)) k[c] += p.period[c];
    }

    return { range: { days, from, to }, trackingSince, totals, period, daily: [...daily.values()], channelsByKind, packages, versions: versionsTop, namespaces, publishers, activity, mcp: this.mcpReport(axis, from, to) };
  }
}
