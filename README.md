# Bevara filter manager

An package manager for **Bevara filters** 
(decoders, demuxers, encoders…) that the Bevara solver links at run time to play
formats a browser does not support natively.

```
packages/cli        the `bevara` command-line tool
packages/registry   self-hosted registry (Node 22+, SQLite, no native deps)
deploy/k8s          manifests for the Bevara microk8s cluster
docs/               requirements, design decisions, package format, HTTP API
```

[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) lists what the tool must do and
[docs/DESIGN.md](docs/DESIGN.md) why it is built the way it is; read both before
changing behaviour.

## Quick start (CLI)

```bash
npm install -g ./packages/cli          # or: npx --prefix packages/cli bevara
bevara login                           # browser SSO through Casdoor, or --password
```

The CLI talks to **https://registry.bevara.ddns.net** out of the box. To use
another registry, for one command or for good:

```bash
bevara filters -r http://127.0.0.1:8080          # one command (a bare host works too)
bevara config set registry http://127.0.0.1:8080
bevara config get registry                    # the registry in use, and where that comes from
bevara config unset registry                  # back to registry.bevara.ddns.net
```

### Check that a combination actually decodes

```bash
bevara test clip.mp4
bevara test clip.mp4 -W "isobmff_1;h264bsd_1" -W "isobmff_1;libde265_1"
bevara bench clip.mp4 -n 5 -W "isobmff_1;h264bsd_1" -W "isobmff_1;ffmpeg-h26x_1"
```

```
✔ testcard.mp4 h264 · isobmff_1;h264bsd_1
  solver solver_1 · graph:
    fin (src=input.mp4) (idx=1)
    -(PID input.mp4) mp4dmx (dyn_idx=3)
    --(PID input.mp4) h264bsd (dyn_idx=4)
    ---(PID input.mp4) writegen (dyn_idx=5)
    ----(PID input.mp4) fout (dst=output.yuv) (idx=2)
    h264bsd  50 pkt  48 kB  10.4 ms  4787 pck/s · 37.9 mbps
```

These run the **real** pipeline: the solver is instantiated, the accessors are
linked as side modules, their constructors self-register, and GPAC resolves the
graph from the file's capabilities exactly as in a page — the sink is a raw file
instead of a browser surface. A graph that resolves but decodes nothing is
reported as a failure, which is what makes `test` worth running in CI.

`bench` separates the costs: linking the modules, the decoder's own process time
(GPAC accounts for it per filter) and the wall clock of the session, with the
median over `-n` runs and one process per run.

Both need the player's distribution — the solver (`solver_1.js`/`.wasm`) next to
the accessors — because the registry distributes accessors, not the solver. Point
`--accessors <dir>` at it, or keep it in the project's accessors directory.

### Publish a filter

A filter repository keeps a single manifest, `<name>.json` — the file its CMake
build already reads — and publishes as it is. The version is the module
generation: the `_1` of `libjxl_1.wasm`, set by `add_filter(… "1")` in
CMakeLists.txt, is published as `1.0.0`. To publish a changed module, increment
that generation.

```bash
git clone https://github.com/Bevara/libjxl.git && cd libjxl
bevara publish --build      # builds .bevara/.build/libjxl_1.wasm, publishes bevara:libjxl@1.0.0
```

The licence is read from the repository's `LICENCE` file (an
`SPDX-License-Identifier:` line makes it exact) and shipped with the module; it
is never written in the manifest.

From anywhere, and with another build directory:

```bash
bevara publish ~/project/libjxl --build -B out    # builds into libjxl/out/ instead of .bevara/.build/
bevara publish ~/project/libjxl -B out            # already built: publishes out/libjxl_1.wasm
```

A new filter starts from `bevara init`, which scaffolds `<name>.json`,
`CMakeLists.txt` and a GPAC filter skeleton in `src/<name>.c`:

```bash
bevara init                 # asks for the name, the GPAC filter names, the formats…
export GPAC_DIR=…/gpac      # GPAC headers of the solver's version
bevara build                # emcmake cmake -S . -B .bevara/.build && cmake --build .bevara/.build
bevara publish
```

Anyone can browse and install without an account. Any authenticated account can
publish: a bare name goes to the default namespace (`bevara:`) and makes you the
owner of that package; only its owners publish new versions of it afterwards.
Accessor names are unique on a registry: once `bevara:theora` provides
`theora_1.wasm`, no other package can (see [docs/PACKAGE_FORMAT.md](docs/PACKAGE_FORMAT.md)).

### Find out what a file needs

```bash
bevara probe movie.mkv
#   format       h264 (video/mp4)
#   container    matroska
#   browsers     decoded natively by at least one engine; the pipeline is the fallback
#   streams      video h264 (V_MPEG4/ISO/AVC) · audio aac (A_AAC) · text srt
#   pipeline     using="solver_1" with="webmdmx_1;h264bsd_1;libfaad_1;isobmff_1;libx264_1;libopusenc_1"
#   accessors    ✓ all six published on the registry
bevara probe https://example.org/clip.mp4 --json
bevara probe movie.mkv --install        # install exactly the accessors it needs
```

`probe` identifies the file with MediaInfo (mediainfo.js), as the editor does:
the container and each track get MediaInfo's format name (`Ogg`, `Theora`,
`JPEG 2000`, `AVC`…), and MediaInfo reads only the chunks it needs — over HTTP
range requests for a URL. The accessors are then chosen among those the registry
carries, by the editor's rule: a track whose `Format` is in an accessor's
`"Format"` list, or the file when its extension is one of the accessor's
`"extension"` keys (what MediaInfo does not recognise, such as JPEG XL). A
container or stream nobody has published an accessor for is reported as missing,
never filled with a module name the registry does not have. `--offline` prints
the built-in suggestion instead.

### Convert an existing page

```bash
bevara update-page index.html           # shows the diff, writes nothing
bevara update-page index.html --write --install
```

```diff
-  <img src="photo.jxl" alt="Photo">
+  <img src="photo.jxl" alt="Photo" is="universal-img_1" using="solver_minimal_1" with="libjxl_1">
-  <video src="trailer.ogv" controls></video>
+  <video src="trailer.ogv" controls is="universal-video_1" using="solver_1" with="ogg_1;theora_1;vorbis_1;isobmff_1;libx264_1;libopusenc_1"></video>
+  <script src="scripts/universal-img_1.js"></script>
+  <script src="scripts/universal-video_1.js"></script>
```

Each `src` is probed, so the `with` list matches what the file actually holds.
The rewrite is surgical: attributes are spliced into the original bytes, so
quoting, indentation, comments and inline scripts are untouched, and running it
twice changes nothing. `--non-native` converts only the formats no engine
decodes, `--attrs "progressive use-worker"` adds the pipeline options, and
`--install` fetches the accessors the page ends up requiring.

### Use filters on a web site

```bash
cd my-site
bevara install theora ogg vorbis       # -> accessors/theora_1.wasm …, bevara.json, bevara-lock.json
bevara filters                         # prints the with="…" and using="…" attributes to paste
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
| `bevara filters [--remote]` | installed filters, or the registry catalog (alias `list`) |
| `bevara runtimes [--remote]` | installed runtimes (solvers), or those the registry publishes |
| `bevara tags [--remote]` | installed tag scripts, or the tags packages the registry publishes |
| `bevara probe <file\|url>` | identify a media file (container, streams, codecs) and the accessors it needs |
| `bevara update-page <file.html>` | rewrite a page so its media elements use the universal tags |
| `bevara search <q>` / `bevara info <f>` | catalog queries |
| `bevara test <file>` | run a real pipeline on a file and report whether it decodes |
| `bevara bench <file>` | measure decoding performance, compare combinations |
| `bevara build` / `pack` / `publish` `[dir]` | build with Emscripten, tarball, upload (`-B <dir>` for the build directory) |
| `bevara unpublish` / `deprecate` / `owner` | maintain published filters |
| `bevara advisory add/rm/ls` | admin: advisories surfaced by `audit` |
| `bevara key generate/ls/revoke` | Ed25519 key that signs your publishes (created automatically) |
| `bevara log [--verify]` | read or fully verify the registry's append-only log |
| `bevara namespace ls/add/rm` | namespaces (`bevara:theora`, `alice:myfilter`) and their owners |
| `bevara login` / `logout` / `whoami` / `adduser` | accounts (SSO or local) |
| `bevara config` / `ping` | registry URL, connectivity |

**Supply-chain integrity.** Every publish is signed (Ed25519) by the publisher and appended
to a hash-chained, append-only log whose head the registry signs (a *checkpoint*).
`bevara install` verifies the signature over the downloaded bytes; `bevara audit` extends
the checkpoint pinned in `bevara-lock.json`, so a registry that rewrites or drops history
is detected by every project that audited it before (see `docs/REGISTRY_API.md`).

Registry precedence: `-r/--registry` > `BEVARA_REGISTRY` > `"registry"` in the project manifest > `~/.bevararc` > default.
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
deploy/k8s/build.sh                       # docker build + push to 192.168.1.120:32000, tagged with the
                                          # version in packages/registry/package.json (registry.yaml uses it)
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

### In VS Code

`.vscode/launch.json` ships the configurations; open the Run and Debug panel
(⇧⌘D) and pick one:

| Configuration | What it does |
|---|---|
| `bevara <args…>` | prompts for the arguments and the working directory, then runs the CLI with breakpoints, against the default registry |
| `bevara <args…> (local registry)` | the same against `http://127.0.0.1:8080` |
| `bevara probe/update-page/test (current file)` | runs that command on the file open in the editor |
| `registry (localhost:8080)` | the registry, with a debug admin (`admin` / `debugdebug`) |
| `registry + bevara <args…> (local registry)` | both at once (compound) |
| `tests: all` / `tests: current file` / `…test under the cursor` | `node --test`, debuggable |
| `e2e (registry + CLI)` | the end-to-end script |

Two details that matter:

- **Child processes.** `bevara test` and `bevara bench` run each pipeline in a
  child process (`src/lib/run-session.cjs`), so breakpoints there are only hit
  because the configurations set `autoAttachChildProcesses`. Keep it if you add
  your own.
- **Your real credentials are left alone.** Every CLI configuration points
  `BEVARA_CONFIG` at `.vscode/debug-bevararc`, so debugging never writes tokens
  or signing keys into `~/.bevararc`. The debug registry stores its data under
  `.vscode/debug-registry-data/`. Both are git-ignored.

Tasks (⇧⌘P → *Tasks: Run Task*) cover the rest: `tests`, `tests (watch CLI)`,
`e2e`, starting the registry, logging in as the debug admin, seeding it with a
directory of built accessors, and `npm link` to put `bevara` on your PATH.

Without a launch configuration, the quickest loop is the **JavaScript Debug
Terminal** (⇧⌘P → *Debug: JavaScript Debug Terminal*): breakpoints apply to
anything you start from it, child processes included.

```bash
node packages/cli/bin/bevara.js probe ../Showcase/test_sequences/trailer_1080p.ogg
```

To test the CLI the way a user runs it, link it once:

```bash
npm link -w @bevara/cli     # then `bevara …` anywhere; `npm unlink -g @bevara/cli` to undo
```

A scratch project to try `install` / `update-page` / `test` against is three lines:

```bash
mkdir -p /tmp/site && cd /tmp/site && echo '{"name":"scratch","dependencies":{}}' > bevara.json
BEVARA_REGISTRY=http://127.0.0.1:8080 bevara install theora
```

`packages/registry/test/fixtures/dummy_1.wasm` is a real Emscripten side module
(built from a 6-line C file) used to exercise the side-module validation.
