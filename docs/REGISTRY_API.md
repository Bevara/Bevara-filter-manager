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
| PUT | `/filters/:name/:version` | body = gzipped tarball (`Content-Type: application/gzip`). Validates manifest, name/version match, side-module check, ownership; 409 if the version exists |
| DELETE | `/filters/:name/:version` | unpublish one version (owner/admin) |
| DELETE | `/filters/:name` | unpublish everything (owner/admin) |
| POST | `/filters/:name/deprecate` | `{version?: range, message}` (empty message clears) |
| PUT/DELETE | `/filters/:name/owners/:user` | manage owners |

## Audit
| Method | Path | Notes |
|---|---|---|
| POST | `/-/audit` | `{filters: {name: version}}` → per-filter latest/deprecation/integrity/advisories |
| GET | `/-/advisories?names=a,b` | |
| POST | `/-/advisories` | admin: `{name, range, severity, title, url?}` |
| DELETE | `/-/advisories/:id` | admin |

## Accessors (for players, CORS `*`)
See PACKAGE_FORMAT.md — `/accessors/<name>_<abi>.wasm`, `/accessors/<name>/<version>/<file>`, `/accessors/index.json`, `/accessors/filter_list.json`.

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
| `MAX_TARBALL_BYTES` | 256 MiB | |
