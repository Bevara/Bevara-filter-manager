/* Content sniffing for `bevara probe`.
 *
 * Two layers, in increasing order of precision:
 *
 *  1. the format table (formats.js): magic signatures and extensions give the
 *     format of the file as a whole, the same decision the browser extension
 *     and the Service Worker make before handing an element to a pipeline;
 *  2. container parsers (here): Ogg, ISOBMFF, Matroska, AVI, MPEG-PS/TS and
 *     FLV are walked far enough to enumerate the *elementary streams* they
 *     carry, because that is what the pipeline resolver actually matches
 *     accessors against - an .mp4 may hold HEVC+AAC or AV1+Opus, and only the
 *     second pair needs a decoder on Chrome.
 *
 * Everything works on a byte window (head, and optionally tail, of the file):
 * no decoding, no Wasm, so probing a 4 GB file reads a few hundred kilobytes.
 */
import { fromMagic, fromExtension, fromMime, extensionOf, pipelineFor, byId, VIDEO_TAIL } from './formats.js';

const txt = (buf, off, len) => buf.toString('latin1', off, off + len);
const u16 = (buf, off) => buf.readUInt16BE(off);
const u32 = (buf, off) => buf.readUInt32BE(off);

/* ------------------------------------------------------------------ Ogg */
/* Bitstreams are identified by the first bytes of their first packet, carried
 * by the "beginning of stream" page of each logical stream. */
const OGG_CODECS = [
  ['\x01vorbis', { codec: 'vorbis', type: 'audio' }],
  ['\x80theora', { codec: 'theora', type: 'video' }],
  ['OpusHead', { codec: 'opus', type: 'audio' }],
  ['Speex   ', { codec: 'speex', type: 'audio' }],
  ['\x7fFLAC', { codec: 'flac', type: 'audio' }],
  ['\x80daala', { codec: 'daala', type: 'video' }],
  ['BBCD', { codec: 'dirac', type: 'video' }],
  ['\x80kate\0\0\0', { codec: 'kate', type: 'text' }],
  ['CMML\0\0\0\0', { codec: 'cmml', type: 'text' }],
  ['PCM     ', { codec: 'pcm', type: 'audio' }],
  ['\x01video\0', { codec: 'ogguvs', type: 'video' }],
  ['fishead\0', { codec: 'skeleton', type: 'metadata', ignore: true }],
  ['fisbone\0', { codec: 'skeleton', type: 'metadata', ignore: true }],
];

function parseOgg(buf) {
  const streams = [];
  let off = 0;
  // Only BOS pages matter and they all sit at the start of the file; stop at
  // the first page that is not one rather than walking the whole stream.
  while (off + 27 <= buf.length) {
    if (txt(buf, off, 4) !== 'OggS') break;
    const headerType = buf[off + 5];
    const nsegs = buf[off + 26];
    const segTable = off + 27;
    if (segTable + nsegs > buf.length) break;
    let payload = 0;
    for (let i = 0; i < nsegs; i++) payload += buf[segTable + i];
    const dataOff = segTable + nsegs;
    if (headerType & 0x02) {                       // beginning of stream
      const serial = u32(buf, off + 14);
      const head = txt(buf, dataOff, Math.min(16, buf.length - dataOff));
      const hit = OGG_CODECS.find(([sig]) => head.startsWith(sig));
      if (hit && !hit[1].ignore) streams.push({ ...hit[1], id: serial });
      else if (!hit) streams.push({ type: 'unknown', codec: null, id: serial, note: 'unrecognised Ogg bitstream' });
    } else break;
    off = dataOff + payload;
  }
  return { container: 'ogg', streams };
}

/* -------------------------------------------------------------- ISOBMFF */
const ISOBMFF_SAMPLE_ENTRIES = {
  avc1: ['video', 'h264'], avc3: ['video', 'h264'], avc2: ['video', 'h264'], avc4: ['video', 'h264'],
  hvc1: ['video', 'hevc'], hev1: ['video', 'hevc'], hvt1: ['video', 'hevc'],
  vvc1: ['video', 'vvc'], vvi1: ['video', 'vvc'],
  av01: ['video', 'av1'], vp08: ['video', 'vp8'], vp09: ['video', 'vp9'],
  mp4v: ['video', 'mpeg4-part2'], s263: ['video', 'h263'], h263: ['video', 'h263'],
  jpeg: ['video', 'mjpeg'], mjp2: ['video', 'jpeg2000'], mjpa: ['video', 'mjpeg'],
  dvhe: ['video', 'dolbyvision'], dvav: ['video', 'dolbyvision'], dav1: ['video', 'dolbyvision'],
  encv: ['video', 'encrypted'], enca: ['audio', 'encrypted'],
  mp4a: ['audio', 'aac'], 'ac-3': ['audio', 'ac3'], 'ec-3': ['audio', 'eac3'], ac4: ['audio', 'ac4'],
  Opus: ['audio', 'opus'], fLaC: ['audio', 'flac'], alac: ['audio', 'alac'],
  twos: ['audio', 'pcm'], sowt: ['audio', 'pcm'], lpcm: ['audio', 'pcm'], raw: ['audio', 'pcm'],
  samr: ['audio', 'amr'], sawb: ['audio', 'amr-wb'], dtsc: ['audio', 'dts'], dtse: ['audio', 'dts'],
  '.mp3': ['audio', 'mp3'], mp3: ['audio', 'mp3'],
  tx3g: ['text', 'tx3g'], wvtt: ['text', 'webvtt'], stpp: ['text', 'ttml'], sbtt: ['text', 'subtitle'],
};
const HANDLER_TYPES = { vide: 'video', soun: 'audio', text: 'text', sbtl: 'text', subt: 'text', meta: 'metadata', hint: 'hint' };
const ISOBMFF_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf', 'udta']);

// Walks boxes in [start, end), calling visit(type, bodyStart, bodyEnd, depth).
function walkBoxes(buf, start, end, visit, depth = 0) {
  let off = start;
  while (off + 8 <= end) {
    let size = u32(buf, off);
    const type = txt(buf, off + 4, 4);
    let body = off + 8;
    if (size === 1) {                       // 64-bit largesize
      if (off + 16 > end) break;
      const hi = u32(buf, off + 8), lo = u32(buf, off + 12);
      size = hi * 2 ** 32 + lo;
      body = off + 16;
    } else if (size === 0) size = end - off; // extends to end of file
    if (size < 8) break;
    const boxEnd = Math.min(off + size, end);
    visit(type, body, boxEnd, depth);
    if (ISOBMFF_CONTAINERS.has(type)) walkBoxes(buf, body, boxEnd, visit, depth + 1);
    off += size;
    if (!Number.isFinite(off)) break;
  }
}

// Many files keep `moov` at the end; when it is not in the head window, look
// for it in the tail by scanning for a box header that makes sense.
function findMoov(tail) {
  for (let i = 0; i + 8 <= tail.length; i++) {
    if (txt(tail, i, 4) !== 'moov') continue;
    const size = i >= 4 ? u32(tail, i - 4) : 0;
    if (size >= 8 && i - 4 + size <= tail.length + 8) return i - 4;
  }
  return -1;
}

function parseIsobmff(buf, tail) {
  const info = { container: 'isobmff', brands: [], streams: [], fragmented: false };
  let sawMoov = false;
  const collect = (b, from, to) => {
    let handler = null;
    walkBoxes(b, from, to, (type, bodyStart, bodyEnd) => {
      if (type === 'ftyp') {
        info.brands = [txt(b, bodyStart, 4).trim()];
        for (let o = bodyStart + 8; o + 4 <= bodyEnd; o += 4) info.brands.push(txt(b, o, 4).trim());
      } else if (type === 'moov') sawMoov = true;
      else if (type === 'mvex') info.fragmented = true;
      else if (type === 'hdlr' && bodyStart + 12 <= bodyEnd) handler = HANDLER_TYPES[txt(b, bodyStart + 8, 4)] ?? null;
      else if (type === 'stsd' && bodyStart + 8 <= bodyEnd) {
        const count = u32(b, bodyStart + 4);
        let o = bodyStart + 8;
        for (let i = 0; i < count && o + 8 <= bodyEnd; i++) {
          const entrySize = u32(b, o);
          const fmt = txt(b, o + 4, 4);
          const known = ISOBMFF_SAMPLE_ENTRIES[fmt] ?? ISOBMFF_SAMPLE_ENTRIES[fmt.trim()];
          info.streams.push(known
            ? { type: known[0], codec: known[1], sampleEntry: fmt }
            : { type: handler ?? 'unknown', codec: null, sampleEntry: fmt, note: `unmapped sample entry "${fmt}"` });
          if (entrySize < 8) break;
          o += entrySize;
        }
      }
    });
  };
  collect(buf, 0, buf.length);
  if (!sawMoov && tail?.length) {
    const at = findMoov(tail);
    if (at >= 0) collect(tail, at, tail.length);
  }
  // Image-only HEIF/AVIF files have no stsd; the brand is the codec.
  if (!info.streams.length) {
    const b = info.brands;
    if (b.some((x) => x === 'avif' || x === 'avis')) info.streams.push({ type: 'image', codec: 'av1', note: 'from ftyp brand' });
    else if (b.some((x) => ['heic', 'heix', 'heim', 'heis', 'hevc'].includes(x))) info.streams.push({ type: 'image', codec: 'hevc', note: 'from ftyp brand' });
    else if (b.includes('mif1') || b.includes('msf1')) info.streams.push({ type: 'image', codec: null, note: 'HEIF image, codec in the item properties' });
  }
  return info;
}

/* ------------------------------------------------------------- Matroska */
const MKV_CODECS = {
  V_VP8: 'vp8', V_VP9: 'vp9', V_AV1: 'av1', V_THEORA: 'theora', V_DIRAC: 'dirac',
  'V_MPEG4/ISO/AVC': 'h264', 'V_MPEGH/ISO/HEVC': 'hevc', 'V_MPEGI/ISO/VVC': 'vvc',
  'V_MPEG4/ISO/ASP': 'mpeg4-part2', 'V_MPEG4/ISO/SP': 'mpeg4-part2', 'V_MPEG4/ISO/AP': 'mpeg4-part2',
  'V_MPEG4/MS/V3': 'msmpeg4v3', V_MPEG1: 'mpeg1video', V_MPEG2: 'mpeg2video',
  'V_REAL/RV40': 'rv40', V_QUICKTIME: 'quicktime', V_UNCOMPRESSED: 'raw',
  A_OPUS: 'opus', A_VORBIS: 'vorbis', A_FLAC: 'flac', A_AAC: 'aac', A_AC3: 'ac3',
  'A_AC3/BSID9': 'ac3', 'A_AC3/BSID10': 'ac3', A_EAC3: 'eac3', A_DTS: 'dts', A_TRUEHD: 'truehd',
  'A_MPEG/L3': 'mp3', 'A_MPEG/L2': 'mp2', 'A_MPEG/L1': 'mp1', A_ALAC: 'alac', A_TTA1: 'tta',
  'A_PCM/INT/LIT': 'pcm', 'A_PCM/INT/BIG': 'pcm', 'A_PCM/FLOAT/IEEE': 'pcm', A_WAVPACK4: 'wavpack',
  'S_TEXT/UTF8': 'srt', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ssa', 'S_TEXT/WEBVTT': 'webvtt',
  S_VOBSUB: 'vobsub', 'S_HDMV/PGS': 'pgs', 'S_DVBSUB': 'dvbsub',
};
const MKV_TRACK_TYPE = { 1: 'video', 2: 'audio', 3: 'complex', 16: 'logo', 17: 'text', 18: 'buttons', 32: 'control' };

// EBML variable-size integer. `keepMarker` is what element IDs need.
function ebmlVint(buf, off, keepMarker) {
  if (off >= buf.length) return null;
  const first = buf[off];
  if (first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + buf[off + i];
  return { value, len };
}

function parseMatroska(buf) {
  const info = { container: 'matroska', docType: null, streams: [] };
  const walk = (start, end, inside) => {
    let off = start;
    while (off < end) {
      const id = ebmlVint(buf, off, true);
      if (!id) return;
      const size = ebmlVint(buf, off + id.len, false);
      if (!size) return;
      const body = off + id.len + size.len;
      const bodyEnd = Math.min(body + size.value, end);
      switch (id.value) {
        case 0x1a45dfa3: walk(body, bodyEnd, 'ebml'); break;         // EBML header
        case 0x4282: info.docType = txt(buf, body, bodyEnd - body).replace(/\0+$/, ''); break;
        case 0x18538067: walk(body, bodyEnd, 'segment'); break;      // Segment
        case 0x1654ae6b: walk(body, bodyEnd, 'tracks'); break;       // Tracks
        case 0xae: walk(body, bodyEnd, 'track'); break;               // TrackEntry
        case 0x83: {                                                 // TrackType
          let v = 0; for (let i = body; i < bodyEnd; i++) v = v * 256 + buf[i];
          info._pendingType = MKV_TRACK_TYPE[v] ?? 'unknown';
          break;
        }
        case 0x86: {                                                 // CodecID
          const raw = txt(buf, body, bodyEnd - body).replace(/\0+$/, '');
          info._pendingCodec = raw;
          break;
        }
        case 0x1f43b675: return;                                     // Cluster: media data, stop
        default: break;
      }
      // A TrackEntry is complete once we leave it.
      if (id.value === 0xae) {
        const codecId = info._pendingCodec;
        const codec = codecId ? MKV_CODECS[codecId] ?? null : null;
        info.streams.push({
          type: info._pendingType ?? 'unknown', codec, codecId,
          ...(codecId && !codec ? { note: `unmapped Matroska CodecID "${codecId}"` } : {}),
        });
        info._pendingCodec = info._pendingType = undefined;
      }
      if (size.value === 0 || !Number.isFinite(bodyEnd)) return;
      off = body + size.value;
    }
  };
  walk(0, buf.length, 'root');
  delete info._pendingCodec; delete info._pendingType;
  if (info.docType === 'webm') info.container = 'webm';
  return info;
}

/* ------------------------------------------------------------------ AVI */
const AVI_VIDEO_FOURCC = {
  H264: 'h264', h264: 'h264', X264: 'h264', x264: 'h264', avc1: 'h264', AVC1: 'h264', DAVC: 'h264',
  HEVC: 'hevc', hvc1: 'hevc', hev1: 'hevc', H265: 'hevc',
  XVID: 'mpeg4-part2', xvid: 'mpeg4-part2', DIVX: 'mpeg4-part2', DX50: 'mpeg4-part2', divx: 'mpeg4-part2',
  MP4V: 'mpeg4-part2', FMP4: 'mpeg4-part2', DIV3: 'msmpeg4v3', MP43: 'msmpeg4v3',
  MJPG: 'mjpeg', mjpg: 'mjpeg', JPEG: 'mjpeg', AVRn: 'mjpeg', dmb1: 'mjpeg',
  H261: 'h261', H263: 'h263', U263: 'h263', M263: 'h263',
  ULRG: 'utvideo', ULY0: 'utvideo', ULY2: 'utvideo', ULH0: 'utvideo', ULH2: 'utvideo',
  WMV3: 'wmv3', WVC1: 'vc1', DVSD: 'dv', dvsd: 'dv', VP80: 'vp8', VP90: 'vp9', AV01: 'av1',
  MPEG: 'mpeg1video', mpg1: 'mpeg1video', mpg2: 'mpeg2video', MPG2: 'mpeg2video',
  DIB: 'raw', RGB: 'raw', Y800: 'raw', YUY2: 'raw', UYVY: 'raw', I420: 'raw',
};
const AVI_AUDIO_TAGS = {
  0x0001: 'pcm', 0x0002: 'adpcm', 0x0003: 'pcm-float', 0x0006: 'alaw', 0x0007: 'mulaw',
  0x0011: 'adpcm', 0x0031: 'gsm', 0x0050: 'mp2', 0x0055: 'mp3', 0x0092: 'ac3',
  0x00ff: 'aac', 0x0160: 'wma', 0x0161: 'wma', 0x0162: 'wma', 0x0163: 'wma-lossless',
  0x2000: 'ac3', 0x2001: 'dts', 0xf1ac: 'flac', 0x706d: 'aac',
};

function parseRiff(buf) {
  const form = txt(buf, 8, 4);
  const info = { container: form === 'AVI ' ? 'avi' : form === 'WAVE' ? 'wav' : 'riff', streams: [] };
  let pendingType = null;
  const walk = (start, end) => {
    let off = start;
    while (off + 8 <= end) {
      const id = txt(buf, off, 4);
      const size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      const bodyEnd = Math.min(body + size, end);
      if (id === 'LIST' || id === 'RIFF') walk(body + 4, bodyEnd);
      else if (id === 'strh' && body + 8 <= bodyEnd) pendingType = txt(buf, body, 4);
      else if (id === 'strf' && body + 2 <= bodyEnd) {
        if (pendingType === 'vids' && body + 20 <= bodyEnd) {
          const fourcc = txt(buf, body + 16, 4);
          const codec = AVI_VIDEO_FOURCC[fourcc] ?? AVI_VIDEO_FOURCC[fourcc.trim()] ?? null;
          info.streams.push({ type: 'video', codec, fourcc, ...(codec ? {} : { note: `unmapped AVI fourcc "${fourcc}"` }) });
        } else if (pendingType === 'auds') {
          const tag = buf.readUInt16LE(body);
          const codec = AVI_AUDIO_TAGS[tag] ?? null;
          info.streams.push({ type: 'audio', codec, formatTag: '0x' + tag.toString(16).padStart(4, '0'), ...(codec ? {} : { note: 'unmapped WAVE format tag' }) });
        } else if (pendingType === 'txts') info.streams.push({ type: 'text', codec: null });
        pendingType = null;
      } else if (id === 'fmt ' && info.container === 'wav') {
        const tag = buf.readUInt16LE(body);
        info.streams.push({ type: 'audio', codec: AVI_AUDIO_TAGS[tag] ?? null, formatTag: '0x' + tag.toString(16).padStart(4, '0') });
      } else if (id === 'movi' || id === 'data') return;   // media payload
      off = body + size + (size & 1);                      // chunks are word-aligned
      if (size === 0 && id !== 'JUNK') return;
    }
  };
  walk(12, buf.length);
  return info;
}

/* ------------------------------------------------------- MPEG-TS and PS */
const TS_STREAM_TYPES = {
  0x01: ['video', 'mpeg1video'], 0x02: ['video', 'mpeg2video'], 0x03: ['audio', 'mp2'], 0x04: ['audio', 'mp2'],
  0x0f: ['audio', 'aac'], 0x11: ['audio', 'aac'], 0x1b: ['video', 'h264'], 0x20: ['video', 'h264'],
  0x24: ['video', 'hevc'], 0x27: ['video', 'hevc'], 0x33: ['video', 'vvc'], 0x51: ['video', 'av1'],
  0x81: ['audio', 'ac3'], 0x82: ['audio', 'dts'], 0x84: ['audio', 'eac3'], 0x87: ['audio', 'eac3'],
  0x06: ['unknown', null], 0x05: ['unknown', null],
};

function parseMpegTs(buf) {
  const info = { container: 'mpeg-ts', streams: [] };
  const PACKET = 188;
  let pmtPid = null;
  const seen = new Set();
  for (let off = 0; off + PACKET <= buf.length; off += PACKET) {
    if (buf[off] !== 0x47) break;
    const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
    const payloadStart = (buf[off + 1] & 0x40) !== 0;
    const adaptation = (buf[off + 3] & 0x30) >> 4;
    let p = off + 4;
    if (adaptation === 2) continue;
    if (adaptation === 3) p += 1 + buf[p];
    if (!payloadStart) continue;
    p += 1 + buf[p];                                    // pointer_field
    if (p + 8 > off + PACKET) continue;
    const tableId = buf[p];
    const sectionLen = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    const sectionEnd = Math.min(p + 3 + sectionLen, off + PACKET);
    if (pid === 0 && tableId === 0x00) {                // PAT
      for (let q = p + 8; q + 4 <= sectionEnd - 4; q += 4) {
        const programNumber = u16(buf, q);
        const target = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3];
        if (programNumber !== 0) { pmtPid = target; break; }
      }
    } else if (pmtPid !== null && pid === pmtPid && tableId === 0x02) {   // PMT
      const programInfoLen = ((buf[p + 10] & 0x0f) << 8) | buf[p + 11];
      let q = p + 12 + programInfoLen;
      while (q + 5 <= sectionEnd - 4) {
        const streamType = buf[q];
        const esPid = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2];
        const esInfoLen = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4];
        if (!seen.has(esPid)) {
          seen.add(esPid);
          const known = TS_STREAM_TYPES[streamType];
          info.streams.push(known && known[1]
            ? { type: known[0], codec: known[1], pid: esPid }
            : { type: 'unknown', codec: null, pid: esPid, note: `MPEG-TS stream_type 0x${streamType.toString(16)}` });
        }
        q += 5 + esInfoLen;
      }
      break;
    }
  }
  return info;
}

// Program stream: report what the PES start codes in the window reveal.
function parseMpegPs(buf) {
  const info = { container: 'mpeg-ps', streams: [] };
  const seen = new Set();
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 1) continue;
    const id = buf[i + 3];
    if (seen.has(id)) continue;
    if (id >= 0xe0 && id <= 0xef) { seen.add(id); info.streams.push({ type: 'video', codec: 'mpeg2video', streamId: '0x' + id.toString(16), note: 'MPEG-1 or MPEG-2 video' }); }
    else if (id >= 0xc0 && id <= 0xdf) { seen.add(id); info.streams.push({ type: 'audio', codec: 'mp2', streamId: '0x' + id.toString(16), note: 'MPEG audio layer I/II/III' }); }
    else if (id === 0xbd) { seen.add(id); info.streams.push({ type: 'audio', codec: null, streamId: '0xbd', note: 'private stream (AC-3, DTS or LPCM)' }); }
  }
  return info;
}

/* ------------------------------------------------------------------ FLV */
function parseFlv(buf) {
  const FLV_VIDEO = { 2: 'h263', 3: 'screen', 4: 'vp6', 5: 'vp6a', 7: 'h264', 12: 'hevc' };
  const FLV_AUDIO = { 0: 'pcm', 1: 'adpcm', 2: 'mp3', 4: 'nellymoser', 7: 'alaw', 8: 'mulaw', 10: 'aac', 11: 'speex', 14: 'mp3' };
  const info = { container: 'flv', streams: [] };
  const seen = new Set();
  let off = u32(buf, 5);                              // DataOffset
  off += 4;                                           // PreviousTagSize0
  while (off + 11 <= buf.length && seen.size < 2) {
    const tagType = buf[off] & 0x1f;
    const dataSize = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const body = off + 11;
    if (body >= buf.length) break;
    if (tagType === 9 && !seen.has('video')) {
      seen.add('video');
      info.streams.push({ type: 'video', codec: FLV_VIDEO[buf[body] & 0x0f] ?? null, note: FLV_VIDEO[buf[body] & 0x0f] ? undefined : `FLV video codec id ${buf[body] & 0x0f}` });
    } else if (tagType === 8 && !seen.has('audio')) {
      seen.add('audio');
      const id = (buf[body] & 0xf0) >> 4;
      info.streams.push({ type: 'audio', codec: FLV_AUDIO[id] ?? null, note: FLV_AUDIO[id] ? undefined : `FLV audio codec id ${id}` });
    }
    off = body + dataSize + 4;
  }
  return info;
}

/* ----------------------------------------------------------- dispatcher */
function parseContainer(head, tail) {
  if (head.length < 12) return null;
  const magic4 = txt(head, 0, 4);
  if (magic4 === 'OggS') return parseOgg(head);
  if (magic4 === 'RIFF') return parseRiff(head);
  if (magic4 === '\x1aE\xdf\xa3') return parseMatroska(head);
  if (txt(head, 0, 3) === 'FLV') return parseFlv(head);
  if (txt(head, 4, 4) === 'ftyp' || txt(head, 4, 4) === 'styp') return parseIsobmff(head, tail);
  if (head[0] === 0x47 && head[188] === 0x47) return parseMpegTs(head);
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && (head[3] === 0xba || head[3] === 0xb3)) return parseMpegPs(head);
  return null;
}

/* Which accessor provides what, when the registry cannot be reached. The
 * registry's capability index is authoritative (`bevara probe` queries it);
 * these tables are the offline answer and the names the Showcase demos use. */
const CONTAINER_MODULES = {
  ogg: ['ogg_1'],
  isobmff: ['isobmff_1'],
  matroska: ['webmdmx_1'],
  webm: ['webmdmx_1'],
  avi: ['avidmx_1'],
  flv: ['flvdmx_1'],
  wav: [],
  riff: [],
  'mpeg-ts': [],      // m2tsdmx is part of the solver core
  'mpeg-ps': [],      // m2psdmx likewise
};

const CODEC_MODULES = {
  // video
  theora: ['theora_1'], h264: ['h264bsd_1'], hevc: ['libde265_1'], vvc: ['libOpenVVC_1'],
  av1: ['libaom_1'], vp8: ['libvpx_1'], vp9: ['libvpx_1'], 'mpeg4-part2': ['libxvid_1'],
  msmpeg4v3: ['libxvid_1'], mpeg1video: ['ffmpeg-mpeg1_1'], mpeg2video: ['libmpeg2_1'],
  mjpeg: ['libjpeg_1'], h261: ['ffmpeg-h26x_1'], h263: ['ffmpeg-h26x_1'], dirac: ['libschro_1'],
  utvideo: ['libutvideo_1'], avs2: ['libdavs2_1'], avs3: ['libuavs3d_1'], evc: ['libxevd_1'],
  ffv1: ['ffmpeg-ffv1_1'], raw: ['rgbyuv_1'], dv: [], vc1: [], wmv3: [],
  // audio
  vorbis: ['vorbis_1'], opus: ['libopus_1'], speex: ['libspeex_1'], flac: ['libflac_1'],
  mp3: ['libmpg123_1'], mp2: ['libmpg123_1'], mp1: ['libmpg123_1'], aac: ['libfaad_1'],
  ac3: ['liba52_1'], eac3: ['liba52_1'], dts: ['libdca_1'], alac: ['libalac_1'],
  amr: ['libamr_1'], 'amr-wb': ['libamr_1'], pcm: ['rfpcm_1'], 'pcm-float': ['rfpcm_1'],
  alaw: ['libg711_1'], mulaw: ['libg711_1'], g726: ['ffmpeg-g726_1'], wavpack: ['libwavpack_1'],
  tta: ['libtta_1'], ape: ['libape_1'], musepack: ['libmpc_1'], gsm: ['libgsm_1'],
  codec2: ['libcodec2_1'], lc3: ['liblc3_1'], sbc: ['libsbc_1'], ilbc: ['libilbc_1'],
  // images
  jxl: ['libjxl_1'], png: ['libpng_1'], jpeg: ['libjpeg_1'], webp: ['libwebp_1'],
  gif: ['libgif_1'], tiff: ['libtiff_1'], jpeg2000: ['openjpeg_1'], bmp: ['simpleimg_1'],
  qoi: ['libqoi_1'], bpg: ['libbpg_1'], heif: ['libheif_1'],
  // carried but not decodable on their own
  srt: [], ass: [], ssa: [], webvtt: [], ttml: [], tx3g: [], vobsub: [], pgs: [], dvbsub: [],
  subtitle: [], encrypted: [], skeleton: [], kate: [], cmml: [],
};

const STREAM_ORDER = { video: 0, image: 1, audio: 2, text: 3, metadata: 4, unknown: 5 };

/* Elementary streams that are their own file: the format table already names
 * the codec, so the "container" is the codec itself. */
const ELEMENTARY_KIND = { image: 'image', audio: 'audio', video: 'video' };

/**
 * @param {{head: Buffer, tail?: Buffer, name?: string, mime?: string, size?: number}} input
 */
export function sniff({ head, tail, name = '', mime = null, size = null }) {
  const warnings = [];
  const evidence = [];

  const byMagic = head?.length ? fromMagic(head.subarray(0, Math.min(head.length, 65536))) : null;
  if (byMagic) evidence.push('magic bytes');
  const ext = name ? extensionOf(name) : '';
  const byExt = name ? fromExtension(name) : null;
  if (byExt) evidence.push(`extension .${ext}`);
  const byMimeHint = mime ? fromMime(mime) : null;
  if (byMimeHint) evidence.push(`declared type ${mime}`);

  const container = parseContainer(head ?? Buffer.alloc(0), tail);
  if (container) evidence.push(`${container.container} structure`);

  let format = byMagic ?? byMimeHint ?? byExt ?? null;

  const streams = (container?.streams ?? (format
    ? [{ type: ELEMENTARY_KIND[format.kind] ?? format.kind, codec: format.id, note: 'elementary stream (no container)' }]
    : [])).slice().sort((a, b) => (STREAM_ORDER[a.type] ?? 9) - (STREAM_ORDER[b.type] ?? 9));

  /* The table reports one format per file, picked by the first matching
   * signature, so an .mp4 is "h264" and a .webm is "vp9" whatever they hold.
   * The container told us the real codecs: name the file after its leading
   * one when that codec is a format we know. */
  // Only the dominant stream may rename the file: an AVI whose video track we
  // could not identify stays an AVI, it does not become its audio codec.
  const visual = streams.find((s) => s.type === 'video' || s.type === 'image');
  const lead = visual ? (visual.codec ? visual : null) : streams.find((s) => s.type === 'audio' && s.codec);
  if (lead) {
    const better = byId.get(lead.codec);
    if (better && better.id !== format?.id) {
      format = better;
      evidence.push(`codec ${lead.codec} in ${container?.container ?? 'stream'}`);
    }
  }

  // Only a genuine disagreement is worth reporting: an extension that the
  // detected format itself declares (.ogg for Theora) is not one.
  if (byMagic && ext && !byMagic.ext.includes(ext) && byExt && byMagic.kind !== byExt.kind)
    warnings.push(`content looks like ${byMagic.id} but the extension suggests ${byExt.id}`);
  if (!format) warnings.push('format not recognised: no magic signature, extension or declared type matched');
  for (const s of streams) if (!s.codec && !['metadata', 'text'].includes(s.type)) warnings.push(s.note ?? `unidentified ${s.type} stream`);

  /* Pipeline: demultiplexer for the container, a decoder per elementary
   * stream, and for video the encoder tail that every browser can play. */
  const modules = [];
  const push = (m) => { if (m && !modules.includes(m)) modules.push(m); };
  const known = new Set(Object.keys(CODEC_MODULES));
  let unmapped = false;
  for (const m of CONTAINER_MODULES[container?.container] ?? []) push(m);
  for (const s of streams) {
    if (['metadata', 'text'].includes(s.type)) continue;
    // A stream we could not identify, or a codec with no accessor mapping,
    // means the assembled list would be missing a decoder: fall back instead
    // of handing out a pipeline that cannot decode the file.
    if (!s.codec || !known.has(s.codec)) { unmapped = true; continue; }
    for (const m of CODEC_MODULES[s.codec]) push(m);
  }
  // Nothing recognised (or codecs we have no mapping for): fall back to the
  // curated pipeline of the format entry, which covers the demo cases.
  const curated = format ? pipelineFor(format) : { using: null, with: [] };
  const assembled = modules.length > 0 && !unmapped;
  const kind = format?.kind ?? (streams.some((s) => s.type === 'video') ? 'video' : null);
  if (assembled && kind === 'video') for (const m of VIDEO_TAIL) push(m);
  const withList = assembled ? modules : curated.with.slice();

  return {
    format: format?.id ?? null,
    kind: format?.kind ?? null,
    mime: format?.mime?.[0] ?? mime ?? null,
    probe: format?.probe ?? null,
    native: format?.native ?? null,
    container: container?.container ?? null,
    brands: container?.brands,
    fragmented: container?.fragmented,
    streams,
    // What the pipeline must be able to do, for matching against a registry.
    required: {
      demux: container?.container ?? null,
      decode: [...new Set(streams.filter((s) => s.codec && !['metadata'].includes(s.type)).map((s) => s.codec))],
    },
    using: curated.using ?? (kind === 'video' ? 'solver_1' : 'solver_minimal_1'),
    with: withList,
    pipelineSource: assembled ? 'assembled' : 'curated',
    size,
    evidence,
    warnings,
  };
}

export { CONTAINER_MODULES, CODEC_MODULES };
export { parseOgg, parseIsobmff, parseMatroska, parseRiff, parseMpegTs, parseFlv };
