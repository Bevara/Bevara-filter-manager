/* Staging a preserved pipeline for an F3 file.
 *
 * F3 (Zeng et al., PACMMOD 3(4) 245, 2025) embeds a WebAssembly decoder for
 * each encoding inside the data file, so the file stays readable when no
 * native decoder is at hand. Its Footer carries an OptionalMetadataSections
 * table, and the section named "WASMBinaries" holds, per the schema in
 * format/File.fbs:
 *
 *     table WASMBinaries {
 *       wasm_binaries: [MetadataSection];   // offset, size, compression
 *       lib_urls: [URL];                    // URL to the lib of each binary
 *     }
 *
 * Two things follow for Bevara.
 *
 * The first is that `lib_urls` already exists. §6.5 of the paper describes
 * fetching a decoder from a URL as something F3 "plans to offer", and lists
 * two obstacles: connectivity, and running code of unknown provenance. A
 * Bevara registry answers the second - every module is published with a
 * version, a licence, a patent status and an Ed25519 signature recorded in an
 * append-only log - so this writer fills `lib_urls` with the registry URL of
 * each accessor and records the digest the reader should check.
 *
 * The second is that a media column needs a *graph*, not one decoder: an .ogv
 * is a demultiplexer, a video decoder, an audio decoder and a multiplexer.
 * F3's unit is one binary per encoding. So the pipeline is staged as one
 * logical decoder - the solver - with the accessors it links at run time
 * named alongside it, which is what `bevara.pipeline` below records.
 *
 * What this writes is the *payload*, not an F3 file: the binaries, the media,
 * the page, and an optional-sections.json holding exactly what an F3 writer
 * has to serialise into the Footer. Producing the container itself needs
 * fff-poc; see docs and the companion article.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const BUNDLE_SUFFIX = '.bevara.f3';
const SECTION = 'WASMBinaries';

const sha256 = (buf) => 'sha256-' + createHash('sha256').update(buf).digest('base64');

/* Items come from preserve() in the same shape the MP4 writer takes:
 * { id, name, path, kind, type, from }. `kind` is 'page' | 'media' | a module
 * kind ('solver', 'accessor', 'tags'). */
/* "bevara:libpsd@1.0.3" is a package reference, not something a reader can
 * fetch. lib_urls has to hold a URL that resolves, so the reference is turned
 * into the registry's own address for that file - the flat, latest-for-this-
 * ABI path the accessors tree serves. */
function libUrlFor(registry, ref, fileName) {
  if (!registry) return null;
  const base = String(registry).replace(/\/+$/, '') + '/accessors/';
  const m = /^([^:]+):([^@]+)@(.+)$/.exec(ref ?? '');
  if (m) return base + encodeURIComponent(`${m[1]}:${m[2]}`) + '/' + m[3] + '/' + fileName;
  return base + fileName;
}

export function writeBundle(items, out, { pipeline, media, registry } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });

  const written = [];
  /* Offsets are the ones the binaries would have once concatenated into the
   * file's optional-data region, in the order they are listed - that is what
   * MetadataSection.offset means. They are recorded now so the F3 writer can
   * place the region wherever it likes and shift by one base. */
  let offset = 0;
  const sections = { names: [], offsets: [], sizes: [], compression_types: [] };
  const wasmBinaries = [];
  const libUrls = [];

  for (const it of items) {
    const bytes = fs.readFileSync(it.path);
    const isWasm = it.name.endsWith('.wasm');
    const dest = isWasm ? path.join(out, 'wasm', path.basename(it.name))
      : path.join(out, it.kind === 'media' ? path.join('media', path.basename(it.name)) : path.basename(it.name));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);

    const rec = { id: it.id, name: it.name, kind: it.kind, type: it.type, size: bytes.length,
                  integrity: sha256(bytes), from: it.from ?? null,
                  file: path.relative(out, dest).split(path.sep).join('/') };
    written.push(rec);

    if (isWasm) {
      sections.names.push(path.basename(it.name));
      sections.offsets.push(offset);
      sections.sizes.push(bytes.length);
      sections.compression_types.push('Uncompressed');
      wasmBinaries.push({ offset, size: bytes.length, compression_type: 'Uncompressed' });
      libUrls.push({ url: libUrlFor(registry, rec.from, path.basename(it.name)), package: rec.from ?? null, integrity: rec.integrity });
      offset += bytes.length;
    }
  }

  /* The shape an F3 writer serialises: OptionalMetadataSections naming one
   * "WASMBinaries" section, and the WASMBinaries table itself. Everything
   * outside those two is Bevara's own, under a namespaced key, so an F3
   * reader that ignores it loses nothing. */
  const descriptor = {
    format: 'f3-optional-data/draft-1',
    note: 'Payload for an F3 OptionalMetadataSections entry; not an F3 file. See bevara.pipeline for how the binaries compose.',
    optional_metadata_sections: {
      names: [SECTION],
      offsets: [0],
      sizes: [offset],
      compression_types: ['Uncompressed'],
    },
    WASMBinaries: { wasm_binaries: wasmBinaries, lib_urls: libUrls },
    'bevara.pipeline': {
      registry: registry ?? null,
      element: pipeline?.is ?? null,
      /* the graph, not a single encoding: the solver is the entry point and
         resolves the accessors into a filter chain at run time */
      solver: pipeline?.using ?? null,
      accessors: pipeline?.with ?? [],
      media: media ? { name: media.name, type: media.type, size: media.size } : null,
    },
    items: written,
  };
  fs.writeFileSync(path.join(out, 'optional-sections.json'), JSON.stringify(descriptor, null, 2) + '\n');

  const size = written.reduce((n, r) => n + r.size, 0);
  return { items: written, size, descriptor, wasmBytes: offset };
}

/* Reads a bundle back and checks every blob against the digest recorded for
 * it, as verify() does for the MP4 package. */
export function readBundle(dir) {
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, 'optional-sections.json'), 'utf8'));
  const problems = [];
  for (const it of descriptor.items) {
    const p = path.join(dir, it.file);
    if (!fs.existsSync(p)) { problems.push(`${it.name}: missing from the bundle`); continue; }
    const bytes = fs.readFileSync(p);
    if (bytes.length !== it.size) problems.push(`${it.name}: ${bytes.length} bytes, expected ${it.size}`);
    else if (sha256(bytes) !== it.integrity) problems.push(`${it.name}: digest differs`);
  }
  const s = descriptor.optional_metadata_sections;
  const declared = descriptor.WASMBinaries.wasm_binaries.reduce((n, b) => n + b.size, 0);
  if (s.sizes[0] !== declared) problems.push(`the ${SECTION} section is ${s.sizes[0]} bytes, its binaries total ${declared}`);
  return { ok: !problems.length, problems, descriptor };
}
