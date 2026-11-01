# Design decisions

Why `bevara` and its registry are built the way they are. Each entry states the
decision, the reasons, the alternatives that were rejected, and what follows
from it. The requirements these decisions serve are in
[REQUIREMENTS.md](REQUIREMENTS.md).

**Maintaining this file.** A change that reverses or bends one of these
decisions updates its entry in the same change, with the new reason. A new
decision that future work could plausibly undo by accident — a format, a
naming rule, an invariant — gets an entry.

Contents
1. [What an accessor is, and how it is named](#1-what-an-accessor-is-and-how-it-is-named)
2. [The manifest](#2-the-manifest)
3. [Names, namespaces and ownership](#3-names-namespaces-and-ownership)
4. [Trust: signatures and the transparency log](#4-trust-signatures-and-the-transparency-log)
5. [Installing: resolution and the lockfile](#5-installing-resolution-and-the-lockfile)
6. [The registry server](#6-the-registry-server)
7. [Delivery to browsers](#7-delivery-to-browsers)
8. [Identifying media: probe](#8-identifying-media-probe)
9. [Rewriting pages: update-page](#9-rewriting-pages-update-page)
10. [Running real pipelines: test and bench](#10-running-real-pipelines-test-and-bench)
11. [The CLI: configuration, errors, dependencies](#11-the-cli-configuration-errors-dependencies)
12. [Relation to WAPM and Warg](#12-relation-to-wapm-and-warg)
13. [Known limitations](#13-known-limitations)

---

## 1. What an accessor is, and how it is named

**D1.1 — An accessor is an Emscripten side module, and the registry checks it.**
A published `.wasm` must be a valid WebAssembly binary carrying a `dylink.0`
(or `dylink`) custom section. Anything else is refused at publish time.
- *Why*: the solver links accessors with `dlopen()` into its own memory and
  function table. A module linked as a standalone program compiles fine but can
  never be loaded; catching that at publish time is cheap, at page load it is not.
- *Rejected*: storing opaque blobs as general-purpose registries do.
- *Consequences*: the registry parses every module (`wasm.js`); its exports are
  kept and shown by `bevara info`.

**D1.2 — The file name is the contract with the player: `<module>_<N>.wasm`.**
Pages name accessors in the `with` attribute (`with="theora_1"`), and the loader
resolves that to `theora_1.wasm`. Everything that installs or serves accessors
preserves exactly that name.
- *`N` is the module generation*, as the MMSys paper defines it: it "denotes a
  module generation and is appropriately incremented as modifications are made
  to the module". It is the last argument of `add_filter()` in the repository's
  CMakeLists.txt. The manifest field that holds it is called `abi` for
  historical reasons; it is not a separate ABI number.
- *Correction.* An earlier version of this document called `N` an ABI distinct
  from the version and required a `"version"` in every manifest. That
  duplicated information the repositories already carry; see D2.7.
- *`module` exists for case.* Package names are lowercase; a file need not be
  (`libOpenVVC_1.wasm`). `module` carries the exact base name and must equal the
  package name up to case. The lowercase spelling is not served as an alias, so
  a page always asks for the file under its published name.

## 2. The manifest

**D2.1 — A filter repository has one manifest, `<name>.json`.**
The CLI recognises as the manifest the `X.json` whose `"name"` is `X` and which
declares `filters`, searching the current directory and its parents.
- *Why*: that file already exists in every filter repository and is consumed
  twice — by the repository's CMake (`file(READ ${FILTERNAME}.json …)` into
  `filter_list.json`) and by the editor, which ships copies. A second
  `bevara.json` would be a second source of truth for the description, the GPAC
  filter list and the supported media, and they would drift.
- *Rejected*: a fixed `bevara.json` for filters, as first implemented. It made
  discovery trivial but duplicated the existing file.
- *Consequences*: discovery must avoid other JSON files (`filter_list.json`,
  `recommended.json`, `package.json`) — the name-equals-file-name rule does, and
  two candidates in one directory is an error rather than a guess.

**D2.2 — Legacy fields are mapped on read, never rewritten.**
`"Format"` is read as `formats`; without it, the keys of `"extension"` are used.
The mapping applies to a copy used for validation and publishing.
- *Why*: the CMake build and the editor read the file as it is; renaming keys in
  place would break them.

**D2.3 — The CLI edits a manifest surgically.**
When it writes into a manifest (`install` recording a dependency, `update
--latest`), only the top-level entries that changed are rewritten; every other
byte — indentation, compact arrays, spacing — is kept. If the document cannot be
edited that way, the CLI falls back to a full rewrite with the detected
indentation, and never writes invalid JSON.
- *Why*: these files are hand-formatted in about ninety repositories; a tool that
  reformats them on every run produces diffs nobody can review.

**D2.4 — `bevara.json` is for sites, and overrides.**
A site has no filter name to put in a file name, so it uses `bevara.json`. If a
filter repository has one, it wins (so a manifest can be overridden locally).
`init` creates `<name>.json` for a filter and `bevara.json` with `--site`.

**D2.5 — `main` and the build command have defaults.**
The build defaults to `emcmake cmake -S . -B <build dir> && cmake --build
<build dir>`, with **`.bevara/.build`** as the build directory. `main` defaults to
`<build dir>/<module>_<N>.wasm`; when no `-B` is given, a module built by hand is
also found in `build/` (CMake's usual directory) and at the root (an in-source
build, as the filter repositories' READMEs describe), in that order, and the
path used is printed.
- *Why `.bevara/`*: filter repositories ignore it in git, so a build leaves the
  working tree clean. When it is not ignored, the build says so (it never edits
  `.gitignore`).
- *Why the dot in `.build`*: the bevara-access editor treats every subdirectory
  of `.bevara/` as one of its own compilation runs — it lists them and its
  "delete all" removes them — but skips names starting with a dot. `.bevara/build`
  would show up as a bogus run and could be deleted from the editor.
- *Side effect*: creating `.bevara/` in a repository makes the editor activate
  there (`workspaceContains:.bevara`); for a filter repository that is expected.
Existing manifests can therefore be published as they are (D2.7).
- *The build directory is a command-line choice* (`-B/--build-dir`, relative to
  the repository like CMake's `-B`), not a manifest key: the manifest is shared
  with the CMake build and the editor, and where one person builds is not a
  property of the filter. A custom `scripts.build` receives it as
  `$BEVARA_BUILD_DIR`; an explicit `main` always wins.

**D2.6 — A directory named on the command line is not searched upwards.**
`bevara publish ../libjxl` uses the manifest in that very directory, or fails.
Walking up is only for the implicit case (running from `build/`), where it is
what the user expects; from a directory the user named, it could silently
publish a parent project.

**D2.7 — The version is derived from the generation.**
A manifest needs no `"version"`. The CLI reads the generation from where it
already is — `"main"` if it names the file, else `add_filter()` in
CMakeLists.txt, else the single `<module>_<N>.wasm` the build produced — and
publishes generation `N` as version `N.0.0`. The file name keeps the spelling of
`"name"`/`add_filter()` (`libOpenVVC_1.wasm`) while the package name is
lowercase (`bevara:libopenvvc`), so no `"module"` is needed either.
- *Why*: the generation is already in two places (CMake and the file name pages
  load); a third copy in the manifest would drift.
- *Consequences*: versions are immutable (D4), so publishing a changed module
  means a new generation — `_2`, a new file name, which pages adopt by changing
  their `with` attribute. That is the generation semantics of the paper.
  A `"version"` in the manifest remains possible and wins: it allows releases
  within a generation (`1.0.1`, served under the same `libjxl_1.wasm`, so pages
  get the fix without changing their markup).
- *Ambiguity is reported, not resolved*: several built generations without a
  CMake value, a generation written as a CMake variable, or an `add_filter()`
  building a differently named filter each produce a warning.
- *Rejected*: requiring `"version"` (the first implementation).

**D2.8 — The licence comes from the licence file.**
The CLI looks for `LICENCE`, `LICENSE`, `COPYING` (and their `.md`/`.txt`
variants) at the root of the repository. An `SPDX-License-Identifier:` line in
it is taken as is — the exact way to state a combination such as
`LGPL-2.1-or-later AND BSD-3-Clause AND MIT`. Without one, the licence texts the
file contains are recognised and joined with `AND` in order of appearance. A
licence text does not say whether later versions of the (L)GPL apply; that is
read from the source headers ("or (at your option) any later version"), and
`-only` is reported when nothing says. An unrecognised text is published as
`SEE LICENSE IN <file>`, npm's convention.
- *Why*: the licence file must be distributed with the module anyway (BSD and
  MIT require the notices, the LGPL its text); a `"license"` in the manifest
  would be a second statement of the same fact.
- *Consequences*: the licence file is always included in the tarball. A
  `"license"` in the manifest still wins, with a warning when it disagrees with
  the file. `bevara init` writes `LICENCE` (with the SPDX tag) instead of a
  manifest field.

**D2.9 — The build follows the active Emscripten SDK, and checks it is the right one.**
A CMake build directory keeps loading the toolchain it was first configured
with (`CMakeFiles/<v>/CMakeSystem.cmake`), even when `emcmake` from another SDK
passes a different `CMAKE_TOOLCHAIN_FILE`; the old SDK's `emcc` then runs with
the new SDK's configuration and fails with errors such as `'$CFGDIR/upstream/bin/clang'`.
Before the default build, the CLI compares the directory's toolchain with the SDK
of the `emcmake` on PATH and, when they differ, removes `CMakeCache.txt` and
`CMakeFiles/` (CMake's own files, nothing else) so the directory is reconfigured.
- *The expected SDK*: filter repositories pin one in
  `third_parties/emsdk_vers.txt` (their CI uses it). The CLI looks for that file
  above the repository and warns when the active `emcc` is another version.
- *Diagnosis*: the build output is shown as it runs and kept; on failure, known
  causes (mixed SDKs, `emcmake` missing, a toolchain/libraries mismatch) get a
  specific hint instead of a generic one.
- *Why*: this happened — a build directory configured with one SDK, reused from a
  terminal where another was active.

## 3. Names, namespaces and ownership

**D3.1 — Names are `<namespace>:<package>`.**
Bare names resolve to the default namespace (`bevara`). The convention is that of
the Bytecode Alliance registry protocol (Warg) and `wkg`, so packages could be
mirrored to a component registry without renaming.

**D3.2 — Who may publish where.**
Reading needs no account. Publishing needs one, and any account may publish a
new filter in the default namespace (a bare name) — it becomes that package's
owner. After that, a package takes new versions only from its owners (who can
add co-owners) and from administrators; a personal namespace (`alice:`) belongs
to its account; the first publisher of any other namespace claims it.
- *Why open*: the registry is meant for external contributions; requiring an
  administrator's grant before a first publish (the earlier rule) turned every
  contributor away.
- *What stays protected, and why*: an accessor runs inside every page that links
  it. Letting any account push a new version of an existing package would let it
  replace `theora_1.wasm` for everyone; ownership per package prevents that, and
  publications are signed and logged (D4).
- *Consequence*: names are first come, first served — in the default namespace
  and for accessor names (D3.3). Administrators can remove a squatted package
  (`bevara unpublish <name> --force`), which also frees its accessor name.
- *Holds on an existing registry*: at start-up every account gets its own
  namespace (accounts older than namespaces lacked one; an account named like the
  default namespace does not get it), and `ADMIN_USERS` promotes the listed
  accounts even if they already exist.

**D3.3 — An accessor name belongs to one package, registry-wide.**
The accessor name is the `.wasm` base name without its generation, lowercased.
It is reserved by the first package that publishes it, in a dedicated table
(`accessor_names`), and refused (`409`) to any other package — whatever its
namespace, its generation, or the case of its file name.
- *Why*: a page loads `theora_1.wasm` by name. Two packages providing it, even in
  different namespaces, make that name ambiguous for every page and every
  `accessors/` directory.
- *How it holds under concurrency*: checked before any file is written (fast
  refusal), then again synchronously inside the publishing transaction, where two
  concurrent publishes cannot both pass. A refused upload leaves no file behind.
- *Release*: the reservation goes when its package is deleted entirely (the
  package name becomes free at the same time).
- *Older databases*: the table is filled at start-up from what is published;
  clashes already present are logged and the first publisher keeps the name.
- *Not enforced*: two packages registering the same *GPAC filter* name get a
  warning. They only conflict when linked into the same page, and forks or
  alternative builds of a decoder legitimately do it.
- *Rejected*: allowing the same name in different namespaces and resolving the
  clash at install time (the first implementation). The CLI still refuses to
  install two packages that produce the same file, as a second line of defence.

## 4. Trust: signatures and the transparency log

**D4.1 — Publications are signed by the publisher.**
Each account registers Ed25519 public keys; the CLI keeps the private key in the
user's settings, per registry and account, and creates one on first publish. A
publish carries a canonical-JSON *record* (name, version, generation, file, SHA-256 of
the module and of the tarball, key id, timestamp) and its signature. The
registry recomputes the digests from the uploaded bytes before accepting.
- *Why*: a stolen token alone must not be enough to publish.

**D4.2 — Accepted records go into an append-only hash chain.**
`hᵢ = SHA256(hᵢ₋₁ ‖ SHA256(canonical(rᵢ)) ‖ σᵢ)`. Yank and deprecation are
recorded too, signed by the registry's own key. A checkpoint (sequence, head,
time) signed by the registry key is returned with publishes, audits and the
capability index.
- *Rejected*: a Merkle tree as in Certificate Transparency and Warg. A linear
  chain makes inclusion proofs O(n) instead of O(log n), but a codec registry
  grows by a few entries a week, verifying 10⁴ entries with signatures takes
  under a second, and the client needs no tree logic. The record format would
  not change if the structure did.

**D4.3 — Verification happens in the site, not in the registry.**
`install` checks each module's digest and the publisher signature, and records
key id and log position in the lockfile. `audit` fetches the log entries after
the checkpoint pinned in the lockfile, re-derives the chain from that head,
re-hashes the entries it uses rather than trusting served hashes, and only then
advances the pin.
- *Consequences*: a registry that rewrites, reorders or drops history cannot
  extend a head a project has already pinned.

## 5. Installing: resolution and the lockfile

**D5.1 — Resolution is flat.**
A page holds one version of each accessor, because the loader identifies modules
by file name. Ranges from different requesters must be satisfied by a single
version; conflicts are reported, never resolved by duplication.

**D5.2 — The lockfile pins bytes, not just versions.**
`bevara-lock.json` records version, file, SHA-256, signature (key id, log
position and hash) and the last verified log checkpoint. `audit` checks the files
on disk against it and against the registry.

## 6. The registry server

**D6.1 — One Node process, SQLite and a file store.**
`node:sqlite` (no native dependency), published files under `DATA_DIR/store`,
one replica on a persistent volume, `Recreate` deployment strategy.
- *Why*: a codec registry holds tens to hundreds of packages; the operational
  cost of Postgres and object storage buys nothing at that size.
- *Consequences*: no horizontal scaling. The SQL is plain enough to move to
  another database if that changes.

**D6.5 — One version number, followed by the image and checked by the CLI.**
The registry's version is the one in `packages/registry/package.json`; `/-/ping`
reports it, `deploy/k8s/build.sh` tags the image with it, and a test fails when
`deploy/k8s/registry.yaml` references another tag. The CLI knows the oldest
registry it works with (`MIN_REGISTRY_VERSION`, 1.1.0: signed publishing, log,
namespaces); `publish` checks it before building, `ping` warns, and a route the
registry does not know is reported as a version gap rather than a bare 404.
- *Why*: the deployed registry once stayed at 1.0.0 while the code moved on,
  because the tag in the manifests was never bumped; `publish` then failed with
  `no route for PUT /-/keys` after a full build.

**D6.2 — Minimal dependencies, no framework.**
The server uses a small router of its own; its only dependencies are `semver`
and `tar`, shared with the CLI.

**D6.3 — Authentication.**
Local accounts (scrypt-hashed passwords), API tokens stored hashed, and optional
OpenID Connect against Casdoor with PKCE. `bevara login` opens the registry's
login page and receives the token on a loopback port, as `npm login` does. The
first account and those in `ADMIN_USERS` are administrators.

**D6.4 — A refused upload is answered before the connection closes.**
When a body exceeds the limit, the server stops reading but keeps the socket,
answers `413` with `Connection: close`, and only then closes — otherwise the
client sees a dropped connection instead of the reason.

## 7. Delivery to browsers

**D7.1 — The registry serves accessors directly to pages.**
`/accessors/<module>_<N>.wasm` is the newest non-deprecated version of that generation
with a short cache lifetime (pages using the library policy);
`/accessors/<ns>:<pkg>/<version>/<file>` is immutable and cached indefinitely
(pages with a lock file). Both are CORS-enabled and served Brotli-compressed,
compressed once at publish time.

**D7.2 — A capability index for on-demand resolution.**
`/accessors/index.json` lists, for each package, its file, capabilities
(`inputs`/`outputs`), priority, legal flags, size and integrity. It is the
"mapping from a declared stream capability to a side-module name" that deferred
resolution needs. `/accessors/filter_list.json` reproduces the format of the
filters repository so existing wrappers work unchanged.

**D7.3 — Runtimes are packages of kind "runtime".**
A solver is published like a filter: a `<name>.json` with `"kind": "runtime"`,
versions, owners, signature, log entry, licence. Its package carries
`<name>_<N>.wasm` and `<name>_<N>.js`; the signed record covers both
(`jsSha256`), `/accessors/<name>_<N>.js|.wasm` serve the newest version of that
generation, and `/accessors/index.json` lists runtimes apart from accessors
(`runtimes`), so that capability selection and probing never pick a solver as
an accessor.
- *Why*: publishing is open to every account; a name that anyone could
  re-upload would let anyone replace the solver every page loads. Ownership,
  immutable versions and the log are what packages already give, and
  `/accessors/<name>_<N>` already serves the newest version of a generation, so
  a fixed solver keeps its URL.
- *Rejected*: a separate store of "runtime files" uploaded by administrators
  (first implemented, never deployed): it bent publishing to one role and
  duplicated what packages do.
- *Consequences*: runtime names share the accessor-name space; the tag scripts
  (`universal-*_N.js`) are not runtimes and are not published (update-page takes
  them from `--runtime`).

**D7.3b — Tag scripts are packages of kind "tags".**
The universal-*_N.js scripts define the customised elements; pages load them
with `<script src>`. A tags package carries several of them: the first stands
as the main file of the version (the `versions` table wants one), the others
are recorded with it (`wasm_info.files`), the signed record covers each
(`tagsSha256`), and every script name is reserved in `accessor_names` - so
`/accessors/universal-img_1.js` finds its package by that reservation, the
package name being `universal-tags`. The index lists them under `tags`.
- *Why*: update-page must write a page that works, and the scripts are part of
  what it loads; publishing them like the rest gives the same signatures,
  owners and versions, and lets anyone publish other tags, extending the
  universal ones or not (`"extends"`).
- *Rejected*: shipping the scripts inside the CLI's npm package - simpler and
  offline, but every change to the tags would need a CLI release.
- *Consequences*: webpack keeps the licence comments of the bundled code inside
  each script (`extractComments: false`): a script copied alone next to a page
  would otherwise lose the .LICENSE.txt holding them.

**D7.4 — A solver directory builds on its own.**
`player/solver` and `player/solver_minimal` were subdirectories of the player's
CMake project only. A guarded block (`if(CMAKE_SOURCE_DIR STREQUAL
CMAKE_CURRENT_SOURCE_DIR)`) now gives them, when built alone, what the player
gives them — `project()`, Release by default, C++20, `-fpic`, one output
directory — and the paths into the player's tree are gone; inside the player
the block is skipped. The executable `<base>_${VERSION}` gives the module and
the generation (`readExecutables`), `loader.js` the built-in filters, LICENCE
the licence (LGPL-2.1-or-later: GPAC is linked statically),
`third_parties/emsdk_vers.txt` the SDK. Built alone, both are byte-identical to
the player's build.

**D7.5 — "using" binds filters to runtimes.**
`"using"` is required to publish a filter, and at least one runtime it names
must be published on the registry (the others are warnings): a registry may
carry several runtimes, per environment, and an accessor whose every solver is
missing could not be loaded by any page. The CLI checks it before building,
the registry at upload.
- *Consequences*: a combination is only proposed with a runtime common to all
  its accessors and published on the registry (`solverOrder` draws from the
  index's `runtimes`; before runtime packages, from the solvers the player
  ships). An accessor without `"using"` (published by an older CLI) is assumed
  compatible and flagged, so that existing pages are not broken by the rule.

## 8. Identifying media: probe

**D8.1 — Probe reads structure, not samples, and only the ends of a file.**
256 kB from the start and 1 MB from the end (a trailing MP4 `moov`), with HTTP
range requests for URLs. No decoding, no Wasm.

**D8.2 — Containers are parsed to list their elementary streams.**
Ogg, ISOBMFF, Matroska/WebM, AVI, MPEG-TS/PS and FLV are walked far enough to
name each stream's codec, because the pipeline depends on what the container
holds: an `.mp4` with HEVC and one with AV1 need different decoders.
- *Consequences*: the file is named after its dominant stream — an AVI whose video
  could not be identified stays an AVI, it does not become its audio codec.

**D8.3 — Tracks are named by MediaInfo, accessors chosen the editor's way.**
The filter manifests describe what they read in MediaInfo's vocabulary
(`"Format": ["JPEG 2000"]`), because the editor matches them against MediaInfo
(Editor/Interface, `libraries.service.ts`). `probe` and `update-page` run the
same library (mediainfo.js) and apply the same rule (`capabilities.js`): an
accessor fits a track whose Format is in its `"Format"` list, or the file when
its extension is one of its `"extension"` keys — which covers what MediaInfo
does not recognise (JPEG XL). Only accessors the registry carries are candidates.
On top of the editor's union of matches, the file is split into needs — a
demultiplexer for the container (unless the solver reads it: MPEG-TS/PS, WAV), a
decoder per stream — so that a need no published accessor covers is reported,
and `update-page` leaves that element alone. Lower `priority` wins. As in the
editor, a video track is drawn on a `<canvas>`; a `<video>` element also needs
the remux/encode tail (`isobmff_1`, `libx264_1`, `libopusenc_1`), which declares
no Format and is therefore looked up by name, still only when published.
- *Rejected*: naming accessors from a built-in table (`openjpeg_1` for JPEG 2000)
  and checking afterwards whether they exist, which suggests modules nobody has
  published; and a home-made table of codec aliases, which MediaInfo's names make
  unnecessary. The built-in table remains for `--offline`, unchecked.

**D8.5 — The solver comes from the accessors' `"using"`.**
A side module links only against a solver that exports what it imports, and a
page loads a single solver. Each manifest lists the solvers it works with
(`"using"`, absent = any); resolution tries the preferred solver of the element
(`mm_solver_minimal_1.0.1` for images and audio, `mm_solver_1.0.1` for a canvas, as in the
editor), then the others, and keeps the first under which every need has an
accessor. Accessors that cannot share a solver are reported as a conflict, not
as a missing codec. `update-page` picks one solver for the whole page, keeping
the one universal elements already on it use.
- *Rejected*: deriving the solver from the module's imports at probe time. It
  needs the solver builds and their JS glue (`invoke_*` live there, not in the
  `.wasm`), and weak symbols show up as imports without being missing. It belongs
  at build time, where the solver builds are at hand.

**D8.4 — The format table is shared with the browser extension.**
`formats.js` is ported verbatim from `bevara-extension/src/common/formats.js`
(magic bytes, native support, curated pipelines) and must be kept in sync. What
a registry actually carries is answered by its capability index, not by the table.

## 9. Rewriting pages: update-page

**D9.1 — Edits are splices on the original bytes.**
A small scanner locates start tags and attribute spans (skipping comments and the
content of `script`, `style`, `textarea`, `title`), and attributes are inserted
or replaced in place. Everything else — quoting, indentation, entities — is kept,
and running the command twice changes nothing.
- *Rejected*: parsing with an HTML5 parser and re-serialising, which rewrites the
  whole document.

**D9.2 — Nothing is written without `--write`.**
By default the command prints the diff.

**D9.4 — `--write` puts what the page loads next to it.**
From the rewritten HTML: the `universal-*_N.js` of its relative `<script>`
tags, and for each universal element the solver pair of `using` and the
accessors of `with`, resolved against the page. The player resolves those
against the page unless `script-directory` is set — and it honours
`script-directory` only as an absolute URL (it checks that `dir + file` is a
URL and otherwise loads nothing), so a relative layout such as `accessors/`
cannot work: the files go next to the page, as in the Showcase pages. An
element with an absolute `script-directory` needs nothing copied.
- Sources: accessors and solvers (runtime packages, D7.3) from the registry
  index, checked against their integrity; `--runtime` directories are looked
  in first, and are where the tag scripts come from.
- A file already there with other bytes is kept (it may be a module built by
  hand) unless `--refresh`; the same bytes are left alone. Without `--write`,
  the same list is shown as what would be added.
- `--install` remains the site-project workflow (bevara.json, lockfile,
  signature checks); `--no-files` rewrites the HTML only.

**D9.5 — update-page keeps what revert-page needs.**
`--write` records, in `.bevara/pages.json` beside the page, the page before the
first run (`.bevara/pages/<page>.orig`), the sha256 of what it last wrote, and
each file it added or replaced with the sha256 of what it wrote; a replaced
file is copied to `.bevara/pages/backup/` first. Later runs keep the first
original: revert goes back to the page before update-page ever touched it.
- *Why*: a revert must remove what update-page added and nothing else; hashes
  tell an untouched file from one rebuilt or edited since, and the record
  makes the operation exact instead of guessed.
- *Rejected*: deriving the revert from the page alone (strip the markup,
  delete what it loads) as the general method - it cannot restore a replaced
  file nor tell a module someone built by hand. It remains the fallback for
  pages updated before records existed, behind a confirmation.

**D9.3 — It refuses what would be wrong rather than guessing.**
A `customized built-in` must match the element it extends: an `<img>` pointing at
a video is reported, not given `is="universal-video_1"` (`<canvas>` accepts both).
`<source>` children are reported, since the universal tags read `src` on the
element. The `<script>` defining each universal tag is added when missing,
because `is=` does nothing without it.

## 10. Running real pipelines: test and bench

**D10.1 — The real solver runs in Node.**
`mm_solver_1.0.1.js` is an Emscripten MAIN_MODULE exported through `module.exports`;
accessors are loaded as `dynamicLibraries` and self-register through their
constructors; built-in filters (`fin`, `fout`, `writegen`…) are registered from
JavaScript with `gf_filter_auto_register`; `main(argc, argv)` receives
`gpac`-style arguments; completion is signalled through `Module.gpac_done`.
- *Consequences*: `globalThis.libgpac` must be set, because the solver's EM_ASM
  code resolves `libgpac` as a global.

**D10.2 — One child process per run.**
Two solver instances in one process interfere; a separate process also makes
timings independent and lets a hung session be killed.

**D10.3 — Output goes to a raw file.**
`.yuv`, `.pcm` or `.rgb`, depending on the media. A sink that accepts compressed
data (`-o null`) is connected straight to the demultiplexer, and nothing would be
decoded. For the same reason the encoder tail is dropped from probed pipelines,
except `isobmff_1` when it is the demultiplexer.

**D10.4 — A graph that resolves but decodes nothing is a failure.**
`test` passes only if the session ends cleanly, every filter connected, the
decoders processed packets and output exists.

**D10.5 — Measurements come from GPAC's own accounting.**
`bench` reports linking (instantiating the solver and the side modules), the
decoder's process time as GPAC accounts it per filter, and the session's wall
clock, as medians over several runs after a warm-up. `mm_solver_1.0.1` is preferred
because `mm_solver_minimal_1.0.1` prints no statistics.

**D10.6 — The solver is not distributed by the registry.**
It is the player's main module, not an accessor; `test` and `bench` look for it
next to the accessors and explain how to provide it when it is missing.

## 11. The CLI: configuration, errors, dependencies

**D11.1 — The default registry needs no configuration.**
Precedence: `-r/--registry` > `BEVARA_REGISTRY` > `"registry"` in the project
manifest > the user settings file > the built-in default. A bare host is
accepted (`https://` for public hosts, `http://` for local addresses). `config
get/list` show where the value comes from, and `config set` warns when a
higher-precedence source masks it.

**D11.2 — Errors explain the status, the context and the next step.**
HTTP failures are described in the user's terms (a 503 means the registry behind
the proxy is not answering), with the method and URL, the `Server` header, an
excerpt of a non-JSON body when it adds information, and a hint. The registry's
own JSON message is kept as is, and its `hint`, when present, is shown. Network
failures are named by cause (DNS, refused connection, TLS, timeout).

**D11.3 — Few dependencies.**
The CLI depends on `semver`, `tar` and `mediainfo.js` (the MediaInfo Wasm build,
for the same track names as the editor, D8.3); Wasm inspection, HTML scanning,
the built-in container parsing and signing use Node built-ins.

**D11.4 — Debugging never touches real credentials.**
The VS Code configurations point `BEVARA_CONFIG` at a scratch file and attach to
child processes, since `test` and `bench` run pipelines in children.

## 12. Relation to WAPM and Warg

**D12.1 — The registry is specific to accessors, and borrows from Warg.**
WAPM distributes WASI programs for a server runtime; Warg and `wkg` distribute
*components* with typed interfaces. Neither models a side module sharing linear
memory with a host through a C ABI — which the component model excludes by
design and on which the zero-copy pipelines rely. What is taken from Warg is its
naming and its record-and-log structure; from Sigstore and TUF, the principle
that consumers, not the registry, verify. Should the component model gain dynamic
linking with shared memory, accessors could become components and Warg their
transport; the capability index and browser delivery would remain specific.

## 13. Selecting by capability: caps and select

**D13.1 — Capabilities are read from the C source, not declared.**
At publish, `caps.js` finds each GPAC register the manifest lists (by `.name`,
through `filter_source`), its `SETCAPS` array and its `.priority`, and
publishes them per filter as `caps`: bundles of `{property, format}` on the
input and output sides, with `excluded`, `optional` and `static` from the flags.
- *Why*: the same rule as the version (CMake) and the licence (LICENCE): the
  source already says it, and a copy in `<name>.json` would drift from the code
  that GPAC actually resolves on.
- *How*: a lexer, not a C compiler — comments stripped, every `#if` branch read,
  `CAP_*()` macros, designated (`{ .code=…, .flags=… }`) and positional
  (`{flags, code, {type, {.uint = v}}, NULL, prio}`) initialisers, `{0}` closing
  a bundle. Values keep their GPAC names (`GF_PIXEL_RGBA`), the vocabulary of
  the paper's query; nothing is evaluated.
- *Consequences*: a filter registered under another name than the manifest's
  (`ffdec` registers `"ffdec-h26x"` and renames itself at run time) is found
  through `filter_source` when that file holds a single register. Caps built at
  run time (`gf_filter_push_caps`) are not seen.

**D13.2 — What is decided at run time is declared, under `"runtime"`.**
A decoder's static caps say "raw video out"; the pixel format comes from
`gf_filter_pid_set_property(…, GF_PROP_PID_PIXFMT, &PROP_UINT(x))` in
`configure_pid`. A literal `x`, or a choice between literals, is read; a
variable (`ctx->ofmt`, `pix_fmt`) is reported, with the candidates found in the
code (assignments, `switch` cases, the helper that computes it), and the
author declares the formats in `<name>.json`:
`"runtime": { "jxldec": { "outputs": [{ "property": "GF_PROP_PID_PIXFMT", "format": ["GF_PIXEL_RGB", "GF_PIXEL_RGBA"] }] } }`.
`bevara caps --write` writes the candidates for review.
- *Why*: this is the only information the source cannot give; it is what a
  selection on `GF_PROP_PID_PIXFMT` needs.
- *Rejected*: observing the output PID at run time with `bevara test` — the
  solver has no inspect filter to report PID properties; it would be exact for
  the files tried and only for them.
- *Consequences*: run-time formats count only where they describe an output —
  not on a parser that sets `PIXFMT` on a compressed stream (`rfjpeg`), not a
  pixel format in an audio-only build of the shared ffmpeg code. The ffmpeg
  wrappers were declared from the decoders actually linked in their
  `libavcodec.a` (`llvm-nm`), not from the shared code's candidates.

**D13.3 — Matching follows GPAC, with a partial PID.**
The query's `inputs` describe the current output. A bundle fits when, for every
property the query gives and the bundle constrains, the value is allowed and
not excluded (string caps are `|` alternatives); a property the query does not
give is not held against the bundle. A raw format implies the rest
(`PIXFMT` ⇒ visual, `GF_CODECID_RAW`), so decoders of compressed streams drop
out. The bundle must accept at least one of the query's properties by name —
the stream type alone does not count unless it is all the query gives —
otherwise every demultiplexer "accepts" a JPEG XL codestream by saying nothing.
A codec declared as `GF_4CC('J','X','L',' ')` compares as `GF_CODECID_JXL`.

**D13.4 — The side conditions of the paper, as read here.**
- `version`: a bare version is a **minimum** (it is listed with `maxsize` and
  `maxpriority`); with an operator, a semver range. Versions are generations
  (`1.0.0`), so `2.1` selects nothing today.
- `IP`: when `condition` is true, an accessor whose `patents.status` is
  `licence-required` or `under-review` is excluded where it applies —
  everywhere, or in the `patents.regions` that contain `geocode` — and one
  that declares no status is excluded too; `license` lists the accepted SPDX
  licences.
- `projectname`: one of `projects`, derived from the static libraries in `lib/`
  (`libavcodec.a` ⇒ ffmpeg); every accessor is also `gpac`. Compared without a
  `lib` prefix.
- `language`: `wasm` for every published accessor; `js` is reserved.
- `size`: the raw `.wasm` size, when `condition` is true.
- `maxpriority`: the GPAC priority of the filter that fits (0 when the register
  sets none, as in GPAC).
- Ranking: priority, then size.

**D13.5 — One matcher, two places.**
`select.js` is the same file in the CLI and the registry (a test compares
them), like `manifest.js`. The registry answers `GET|POST /-/select` (CORS `*`,
GET with plain parameters for a player); the CLI runs the same function on
`/accessors/index.json` when the registry predates the endpoint.

## 14. Preserving a file: preserve

**D14.1 — The package is the paper's (MMSys'27 §5.3), written with mp4box.js.**
The layout is the one `MP4Box -set-meta html -add-item … -set-primary 1`
produces and the MP4 Service Worker reads: `ftyp` (isom, iso2), a file-level
`meta` box (handler `html`; `pitm` the page; `iloc` v0, one extent per item,
absolute offsets; `iinf` of `infe` v2 `mime` items carrying the name and MIME
type), then one `mdat` with the items' bytes. mp4box.js 2.4 parses these boxes
but writes only `ftyp` and `hdlr`; `mp4-package.js` writes the other payloads
and lets mp4box.js's generic box writer frame them. Offsets and lengths widen
to 64 bits, and the `mdat` to a large size, when the file passes 4 GiB.
- *Consequences*: native MP4Box lists and extracts the items (`MP4Box -info`,
  `-dump-item`); there is no `moov` - MP4Box writes none for a file of items only.

**D14.2 — The media is an item, byte for byte.**
The paper's example imports the Ogg into tracks with native MP4Box; mp4box.js
has no importers, and preservation wants the original anyway. The page shows
the media item through the universal element, as any page would.

**D14.3 — The page is built by update-page.**
`preserve` stages `index.html` with the media in the element its kind calls
for (img, audio, or canvas for video, as in the paper; `--element` overrides),
and runs `rewritePages` - the core of `update-page` - on it: same probing,
same registry choice, same files (tag script, solver, accessors), checked
against their integrity. Items are named by their path relative to the page.

**D14.4 — An extended service worker opens the package.**
GPAC's `mp4box-sw` finds an item by stripping the characters a request URL
shares with the .mp4 URL: `out.mp4` asking for `ogg_1.wasm` looks up
`gg_1.wasm`. `templates/preserve/bevara-sw.js` names items relative to the
.mp4's directory, finds the package from the requesting client (then the
Referer), parses it again after the worker restarts, and answers HEAD - the
player asks a source's type and size first. It is a module worker importing
mp4box.js's ESM build, which `--viewer` copies beside it.

## 15. Known limitations

- **The registry image has not been built or deployed yet**; the default
  registry answers `503` until it is.
- **Some pipelines resolve but produce no output under Node** (Ogg/Theora, HEVC in
  MP4 in the tested corpus). `test` reports them; the cause is in the solver's
  behaviour outside a browser and has not been investigated.
- **The libjxl repository commits a debug build of `lib/libjxl.a`**, which makes
  the accessor built from it about 32× slower than the Showcase one. Prebuilt
  static libraries should be checked before publishing.
- **Inclusion proofs are linear** (D4.2).
- **One registry replica** (D6.1).
