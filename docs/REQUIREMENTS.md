# Requirements

What `bevara` and its registry must do, as asked by the project owner. Each
requirement says where it is implemented and what checks it, so a change that
breaks one is caught by a test rather than by a user.

**Maintaining this file.** When a new requirement is expressed, add it here
with the date, then the code, then the test that holds it. When one is
dropped or changed, edit it here in the same change — never leave this file
describing behaviour the code no longer has. Design choices made *to meet*
these requirements, and the alternatives rejected, are in
[DESIGN.md](DESIGN.md).

| ID | Requirement | Since |
|---|---|---|
| [R1](#r1) | An npm-like tool to manage filters, open to external contributions | 2026-09-20 |
| [R2](#r2) | The registry runs on the Bevara Kubernetes cluster | 2026-09-20 |
| [R3](#r3) | Publications are signed and recorded in a verifiable log | 2026-09-21 |
| [R4](#r4) | Package names are namespaced | 2026-09-21 |
| [R5](#r5) | The CLI is published publicly on npm | 2026-10-05 |
| [R6](#r6) | `probe` identifies a file and the accessors it needs | 2026-10-05 |
| [R7](#r7) | `update-page` converts a page to the universal tags | 2026-10-06 |
| [R8](#r8) | `test` checks a filter combination, `bench` measures it | 2026-10-06 |
| [R9](#r9) | The CLI can be run and debugged in VS Code | 2026-10-06 |
| [R10](#r10) | Error messages are explicit | 2026-10-06 |
| [R11](#r11) | The default registry is registry.bevara.ddns.net | 2026-10-06 |
| [R12](#r12) | A filter repository keeps a single manifest, `<name>.json` | 2026-10-06 |
| [R13](#r13) | A registry never accepts two packages with the same accessor name | 2026-10-06 |
| [R14](#r14) | Requirements and design choices are documented in the repository | 2026-10-06 |
| [R15](#r15) | `publish --build` can be pointed at a repository and a build directory | 2026-10-06 |
| [R16](#r16) | No version in the manifest: it is the generation, already in CMake and the file name | 2026-10-07 |
| [R17](#r17) | The licence is stated once, in a LICENCE file, never in the manifest | 2026-10-07 |
| [R18](#r18) | `--build` builds under `.bevara/` by default, which repositories ignore in git | 2026-10-07 |
| [R19](#r19) | Anyone reads the registry without an account; any authenticated account publishes filters | 2026-10-08 |
| [R20](#r20) | Accessors are selected by capability, priority, size, licence, project — the paper's query | 2026-10-10 |
| [R21](#r21) | `update-page --write` also puts the scripts, the solver and the accessors where the page loads them | 2026-10-15 |
| [R22](#r22) | Runtimes (solvers) are packages any authenticated account publishes from their source directories | 2026-10-15 |
| [R23](#r23) | A filter must name its runtimes in "using", and at least one must be published on the registry | 2026-10-15 |
| [R24](#r24) | Every combination proposed for a file shares a runtime; `list` shows the runtimes | 2026-10-15 |

---

### R1
**An npm-like tool to manage filters, open to external contributions.**
The commands mirror npm: `init` (new filter), `install`, `update`, `audit`,
`publish`, `login`, `list`, plus `uninstall`, `outdated`, `search`, `info`,
`build`, `pack`, `unpublish`, `deprecate`, `owner`, `whoami`, `adduser`,
`config`, `ping`. Anyone with an account can publish; ownership is per package.

- Where: `packages/cli/src/commands/`, `packages/registry/src/app.js`
- Checked by: `scripts/e2e.sh` (every command against a live registry), `packages/*/test/`

### R2
**The registry runs on the Bevara Kubernetes cluster**, next to the other
services of `~/project/SDK`: same local image registry (`192.168.1.120:32000`),
same ingress and cert-manager issuer, same Casdoor for single sign-on.

- Where: `deploy/k8s/` (mirrored in `SDK/registry/`), `packages/registry/Dockerfile`
- Checked by: manifests validated as YAML; the image itself has not been built yet (Docker was not running) — see DESIGN.md, known limitations

### R3
**Publications are signed and recorded in a verifiable log**, so that a site
can trust an accessor without trusting the registry: Ed25519 signature by the
publisher over the published bytes, append-only hash-chained log, registry-signed
checkpoints pinned by each project and extended on every `audit`.

- Where: `packages/cli/src/lib/sig.js`, `logcheck.js`, `commands/{publish,audit,log,key}.js`; `packages/registry/src/ledger.js`
- Checked by: `registry.test.js` (tampered records, foreign/revoked keys, chain verification), `cli/test/lib.test.js`, e2e step "a rewritten log is detected"

### R4
**Package names are namespaced** (`bevara:theora`), following the Warg/wkg
convention so packages stay addressable if mirrored to a component registry.
The default namespace `bevara` is open to every authenticated account (R19);
every account owns the namespace of its user name.

- Where: `manifest.js` (`NAME_RE`, `fullName`), registry publish route
- Checked by: `registry.test.js` "namespaces…", e2e step "namespaces"

### R5
**The CLI is published publicly on npm** as `@bevara/cli` (a scoped package is
private by default on npm, which requires a paid plan).

- Where: `packages/cli/package.json` (`"publishConfig": { "access": "public" }`)
- Checked by: `npm pack --dry-run -w @bevara/cli`; publishing needs the `@bevara` npm organisation to exist

### R6
**`bevara probe` tests a file and identifies the right accessors**, from its
content rather than its extension: container and elementary streams, then the
accessors needed, checked against the registry.

- Where: `cli/src/lib/sniff.js`, `formats.js`, `commands/probe.js`
- Checked by: `cli/test/sniff.test.js` (synthetic containers + the Showcase corpus when present)

### R7
**`bevara update-page` converts an HTML page to the universal tags**, choosing
the pipeline from the file each `src` points to:
`<img src="photo.jxl">` → `<img is="universal-img_1" src="photo.jxl" using="solver_minimal_1" with="libjxl_1">`.
`using` names the main module (the solver), `with` the accessors.

- Where: `cli/src/lib/html.js`, `commands/update-page.js`
- Checked by: `cli/test/html.test.js`, e2e step "update-page" (including idempotence)

### R8
**`bevara test` checks whether a filter combination works on a file, and
`bevara bench` measures its decoding performance**, by running the real
pipeline (solver + accessors as side modules), not a simulation.

- Where: `cli/src/lib/run-session.cjs`, `runner.js`, `commands/{test,bench}.js`
- Checked by: `cli/test/runner.test.js`, including two real-pipeline tests that run when the solver is available

### R9
**The CLI can be run and debugged in VS Code**, including the child processes
that `test` and `bench` start, without touching the user's real credentials.

- Where: `.vscode/launch.json`, `.vscode/tasks.json`, README "In VS Code"

### R10
**Error messages are explicit.** A failure says what happened in the user's
terms, where (method and URL), and what to do — never a bare `HTTP 503`.

- Where: `cli/src/lib/registry-client.js` (`describeHttpFailure`, `describeNetworkFailure`), `src/index.js` (printing)
- Checked by: `cli/test/registry-client.test.js`

### R11
**The default registry is `https://registry.bevara.ddns.net`**, with nothing
to configure. Other registries are opt-in (`-r`, `BEVARA_REGISTRY`, project
manifest, `bevara config set registry`), and `bevara config get registry` says
which one is in use and why.

- Where: `cli/src/lib/config.js` (`DEFAULT_REGISTRY`, `resolveRegistrySource`)
- Checked by: `cli/test/config.test.js`

### R12
**A filter repository keeps a single manifest, `<name>.json`** (e.g.
`libjxl.json`) — the file its CMake build reads into `filter_list.json` and the
editor ships. No second `bevara.json` alongside it. An existing repository is
published without adding anything to that file (a `"license"` is recommended),
and the CLI never reformats it when it writes into it. `bevara.json` remains the
manifest of a *site*, which has no filter name.

- Where: `cli/src/lib/project.js` (discovery, `updateJsonText`), `manifest.js` (`fromLegacy`), `pack.js`, `commands/init.js`
- Checked by: `cli/test/project.test.js`, e2e step "a filter repository publishes from its own <name>.json"

### R13
**A registry never accepts two packages with the same accessor name.** The
accessor name is what a page loads (`theora_1.wasm` → `theora`); it is unique
across namespaces, generations and letter case.

- Where: `registry/src/db.js` (`accessor_names`), publish route in `registry/src/app.js`
- Checked by: `registry.test.js` "an accessor name belongs to one package…", "registry opened on an older database"

### R14
**Requirements and important design choices are documented in the
repository**: this file and [DESIGN.md](DESIGN.md).

### R15
**`bevara publish --build` can be told which repository to publish and which
build directory to use**, without changing directory:
`bevara publish ../libjxl --build -B out`. The same applies to `build` and `pack`.

- Where: `Project.load({ dir })` in `cli/src/lib/project.js`; `buildDir` in `cli/src/lib/pack.js`; `commands/{publish,pack,build}.js`
- Checked by: `cli/test/project.test.js` "naming the project and the build directory", e2e step "a filter repository publishes from its own <name>.json"

### R16
**A filter manifest needs no `"version"`.** The `_1` of `libjxl_1.wasm` is the
module generation (the paper: "incremented as modifications are made to the
module"), already given by `add_filter(… "1")` in CMakeLists.txt and by the file
name. Generation `N` is published as version `N.0.0`. An explicit `"version"`
stays possible, for releases within a generation.

- Where: `cli/src/lib/cmake.js`, `filterManifest` in `cli/src/lib/pack.js`
- Checked by: `cli/test/cmake.test.js`, e2e step "a filter repository publishes from its own <name>.json"

### R17
**The licence of a filter lives in a `LICENCE` file at the root of its
repository, not in `<name>.json`.** The CLI reads it when publishing and sends it
to the registry as the package's licence, so the information exists once. The
file travels inside the published package, as the licences require.

- Where: `cli/src/lib/license.js`; `filterManifest` and `ALWAYS_INCLUDE` in `cli/src/lib/pack.js`; `commands/init.js` writes `LICENCE`
- Checked by: `cli/test/license.test.js`, e2e step "a filter repository publishes from its own <name>.json" (licence shown by `info`, `LICENCE` present in the tarball)

### R18
**`bevara publish --build` (and `bevara build`) build under `.bevara/` by
default**, the directory filter repositories already ignore in git, so a build
leaves `git status` clean. `-B` still chooses another directory.

- Where: `DEFAULT_BUILD_DIR` and `checkArtifact` in `cli/src/lib/pack.js`; template `.gitignore`
- Checked by: `cli/test/project.test.js` (default command, lookup order, `-B`), e2e

### R19
**The registry is readable by everyone without an account, and every
authenticated account can publish filters.** Browsing, searching, installing,
downloading accessors, reading the log and auditing need no login. Publishing
needs one, and nothing more: a bare name publishes in the default namespace,
whoever the account is. Supersedes the earlier rule that reserved the default
namespace to administrators (R4).

What authentication still protects: a package, once published, takes new
versions from its owners only (and administrators), and a personal namespace
belongs to its account — otherwise any account could replace an accessor that
pages already load.

- Where: publish route in `registry/src/app.js` (reads never call `requireAuth`)
- Checked by: `registry.test.js` "reading needs no account; publishing needs one, and nothing else", "namespaces: the default one is open to any account…", e2e step "namespaces"

### R20
**The registry answers the capability query of the paper** (MMSys, Section 5,
"the full library"): not a named module, but every accessor whose declared
inputs accept the current output, under side conditions —

```yaml
inputs:
  - property: GF_PROP_PID_PIXFMT
    format:   GF_PIXEL_RGBA
version:     2.1
IP:          { condition: false, license: , geocode: }
projectname: "ffmpeg"
language:    "wasm"
size:        { condition: false, maxsize: }
maxpriority: 50
```

The information is read from the filters themselves: the capability bundles
and `.priority` of each GPAC register, from the C source. What the source
decides only at run time — the pixel or audio format a decoder sets on its
output — and cannot be read from it is declared in `<name>.json` under
`"runtime"`; `bevara caps --write` proposes it from the code.

- Where: `cli/src/lib/caps.js` (extraction), `filterManifest` in `cli/src/lib/pack.js`
  (published as `caps`, `projects`, `language`), `cli/src/lib/select.js` = `registry/src/select.js`
  (matching), `GET|POST /-/select` in `registry/src/app.js`, commands `caps` and `select`
- Checked by: `cli/test/caps.test.js`, `cli/test/select.test.js` (the query pasted from
  the paper; the two copies of select.js are identical), `registry.test.js` "selection by capability"

### R21
**`bevara update-page --write` leaves a working page**: besides the HTML, it
writes the files the page then loads — the `universal-*_N.js` scripts its
`<script>` tags name, the solver of `using="…"` (`.js` and `.wasm`) and the
accessors of `with="…"` — where the player looks for them: next to the page,
the scripts under `--scripts`. Accessors come from the registry and are checked
against its integrity hash; scripts and solvers from the registry's runtime
files, or from local directories (`--runtime`). A file already there that
differs is kept unless `--refresh`.

- Where: `cli/src/lib/page-files.js`, `cli/src/commands/update-page.js`
- Checked by: `cli/test/page-files.test.js`; by hand, test-jxl/index.html decodes in Chromium with what it wrote

### R22
**Runtimes are packages, published by any authenticated account from their
source directories.** A solver directory (`Editor/Interface/player/solver`,
`solver_minimal`) holds a `<name>.json` with `"kind": "runtime"`, a LICENCE and
a CMakeLists.txt that builds on its own; `bevara publish --build` there builds
`<name>_<N>.js` and `.wasm`, derives the version from `set(VERSION "N")`, the
licence from LICENCE and the built-in filters from `loader.js`, and publishes
both files, signed and logged. As for filters, the first publisher owns the
name and only owners publish new versions; runtime names are accessor names,
unique registry-wide. The registry serves them under `/accessors/` and lists
them in `/accessors/index.json` under `runtimes`.

- Where: `filterManifest`/`checkArtifact`/`packFilter` in `cli/src/lib/pack.js`, `readExecutables` in
  `cli/src/lib/cmake.js`, `runtimeBuiltins` in `cli/src/lib/caps.js`; publish and `/accessors/*` in `registry/src/app.js`
- Checked by: `registry.test.js` "runtimes (solvers) as packages", `cli/test/page-files.test.js` "a runtime…",
  e2e step "publish the runtime solver_1"; by hand, both solvers built alone are byte-identical to the player's build

### R23
**A filter names the runtimes it links against in `"using"`, and at least one
of them must be published on the registry.** A filter without `"using"` (or
with an empty one) is refused, by the CLI and by the registry; one whose
runtimes are all missing is refused, with the runtimes to publish first; one
with at least one published runtime is accepted, the others reported as
warnings. A registry may carry several runtimes, one per environment.
`bevara init` asks for them (default `solver_1`).

- Where: `validateManifest` (shared), the publish route in `registry/src/app.js`, the pre-build check in `cli/src/commands/publish.js`
- Checked by: `registry.test.js` "a filter cannot be published before the runtime…", "then the filter publishes…",
  `cli/test/page-files.test.js` "a filter must name its runtimes", e2e; every filter repository declares it (libmidi was added)

### R24
**Every combination of filters proposed for a file links against one common
runtime**, published on the registry: a page loads a single solver. `probe`
and `update-page` choose the solver among the runtimes the registry publishes
and every chosen accessor declares; accessors that agree on a runtime the
registry lacks, or a registry with no runtime at all, are reported as such
(not as a conflict), and an accessor without `"using"` is flagged. `test` and
`bench` refuse a combination (automatic or `-W`) whose installed accessors
share no runtime, and run it with one they share (`--solver` must be one).
`bevara list` shows each filter's runtimes - in red when the registry does not
publish them - and the published runtimes with their built-in filters; in a
site, each installed filter's runtimes and the `using="…"` they all share.

- Where: `resolvePipeline`, `solverOrder`, `commonRuntimes` in `cli/src/lib/capabilities.js`;
  `solverForCombination` in `cli/src/lib/runner.js`; `cli/src/commands/list.js`
- Checked by: `cli/test/capabilities.test.js` "a combination shares a runtime"

