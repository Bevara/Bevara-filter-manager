import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sniff } from '../src/lib/sniff.js';

/* ------------------------------------------------- synthetic fixtures */
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const le16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
  return Buffer.concat([be32(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
// ftyp + moov/trak/mdia/{hdlr,minf/stbl/stsd}
function mp4(sampleEntry, handler = 'vide', brands = ['isom', 'mp41']) {
  const stsd = box('stsd', be32(0), be32(1), box(sampleEntry, Buffer.alloc(8)));
  const hdlr = box('hdlr', be32(0), be32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12));
  const trak = box('trak', box('mdia', hdlr, box('minf', box('stbl', stsd))));
  return Buffer.concat([
    box('ftyp', Buffer.from(brands[0], 'latin1'), be32(512), ...brands.slice(1).map((b) => Buffer.from(b, 'latin1'))),
    box('moov', trak),
  ]);
}
function oggPage(payload, { bos = true, serial = 1 } = {}) {
  const data = Buffer.from(payload, 'latin1');
  const segs = [];
  let left = data.length;
  while (left >= 255) { segs.push(255); left -= 255; }
  segs.push(left);
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head[4] = 0; head[5] = bos ? 0x02 : 0x00;
  head.writeUInt32BE(serial, 14);
  head[26] = segs.length;
  return Buffer.concat([head, Buffer.from(segs), data]);
}
const vint = (n) => { if (n < 0x7f) return Buffer.from([0x80 | n]); const b = Buffer.alloc(3); b[0] = 0x40 | (n >> 8); b[1] = n & 0xff; return b.subarray(0, 2); };
const el = (id, payload) => Buffer.concat([Buffer.from(id, 'hex'), vint(payload.length), payload]);
function mkv(codecId, trackType = 1, docType = 'webm') {
  const track = Buffer.concat([el('83', Buffer.from([trackType])), el('86', Buffer.from(codecId, 'latin1'))]);
  return Buffer.concat([
    el('1a45dfa3', el('4282', Buffer.from(docType, 'latin1'))),
    el('18538067', el('1654ae6b', el('ae', track))),
  ]);
}
function avi(fourcc, formatTag) {
  const strh = Buffer.concat([Buffer.from('strh', 'latin1'), le32(16), Buffer.from('vids', 'latin1'), Buffer.from(fourcc, 'latin1'), Buffer.alloc(8)]);
  const bih = Buffer.concat([le32(40), le32(640), le32(480), le16(1), le16(24), Buffer.from(fourcc, 'latin1'), Buffer.alloc(20)]);
  const strf = Buffer.concat([Buffer.from('strf', 'latin1'), le32(bih.length), bih]);
  const strhA = Buffer.concat([Buffer.from('strh', 'latin1'), le32(16), Buffer.from('auds', 'latin1'), Buffer.alloc(12)]);
  const wfx = Buffer.concat([le16(formatTag), le16(2), le32(48000), Buffer.alloc(8)]);
  const strfA = Buffer.concat([Buffer.from('strf', 'latin1'), le32(wfx.length), wfx]);
  const strl = (...c) => { const body = Buffer.concat([Buffer.from('strl', 'latin1'), ...c]); return Buffer.concat([Buffer.from('LIST', 'latin1'), le32(body.length), body]); };
  const hdrlBody = Buffer.concat([Buffer.from('hdrl', 'latin1'), strl(strh, strf), strl(strhA, strfA)]);
  const hdrl = Buffer.concat([Buffer.from('LIST', 'latin1'), le32(hdrlBody.length), hdrlBody]);
  const body = Buffer.concat([Buffer.from('AVI ', 'latin1'), hdrl]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(body.length), body]);
}

const codecs = (r) => r.streams.map((s) => `${s.type}/${s.codec}`);

describe('sniff: containers', () => {
  test('ISOBMFF sample entries name the codec, not the extension', () => {
    assert.equal(sniff({ head: mp4('hvc1'), name: 'x.mp4' }).format, 'hevc');
    assert.equal(sniff({ head: mp4('av01'), name: 'x.mp4' }).format, 'av1');
    assert.equal(sniff({ head: mp4('vvc1'), name: 'x.mp4' }).format, 'vvc');
    const r = sniff({ head: mp4('avc1'), name: 'x.mp4' });
    assert.equal(r.container, 'isobmff');
    assert.deepEqual(r.brands, ['isom', 'mp41']);
    assert.deepEqual(codecs(r), ['video/h264']);
  });

  test('ISOBMFF with moov only in the tail is still parsed', () => {
    const full = mp4('hvc1');
    const ftypLen = full.readUInt32BE(0);
    const head = Buffer.concat([full.subarray(0, ftypLen), Buffer.alloc(4096)]);  // mdat-ish filler
    const r = sniff({ head, tail: full.subarray(ftypLen), name: 'x.mp4' });
    assert.equal(r.format, 'hevc');
    assert.deepEqual(codecs(r), ['video/hevc']);
  });

  test('an unmapped sample entry is reported, not guessed', () => {
    const r = sniff({ head: mp4('zzzz'), name: 'x.mp4' });
    assert.equal(r.streams[0].codec, null);
    assert.match(r.warnings.join(' '), /unmapped sample entry/);
  });

  test('AVIF and HEIF images are recognised from the ftyp brand alone', () => {
    const r = sniff({ head: Buffer.concat([box('ftyp', Buffer.from('avif', 'latin1'), be32(0))]), name: 'x.avif' });
    assert.deepEqual(codecs(r), ['image/av1']);
  });

  test('Ogg BOS pages enumerate every logical bitstream', () => {
    const head = Buffer.concat([
      oggPage('\x80theora........', { serial: 10 }),
      oggPage('\x01vorbis........', { serial: 20 }),
      oggPage('not a header', { bos: false, serial: 10 }),
    ]);
    const r = sniff({ head, name: 'movie.ogg' });
    assert.equal(r.container, 'ogg');
    assert.equal(r.format, 'theora');                 // video leads, not the .ogg extension
    assert.deepEqual(codecs(r), ['video/theora', 'audio/vorbis']);
    assert.deepEqual(r.streams.map((s) => s.id), [10, 20]);
    assert.deepEqual(r.warnings, []);                 // .ogg is a legitimate Theora extension
  });

  test('Ogg Opus and FLAC', () => {
    assert.deepEqual(codecs(sniff({ head: oggPage('OpusHead........'), name: 'a.opus' })), ['audio/opus']);
    assert.deepEqual(codecs(sniff({ head: oggPage('\x7fFLAC.........'), name: 'a.ogg' })), ['audio/flac']);
  });

  test('Matroska CodecIDs, including a non-webm DocType', () => {
    assert.deepEqual(codecs(sniff({ head: mkv('V_AV1'), name: 'x.webm' })), ['video/av1']);
    const r = sniff({ head: mkv('V_MPEG4/ISO/AVC', 1, 'matroska'), name: 'x.mkv' });
    assert.equal(r.container, 'matroska');
    assert.equal(r.format, 'h264');
    const audio = sniff({ head: mkv('A_OPUS', 2), name: 'x.webm' });
    assert.deepEqual(codecs(audio), ['audio/opus']);
  });

  test('AVI reads the fourcc and the WAVE format tag', () => {
    const r = sniff({ head: avi('XVID', 0x0055), name: 'x.avi' });
    assert.equal(r.container, 'avi');
    assert.deepEqual(codecs(r), ['video/mpeg4-part2', 'audio/mp3']);
    assert.equal(r.streams[0].fourcc, 'XVID');
  });

  test('elementary streams have no container', () => {
    const png = sniff({ head: Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex'), name: 'x.png' });
    assert.equal(png.container, null);
    assert.equal(png.kind, 'image');
    assert.deepEqual(png.with, ['libpng_1']);
  });

  test('unrecognised content is reported rather than guessed', () => {
    const r = sniff({ head: Buffer.alloc(64, 0x5a), name: 'mystery.bin' });
    assert.equal(r.format, null);
    assert.deepEqual(r.with, []);
    assert.match(r.warnings.join(' '), /not recognised/);
  });
});

describe('sniff: pipelines', () => {
  test('assembles demultiplexer + decoders + encoder tail for video', () => {
    const r = sniff({ head: Buffer.concat([oggPage('\x80theora...'), oggPage('\x01vorbis...', { serial: 2 })]), name: 'm.ogv' });
    assert.equal(r.pipelineSource, 'assembled');
    assert.deepEqual(r.with, ['ogg_1', 'theora_1', 'vorbis_1', 'isobmff_1', 'libx264_1', 'libopusenc_1']);
    assert.equal(r.using, 'mm_solver_1.0.1');
  });

  test('audio and image pipelines carry no encoder tail', () => {
    assert.deepEqual(sniff({ head: oggPage('\x01vorbis...'), name: 'a.ogg' }).with, ['ogg_1', 'vorbis_1']);
    assert.equal(sniff({ head: oggPage('\x01vorbis...'), name: 'a.ogg' }).using, 'mm_solver_minimal_1.0.1');
  });

  test('requirements are exposed for registry matching', () => {
    const r = sniff({ head: mp4('hvc1'), name: 'x.mp4' });
    assert.deepEqual(r.required, { demux: 'isobmff', decode: ['hevc'] });
  });

  test('falls back to the curated pipeline when a codec has no mapping', () => {
    const r = sniff({ head: avi('ZZZZ', 0x0055), name: 'x.avi' });
    assert.equal(r.pipelineSource, 'curated');
    assert.ok(r.with.includes('avidmx_1'));
  });
});

/* The Showcase corpus is not part of this repository; when it is checked out
 * next to it, probe every file we have an expectation for. */
const SHOWCASE = path.resolve(process.env.BEVARA_SHOWCASE ?? '../../../Showcase', '');
const CORPUS = [
  ['test_sequences/trailer_1080p.ogg', 'theora', ['video/theora', 'audio/vorbis']],
  ['test_sequences/CityHall_640x360.webm', 'av1', ['video/av1']],
  ['test_sequences/elephants-dream.webm', 'vp9', ['video/vp8', 'audio/vorbis']],
  ['test_sequences/hevcds_720p30_2M.mp4', 'hevc', ['video/hevc', 'audio/aac']],
  ['test_sequences/NovosobornayaSquare_640x360.mp4', 'vvc', ['video/vvc']],
  ['test_sequences/Canyon-5.1-48khz-448kbit.ac3', 'ac3', ['audio/ac3']],
  ['test_sequences/zoltan-tasi-CLJeQCr2F_A-unsplash.jxl', 'jxl', ['image/jxl']],
  ['test_sequences/sample_1280x720_surfing_with_audio.mpeg', 'mpeg2', ['video/mpeg2video', 'audio/mp2']],
  ['flac/recit16bit.flac', 'flac', ['audio/flac']],
  ['png/Freedom.png', 'png', ['image/png']],
];

describe('sniff: real media corpus', { skip: !fs.existsSync(SHOWCASE) && 'Showcase checkout not found' }, () => {
  for (const [rel, format, expected] of CORPUS) {
    const file = path.join(SHOWCASE, rel);
    test(`${rel} is ${format}`, { skip: !fs.existsSync(file) && 'missing sample' }, () => {
      const fd = fs.openSync(file, 'r');
      const st = fs.fstatSync(fd);
      const head = Buffer.alloc(Math.min(262144, st.size));
      fs.readSync(fd, head, 0, head.length, 0);
      const tailLen = Math.min(1048576, Math.max(0, st.size - head.length));
      const tail = Buffer.alloc(tailLen);
      if (tailLen) fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
      fs.closeSync(fd);
      const r = sniff({ head, tail, name: file, size: st.size });
      assert.equal(r.format, format);
      assert.deepEqual(codecs(r), expected);
      assert.ok(r.with.length > 0);
    });
  }
});
