/* What update-page --write changed in a page's directory, so that revert-page
 * can undo it: <dir>/.bevara/pages.json, one entry per page file name, with
 *
 *   original   the page as it was before the first update-page (kept in
 *              .bevara/pages/<page>.orig, the first run's state is the one
 *              revert-page goes back to);
 *   written    sha256 of the page update-page last wrote, to tell later edits;
 *   files      the files it added or replaced next to the page: path (relative
 *              to the page), sha256 of what it wrote, and for a replaced file
 *              the copy of what was there (.bevara/pages/backup/<path>).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanTags, getAttr, applyEdits } from './html.js';
import { pageRequirements, pageTagNames } from './page-files.js';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const recordDir = (dir) => path.join(dir, '.bevara', 'pages');
const recordFile = (dir) => path.join(dir, '.bevara', 'pages.json');

export function readRecords(dir) {
  try { return JSON.parse(fs.readFileSync(recordFile(dir), 'utf8')); } catch { return {}; }
}

function writeRecords(dir, records) {
  if (!Object.keys(records).length) {
    fs.rmSync(recordFile(dir), { force: true });
    removeEmptyDirs(recordDir(dir), dir);
    removeEmptyDirs(path.join(dir, '.bevara'), dir);
    return;
  }
  fs.mkdirSync(path.dirname(recordFile(dir)), { recursive: true });
  fs.writeFileSync(recordFile(dir), JSON.stringify(records, null, 2) + '\n');
}

/* Keeps a copy of a file update-page is about to overwrite (--refresh). */
export function backupBeforeReplace(pageDir, dest) {
  const rel = path.relative(pageDir, dest);
  const target = path.join(recordDir(pageDir), 'backup', rel);
  if (fs.existsSync(target)) return;               // the first state is the one to restore
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(dest, target);
}

/**
 * Records one update-page --write on a page.
 * @param {string} pageFile  the page
 * @param {string} before    its HTML before this run
 * @param {string} after     its HTML after this run
 * @param {object[]} files   deployFiles() results
 */
export function recordUpdate(pageFile, before, after, files = []) {
  const dir = path.dirname(path.resolve(pageFile));
  const name = path.basename(pageFile);
  const records = readRecords(dir);
  const rec = records[name] ?? { original: `${name}.orig`, files: [] };
  if (!records[name]) {
    fs.mkdirSync(recordDir(dir), { recursive: true });
    fs.writeFileSync(path.join(recordDir(dir), rec.original), before);
  }
  rec.written = sha256(after);
  rec.updatedAt = new Date().toISOString();
  for (const f of files) {
    if (f.status !== 'added' && f.status !== 'replaced') continue;
    const rel = path.relative(dir, f.dest);
    const entry = rec.files.find((x) => x.path === rel);
    const backup = f.status === 'replaced' && fs.existsSync(path.join(recordDir(dir), 'backup', rel)) ? path.join('backup', rel) : entry?.backup;
    const next = { path: rel, sha256: sha256(fs.readFileSync(f.dest)), ...(backup ? { backup } : {}) };
    if (entry) Object.assign(entry, next); else rec.files.push(next);
  }
  records[name] = rec;
  writeRecords(dir, records);
}

function removeEmptyDirs(from, stopAt) {
  let d = path.resolve(from);
  const stop = path.resolve(stopAt);
  while (d.startsWith(stop) && d !== stop) {
    try { if (fs.readdirSync(d).length) return; fs.rmdirSync(d); } catch { return; }
    d = path.dirname(d);
  }
}

/* Files the other pages of the directory still load: never removed. */
function usedElsewhere(dir, name) {
  const used = new Set();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* none */ }
  for (const f of entries) {
    if (f === name || !/\.html?$/i.test(f)) continue;
    try { for (const r of pageRequirements(fs.readFileSync(path.join(dir, f), 'utf8'), dir)) used.add(r.dest); } catch { /* unreadable */ }
  }
  return used;
}

// The attributes update-page or the universal elements use (paper, Table 1).
const UNIVERSAL_ATTRS = new Set(['is', 'using', 'with', 'script-directory', 'out', 'use-cache', 'use-worker', 'use-webcodec', 'progressive']);
const SCRIPT_RE = /(?:^|\/)([A-Za-z0-9][A-Za-z0-9._-]*_\d+)\.js(?:[?#].*)?$/;

/* Without a record: the page minus its universal markup - the attributes of
 * universal elements, and of the elements of other tags that name a solver
 * (is="art-player_1" using="…"), and the <script> tags of their definitions. */
export function stripUniversal(html) {
  const edits = [];
  const tags = scanTags(html);
  const names = pageTagNames(tags);
  const isDefinition = (src) => {
    const m = SCRIPT_RE.exec(src);
    return !!m && (/^universal-/.test(m[1]) || names.has(m[1]));
  };
  for (const t of tags) {
    if (t.name === 'script' && isDefinition(getAttr(t, 'src')?.value ?? '')) {
      const close = html.toLowerCase().indexOf('</script>', t.end);
      let start = t.start, end = close < 0 ? t.end : close + '</script>'.length;
      // The whole line when the tag is alone on it, as update-page wrote it.
      const lineStart = html.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = html.indexOf('\n', end);
      if (!html.slice(lineStart, start).trim() && !html.slice(end, lineEnd < 0 ? html.length : lineEnd).trim()) {
        start = lineStart; end = lineEnd < 0 ? html.length : lineEnd + 1;
      }
      edits.push({ start, end, text: '' });
      continue;
    }
    if (!names.has(getAttr(t, 'is')?.value)) continue;
    t.attrs.forEach((a, i) => {
      if (!UNIVERSAL_ATTRS.has(a.name)) return;
      const prevEnd = i > 0 ? t.attrs[i - 1].end : t.nameEnd;
      edits.push({ start: prevEnd, end: a.end, text: '' });
    });
  }
  return edits.length ? applyEdits(html, edits) : html;
}

/**
 * Plans the revert of a page: what to write and remove.
 * @returns {{ recorded, page: {action, why?, html?}, files: Array<{dest, rel, action, why?, backup?}> }}
 *   action: restore | remove | keep | missing
 */
export function planRevert(pageFile, { force = false } = {}) {
  const file = path.resolve(pageFile);
  const dir = path.dirname(file);
  const name = path.basename(file);
  const current = fs.readFileSync(file, 'utf8');
  const rec = readRecords(dir)[name];
  const elsewhere = usedElsewhere(dir, name);
  const keepShared = (dest) => (elsewhere.has(dest) ? 'another page of this directory loads it' : null);

  if (rec) {
    const original = fs.readFileSync(path.join(recordDir(dir), rec.original), 'utf8');
    const edited = sha256(current) !== rec.written;
    const page = original === current ? { action: 'keep', why: 'already the original' }
      : edited && !force ? { action: 'keep', why: 'edited since update-page (--force restores the original anyway)' }
      : { action: 'restore', html: original };
    const files = rec.files.map((f) => {
      const dest = path.join(dir, f.path);
      if (!fs.existsSync(dest)) return { dest, rel: f.path, action: 'missing' };
      const shared = !f.backup && keepShared(dest);
      if (shared) return { dest, rel: f.path, action: 'keep', why: shared };
      if (sha256(fs.readFileSync(dest)) !== f.sha256 && !force) return { dest, rel: f.path, action: 'keep', why: 'changed since update-page (--force removes it anyway)' };
      return f.backup ? { dest, rel: f.path, action: 'restore', backup: path.join(recordDir(dir), f.backup) } : { dest, rel: f.path, action: 'remove' };
    });
    return { recorded: true, page, files };
  }

  // Not recorded (updated before revert-page existed, or by hand): strip the
  // universal markup and remove what it made the page load.
  const stripped = stripUniversal(current);
  const files = pageRequirements(current, dir).map((r) => {
    const rel = path.relative(dir, r.dest);
    if (!fs.existsSync(r.dest)) return { dest: r.dest, rel, action: 'missing' };
    const shared = keepShared(r.dest);
    return shared ? { dest: r.dest, rel, action: 'keep', why: shared } : { dest: r.dest, rel, action: 'remove' };
  });
  return {
    recorded: false,
    page: stripped === current ? { action: 'keep', why: 'no universal markup' } : { action: 'restore', html: stripped },
    files,
  };
}

/* Carries out a plan; returns it. */
export function applyRevert(pageFile, plan) {
  const file = path.resolve(pageFile);
  const dir = path.dirname(file);
  if (plan.page.action === 'restore') fs.writeFileSync(file, plan.page.html);
  for (const f of plan.files) {
    if (f.action === 'remove') { fs.rmSync(f.dest, { force: true }); removeEmptyDirs(path.dirname(f.dest), dir); }
    else if (f.action === 'restore') fs.copyFileSync(f.backup, f.dest);
  }
  if (plan.recorded) {
    const records = readRecords(dir);
    const rec = records[path.basename(file)];
    // Done with the page: drop its record, unless something was left behind on purpose.
    if (plan.page.action !== 'keep' || plan.page.why === 'already the original') {
      fs.rmSync(path.join(recordDir(dir), rec.original), { force: true });
      for (const f of rec.files) if (f.backup) { fs.rmSync(path.join(recordDir(dir), f.backup), { force: true }); removeEmptyDirs(path.dirname(path.join(recordDir(dir), f.backup)), dir); }
      delete records[path.basename(file)];
      writeRecords(dir, records);
    }
  }
  return plan;
}
