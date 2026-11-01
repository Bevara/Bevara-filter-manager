# @bevara/cli

`bevara` — an npm-like package manager for **Bevara filters**: the WebAssembly
accessors (decoders, demultiplexers, encoders…) that the Bevara solver links at
run time so a browser can play formats it does not support natively.

## Install

Requires **Node.js 20 or later** (`node --version`).

```bash
npm install -g @bevara/cli
bevara --version
```

Or run it without installing:

```bash
npx @bevara/cli --help
```

Update with `npm install -g @bevara/cli@latest`.

Nothing to configure: the CLI talks to **https://registry.bevara.ddns.net**, and
browsing, searching and installing filters need **no account**. An account is
only needed to publish.

## Use filters on a web site

```bash
bevara probe movie.mkv                  # what the file holds, and the accessors it needs
bevara update-page index.html           # shows how <img>/<video>/<audio> would become universal tags
bevara update-page index.html --write   # apply it: also writes the scripts, solver and accessors it loads
bevara update-page index.html --tags art-player --using mm_solver_1.0.1   # other tags than the universal ones, one runtime
```

Or manage the accessors yourself:

```bash
bevara install theora ogg vorbis   # -> accessors/theora_1.wasm …, bevara.json, bevara-lock.json
bevara filters                     # prints the with="…" and using="…" attributes to paste
bevara runtimes                    # the runtimes (solvers) filters link against
bevara tags                        # the tag scripts (universal elements) pages load
bevara audit                       # integrity, signatures, advisories, deprecations, licences
bevara update                      # within the semver ranges; --latest to cross majors
```

```html
<video is="universal-video_1" src="movie.ogv" using="mm_solver_1.0.1"
       with="ogg_1;vorbis_1;theora_1" controls></video>
```

Or let the registry choose by capability — every accessor that accepts what
the previous stage outputs, under priority, size, licence or project bounds:

```bash
bevara select -i PIXFMT=RGBA -p 50       # accepts raw RGBA, GPAC priority <= 50
bevara select -i CODECID=JXL             # decodes JPEG XL
bevara select query.json                 # the query format of the paper (bevara select --help)
```

## Publish a filter

```bash
bevara login                       # opens the registry's sign-in page in your browser
cd my-filter-repository            # holds <name>.json, CMakeLists.txt and LICENCE
bevara publish --build             # builds .bevara/.build/<name>_1.wasm, signs, uploads
```

Building needs the **Emscripten SDK** activated (`source <emsdk>/emsdk_env.sh`);
the Bevara filter repositories pin the version they need in
`third_parties/emsdk_vers.txt`. The manifest is the repository's existing
`<name>.json`: the version comes from the generation in `add_filter()` (the `_1`
of the file name) and the licence from the `LICENCE` file. Any account can
publish a new filter; afterwards only its owners publish new versions of it.

What each GPAC filter accepts and produces, and its priority, are read from
the C source at publish; `bevara caps` shows them, and `bevara caps --write`
declares in `<name>.json` the output formats the code only chooses at run time.

A new filter starts from `bevara init`, which writes `<name>.json`,
`CMakeLists.txt`, `LICENCE` and a GPAC filter skeleton in `src/<name>.c`.

Every publish is signed and appended to the registry's append-only, hash-chained
log; `bevara install` verifies the signature over the downloaded bytes and
`bevara audit` extends the checkpoint pinned in `bevara-lock.json`.

## Preserve a file with its player

```bash
bevara preserve clip.ogv                 # clip.bevara.mp4: the file, its page, solver and accessors
bevara preserve clip.ogv --viewer        # also the service worker and clip.bevara.html that open it
```

The package is an MP4 whose `meta` box (handler `html`) lists the page as its
primary item and the tag script, solver and accessors (Wasm bytecode) as the
other items, stored in the `mdat` with the media unchanged — §5.3 of the
MMSys'27 paper. Served over HTTP with the service worker beside it, opening
the `.html` plays the file from the package alone.

## Test and measure a pipeline

```bash
bevara test clip.mp4 --accessors <dir>    # does this combination really decode the file?
bevara bench clip.mp4 --accessors <dir> -W "isobmff_1;h264bsd_1" -W "isobmff_1;libde265_1"
```

These run the real pipeline and need the player's main module
(`mm_solver_1.0.1.js` and `mm_solver_1.0.1.wasm`) in `<dir>`, next to the accessors.

`bevara --help` lists every command; `bevara <command> --help` details one.

Full documentation, the registry server and the Kubernetes manifests:
<https://github.com/Bevara/Bevara-filter-manager>.

## License

MIT
