# Bevara filter manager

An package manager for **Bevara filters** 
(decoders, demuxers, encoders…) that the Bevara solver links at run time to play
formats a browser does not support natively.

```
packages/cli        the `bevara` command-line tool
packages/registry   self-hosted registry (Node 22+, SQLite, no native deps)
deploy/k8s          manifests for the Bevara microk8s cluster
docs/               package format and HTTP API
```

## Quick start (CLI)

```bash
npm install -g ./packages/cli          # or: npx --prefix packages/cli bevara
bevara config set registry https://registry.bevara.ddns.net
bevara login                           # browser SSO through Casdoor, or --password
```

### Publish a filter

```bash
bevara init                 # scaffolds bevara.json, CMakeLists.txt, src/<name>.c (GPAC skeleton)
export GPAC_DIR=…/gpac      # GPAC headers of the solver's version
bevara build                # emcmake cmake -S . -B build && cmake --build build
bevara publish              # validates the side module, uploads theora_1.wasm + manifest
```

Any existing accessor from the [filters](https://github.com/Bevara/filters) repository
can be published as-is: drop a `bevara.json` next to it (its `theora.json` already
has most fields) with `"main": "build/theora_1.wasm"`.

### Use filters on a web site

```bash
cd my-site
bevara install theora ogg vorbis       # -> accessors/theora_1.wasm …, bevara.json, bevara-lock.json
bevara list                            # prints the with="…" attribute to paste
bevara audit                           # integrity, advisories, deprecations, licences
bevara update                          # within the semver ranges; --latest to cross majors
```

```html
<video is="universal-video_1" src="movie.ogv" using="solver_1" with="ogg_1;vorbis_1;theora_1" controls></video>
```

Sites can also skip the install step and point the player's script directory at the
registry: `https://registry.bevara.ddns.net/accessors/` serves `<name>_<abi>.wasm`
directly (newest non-deprecated version, brotli, CORS).

### All commands

| Command | Purpose |
|---|---|
| `bevara init [dir]` | new filter project (`--site` for a consumer project) |
| `bevara install [f[@range]…]` | resolve + download into `accessors/`, update `bevara.json` / lockfile |
| `bevara uninstall <f…>` | remove filters |
| `bevara update [f…]` | newest versions in range (`--latest` ignores ranges) |
| `bevara outdated` | current / wanted / latest table |
| `bevara audit [--fix]` | integrity vs lockfile & registry, module validity, advisories, deprecations, outdated, licence flags; exit 1 on findings (`--audit-level`) |
| `bevara list [--remote]` | installed filters, or the registry catalog |
| `bevara search <q>` / `bevara info <f>` | catalog queries |
| `bevara build` / `pack` / `publish` | build with Emscripten, tarball, upload |
| `bevara unpublish` / `deprecate` / `owner` | maintain published filters |
| `bevara advisory add/rm/ls` | admin: advisories surfaced by `audit` |
| `bevara login` / `logout` / `whoami` / `adduser` | accounts (SSO or local) |
| `bevara config` / `ping` | registry URL, connectivity |

Registry precedence: `-r/--registry` > `BEVARA_REGISTRY` > `"registry"` in `bevara.json` > `~/.bevararc` > default.
Non-interactive use: `BEVARA_TOKEN`, `BEVARA_PASSWORD`, `-y`, `--json`.

## Running the registry

```bash
npm install
DATA_DIR=./data PORT=8080 npm run registry         # http://localhost:8080  (web catalog at /)
```

Docker: `docker build -t bevara-registry packages/registry`, mount `/data`.
See [docs/REGISTRY_API.md](docs/REGISTRY_API.md) for the environment variables
(`PUBLIC_URL`, `ALLOW_SIGNUP`, `ADMIN_USERS`, `OIDC_*`, …).

### Kubernetes (Bevara cluster)

```bash
deploy/k8s/build.sh 1.0.0                 # docker build + push to 192.168.1.120:32000
cp deploy/k8s/secret.example.yaml deploy/k8s/secret.yaml   # admin password, Casdoor client
deploy/k8s/apply.sh                       # PVC + Deployment + Service + Ingress (registry.bevara.ddns.net)
```

The same manifests are mirrored in the `SDK/registry/` folder of the cluster repository.

Single sign-on: create an application in Casdoor (`https://bevara-auth.ddns.net`)
with redirect URL `https://registry.bevara.ddns.net/-/login/web/callback`, put its
client id/secret in the Secret. `bevara login` then opens the browser, Casdoor
authenticates, and the registry hands a token back to the CLI on `127.0.0.1`.
Without OIDC the same flow shows the registry's own login form; `bevara login --password`
works in both modes for local accounts.

## Development

```bash
npm test          # registry (node:test, in-memory SQLite) + CLI unit tests
npm run e2e       # boots a registry and drives it with the CLI end to end
```

`packages/registry/test/fixtures/dummy_1.wasm` is a real Emscripten side module
(built from a 6-line C file) used to exercise the side-module validation.
