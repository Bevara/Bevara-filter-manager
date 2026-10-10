import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanTags, getAttr, setAttributes, renameAttr, applyEdits, previewEdits } from '../src/lib/html.js';

const names = (html) => scanTags(html).map((t) => t.name);
const edit = (html, pick, values) => {
  const tag = scanTags(html).find(pick);
  return applyEdits(html, setAttributes(html, tag, values));
};

describe('html scanner', () => {
  test('finds start tags and ignores end tags, doctypes and processing instructions', () => {
    assert.deepEqual(names('<!doctype html><html><body><img src=a></body></html>'), ['html', 'body', 'img']);
    assert.deepEqual(names('<?xml version="1.0"?><svg><image href="x"/></svg>'), ['svg', 'image']);
  });

  test('markup inside comments is not a tag', () => {
    assert.deepEqual(names('<p><!-- <img src="x.jxl"> --><b>'), ['p', 'b']);
    assert.deepEqual(names('<!-- unterminated <img>'), []);
  });

  test('raw-text elements hide their content', () => {
    assert.deepEqual(names('<script>if (a<b) "<img src=x>";</script><p>'), ['script', 'p']);
    assert.deepEqual(names('<style>a[href]::after{content:"<b>"}</style><i>'), ['style', 'i']);
    assert.deepEqual(names('<textarea><video src=x></textarea><i>'), ['textarea', 'i']);
    assert.deepEqual(names('<SCRIPT>var x="<img>";</SCRIPT><p>'), ['script', 'p']);
  });

  test('attribute forms: quoted, single-quoted, unquoted and bare', () => {
    const [t] = scanTags(`<video src="a b.ogv" poster='p.png' width=640 controls DATA-X>`);
    assert.equal(getAttr(t, 'src').value, 'a b.ogv');
    assert.equal(getAttr(t, 'src').quote, '"');
    assert.equal(getAttr(t, 'poster').quote, "'");
    assert.equal(getAttr(t, 'width').value, '640');
    assert.equal(getAttr(t, 'width').quote, '');
    assert.equal(getAttr(t, 'controls').value, null);
    assert.ok(getAttr(t, 'data-x'), 'attribute names are case-insensitive');
  });

  test('a ">" inside a quoted value does not end the tag', () => {
    const tags = scanTags('<img alt="a > b" src="x.png"><p>');
    assert.deepEqual(tags.map((t) => t.name), ['img', 'p']);
    assert.equal(getAttr(tags[0], 'src').value, 'x.png');
  });

  test('self-closing tags are recognised', () => {
    const [t] = scanTags('<img src="x.png" />');
    assert.equal(t.selfClosing, true);
  });
});

describe('html editing', () => {
  test('adds attributes before the closing bracket, keeping everything else', () => {
    const html = '<p>before</p>\n<img src="x.jxl" alt="hi">\n<p>after</p>';
    const out = edit(html, (t) => t.name === 'img', { is: 'universal-img_1', with: 'libjxl_1' });
    assert.equal(out, '<p>before</p>\n<img src="x.jxl" alt="hi" is="universal-img_1" with="libjxl_1">\n<p>after</p>');
  });

  test('keeps the self-closing slash tidy', () => {
    assert.equal(edit('<img src="x.png" />', (t) => t.name === 'img', { is: 'universal-img_1' }),
      '<img src="x.png" is="universal-img_1"/>');
  });

  test('replaces an existing value in place and preserves its quoting', () => {
    assert.equal(edit(`<video src='a' with='old'>`, (t) => t.name === 'video', { with: 'new_1' }), `<video src='a' with='new_1'>`);
    assert.equal(edit('<video with="old">', (t) => t.name === 'video', { with: 'new_1' }), '<video with="new_1">');
  });

  test('a null value writes a bare boolean attribute', () => {
    assert.equal(edit('<video src="a">', (t) => t.name === 'video', { progressive: null }), '<video src="a" progressive>');
    assert.equal(edit('<video src="a" progressive>', (t) => t.name === 'video', { progressive: null }), '<video src="a" progressive>');
  });

  test('values are escaped', () => {
    assert.equal(edit('<img src="a">', (t) => t.name === 'img', { with: 'a"b&c' }), '<img src="a" with="a&quot;b&amp;c">');
  });

  test('an unchanged value produces no edit', () => {
    const html = '<img src="a" is="universal-img_1">';
    const tag = scanTags(html)[0];
    assert.deepEqual(setAttributes(html, tag, { is: 'universal-img_1' }), []);
  });

  test('several tags are edited in one pass without shifting each other', () => {
    const html = '<img src="1.png"><img src="2.png"><img src="3.png">';
    const tags = scanTags(html);
    const edits = tags.flatMap((t, i) => setAttributes(html, t, { 'data-i': String(i) }));
    assert.equal(applyEdits(html, edits), '<img src="1.png" data-i="0"><img src="2.png" data-i="1"><img src="3.png" data-i="2">');
  });

  test('an attribute is renamed in place, with its value and quoting', () => {
    const html = "<canvas SRC='a.ogv' width=640>";
    const tag = scanTags(html)[0];
    const edits = [...setAttributes(html, tag, { is: 'universal-canvas_1' }), ...renameAttr(tag, 'src', 'data-url')];
    assert.equal(applyEdits(html, edits), "<canvas data-url='a.ogv' width=640 is=\"universal-canvas_1\">");
    assert.deepEqual(renameAttr(tag, 'href', 'x'), []);
  });
});

describe('edit preview', () => {
  test('reports the touched lines, before and after', () => {
    const html = 'a\n<img src="x.jxl">\nb';
    const tag = scanTags(html)[0];
    const blocks = previewEdits(html, setAttributes(html, tag, { is: 'universal-img_1' }));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0][0].line, 1);
    assert.equal(blocks[0][0].old, '<img src="x.jxl">');
    assert.deepEqual(blocks[0][0].now, ['<img src="x.jxl" is="universal-img_1">']);
  });

  test('an insertion keeps the original line as the last new one', () => {
    const html = '<body>\n</body>';
    const at = html.indexOf('</body>');
    const blocks = previewEdits(html, [{ start: at, end: at, text: '<script src="u.js"></script>\n' }]);
    assert.deepEqual(blocks[0][0].now, ['<script src="u.js"></script>', '</body>']);
  });

  test('no edits, no preview', () => assert.deepEqual(previewEdits('x', []), ''));
});
