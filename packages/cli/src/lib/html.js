/* A deliberately small HTML scanner.
 *
 * `update-page` edits a handful of attributes in a document somebody wrote by
 * hand, so it must not reformat anything: parsing with a real HTML5 parser and
 * re-serialising would rewrite quoting, self-closing slashes, entities and
 * whitespace across the whole file. Instead this scanner locates start tags
 * and the exact byte range of each attribute, and edits are applied as splices
 * on the original text - every byte we do not touch stays as it was.
 *
 * It understands what it must not mistake for markup: comments, doctypes,
 * processing instructions, and the raw-text elements whose content may contain
 * "<" (script, style, textarea, title).
 */

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const NAME_START = /[A-Za-z]/;

/**
 * @returns {Array<{name, start, end, attrs, selfClosing, nameEnd}>} start tags,
 * in document order. `start`/`end` bracket the whole tag, including "<" and ">".
 */
export function scanTags(html) {
  const tags = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const next = html[lt + 1];

    if (next === '!') {
      if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; continue; }
      const e = html.indexOf('>', lt); i = e < 0 ? html.length : e + 1; continue;        // doctype, CDATA
    }
    if (next === '?') { const e = html.indexOf('>', lt); i = e < 0 ? html.length : e + 1; continue; }
    if (next === '/') { const e = html.indexOf('>', lt); i = e < 0 ? html.length : e + 1; continue; }
    if (!next || !NAME_START.test(next)) { i = lt + 1; continue; }

    const tag = parseStartTag(html, lt);
    if (!tag) { i = lt + 1; continue; }
    tags.push(tag);
    i = tag.end;

    // Skip the raw content of script/style/… so markup inside them is ignored.
    if (RAW_TEXT.has(tag.name) && !tag.selfClosing) {
      const close = new RegExp(`</${tag.name}\\s*>`, 'i');
      const rest = html.slice(tag.end);
      const m = close.exec(rest);
      i = m ? tag.end + m.index + m[0].length : html.length;
    }
  }
  return tags;
}

function parseStartTag(html, start) {
  let i = start + 1;
  while (i < html.length && /[A-Za-z0-9:-]/.test(html[i])) i++;
  const name = html.slice(start + 1, i).toLowerCase();
  if (!name) return null;
  const nameEnd = i;
  const attrs = [];
  for (;;) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) return null;
    if (html[i] === '>') return { name, start, end: i + 1, attrs, selfClosing: false, nameEnd, closeStart: i };
    if (html[i] === '/' && html[i + 1] === '>') return { name, start, end: i + 2, attrs, selfClosing: true, nameEnd, closeStart: i };

    const aStart = i;
    while (i < html.length && !/[\s/>=]/.test(html[i])) i++;
    if (i === aStart) { i++; continue; }                       // stray character
    const aName = html.slice(aStart, i).toLowerCase();
    let value = null, quote = '', valueStart = -1, valueEnd = -1;
    const save = i;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      if (html[i] === '"' || html[i] === "'") {
        quote = html[i];
        valueStart = ++i;
        while (i < html.length && html[i] !== quote) i++;
        valueEnd = i;
        i++;                                                    // closing quote
      } else {
        valueStart = i;
        while (i < html.length && !/[\s>]/.test(html[i])) i++;
        valueEnd = i;
      }
      value = html.slice(valueStart, valueEnd);
    } else i = save;                                            // bare attribute
    attrs.push({ name: aName, value, quote, start: aStart, end: i, valueStart, valueEnd });
  }
}

export const getAttr = (tag, name) => tag.attrs.find((a) => a.name === name) ?? null;

/* Edits are {start, end, text} splices on the original string. Applying them
 * back-to-front keeps every offset valid. */
export function applyEdits(html, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/* Sets attributes on a tag: existing ones are replaced in place (keeping their
 * quoting), new ones are appended just before the closing ">". A value of null
 * writes a boolean attribute with no value. */
export function setAttributes(html, tag, values) {
  const edits = [];
  const added = [];
  for (const [name, value] of Object.entries(values)) {
    const existing = getAttr(tag, name);
    if (!existing) { added.push([name, value]); continue; }
    if (existing.value === value) continue;
    if (value === null) continue;                                // bare attribute already present
    if (existing.value === null)                                 // bare -> valued
      edits.push({ start: existing.start, end: existing.end, text: `${name}="${escapeAttr(value)}"` });
    else {
      const q = existing.quote || '"';
      edits.push({ start: existing.valueStart, end: existing.valueEnd, text: escapeAttr(value, q) });
      if (!existing.quote) edits.push({ start: existing.valueStart, end: existing.valueStart, text: '' });
    }
  }
  if (added.length) {
    // A null value means a boolean attribute, written bare: `progressive`.
    const text = ' ' + added.map(([n, v]) => (v === null ? n : `${n}="${escapeAttr(v)}"`)).join(' ');
    const at = tag.closeStart;
    // Keep "<img ... />" tidy: insert before the slash, not between / and >.
    edits.push({ start: at, end: at, text: html[at - 1] === ' ' ? text.slice(1) : text });
  }
  return edits;
}

const escapeAttr = (s, quote = '"') => String(s).replace(/&/g, '&amp;').replace(quote === "'" ? /'/g : /"/g, quote === "'" ? '&#39;' : '&quot;');

/* Line-oriented preview of a set of edits: each touched line is shown before
 * and after. Enough for a command whose changes are a few attributes. */
export function previewEdits(original, edits, { context = 0 } = {}) {
  if (!edits.length) return '';
  const updated = applyEdits(original, edits);
  const lineOf = (text, offset) => text.slice(0, offset).split('\n').length - 1;
  const oldLines = original.split('\n');
  const newLines = updated.split('\n');
  const touched = new Set();
  for (const e of edits) {
    const from = lineOf(original, e.start);
    const to = lineOf(original, e.end);
    for (let l = from - context; l <= to + context; l++) if (l >= 0 && l < oldLines.length) touched.add(l);
  }
  // Edits never reorder lines, so a running offset maps old lines to new ones.
  const blocks = [];
  let delta = 0, prev = -2;
  for (const l of [...touched].sort((a, b) => a - b)) {
    const inserted = edits.filter((e) => lineOf(original, e.start) === l).reduce((n, e) => n + (e.text.split('\n').length - original.slice(e.start, e.end).split('\n').length), 0);
    if (l !== prev + 1) blocks.push([]);
    blocks[blocks.length - 1].push({ line: l, old: oldLines[l], now: newLines.slice(l + delta, l + delta + 1 + inserted) });
    delta += inserted;
    prev = l;
  }
  return blocks;
}
