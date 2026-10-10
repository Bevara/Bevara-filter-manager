import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { needsOf, videoTailNeeds, resolveNeeds, resolvePipeline, pageSolver, describeNeed, elementFor } from '../src/lib/capabilities.js';
import { mediaTracks, closeMediaInfo } from '../src/lib/mediainfo.js';
import { readSource } from '../src/lib/source.js';

// Index entries as /accessors/index.json serves them, from the editor's manifests.
const entry = (module, fields = {}) => ({ name: `bevara:${module.toLowerCase()}`, version: '1.0.0', file: `${module}_1.wasm`, ...fields });
const LIBJXL = entry('libjxl', { formats: ['jxl'], extension: { jxl: 'img' } });
const ISOBMFF = entry('isobmff', { formats: ['MPEG-4'], extension: { mp4: 'video', mov: 'video', heic: 'img' } });
const OPENJPEG = entry('openjpeg', { formats: ['JPEG 2000', 'j2k1'] });
const OGG = entry('ogg', { formats: ['Ogg'], extension: { ogg: 'audio' } });
const THEORA = entry('theora', { formats: ['Theora'] });
const VORBIS = entry('vorbis', { formats: ['Vorbis'], extension: { ogg: 'audio' } });

const tracks = (general, ...streams) => [{ '@type': 'General', Format: general }, ...streams.map(([t, f]) => ({ '@type': t, Format: f }))];
const J2K = tracks('JPEG 2000', ['Image', 'JPEG 2000']);
const OGV = tracks('Ogg', ['Video', 'Theora'], ['Audio', 'Vorbis']);
const JXL = [{ '@type': 'General' }];        // MediaInfo does not know JPEG XL

describe('capabilities', () => {
  test('a format nobody published is missing, whatever the built-in tables say', () => {
    const r = resolveNeeds(needsOf(J2K, { ext: 'j2k' }), { filters: [LIBJXL, ISOBMFF] });
    assert.deepEqual(r.with, []);
    assert.deepEqual(r.missing.map(describeNeed), ['decode JPEG 2000']);
  });

  test('a track matches an accessor by its "Format", whatever the module is called', () => {
    assert.deepEqual(resolveNeeds(needsOf(J2K, { ext: 'j2k' }), { filters: [LIBJXL, OPENJPEG] }).with, ['openjpeg_1']);
    const renamed = entry('fastj2k', { formats: ['JPEG 2000'] });
    assert.deepEqual(resolveNeeds(needsOf(J2K, { ext: 'j2k' }), { filters: [renamed] }).with, ['fastj2k_1']);
  });

  test('a container needs a demultiplexer and each stream a decoder', () => {
    const needs = needsOf(OGV, { ext: 'ogv' });
    assert.deepEqual(needs.map(describeNeed), ['demultiplex Ogg', 'decode Theora', 'decode Vorbis']);
    const r = resolveNeeds(needs, { filters: [OGG, THEORA, VORBIS, LIBJXL] });
    assert.deepEqual(r.with, ['ogg_1', 'theora_1', 'vorbis_1']);
    assert.deepEqual(resolveNeeds(needs, { filters: [OGG, VORBIS] }).missing.map(describeNeed), ['decode Theora']);
  });

  test('what MediaInfo does not recognise is matched by extension', () => {
    const r = resolveNeeds(needsOf(JXL, { ext: 'jxl' }), { filters: [LIBJXL, ISOBMFF] });
    assert.deepEqual(r.with, ['libjxl_1']);
    assert.equal(elementFor(JXL, r, null), 'img');
    // Before "extension" was published, its keys were published as "formats".
    const legacy = entry('libjxl', { formats: ['jxl'] });
    assert.deepEqual(resolveNeeds(needsOf(JXL, { ext: 'jxl' }), { filters: [legacy] }).with, ['libjxl_1']);
  });

  test('the extension does not stand for a stream inside a container', () => {
    const alac = entry('libalac', { extension: { mp4: 'audio', m4a: 'audio' } });
    const mp4 = tracks('MPEG-4', ['Video', 'AVC']);
    const r = resolveNeeds(needsOf(mp4, { ext: 'mp4' }), { filters: [ISOBMFF, alac] });
    assert.deepEqual(r.with, ['isobmff_1']);
    assert.deepEqual(r.missing.map(describeNeed), ['decode AVC']);
  });

  test('lower priority wins', () => {
    const a = entry('h264bsd', { formats: ['AVC'] });
    const b = entry('ffmpeg-x264', { formats: ['AVC'], priority: 10 });
    const r = resolveNeeds(needsOf(tracks('MPEG-4', ['Video', 'AVC']), { ext: 'mp4' }), { filters: [ISOBMFF, a, b] });
    assert.deepEqual(r.with, ['isobmff_1', 'ffmpeg-x264_1']);
    assert.deepEqual(r.needs[1].candidates.map((c) => c.module), ['ffmpeg-x264_1', 'h264bsd_1']);
  });

  test('containers the solver reads need no accessor', () => {
    assert.deepEqual(needsOf(tracks('MPEG-TS', ['Audio', 'AC-3']), { ext: 'ts' }).map(describeNeed), ['decode AC-3']);
  });

  test('the <video> tail is taken by name, and only when published', () => {
    const r = resolveNeeds([...needsOf(OGV, { ext: 'ogv' }), ...videoTailNeeds()], { filters: [OGG, THEORA, VORBIS, ISOBMFF] });
    assert.deepEqual(r.with, ['ogg_1', 'theora_1', 'vorbis_1', 'isobmff_1']);
    assert.deepEqual(r.missing.map((n) => n.module), ['libx264_1', 'libopusenc_1']);
  });

  test('the element follows the editor: video draws on a canvas', () => {
    assert.equal(elementFor(OGV, null, 'video'), 'canvas');
    assert.equal(elementFor(J2K, null, 'image'), 'img');
    assert.equal(elementFor(tracks('FLAC', ['Audio', 'FLAC']), null, 'audio'), 'audio');
  });
});

describe('solvers', () => {
  const MP4 = tracks('MPEG-4', ['Audio', 'ALAC']);
  const ISO1 = entry('isobmff', { formats: ['MPEG-4'], using: ['solver_1'] });
  const ALAC = entry('libalac', { formats: ['ALAC'] });

  test('the preferred solver is kept when every accessor links against it', () => {
    const p = resolvePipeline(needsOf(J2K, { ext: 'j2k' }), { filters: [OPENJPEG] }, { prefer: 'solver_minimal_1' });
    assert.equal(p.using, 'solver_minimal_1');
    assert.deepEqual(p.fits, ['solver_minimal_1', 'solver_1']);
  });

  test('an accessor\'s "using" imposes the solver', () => {
    const p = resolvePipeline(needsOf(MP4, { ext: 'm4a' }), { filters: [ISO1, ALAC] }, { prefer: 'solver_minimal_1' });
    assert.equal(p.using, 'solver_1');
    assert.deepEqual(p.with, ['isobmff_1', 'libalac_1']);
    assert.equal(p.conflict, null);
  });

  test('a candidate that does not link against the solver is passed over', () => {
    const minimalOnly = entry('alacmin', { formats: ['ALAC'], using: ['solver_minimal_1'], priority: 1 });
    const p = resolvePipeline(needsOf(MP4, { ext: 'm4a' }), { filters: [ISO1, ALAC, minimalOnly] }, { prefer: 'solver_minimal_1' });
    assert.equal(p.using, 'solver_1');
    assert.deepEqual(p.with, ['isobmff_1', 'libalac_1']);
  });

  test('accessors that need different solvers are a conflict, not a missing need', () => {
    const tta = entry('libtta', { formats: ['ALAC'], using: ['solver_minimal_1'] });
    const p = resolvePipeline(needsOf(MP4, { ext: 'm4a' }), { filters: [ISO1, tta] }, { prefer: 'solver_minimal_1' });
    assert.deepEqual(p.missing, []);
    assert.deepEqual(p.fits, []);
    assert.deepEqual(p.conflict, [{ module: 'isobmff_1', using: ['solver_1'] }, { module: 'libtta_1', using: ['solver_minimal_1'] }]);
  });

  test('a page gets one solver that fits every element, and keeps the one it has', () => {
    const img = resolvePipeline(needsOf(J2K, { ext: 'j2k' }), { filters: [OPENJPEG] }, { prefer: 'solver_minimal_1' });
    const m4a = resolvePipeline(needsOf(MP4, { ext: 'm4a' }), { filters: [ISO1, ALAC] }, { prefer: 'solver_minimal_1' });
    assert.equal(pageSolver([img]), 'solver_minimal_1');
    assert.equal(pageSolver([img, m4a]), 'solver_1');
    assert.equal(pageSolver([img], ['solver_1']), 'solver_1');
    assert.equal(pageSolver([m4a], ['solver_minimal_1']), null);
  });
});

describe('mediainfo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-mi-'));
  after(async () => { await closeMediaInfo(); fs.rmSync(dir, { recursive: true, force: true }); });

  // A valid 1×1 PNG.
  function png() {
    const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    return Buffer.concat([Buffer.from('89504E470D0A1A0A', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
  }

  test('names the tracks of a file', async () => {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, png());
    const t = await mediaTracks(file, await readSource(file));
    assert.equal(t.find((x) => x['@type'] === 'General')?.Format, 'PNG');
    assert.equal(t.find((x) => x['@type'] === 'Image')?.Format, 'PNG');
  });

  test('returns no format for what it does not know', async () => {
    const file = path.join(dir, 'a.bin');
    fs.writeFileSync(file, Buffer.alloc(4096, 0x5a));
    const t = await mediaTracks(file, await readSource(file));
    assert.equal(t?.find((x) => x['@type'] === 'General')?.Format, undefined);
  });
});
