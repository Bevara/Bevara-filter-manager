# {{NAME}}

{{DESCRIPTION}}

Bevara accessor (GPAC filter compiled to a WebAssembly side module).

## Build

Requires the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
and the GPAC headers matching the solver:

```bash
source /path/to/emsdk/emsdk_env.sh
export GPAC_DIR=/path/to/gpac
bevara build            # emcmake cmake -S . -B .bevara/.build && cmake --build .bevara/.build
```

The result is `.bevara/.build/{{NAME}}_1.wasm` (`.bevara/` is git-ignored).

## Publish

```bash
bevara login
bevara publish
```

## Use in a page

```html
<video is="universal-video_1" src="movie.ext" using="mm_solver_1.0.1" with="{{NAME}}_1" controls></video>
```

or install it in a site project with `bevara install {{NAME}}`.
