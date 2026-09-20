# Filter package format

A filter package is what `bevara publish` uploads and what `bevara install` downloads.
It wraps one **accessor**: a GPAC filter (or several) compiled with Emscripten as a
*side module* (`-sSIDE_MODULE=2`) that self-registers into the solver's filter session
at link time.

## `bevara.json`

```jsonc
{
  "name": "theora",                 // lowercase, digits, . _ -  (registry key)
  "version": "1.2.0",               // semver; versions are immutable once published
  "abi": 1,                         // "_1" suffix of the .wasm; bump when the solver ABI changes
  "description": "Theora decoder",
  "help": "Decodes Theora streams through libtheora.",
  "filters": ["theoradec"],         // GPAC filter names registered by the module
  "support": ["video"],             // image | audio | video | canvas | text | subtitle | container
  "formats": ["Theora"],            // formats handled (used by search / filter_list.json)
  "keywords": ["xiph", "ogg"],
  "license": "BSD-3-Clause",        // SPDX
  "licence_required": false,        // true when the site owner needs a patent/commercial licence
  "georestrictions": false,         // or ["US", "JP"]: territories where the codec may not be used
  "priority": 50,                   // 0-255, lower = preferred by the resolver (see paper §3.3)
  "inputs":  [{ "stream_type": "visual", "codec": "theora" }],   // capability summary
  "outputs": [{ "stream_type": "visual", "codec": "raw" }],
  "dependencies": { "ogg": "^1.0.0" },   // other filters needed in the same page (e.g. a demuxer)
  "sources": "https://github.com/Bevara/theora",
  "filter_source": { "theoradec": "src/dec_theora.c" },

  // build-time only (stripped when publishing)
  "main": "build/theora_1.wasm",
  "scripts": { "build": "emcmake cmake -S . -B build && cmake --build build" },
  "files": ["docs/"],               // extra files to include in the tarball
  "registry": "https://registry.bevara.ddns.net"   // optional per-project override
}
```

`name`, `version` and `filters` are required. The compiled artifact must be a valid
Wasm binary carrying a `dylink.0` (or `dylink`) custom section — the registry refuses
anything else, since the solver's `dlopen()` could not link it.

## Tarball

npm-style layout, gzip-compressed:

```
package/bevara.json
package/<name>_<abi>.wasm
package/README.md, LICENSE, …    (if present, plus "files" entries)
```

## Consumer projects

A web site that uses filters has a `bevara.json` with only `dependencies` (and an
optional `accessorsDir`, default `accessors/`):

```json
{ "name": "my-site", "accessorsDir": "accessors", "dependencies": { "theora": "^1.2.0", "ogg": "^1.0.0" } }
```

`bevara install` writes `accessors/<name>_<abi>.wasm` (exactly the file names the
universal tags load through the `with` attribute), `accessors/<name>.json` (the
published manifest, same shape as `theora.json` in the Bevara filters repository),
and `bevara-lock.json` with the resolved versions and `sha256` integrity of every file.

```html
<video is="universal-video_1" src="movie.ogv" using="solver_1" with="ogg_1;theora_1" controls></video>
```

## Registry URLs used by players

| URL | Content |
|-----|---------|
| `/accessors/<name>_<abi>.wasm` | newest non-deprecated version for that ABI (`Cache-Control: max-age=300`) |
| `/accessors/<name>/<version>/<name>_<abi>.wasm` | exact version, immutable |
| `/accessors/index.json` | machine-readable catalog with integrity hashes |
| `/accessors/filter_list.json` | same shape as the `filter_list.json` of the filters repository |

All are CORS-enabled and served brotli-compressed when the client accepts `br`.
