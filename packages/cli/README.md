# @bevara/cli

`bevara` — an npm-like package manager for **Bevara filters**: the WebAssembly
accessors (decoders, demultiplexers, encoders…) that the Bevara solver links at
run time so a browser can play formats it does not support natively.

```bash
npm install -g @bevara/cli
bevara login      # the registry defaults to https://registry.bevara.ddns.net
```

## Use filters on a web site

```bash
bevara install theora ogg vorbis   # -> accessors/theora_1.wasm …, bevara.json, bevara-lock.json
bevara list                        # prints the with="…" attribute to paste
bevara audit                       # integrity, signatures, advisories, deprecations, licences
bevara update                      # within the semver ranges; --latest to cross majors
```

```html
<video is="universal-video_1" src="movie.ogv" using="solver_1"
       with="ogg_1;vorbis_1;theora_1" controls></video>
```

## Publish a filter

```bash
bevara init        # bevara.json, CMakeLists.txt, src/<name>.c (GPAC filter skeleton)
bevara build       # needs the Emscripten SDK and GPAC headers (GPAC_DIR)
bevara publish     # signs the module with your Ed25519 key and uploads it
```

Every publish is signed and appended to the registry's append-only, hash-chained
log; `bevara install` verifies the signature over the downloaded bytes and
`bevara audit` extends the checkpoint pinned in `bevara-lock.json`.

Full documentation, the registry server and the Kubernetes manifests:
<https://github.com/Bevara/Bevara-filter-manager>.

## License

MIT
