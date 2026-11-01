import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePackage, readPackage } from '../src/lib/mp4-package.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-mp4pkg-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };
const page = '<!DOCTYPE html><img is="universal-img_1" src="photo.jxl" using="mm_solver_minimal_1.0.1" with="libjxl_1">';
const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(3000, 7)]);
const media = Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 251));
const items = [
  { id: 1, name: 'index.html', type: 'text/html', path: put('index.html', page) },
  { id: 2, name: 'universal-img_1.js', type: 'text/javascript', path: put('universal-img_1.js', 'customElements;') },
  { id: 3, name: 'libjxl_1.wasm', type: 'application/wasm', path: put('libjxl_1.wasm', wasm) },
  { id: 4, name: 'photo.jxl', type: 'image/jxl', path: put('photo.jxl', media) },
];

// The top-level boxes of a file: [type, offset, size].
function topBoxes(buf) {
  const out = [];
  for (let o = 0; o < buf.length;) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(o + 8));
    out.push([type, o, size]);
    o += size;
  }
  return out;
}

describe('a preserved package', async () => {
  const out = path.join(dir, 'photo.bevara.mp4');
  const written = await writePackage(items, out, { primary: 1 });
  const buf = fs.readFileSync(out);

  test('is ftyp, a meta box, then the mdat holding every item', () => {
    assert.deepEqual(topBoxes(buf).map(([t]) => t), ['ftyp', 'meta', 'mdat']);
    assert.equal(buf.length, written.size);
    const [, mdatAt, mdatSize] = topBoxes(buf)[2];
    assert.equal(mdatSize - 8, items.reduce((n, i) => n + fs.statSync(i.path).size, 0));
    // The items follow each other in the mdat, in the order given.
    assert.equal(written.items[0].offset, mdatAt + 8);
    assert.ok(written.items.every((it, i) => i === 0 || it.offset === written.items[i - 1].offset + written.items[i - 1].size));
  });

  test('reads back as the MP4 Service Worker reads it', () => {
    const pkg = readPackage(out);
    assert.equal(pkg.handler, 'html');
    assert.equal(pkg.primary.name, 'index.html');
    assert.equal(pkg.primary.content_type, 'text/html');
    for (const it of items) {
      const got = pkg.items.find((x) => x.id === pkg.hasItem(it.name));
      assert.ok(got, it.name);
      assert.equal(got.type, it.type);
      assert.ok(Buffer.from(got.data).equals(fs.readFileSync(it.path)), `${it.name} bytes`);
    }
  });

  test('the Wasm bytecode is in the mdat, where iloc points', () => {
    const it = written.items.find((x) => x.name === 'libjxl_1.wasm');
    assert.ok(buf.subarray(it.offset, it.offset + it.size).equals(wasm));
  });
});
