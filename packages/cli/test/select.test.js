import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeQuery, selectAccessors, canonicalValue, parseSize } from '../src/lib/select.js';
import { parseQueryText } from '../src/commands/select.js';

// The query as the paper prints it, pasted from the PDF (indentation lost).
const PAPER = `inputs :
- property : GF_PROP_PID_PIXFMT
format : GF_PIXEL_RGBA
version : 2.1
IP : { condition : false , license :, geocode : }
projectname : " ffmpeg "
language : " wasm "
size : { condition : false , maxsize : }
maxpriority : 50`;

const cap = (property, format, extra = {}) => ({ property, format, ...extra });
const RAW_IN = [cap('GF_PROP_PID_STREAM_TYPE', 'GF_STREAM_VISUAL'), cap('GF_PROP_PID_CODECID', 'GF_CODECID_RAW')];
const INDEX = [
  { name: 'bevara:ffmpeg-hevc', version: '1.0.0', file: 'ffmpeg-hevc_1.wasm', size: 900000, projects: ['gpac', 'ffmpeg'], license: 'LGPL-2.1-or-later', caps: [
    { filter: 'ffdec-hevc', priority: 128, bundles: [{ inputs: [cap('GF_PROP_PID_STREAM_TYPE', 'GF_STREAM_VISUAL'), cap('GF_PROP_PID_CODECID', 'GF_CODECID_RAW', { excluded: true })], outputs: [cap('GF_PROP_PID_CODECID', 'GF_CODECID_RAW')] }],
      runtime: { outputs: [cap('GF_PROP_PID_PIXFMT', 'GF_PIXEL_YUV', { declared: true })] } },
    { filter: 'ffsws-hevc', priority: 0, bundles: [{ inputs: RAW_IN, outputs: RAW_IN }] },
  ] },
  { name: 'bevara:ffmpeg-x264', version: '1.0.0', file: 'ffmpeg-x264_1.wasm', size: 2000000, projects: ['gpac', 'ffmpeg', 'libx264'], licence_required: true, caps: [
    { filter: 'ffenc', priority: 128, bundles: [{ inputs: RAW_IN, outputs: [cap('GF_PROP_PID_CODECID', 'GF_CODECID_AVC')] }] },
  ] },
  { name: 'bevara:libpng', version: '2.0.0', file: 'libpng_1.wasm', size: 120000, projects: ['gpac', 'libpng'], license: 'Zlib', caps: [
    { filter: 'encpng', priority: 0, bundles: [{ inputs: RAW_IN, outputs: [cap('GF_PROP_PID_CODECID', 'GF_CODECID_PNG')] }] },
  ] },
  { name: 'bevara:libx264', version: '1.0.0', file: 'libx264_1.wasm', size: 1500000, projects: ['gpac', 'libx264'], licence_required: true, georestrictions: ['US'], caps: [
    { filter: 'x264enc', priority: 0, bundles: [{ inputs: [...RAW_IN, cap('GF_PROP_PID_PIXFMT', 'GF_PIXEL_YUV')], outputs: [cap('GF_PROP_PID_CODECID', 'GF_CODECID_AVC')] }] },
  ] },
  { name: 'bevara:libjxl', version: '1.0.0', file: 'libjxl_1.wasm', size: 600000, projects: ['gpac', 'libjxl'], caps: [
    { filter: 'jxldec', priority: 0, bundles: [{ inputs: [cap('GF_PROP_PID_STREAM_TYPE', 'GF_STREAM_VISUAL'), cap('GF_PROP_PID_CODECID', "GF_4CC('J','X','L',' ')")], outputs: [cap('GF_PROP_PID_CODECID', 'GF_CODECID_RAW')] }],
      runtime: { outputs: [cap('GF_PROP_PID_PIXFMT', 'GF_PIXEL_RGB'), cap('GF_PROP_PID_PIXFMT', 'GF_PIXEL_RGBA', { declared: true })] } },
    { filter: 'rfjxl', priority: 0, bundles: [{ inputs: [cap('GF_PROP_PID_STREAM_TYPE', 'GF_STREAM_FILE'), cap('GF_PROP_PID_FILE_EXT', '"jxl"'), cap('GF_PROP_PID_MIME', '"image/jxl"')], outputs: [] }] },
  ] },
  { name: 'bevara:ogg', version: '1.0.0', file: 'ogg_1.wasm', size: 200000, caps: [
    { filter: 'oggdmx', priority: 0, bundles: [{ inputs: [cap('GF_PROP_PID_STREAM_TYPE', 'GF_STREAM_FILE'), cap('GF_PROP_PID_FILE_EXT', '"oga|ogg|ogv"')], outputs: [] }] },
  ] },
  { name: 'bevara:old', version: '1.0.0', file: 'old_1.wasm', size: 1 },
];

const names = (r) => r.matches.map((m) => m.filter);

test('select: the paper query, as pasted from the PDF, is read field by field', () => {
  const q = normalizeQuery(parseQueryText(PAPER));
  assert.deepEqual(q.inputs, [{ property: 'GF_PROP_PID_PIXFMT', format: 'GF_PIXEL_RGBA' }]);
  assert.equal(q.range, '>=2.1.0');
  assert.deepEqual(q.ip, { condition: false, license: [], geocode: null });
  assert.deepEqual(q.projects, ['ffmpeg']);
  assert.equal(q.language, 'wasm');
  assert.deepEqual(q.size, { condition: false, maxsize: null });
  assert.equal(q.maxpriority, 50);
});

test('select: the paper query keeps the ffmpeg modules accepting raw RGBA at priority <= 50', () => {
  const q = { ...parseQueryText(PAPER), version: undefined };
  const r = selectAccessors(INDEX, q);
  // The rescaler takes raw video; the encoder too but at 128; ffdec takes compressed only;
  // libpng is not ffmpeg; x264enc declares YUV, not RGBA.
  assert.deepEqual(names(r), ['ffsws-hevc']);
  assert.ok(r.excluded.some((x) => x.filter === 'ffenc' && /priority 128/.test(x.reason)));
  assert.ok(r.excluded.some((x) => x.name === 'bevara:libpng' && /projects/.test(x.reason)));
  assert.deepEqual(r.uncharacterised, ['bevara:old']);
  // With the version: every module here is older than 2.1.
  assert.deepEqual(names(selectAccessors(INDEX, parseQueryText(PAPER))), []);
});

test('select: a codec named by its four characters, string alternatives, and the explicit-acceptance rule', () => {
  assert.equal(canonicalValue('GF_PROP_PID_CODECID', "GF_4CC('J','X','L',' ')"), 'GF_CODECID_JXL');
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: [{ property: 'CODECID', format: 'jxl' }] })), ['jxldec']);
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: [{ property: 'STREAM_TYPE', format: 'FILE' }, { property: 'FILE_EXT', format: 'ogg' }] })), ['oggdmx']);
  // Only the stream type: every demultiplexer of files.
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: [{ property: 'STREAM_TYPE', format: 'FILE' }] })).sort(), ['oggdmx', 'rfjxl']);
});

test('select: outputs, including the formats declared for run time', () => {
  assert.deepEqual(names(selectAccessors(INDEX, { outputs: [{ property: 'PIXFMT', format: 'RGBA' }] })), ['jxldec']);
  assert.deepEqual(names(selectAccessors(INDEX, { outputs: [{ property: 'PixelFormat', format: 'yuv' }] })), ['ffdec-hevc']);
});

test('select: side conditions - size, IP with jurisdiction and licence, projects, ranking', () => {
  const yuv = [{ property: 'PIXFMT', format: 'YUV' }];
  const all = selectAccessors(INDEX, { inputs: yuv });
  assert.deepEqual(names(all), ['encpng', 'ffsws-hevc', 'x264enc', 'ffenc']);   // priority, then size
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: yuv, size: { condition: true, maxsize: '1MB' } })), ['encpng', 'ffsws-hevc']);
  // x264 needs a patent licence in the US only; ffmpeg-x264 everywhere.
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: yuv, IP: { condition: true, geocode: 'fr' } })), ['encpng', 'ffsws-hevc', 'x264enc']);
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: yuv, IP: { condition: true, geocode: 'US' } })), ['encpng', 'ffsws-hevc']);
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: yuv, IP: { condition: true, license: 'zlib' } })), ['encpng']);
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: yuv, projectname: 'x264' })), ['x264enc', 'ffenc']);
  assert.deepEqual(names(selectAccessors(INDEX, { inputs: yuv, version: '^2' })), ['encpng']);
});

test('select: malformed queries are explained', () => {
  assert.throws(() => normalizeQuery({}), /selects nothing/);
  assert.throws(() => normalizeQuery({ inputs: [{ format: 'x' }] }), /property, format/);
  assert.throws(() => normalizeQuery({ inputs: [{ property: 'PIXFMT', format: 'RGB' }], size: { condition: true } }), /maxsize/);
  assert.throws(() => normalizeQuery({ inputs: [{ property: 'PIXFMT', format: 'RGB' }], version: 'soon' }), /semver/);
  assert.equal(parseSize('200kB'), 200000);
  assert.equal(parseSize('1.5MiB'), 1572864);
});

test('select.js and manifest.js are the same file in the CLI and the registry', () => {
  for (const f of ['select.js', 'manifest.js']) {
    const cli = fs.readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8');
    const reg = fs.readFileSync(new URL(`../../registry/src/${f}`, import.meta.url), 'utf8');
    assert.equal(cli, reg, `packages/registry/src/${f} differs from packages/cli/src/lib/${f}: copy it over`);
  }
});
