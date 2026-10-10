import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capArrays, registers, runtimeFormats, extractCaps, runtimeDeclarations, projectsOf, stripComments, relevantRuntime } from '../src/lib/caps.js';

const DEC = `
/* a decoder */
static const GF_FilterCapability JXLDecCaps[] =
{
    CAP_UINT(GF_CAPS_INPUT, GF_PROP_PID_STREAM_TYPE, GF_STREAM_VISUAL),
    CAP_UINT(GF_CAPS_INPUT, GF_PROP_PID_CODECID, GF_4CC('J', 'X', 'L', ' ')),
    CAP_BOOL(GF_CAPS_INPUT_EXCLUDED, GF_PROP_PID_UNFRAMED, GF_TRUE), // framed only
    CAP_UINT(GF_CAPS_OUTPUT, GF_PROP_PID_STREAM_TYPE, GF_STREAM_VISUAL),
    CAP_UINT(GF_CAPS_OUTPUT, GF_PROP_PID_CODECID, GF_CODECID_RAW),
#ifndef NO_SECOND
    {0},
    CAP_UINT(GF_CAPS_INPUT_OUTPUT, GF_PROP_PID_STREAM_TYPE, GF_STREAM_AUDIO),
    { .code=GF_PROP_PID_SCALABLE, .val={.type=GF_PROP_BOOL, .value.boolean = GF_TRUE}, .flags=(GF_CAPS_INPUT_OPT), .priority=255 },
    {GF_CAPFLAG_IN_BUNDLE | GF_CAPFLAG_INPUT | GF_CAPFLAG_RECONFIG, GF_PROP_PID_PIXFMT, {GF_PROP_UINT, {.uint = GF_PIXEL_RGB}}, NULL, 0},
#endif
};
static GF_Err configure(GF_Filter *filter) {
    if (!ctx->ofmt) ctx->ofmt = GF_PIXEL_RGB;
    gf_filter_pid_set_property(ctx->opid, GF_PROP_PID_PIXFMT, &PROP_UINT(ctx->ofmt));
    gf_filter_pid_set_property(ctx->opid, GF_PROP_PID_PIXFMT, &PROP_UINT(has_alpha ? GF_PIXEL_RGBA : GF_PIXEL_RGB));
    gf_filter_pid_negotiate_property(pid, GF_PROP_PID_PIXFMT, &PROP_UINT(GF_PIXEL_YUV));
    switch (ctx->ofmt) { case GF_PIXEL_RGBA: break; case GF_PIXEL_GREYSCALE: break; }
}
GF_FilterRegister JXLDecoderRegister = {
    .name = "jxldec",
    GF_FS_SET_DESCRIPTION("JXL decoder")
    .private_size = sizeof(GF_JXLDecCtx),
    SETCAPS(JXLDecCaps),
    .configure_pid = jxldec_configure_pid,
    .priority = 128
};
`;

test('caps: bundles, exclusions, designated and positional initialisers, every #if branch', () => {
  const src = stripComments(DEC).replace(/^[ \t]*#.*$/gm, '');
  const arr = capArrays(src).get('JXLDecCaps');
  assert.equal(arr.bundles.length, 2);
  assert.deepEqual(arr.unknown, []);
  const [b1, b2] = arr.bundles;
  assert.deepEqual(b1.inputs.map((c) => [c.property, c.format, !!c.excluded]), [
    ['GF_PROP_PID_STREAM_TYPE', 'GF_STREAM_VISUAL', false],
    ['GF_PROP_PID_CODECID', "GF_4CC('J','X','L',' ')", false],
    ['GF_PROP_PID_UNFRAMED', 'GF_TRUE', true],
  ]);
  assert.deepEqual(b1.outputs.map((c) => c.format), ['GF_STREAM_VISUAL', 'GF_CODECID_RAW']);
  // GF_CAPS_INPUT_OUTPUT is on both sides; the designated one is optional with its own priority.
  assert.equal(b2.inputs[0].format, 'GF_STREAM_AUDIO');
  assert.equal(b2.outputs[0].format, 'GF_STREAM_AUDIO');
  assert.deepEqual(b2.inputs[1], { property: 'GF_PROP_PID_SCALABLE', format: 'GF_TRUE', optional: true, priority: 255 });
  assert.deepEqual(b2.inputs[2], { property: 'GF_PROP_PID_PIXFMT', format: 'GF_PIXEL_RGB' });
});

test('caps: the register gives the name, the caps array and the priority', () => {
  const [reg] = registers(stripComments(DEC));
  assert.equal(reg.name, 'jxldec');
  assert.equal(reg.caps, 'JXLDecCaps');
  assert.equal(reg.priority, 128);
});

test('caps: run-time formats - literals, choices between literals, variables with candidates', () => {
  const rt = runtimeFormats(stripComments(DEC));
  assert.deepEqual(rt.outputs.map((c) => c.format), ['GF_PIXEL_RGBA', 'GF_PIXEL_RGB']);
  assert.deepEqual(rt.inputs, [{ property: 'GF_PROP_PID_PIXFMT', format: 'GF_PIXEL_YUV' }]);
  assert.equal(rt.unresolved.length, 1);
  assert.equal(rt.unresolved[0].expression, 'ctx->ofmt');
  assert.deepEqual(rt.unresolved[0].candidates.sort(), ['GF_PIXEL_GREYSCALE', 'GF_PIXEL_RGB', 'GF_PIXEL_RGBA']);
});

test('caps: the formats a helper function returns are candidates', () => {
  const src = `
static u32 get_pf(int c) { switch (c) { case 0: return GF_PIXEL_YUV; default: return GF_PIXEL_YUV444_10; } }
void f() { pix_fmt = get_pf(x); gf_filter_pid_set_property(ctx->opid, GF_PROP_PID_PIXFMT, &PROP_UINT(pix_fmt)); }`;
  assert.deepEqual(runtimeFormats(src).unresolved[0].candidates, ['GF_PIXEL_YUV', 'GF_PIXEL_YUV444_10']);
});

test('caps: run-time formats of a parser (compressed output) or of the wrong medium are dropped', () => {
  const rt = { outputs: [{ property: 'GF_PROP_PID_PIXFMT', format: 'GF_PIXEL_RGB' }], inputs: [], unresolved: [] };
  const parser = [{ inputs: [], outputs: [{ property: 'GF_PROP_PID_CODECID', format: 'GF_CODECID_PNG' }] }];
  const decoder = [{ inputs: [], outputs: [{ property: 'GF_PROP_PID_CODECID', format: 'GF_CODECID_RAW' }] }];
  assert.equal(relevantRuntime(rt, parser, ['image']).outputs.length, 0);
  assert.equal(relevantRuntime(rt, decoder, ['image']).outputs.length, 1);
  assert.equal(relevantRuntime(rt, decoder, ['audio']).outputs.length, 0);
});

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-caps-'));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return dir;
}

test('extractCaps: per filter, with the manifest declarations folding into run time', () => {
  const dir = repo({ 'dec_jxl.c': DEC, 'third_parties/x.c': 'GF_FilterRegister R = { .name = "jxldec" };', 'lib/libjxl.a': '', 'lib/libc.a': '', 'lib/libbrotlidec.a': '' });
  const m = { name: 'libjxl', filters: ['jxldec'], filter_source: { jxldec: 'dec_jxl.c' } };
  const r = extractCaps(dir, m);
  assert.equal(r.caps.length, 1);
  assert.equal(r.caps[0].priority, 128);
  assert.equal(r.caps[0].source, 'dec_jxl.c');
  assert.equal(r.unresolved.length, 1);

  const runtime = runtimeDeclarations(m, r.unresolved);
  assert.deepEqual(runtime.jxldec.outputs[0].property, 'GF_PROP_PID_PIXFMT');
  const again = extractCaps(dir, { ...m, runtime });
  assert.equal(again.unresolved.length, 0);
  assert.ok(again.caps[0].runtime.outputs.some((c) => c.format === 'GF_PIXEL_GREYSCALE' && c.declared));
  assert.deepEqual(projectsOf(dir), ['gpac', 'brotli', 'libjxl']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractCaps: a filter registered under another name is found through filter_source', () => {
  const dir = repo({ 'ff_dec-h26x.c': 'static const GF_FilterCapability C[] = { CAP_UINT(GF_CAPS_INPUT, GF_PROP_PID_STREAM_TYPE, GF_STREAM_VISUAL) };\nGF_FilterRegister R = { .name = "ffdec-h26x", SETCAPS(C), .priority = 128 };' });
  const r = extractCaps(dir, { filters: ['ffdec', 'nothere'], filter_source: { ffdec: 'ff_dec-h26x.c' } });
  assert.deepEqual(r.caps.map((c) => [c.filter, c.priority]), [['ffdec', 128]]);
  assert.deepEqual(r.missing, ['nothere']);
  assert.ok(r.notes.some((n) => /registers it as "ffdec-h26x"/.test(n)));
  fs.rmSync(dir, { recursive: true, force: true });
});
