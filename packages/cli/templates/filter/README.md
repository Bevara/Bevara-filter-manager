# {{NAME}}

{{DESCRIPTION}}

Bevara accessor (GPAC filter compiled to a WebAssembly side module).

## Build

Requires the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
and the GPAC headers matching the solver:

```bash
source /path/to/emsdk/emsdk_env.sh
export GPAC_DIR=/path/to/gpac
bevara build            # emcmake cmake -S . -B build && cmake --build build
```

The result is `build/{{NAME}}_1.wasm`.

## Publish

```bash
bevara login
bevara publish
```

## Use in a page

```html
<video is="universal-video_1" src="movie.ext" using="solver_1" with="{{NAME}}_1" controls></video>
```

or install it in a site project with `bevara install {{NAME}}`.
