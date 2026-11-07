/* A file packaged with what plays it, as one ISOBMFF file (MMSys'27 §5.3).
 *
 * The layout is the one MP4Box writes for `-set-meta html -add-item … -set-primary`,
 * which the MP4 Service Worker reads:
 *
 *   ftyp   isom, iso2
 *   meta   hdlr "html"     - the items are meant for a browser
 *          pitm            - the primary item: the page served in place of the file
 *          iloc            - where each item's bytes are, in the mdat
 *          iinf/infe       - each item's name (its path relative to the page) and MIME type
 *   mdat   the page, the tag scripts, the solver, the accessors (Wasm bytecode)
 *          and the media, one after the other
 *
 * The boxes are mp4box.js's; the item boxes have no writer there, so their
 * payloads are written here and the boxes' generic writer frames them. Item
 * data is copied from the files into the mdat as a stream: a preserved film is
 * never held in memory whole.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { BoxParser, DataStream, Endianness, Log, createFile } from 'mp4box';

Log.setLogLevel(Log.error);

const MAX_UINT32 = 2 ** 32 - 1;
const BOX = BoxParser.box;

function newStream() {
  const s = new DataStream();
  s.endianness = Endianness.BIG_ENDIAN;
  return s;
}
const bytesOf = (s) => new Uint8Array(s.buffer, 0, s.getPosition()).slice();

// A box of mp4box.js whose payload we provide; its generic writer adds the header.
function framed(type, payload, fullBox = { version: 0, flags: 0 }) {
  const box = new BOX[type]();
  Object.assign(box, fullBox, { data: payload });
  const s = newStream();
  box.write(s);
  return bytesOf(s);
}

function write(fn) {
  const s = newStream();
  fn(s);
  return bytesOf(s);
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

function writeSized(s, value, size) {
  if (size === 8) s.writeUint64(value);
  else s.writeUint32(value);
}

/* The meta box for `items` (in mdat order), the first item's data at `dataStart`. */
function metaBox(items, { primary, dataStart, wide, handlerName }) {
  const hdlr = new BOX.hdlr();
  Object.assign(hdlr, { handler: 'html', name: handlerName });
  const hdlrBytes = write((s) => hdlr.write(s));

  const pitm = framed('pitm', write((s) => s.writeUint16(primary)));

  // iloc v0: one extent per item, absolute file offsets (construction method 0).
  const size = wide ? 8 : 4;
  let offset = dataStart;
  const iloc = framed('iloc', write((s) => {
    s.writeUint8((size << 4) | size);    // offset_size, length_size
    s.writeUint8(0);                     // base_offset_size, reserved
    s.writeUint16(items.length);
    for (const item of items) {
      s.writeUint16(item.id);
      s.writeUint16(0);                  // data_reference_index: this file
      s.writeUint16(1);                  // extent_count
      writeSized(s, offset, size);
      writeSized(s, item.size, size);
      offset += item.size;
    }
  }));

  const infes = items.map((item) => framed('infe', write((s) => {
    s.writeUint16(item.id);
    s.writeUint16(0);                    // item_protection_index
    s.writeString('mime', undefined, 4);
    s.writeCString(item.name);
    s.writeCString(item.type);
    s.writeCString('');                  // content_encoding
  }), { version: 2, flags: 0 }));
  const iinf = framed('iinf', concat([write((s) => s.writeUint16(items.length)), ...infes]));

  return framed('meta', concat([hdlrBytes, pitm, iloc, iinf]));
}

/**
 * Writes the package.
 * @param {Array<{ id: number, name: string, type: string, path: string }>} items
 *   in the order their bytes go in the mdat; `name` is the path the page asks for.
 * @param {string} out the .mp4 to write
 * @param {{ primary: number, handlerName?: string }} opts
 * @returns {{ size: number, items: Array<item & { size: number, offset: number }> }}
 */
export async function writePackage(items, out, { primary, handlerName = 'Bevara preserved media' }) {
  const sized = items.map((i) => ({ ...i, size: fs.statSync(i.path).size }));
  const dataSize = sized.reduce((n, i) => n + i.size, 0);

  const ftyp = new BOX.ftyp();
  Object.assign(ftyp, { major_brand: 'isom', minor_version: 1, compatible_brands: ['isom', 'iso2'] });
  const ftypBytes = write((s) => ftyp.write(s));

  // Offsets and lengths are 32-bit unless the file is larger; the meta box's
  // size does not depend on the offsets' values, only on their width.
  const mdatHeader = (n) => { const m = new BOX.mdat(); m.size = n; return write((s) => m.writeHeader(s)); };
  const wide = ftypBytes.length + 64 * sized.length + dataSize + 16 > MAX_UINT32;
  const probe = metaBox(sized, { primary, dataStart: 0, wide, handlerName });
  const header = mdatHeader(dataSize);
  const dataStart = ftypBytes.length + probe.length + header.length;
  const meta = metaBox(sized, { primary, dataStart, wide, handlerName });

  const fd = fs.createWriteStream(out);
  await new Promise((resolve, reject) => fd.write(concat([ftypBytes, meta, header]), (e) => (e ? reject(e) : resolve())));
  for (const item of sized) {
    for await (const chunk of fs.createReadStream(item.path)) if (!fd.write(chunk)) await once(fd, 'drain');
  }
  await new Promise((resolve, reject) => fd.end((e) => (e ? reject(e) : resolve())));

  let offset = dataStart;
  return { size: dataStart + dataSize, items: sized.map((i) => { const r = { ...i, offset }; offset += i.size; return r; }) };
}

/**
 * Reads a package as the MP4 Service Worker does, with mp4box.js: its meta
 * handler, its primary item, and every item by name.
 * @returns {{ handler: string|undefined, primary: object|undefined, items: Array<{ id, name, type, size, data: Uint8Array }> }}
 */
export function readPackage(file) {
  const bytes = fs.readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  buffer.fileStart = 0;
  const iso = createFile();
  iso.appendBuffer(buffer);
  iso.flush();
  const items = Object.values(iso.items ?? {}).map((i) => {
    const item = iso.getItem(i.id);
    return { id: i.id, name: i.name, type: i.content_type, size: i.size, primary: !!i.primary, data: item?.data };
  });
  return { handler: iso.getMetaHandler(), primary: iso.getPrimaryItem(), items, hasItem: (name) => iso.hasItem(name) };
}

/* ---------------------------------------------------------------- tracks --
 *
 * §5.3 of the MMSys'27 paper writes the package with the media as a *track*:
 *
 *     MP4Box -add sequence.ogg -new sequence.mp4 -set-meta html \
 *            -add-item ./index.html:mime=text/html:id=1 … -set-primary 1
 *
 * so the result is still a movie a native player can open, with the modules
 * carried beside it. The writer above instead carries the media as one more
 * item, which is the only thing possible for a PSD or a camera raw - they
 * have no track representation - but loses that property for media GPAC can
 * import.
 *
 * These helpers restore the paper's form when GPAC is at hand and can import
 * the file, and let the caller fall back to the item form when it cannot.
 * They shell out to MP4Box rather than muxing here: importing an arbitrary
 * elementary stream into ISOBMFF is what MP4Box is, and reimplementing it
 * would be absurd.
 */

export function findMP4Box() {
  const r = spawnSync('MP4Box', ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const v = (r.stderr || r.stdout || '').split('\n')[0].trim();
  return { bin: 'MP4Box', version: v };
}

/* Imports `file` into `out` as one or more tracks. Returns the track count,
 * or 0 when GPAC declines it - which is the signal to fall back. */
export function remuxToTracks(bin, file, out) {
  fs.rmSync(out, { force: true });
  const add = spawnSync(bin, ['-quiet', '-add', file, '-new', out], { encoding: 'utf8' });
  if (add.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    fs.rmSync(out, { force: true });
    return { tracks: 0, why: (add.stderr || add.stdout || '').trim().split('\n').pop() };
  }
  /* MP4Box -info prints "# Movie Info - 2 tracks - TimeScale 600" and then
   * "# Track 1 Info - ID 1 …" per track - no "Track #". Counting the wrong
   * shape made every import look like a failure, including the Ogg/Theora
   * of the paper's own example, which GPAC imports perfectly well. */
  const info = spawnSync(bin, ['-info', out], { encoding: 'utf8' });
  const text = (info.stderr || '') + (info.stdout || '');
  const header = /^# Movie Info - (\d+) tracks?\b/m.exec(text);
  const tracks = header ? Number(header[1]) : (text.match(/^# Track \d+ Info\b/gm) || []).length;
  if (!tracks) { fs.rmSync(out, { force: true }); return { tracks: 0, why: 'no track after import' }; }
  return { tracks, info: text };
}

/* Attaches the meta box and its items to an existing movie, in place. */
export function addItems(bin, target, items, { primary = 1 } = {}) {
  const args = ['-set-meta', 'html'];
  for (const it of items) {
    const spec = [it.path, `name=${it.name}`, `mime=${it.type}`, `id=${it.id}`].join(':');
    args.push('-add-item', spec);
  }
  args.push('-set-primary', String(primary), target);
  const r = spawnSync(bin, ['-quiet', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().split('\n').pop() || 'MP4Box refused the items');
  return fs.statSync(target).size;
}
