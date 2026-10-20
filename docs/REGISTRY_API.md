# Registry HTTP API

Base URL: the registry origin (e.g. `https://registry.bevara.ddns.net`). JSON unless stated.
Authenticated routes take `Authorization: Bearer <token>`.

## Accounts
| Method | Path | Body / notes |
|---|---|---|
| POST | `/-/user` | `{name, password, email?}` → `{token, user}` (403 if `ALLOW_SIGNUP=false`) |
| POST | `/-/login` | `{name, password, label?}` → `{token, user}` |
| GET | `/-/whoami` | auth → `{name, email, role}` |
| DELETE | `/-/token` | auth → revokes the presented token |
| GET | `/-/login/web?callback=http://127.0.0.1:PORT/…` | browser flow: OIDC redirect (Casdoor) or local login form; ends with `302 <callback>?token=…&user=…` |
| POST | `/-/login/web` | form fields `name, password, callback` |
| GET | `/-/login/web/callback` | OIDC redirect URI |

The first account created and the names in `ADMIN_USERS` get the `admin` role.

## Names
Filters are named `<namespace>:<package>` (Warg/`wkg` convention), e.g. `bevara:theora`.
A bare `theora` is resolved to `DEFAULT_NAMESPACE:theora`. Every account owns the
namespace of its username; the first publisher of an unknown namespace claims it;
only admins create packages in the default namespace. `:` must be percent-encoded
in paths (`/filters/bevara%3Atheora`), except in `/accessors/bevara:theora_1.wasm`.

## Signing keys
| Method | Path | Notes |
|---|---|---|
| PUT | `/-/keys` | auth, `{publicKey (Ed25519 SPKI DER, base64), label?}` → `{keyId}` (`sha256:` + 16 bytes of the key digest) |
| GET | `/-/keys` | auth → own keys |
| GET | `/-/keys/:keyId` | public: key + owner |
| DELETE | `/-/keys/:keyId` | revoke (existing log entries stay valid) |

## Transparency log
Every accepted publish appends `{seq, prevHash, hash, record, signature, keyId}` to a
hash chain: `hash = sha256(prevHash ‖ sha256(canonical(record)) ‖ signature)`, genesis
`prevHash = 0…0`. Publish records are signed by the publisher; `yank` / `deprecate`
records by the registry key. A **checkpoint** `{seq, head, timestamp, keyId}` is signed
by the registry key and returned with every publish, `/-/audit` and `/accessors/index.json`.
| Method | Path | Notes |
|---|---|---|
| GET | `/-/log?since=&limit=&name=` | entries after `since`, plus the current checkpoint |
| GET | `/-/log/checkpoint` | |
| GET | `/-/log/:seq` | entry + the digests needed to recompute the head from it (linear inclusion proof) |
| GET | `/-/log/keys/all` | every public key referenced by the log (publishers + registry) |

Publish record (canonical JSON, sorted keys):
```json
{"abi":1,"file":"theora_1.wasm","keyId":"sha256:…","name":"bevara:theora","tarballSha256":"…","timestamp":"…","type":"publish","version":"1.2.0","wasmSha256":"…"}
```
sent as `x-bevara-record` (base64) and `x-bevara-signature` (base64 Ed25519) headers on `PUT /filters/:name/:version`.
The registry checks the record against the uploaded bytes, the key against the token's user, then appends.

## Catalog
| Method | Path | Notes |
|---|---|---|
| GET | `/filters?q=&support=&format=&limit=&offset=` | list / search |
| GET | `/filters/:name` | packument: `dist-tags`, `versions{}`, `owners`, `time`, `advisories`, `deprecated` |
| GET | `/filters/:name/:version` | exact version, `latest`, or a semver range |
| GET | `/filters/:name/-/:name-:version.tgz` | tarball |
| GET | `/filters/:name/owners` | |

Each version document is the published manifest plus:
```json
"dist": { "file": "theora_1.wasm", "wasm": "…/accessors/theora/1.2.0/theora_1.wasm", "tarball": "…", "integrity": "sha256-…", "size": 36864, "brSize": 15360 },
"wasm": { "exports": ["…"], "imports": 12, "needed": [], "customSections": ["dylink.0", "name"] },
"publishedAt": "…", "publishedBy": "alice", "deprecated": null, "downloads": 42
```

## Publishing (auth)
| Method | Path | Notes |
|---|---|---|
| PUT | `/filters/:name/:version` | body = gzipped tarball (`Content-Type: application/gzip`). Validates manifest, name/version match, side-module check, ownership; `409` if the version exists, or if another package already provides the same accessor name (see below) |
| DELETE | `/filters/:name/:version` | unpublish one version (owner/admin) |
| DELETE | `/filters/:name` | unpublish everything (owner/admin) |
| POST | `/filters/:name/deprecate` | `{version?: range, message}` (empty message clears) |
| PUT/DELETE | `/filters/:name/owners/:user` | manage owners |

### Accessor-name uniqueness
The accessor name is the `.wasm` base name without its generation, lowercased (`theora_1.wasm`
→ `theora`). It belongs to the first package that publishes it, across all
namespaces; the reservation (table `accessor_names`) is checked before any file
is written and again inside the publishing transaction, and is released when
that package is deleted entirely. A refusal looks like:
```json
{ "error": "the accessor name \"theora\" is already taken by bevara:theora: …",
  "hint": "pick another name (or \"module\") for this accessor, or ask the owners of bevara:theora to add you: …" }
```
Error responses may carry a `hint`, which the CLI prints as is. Registries
created before the reservation existed fill it at start-up from what is
published; clashes already present are logged, and the first publisher keeps
the name.

## Audit
| Method | Path | Notes |
|---|---|---|
| POST | `/-/audit` | `{filters: {name: version}}` → per-filter latest/deprecation/integrity/signature/advisories + checkpoint |
| GET | `/-/advisories?names=a,b` | |
| POST | `/-/advisories` | admin: `{name, range, severity, title, url?}` |
| DELETE | `/-/advisories/:id` | admin |

## Accessors (for players, CORS `*`)
See PACKAGE_FORMAT.md — `/accessors/<name>_<abi>.wasm`, `/accessors/<name>/<version>/<file>`, `/accessors/index.json`, `/accessors/filter_list.json`.

## Runtimes (solvers)
A runtime is a package whose manifest says `"kind": "runtime"`: published with
the same `PUT /filters/:name/:version`, its tarball holds `package/<name>_<N>.wasm`
**and** `package/<name>_<N>.js`, and its signed record adds `jsSha256`. Its
version document has `dist.jsFile`, `dist.js`, `dist.jsIntegrity`;
`/accessors/<name>_<N>.js` and `/accessors/<name>/<version>/<name>_<N>.js` serve
the JavaScript. `/accessors/index.json` lists runtimes under `runtimes`
(`module`, `file`, `url`, `integrity`, `js`, `jsUrl`, `jsIntegrity`, `builtins`…),
not under `filters`.

Publishing a filter requires `"using"`, and at least one runtime it names
published here: otherwise `400` (`none of the runtimes in "using" … is
published`); the ones missing are returned as `warnings`.

## Tag scripts (kind "tags")
A tags package lists its scripts in `"tags"` (`["universal-img_1.js", …]`, one
generation); its tarball holds `package/<script>` for each, and its signed
record adds `tagsSha256: {script: sha256}`. Each script is served at
`/accessors/<script>` (found through the names the package reserved) and at
`/accessors/<name>/<version>/<script>`; the version document lists them in
`dist.files`; `/accessors/index.json` lists them under `tags` (`name`,
`version`, `file`, `url`, `integrity`, `size`). `"extends"` maps a script to
the tag it builds on.

## Patent status

Every package carries `patents: {status, note?, regions?, checked?}` (status:
`royalty-free`, `expired`, `licence-required`, `under-review`), returned by
`/filters`, `/accessors/index.json` (filters, runtimes, tags) and the version
documents. Every file served under `/accessors/` carries `X-Bevara-Patents:
<status>` (`undeclared` for packages published before the field) and, for the
two restricted statuses, `X-Bevara-Patents-Notice: <sentence for users>`;
both are exposed to cross-origin pages. Publishing a restricted status
succeeds with a warning saying what users will be told.

## Selection (no auth, CORS `*`)
Capability-driven selection (paper, Section 5; DESIGN.md D13): every accessor
whose declared inputs accept the query's, under side conditions.

| Method | Path | |
|---|---|---|
| POST | `/-/select` | body: the query as JSON |
| GET | `/-/select?query=<JSON>` | the same, URL-encoded |
| GET | `/-/select?pixfmt=rgba&maxpriority=50` | plain parameters: any other name is an input property; `output=PROP=VALUE`, `projectname`, `version`, `language`, `maxsize`, `license`, `geocode`, `filter` |

```json
{ "inputs": [{ "property": "GF_PROP_PID_PIXFMT", "format": "GF_PIXEL_RGBA" }],
  "version": "2.1", "IP": { "condition": false, "license": null, "geocode": null },
  "projectname": "ffmpeg", "language": "wasm", "size": { "condition": false, "maxsize": null },
  "maxpriority": 50 }
```

Properties and values take GPAC's names, with or without prefix
(`GF_PROP_PID_PIXFMT`, `PIXFMT`, `PixelFormat`; `GF_PIXEL_RGBA`, `rgba`).
`outputs` selects on what a module produces, run-time formats included.
`maxsize` is bytes or `"200kB"`, `"1.5MB"`.

Answer: `{ query, total, matches: [{ name, version, file, url, filter, priority,
size, brSize, projects, language, license, patents, using, accepts,
produces }], excluded: [{ name, filter, reason }], uncharacterised: [name] }` —
`matches` most preferred first (priority, then size); `excluded` fit the
capabilities but fail a side condition; `uncharacterised` were published
without `caps`. A malformed query is a `400` saying what is wrong.

## Usage statistics (administrators)
The registry counts, per day, package, version and kind of request, what it
serves (counts only: no address, no account). Channels: `tarball` (`bevara
install`), `accessor` (a pinned `/accessors/:name/:version/:file`),
`accessor-latest` (`/accessors/:file`, what pages load), `metadata`, `search`,
`index`, `filter-list`, `select`, `audit`, `publish`, `unpublish`, `deprecate`,
`login`. `HEAD` and failed requests are not counted. The per-version `downloads`
of the packument is the older all-time counter (every download channel, `HEAD` included).

| Method | Path | Notes |
|---|---|---|
| GET | `/-/admin/me` | admin → `{name, email, role}` |
| GET | `/-/admin/stats?days=30` | admin, 1–730 days → `{range, trackingSince, totals, period, daily[], channelsByKind, packages[], versions[], namespaces[], publishers[], activity[]}` |

| POST | `/-/stats/mcp` | the MCP server's usage report, with the shared token `STATS_INGEST_TOKEN` (404 when none is set): `{counts: [{day, event: "request"\|"tool", name, ext?, target?, source?, outcome?, client?, n}]}`, at most 2000 rows of the last 7 days, fields of at most 48 letters, digits or `. _ / -` space; one bad row refuses the batch. Counts add up; `/-/admin/stats` returns them as `mcp` |

The admin routes take a registry token of an administrator, or an OIDC access token (a JWT
from `OIDC_ISSUER`, checked against its JWKS) issued to one of the client ids in
`ADMIN_OIDC_AUDIENCES` for a person whose single-sign-on account is an
administrator's. The dashboard (https://dashboard.bevara.ddns.net, source
`~/project/registry-dashboard`) uses the latter.

## Misc
`GET /-/ping`, `GET /-/config`, `GET /` (web catalog).

## Configuration (environment)
| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `DATA_DIR` | `./data` | SQLite db + `store/` tree |
| `PUBLIC_URL` | derived from `Host` | absolute URLs in responses, OIDC redirect URI |
| `REGISTRY_NAME` | Bevara filter registry | |
| `ALLOW_SIGNUP` | `true` | `false` closes `POST /-/user` |
| `ADMIN_USERS` | | comma-separated admin usernames |
| `BOOTSTRAP_ADMIN_USER/PASSWORD` | | create an admin at startup if missing |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPE` | | single sign-on (Casdoor) |
| `STATS_INGEST_TOKEN` | | comma-separated tokens the MCP server presents to `POST /-/stats/mcp` (SDK: Secret `bevara-registry-stats`, made by `SDK/mcp/stats-token.sh`) |
| `ADMIN_OIDC_AUDIENCES` | | comma-separated OIDC client ids whose access tokens may read `/-/admin/*` (the dashboard's) |
| `MAX_TARBALL_BYTES` | 256 MiB | |
| `DEFAULT_NAMESPACE` | `bevara` | namespace for bare names |
| `REQUIRE_SIGNATURES` | `true` | `false` accepts unsigned publishes (not logged) |
