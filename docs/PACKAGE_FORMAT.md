# Filter package format

A filter package is what `bevara publish` uploads and what `bevara install` downloads.
It wraps one **accessor**: a GPAC filter (or several) compiled with Emscripten as a
*side module* (`-sSIDE_MODULE=2`) that self-registers into the solver's filter session
at link time.

## The manifest: `<name>.json`

A filter repository describes its accessor in **one** file named after it —
`libjxl.json` in the libjxl repository. It is the file the repository's CMake
build already reads into `filter_list.json` and that the editor ships, so the
registry uses it as is instead of adding a second file that would drift from it.
The CLI finds it as the `X.json` whose `"name"` is `X` and which lists
`filters`, in the current directory or a parent (so `bevara publish` also works
from `build/`). Two such files in one directory is an error, not a guess.

The existing manifests are published as they are:

```jsonc
{
    "name": "libjxl",                 // = file name; "bevara:libjxl" is accepted too
    "description": "JXL decoder",
    "help": "This filter decodes JXL images using libjxl.",
    "filters": ["jxldec", "rfjxl"],   // GPAC filter names registered by the module
    "support": ["image"],             // image | audio | video | canvas | text | subtitle | container
    "Format": ["JPEG XL"],            // MediaInfo format names handled; read as "formats" by the registry
    "extension": { "jxl": "img" },    // file extensions read, and the element that shows them
    "using": ["solver_minimal_1", "solver_1"],   // solvers the module links against (default: any)
    "patents": { "status": "royalty-free", "checked": "2026-10-16" },   // see "Patent status" below
    "sources": "https://github.com/Bevara/libjxl",
    "filter_source": { "jxldec": "dec_jxl.c", "rfjxl": "reframe_jxl.c" }
}
```

**`Format` and `extension` are how a file finds the accessor.** `bevara probe`
and `bevara update-page` identify a file with MediaInfo, as the editor does, and
pick an accessor whose `"Format"` holds the MediaInfo name of a track (`"JPEG
2000"`, `"AVC"`, `"Ogg"`), or whose `"extension"` holds the file's extension. A
manifest with neither is never proposed. `bevara probe <file>` prints the
names MediaInfo gives.

**`using` lists the solvers the module links against.** An accessor is a side
module: the solver a page loads (`using="…"`) must export every symbol it
imports, and the two solvers differ — `isobmff` imports GPAC functions only
`solver_1` has, `libtta` needs `invoke_*` trampolines only `solver_minimal_1`
defines. A page loads one solver (the loader keeps the first), so `probe` and
`update-page` pick one that every chosen accessor lists, and report the
accessors that cannot share one. Without `using`, a module is taken to work with
any solver, and publishing warns. To check a module's imports against a solver,
see `AGENTS.md` in the player repository.

**The licence comes from the `LICENCE` file** (or `LICENSE`, `COPYING`) at the
root of the repository, not from the manifest. Start it with an SPDX tag to state
it exactly, then the full texts:

```
SPDX-License-Identifier: LGPL-2.1-or-later AND BSD-3-Clause AND MIT
…
```

Without the tag, the licence texts in the file are recognised. The file is
always shipped in the published package.

**The version comes from the generation.** The `_1` of `libjxl_1.wasm` is the
module generation, set by the last argument of `add_filter()` in CMakeLists.txt
and incremented when the module changes. Without a `"version"`, generation `N` is
published as `N.0.0`; the CLI reads it from `"main"` if that names the file, else
from `add_filter()`, else from the single built `<module>_<N>.wasm`. A
mixed-case name (`libOpenVVC`) keeps its spelling for the file and is lowercased
for the package (`bevara:libopenvvc`).

Optional fields, for new or updated manifests:

```jsonc
{
    "name": "bevara:theora",          // "<namespace>:<package>"; bare = default namespace
    "version": "1.0.1",               // a release within a generation (default: <N>.0.0)
    "abi": 1,                         // the generation, when CMake cannot give it
    "module": "theora",               // .wasm base name, when neither "name" nor add_filter() gives it
    "formats": ["Theora"],            // preferred spelling of "Format"
    "keywords": ["xiph", "ogg"],
    "runtime": {                      // formats a filter sets at run time, which its source cannot tell
        "theoradec": { "outputs": [{ "property": "GF_PROP_PID_PIXFMT", "format": ["GF_PIXEL_YUV", "GF_PIXEL_YUV422"] }] }
    },                                // bevara caps --write proposes them; see "Capabilities" below
    "projects": ["gpac", "libtheora"],    // default: from the static libraries in lib/
    "dependencies": { "bevara:ogg": "^1.0.0" },   // accessors needed alongside (e.g. a demuxer)

    // build-time only, never published
    "main": "build/theora_1.wasm",    // default: .bevara/.build/<module>_<N>.wasm, then build/…, then ./…
    "scripts": { "build": "emcmake cmake -S . -B .bevara/.build && cmake --build .bevara/.build" },   // default shown
    "files": ["docs/"],               // extra files to include in the tarball
    "registry": "http://127.0.0.1:8080"   // optional per-project registry
}
```

When the CLI writes into the manifest (`bevara install` recording a
dependency), it rewrites only the entries that changed: the rest of the file —
indentation, compact arrays, spacing — stays byte for byte as it was.

`bevara.json` is the manifest of a **site** (no filter name to put in a file
name: see "Consumer projects" below). If a filter repository has one, it takes
precedence over `<name>.json`.

### Capabilities

What each GPAC filter accepts and produces is **read from the C source** at
publish (`bevara caps` shows it) and published as `caps`, one entry per filter:

```jsonc
"caps": [{
  "filter": "jxldec", "priority": 0, "source": "dec_jxl.c",
  "bundles": [{
    "inputs":  [{ "property": "GF_PROP_PID_CODECID", "format": "GF_4CC('J','X','L',' ')" },
                { "property": "GF_PROP_PID_UNFRAMED", "format": "GF_TRUE", "excluded": true }],
    "outputs": [{ "property": "GF_PROP_PID_CODECID", "format": "GF_CODECID_RAW" }]
  }],
  "runtime": { "outputs": [{ "property": "GF_PROP_PID_PIXFMT", "format": "GF_PIXEL_RGB" },
                           { "property": "GF_PROP_PID_PIXFMT", "format": "GF_PIXEL_RGBA", "declared": true }] }
}],
"priority": 0,          // the lowest of the filters' priorities
"projects": ["gpac", "brotli", "highway", "libjxl"],
"language": "wasm"
```

`priority` is the register's `.priority` (0 when unset, as in GPAC; lower is
preferred). `runtime` merges the formats the code sets literally with those
`<name>.json` declares (`"declared": true`). Never write `caps` by hand: the
source is the reference. See DESIGN.md D13 and `GET /-/select` in REGISTRY_API.md.

### Patent status

Every package states the patent status of what it implements, required to
publish:

```jsonc
"patents": {
  "status": "licence-required",       // royalty-free | expired | licence-required | under-review
  "note": "HEVC: Access Advance, Via LA",   // what is claimed, by whom
  "regions": ["US", "JP"],            // ISO 3166 codes where it applies; absent = everywhere
  "checked": "2026-10-16"             // date of the review
}
```

The registry accepts and serves every status. The restricted ones
(`licence-required`, `under-review`) are announced: at publish, in the index
and `/filters`, in the `X-Bevara-Patents` and `X-Bevara-Patents-Notice`
headers of every served file, and by the CLI (`install`, `update-page`,
`probe`, `filters`, `info`, `audit`). The capability query's `IP` condition
excludes them. `licence_required` and `georestrictions` are gone.

### Runtimes

A solver repository has a `<name>.json` with `"kind": "runtime"` instead of
`"filters"`: `{ "name": "solver_minimal", "kind": "runtime", "description": "…" }`.
The generation comes from `add_executable(<name>_${VERSION})` and
`set(VERSION "N")`, the licence from LICENCE, the published `builtins` (the
GPAC filters it registers itself) from `loader.js`. The package carries
`<name>_<N>.wasm` and `<name>_<N>.js`. A runtime has no `"using"`.

### Tags packages

The scripts that define the universal elements are published as a package of
kind `"tags"`, from the player:

```jsonc
{ "name": "universal-tags", "kind": "tags", "description": "…",
  "tags": ["universal-img_1.js", "universal-audio_1.js", "universal-video_1.js", "universal-canvas_1.js", "universal-tags_1.js"],
  "main": "build/dist",                 // the directory the scripts are built into
  "scripts": { "build": "npm run build" },
  "extends": { "my-img_1.js": "universal-img_1" } }   // optional: a tag built on another one
```

The generation is the `_N` of the scripts' names. No `"using"`, no emsdk.

A tag that `"extends"` a universal one stands for its element: `bevara
update-page --tags <package>` puts it on those elements instead of the
universal tag (the index gives `extends` per script). `art-player`
(`webinterface/ArtPlayer/packages/art-player` in the player) extends
`universal-canvas_1`: `<canvas is="art-player_1" src="…" using="…" with="…">`,
the universal canvas inside an ArtPlayer. A tag other than the universal
canvas reads its source from `src`.

`emsdk` (the Emscripten version, e.g. `"6.0.8"`) is derived at publish from
the CMake configuration of the build directory; it is never written in
`<name>.json`.

`name` and `filters` (or `"kind": "runtime"`) are required to publish, and a
filter needs `"using"`: the runtimes it links against, at least one of them
published on the registry. The compiled artifact must be a valid
Wasm binary carrying a `dylink.0` (or `dylink`) custom section — the registry refuses
anything else, since the solver's `dlopen()` could not link it.

## Accessor names are unique

A page loads accessors by file name (`with="theora_1"`), so a registry accepts
**one package per accessor name** — across namespaces, generations and letter case:
once `bevara:theora` provides `theora_1.wasm`, `zoe:theora` (or `zoe:x` with
`"module": "Theora"`, or generation 2) is refused with `409`. Owners can add
co-maintainers instead (`bevara owner add`). The name is released only when its
package is deleted entirely. Two packages registering the same *GPAC filter*
name get a warning at publish, not a refusal.

## Tarball

npm-style layout, gzip-compressed:

```
package/bevara.json              the manifest as published (legacy keys mapped, build keys removed)
package/<module>_<N>.wasm
package/README.md, LICENSE, …    (if present, plus "files" entries)
```

Package names are lowercase, but an accessor file name need not be: `module`
carries the exact base name the `with` attribute loads, and must equal the
package name up to case. `/accessors/libOpenVVC_1.wasm` serves
`bevara:libopenvvc`; the lowercase spelling is *not* an alias, so a page always
asks for the file under the name its author published.

## Consumer projects

A web site that uses filters has a `bevara.json` with only `dependencies` (and an
optional `accessorsDir`, default `accessors/`):

```json
{ "name": "my-site", "accessorsDir": "accessors", "dependencies": { "theora": "^1.2.0", "ogg": "^1.0.0" } }
```

`bevara install` verifies the publisher's Ed25519 signature over the downloaded bytes and
writes `accessors/<package>_<abi>.wasm` (exactly the file names the
universal tags load through the `with` attribute), `accessors/<name>.json` (the
published manifest, same shape as `theora.json` in the Bevara filters repository),
and `bevara-lock.json` with the resolved versions, the `sha256` integrity of every file,
the signing key id and log position of each version, and the last verified log checkpoint
(`"log": {seq, head, registryKeyId}`) that `bevara audit` extends on every run.

```html
<video is="universal-video_1" src="movie.ogv" using="solver_1" with="ogg_1;theora_1" controls></video>
```

## Registry URLs used by players

| URL | Content |
|-----|---------|
| `/accessors/<name>_<N>.wasm` | newest non-deprecated version of generation `N` (`Cache-Control: max-age=300`) |
| `/accessors/<name>/<version>/<name>_<abi>.wasm` | exact version, immutable |
| `/accessors/index.json` | machine-readable catalog with integrity hashes and capabilities (`caps`, `projects`, `language`) |
| `/accessors/filter_list.json` | same shape as the `filter_list.json` of the filters repository |

All are CORS-enabled and served brotli-compressed when the client accepts `br`.
