import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordUpdate, backupBeforeReplace, planRevert, applyRevert, stripUniversal, readRecords } from '../src/lib/page-record.js';

const ORIGINAL = '<html><body>\n  <img src="a.jxl" alt="x">\n</body></html>\n';
const UPDATED = '<html><body>\n  <img src="a.jxl" alt="x" is="universal-img_1" using="mm_solver_minimal_1.0.1" with="libjxl_1">\n  <script src="scripts/universal-img_1.js"></script>\n</body></html>\n';

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-revert-'));
  fs.writeFileSync(path.join(dir, 'index.html'), UPDATED);
  const files = {};
  for (const [rel, data] of [['scripts/universal-img_1.js', 'tag'], ['mm_solver_minimal_1.0.1.js', 'js'], ['mm_solver_minimal_1.0.1.wasm', 'wasm'], ['libjxl_1.wasm', 'jxl']]) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    files[rel] = { dest, status: 'added' };
  }
  return { dir, page: path.join(dir, 'index.html'), files };
}

test('revert-page restores the recorded original and removes what update-page added', () => {
  const { dir, page, files } = site();
  recordUpdate(page, ORIGINAL, UPDATED, Object.values(files));
  applyRevert(page, planRevert(page));
  assert.equal(fs.readFileSync(page, 'utf8'), ORIGINAL);
  assert.deepEqual(fs.readdirSync(dir), ['index.html']);           // files, scripts/ and .bevara/ gone
});

test('what changed since update-page is kept, unless --force', () => {
  const { dir, page, files } = site();
  recordUpdate(page, ORIGINAL, UPDATED, Object.values(files));
  fs.appendFileSync(page, '<!-- edited -->\n');
  fs.writeFileSync(files['libjxl_1.wasm'].dest, 'rebuilt');
  const plan = planRevert(page);
  assert.equal(plan.page.action, 'keep');
  assert.equal(plan.files.find((f) => f.rel === 'libjxl_1.wasm').action, 'keep');
  applyRevert(page, plan);
  assert.ok(readRecords(dir)['index.html'], 'the record stays while the page is not reverted');
  applyRevert(page, planRevert(page, { force: true }));
  assert.equal(fs.readFileSync(page, 'utf8'), ORIGINAL);
  assert.ok(!fs.existsSync(files['libjxl_1.wasm'].dest));
});

test('a file another page loads stays; a replaced file comes back as it was', () => {
  const { dir, page, files } = site();
  fs.writeFileSync(path.join(dir, 'other.html'), '<img is="universal-img_1" src="b.jxl" using="mm_solver_minimal_1.0.1" with="libjxl_1">');
  // update-page --refresh replaced a hand-built mm_solver_minimal_1.0.1.wasm
  fs.writeFileSync(files['mm_solver_minimal_1.0.1.wasm'].dest, 'hand-built');
  backupBeforeReplace(dir, files['mm_solver_minimal_1.0.1.wasm'].dest);
  fs.writeFileSync(files['mm_solver_minimal_1.0.1.wasm'].dest, 'wasm');
  recordUpdate(page, ORIGINAL, UPDATED, [...Object.values(files).filter((f) => !f.dest.endsWith('mm_solver_minimal_1.0.1.wasm')), { ...files['mm_solver_minimal_1.0.1.wasm'], status: 'replaced' }]);
  const plan = planRevert(page);
  assert.equal(plan.files.find((f) => f.rel === 'libjxl_1.wasm').action, 'keep');
  assert.equal(plan.files.find((f) => f.rel === 'mm_solver_minimal_1.0.1.wasm').action, 'restore');
  applyRevert(page, plan);
  assert.equal(fs.readFileSync(files['mm_solver_minimal_1.0.1.wasm'].dest, 'utf8'), 'hand-built');
  assert.ok(fs.existsSync(files['libjxl_1.wasm'].dest));
  assert.ok(fs.existsSync(files['mm_solver_minimal_1.0.1.js'].dest));       // other.html loads it too
});

test('without a record, the universal markup and the files it loads are removed', () => {
  const { dir, page } = site();
  assert.equal(stripUniversal(UPDATED), ORIGINAL);
  const plan = planRevert(page);
  assert.equal(plan.recorded, false);
  assert.deepEqual(plan.files.map((f) => f.action), ['remove', 'remove', 'remove', 'remove']);
  applyRevert(page, plan);
  assert.equal(fs.readFileSync(page, 'utf8'), ORIGINAL);
  assert.deepEqual(fs.readdirSync(dir), ['index.html']);
});
