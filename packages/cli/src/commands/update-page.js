import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { sniff } from '../lib/sniff.js';
import { readSource, isUrl } from '../lib/source.js';
import { scanTags, getAttr, setAttributes, applyEdits, previewEdits } from '../lib/html.js';
import { resolveTree, installResolved } from '../lib/resolve.js';

export const options = {
  write: { type: 'boolean', short: 'w' },
  force: { type: 'boolean', short: 'f' },
  'non-native': { type: 'boolean' },
  attrs: { type: 'string' },
  scripts: { type: 'string' },
  'no-scripts': { type: 'boolean' },
  install: { type: 'boolean', short: 'i' },
  offline: { type: 'boolean' },
};

export const help = `Rewrites a page so its media elements go through the universal tags: each
<img>, <audio>, <video> and <canvas> whose src can be identified gets the
customised built-in element and the pipeline that decodes it.

  <img src="photo.jxl">
  <img is="universal-img_1" src="photo.jxl" using="solver_minimal_1" with="libjxl_1">

The file is probed, not guessed: an .mp4 holding HEVC and one holding AV1 get
different \`with\` lists. Nothing is written unless --write is passed; by default
the changes are shown as a diff. Everything the command does not touch is kept
byte for byte, including quoting and indentation.

  bevara update-page index.html
  bevara update-page site/**/*.html --write
  bevara update-page index.html --write --install     also install the accessors it uses
  bevara update-page index.html --attrs "progressive use-worker"

Options:
  -w, --write        apply the changes (default: show the diff only)
  -f, --force        rewrite elements that already carry an "is" attribute
  -i, --install      install the accessors the page ends up requiring
  --non-native       only convert formats no browser engine decodes natively
  --attrs "a b"      extra attributes to set, e.g. "progressive use-worker use-cache"
  --scripts <base>   where the universal-*.js scripts live (default: scripts/)
  --no-scripts       do not add the <script> tags for the universal elements
  --offline          do not check the accessors against the registry
  --json             machine-readable report`;

const MEDIA_TAGS = new Set(['img', 'audio', 'video', 'canvas']);
// The customised built-in element for each kind of media.
const ELEMENT_FOR = { image: 'img', audio: 'audio', video: 'video' };
const TAG_KIND = { img: 'image', audio: 'audio', video: 'video', canvas: 'image' };

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara update-page <file.html...>');
  const project = Project.load({ required: false });
  const { registry, client } = clientFor(opts, project);

  let index = null;
  if (!opts.offline) {
    try { index = await client.get('/accessors/index.json'); }
    catch (e) { log.warn(`registry unreachable (${e.message}); accessors will not be checked`); }
  }
  const published = index ? new Set(index.filters.map((f) => f.file)) : null;
  const extra = (opts.attrs ?? '').split(/[\s;]+/).filter(Boolean);
  const scriptsBase = (opts.scripts ?? 'scripts/').replace(/\/*$/, '/');

  const reports = [];
  const allModules = new Set();

  for (const file of args) {
    const report = { file, elements: [], scripts: [], warnings: [], changed: false };
    let html;
    try { html = await fs.promises.readFile(file, 'utf8'); }
    catch (e) { log.error(`${file}: ${e.message}`); process.exitCode = 1; continue; }
    const dir = path.dirname(path.resolve(file));
    const edits = [];
    const needTags = new Set();

    for (const tag of scanTags(html)) {
      if (tag.name === 'source') { report.warnings.push('<source> children are not rewritten: the universal tags read "src" on the element itself'); continue; }
      if (!MEDIA_TAGS.has(tag.name)) continue;
      const src = getAttr(tag, 'src')?.value;
      const line = html.slice(0, tag.start).split('\n').length;
      if (!src) { if (tag.name !== 'canvas') report.warnings.push(`line ${line}: <${tag.name}> has no src`); continue; }
      if (src.startsWith('data:') || src.startsWith('blob:')) continue;
      const already = getAttr(tag, 'is');
      if (already && !opts.force) { report.elements.push({ line, tag: tag.name, src, skipped: `already ${already.value}` }); continue; }

      let info;
      try {
        const target = isUrl(src) ? src : path.resolve(dir, decodeURIComponent(src));
        const { head, tail, size, mime } = await readSource(target);
        info = sniff({ head, tail, name: target, mime, size });
      } catch (e) {
        const why = /ENOENT/.test(e.message) ? 'file not found' : e.message.replace(/^cannot fetch \S+: /, '');
        report.elements.push({ line, tag: tag.name, src, skipped: why });
        continue;
      }
      if (!info.format || !info.with.length) { report.elements.push({ line, tag: tag.name, src, skipped: 'format not identified' }); continue; }
      if (opts['non-native'] && info.native) { report.elements.push({ line, tag: tag.name, src, skipped: `${info.format} is decoded natively by some engines` }); continue; }

      /* The customised built-in must match the element it extends: an <img>
       * cannot carry is="universal-video_1". A source of the wrong kind is an
       * authoring mistake we report rather than paper over - except on
       * <canvas>, which legitimately renders both images and video. */
      const expected = ELEMENT_FOR[info.kind];
      if (tag.name !== 'canvas' && expected && expected !== tag.name) {
        report.elements.push({ line, tag: tag.name, src, skipped: `${info.format} is ${info.kind}: use <${expected}> (or <canvas>) for this source` });
        continue;
      }
      const element = tag.name === 'canvas' ? 'canvas' : tag.name;
      const is = `universal-${element}_1`;
      needTags.add(element);

      const values = { is, using: info.using, with: info.with.join(';') };
      for (const a of extra) values[a] = null;      // boolean attributes: progressive, use-worker…
      const tagEdits = setAttributes(html, tag, values);
      edits.push(...tagEdits);
      for (const m of info.with) allModules.add(m);
      const missing = published ? info.with.filter((m) => !published.has(`${m}.wasm`)) : [];
      report.elements.push({ line, tag: tag.name, src, format: info.format, kind: info.kind, native: info.native,
        streams: info.streams.map((s) => `${s.type}/${s.codec ?? '?'}`), is, using: info.using, with: info.with, missing,
        changed: tagEdits.length > 0 });
    }

    // The customised elements do nothing unless their definition is loaded.
    if (!opts['no-scripts'] && needTags.size) {
      const haveScript = (name) => scanTags(html).some((t) => t.name === 'script' && (getAttr(t, 'src')?.value ?? '').includes(name));
      const missingScripts = [...needTags].map((t) => `universal-${t}_1.js`).filter((n) => !haveScript(n));
      if (missingScripts.length) {
        const insertAt = findScriptInsertionPoint(html);
        const indent = insertAt.indent ?? '  ';
        const text = missingScripts.map((n) => `${indent}<script src="${scriptsBase}${n}"></script>\n`).join('');
        edits.push({ start: insertAt.offset, end: insertAt.offset, text });
        report.scripts = missingScripts.map((n) => scriptsBase + n);
        for (const n of missingScripts) {
          const local = path.resolve(dir, scriptsBase + n);
          if (!fs.existsSync(local)) report.warnings.push(`${scriptsBase}${n} is not next to the page; copy the universal tag scripts there or pass --scripts`);
        }
      }
    }

    report.changed = edits.length > 0;
    report.updated = report.changed ? applyEdits(html, edits) : html;
    report.preview = report.changed ? previewEdits(html, edits) : [];
    reports.push(report);

    if (report.changed && opts.write) await fs.promises.writeFile(file, report.updated);
  }

  if (opts.json) {
    console.log(JSON.stringify(reports.map(({ updated, preview, ...r }) => r), null, 2));
    return;
  }

  for (const r of reports) print(r, opts, registry);

  const touched = reports.filter((r) => r.changed);
  if (!touched.length) log.info('nothing to change');
  else if (opts.write) log.ok(`updated ${touched.length} file${touched.length === 1 ? '' : 's'}`);
  else log.info(color.dim(`run again with ${color.bold('--write')} to apply`));

  if (opts.install) {
    if (!index) throw new CliError('--install needs the registry', { hint: 'drop --offline, or check `bevara ping`' });
    const names = [...allModules].map((m) => index.filters.find((f) => f.file === `${m}.wasm`)?.name).filter(Boolean);
    if (!names.length) throw new CliError('none of the required accessors are published on this registry');
    if (!project.manifestFile) throw new CliError('no bevara.json here', { hint: 'run `bevara init --site` first' });
    log.step(`installing ${names.length} accessors`);
    const roots = { ...(project.manifest.dependencies ?? {}) };
    for (const n of names) roots[n] ??= 'latest';
    const chosen = await resolveTree(client, roots, { lock: project.lock.filters });
    project.manifest.dependencies ??= {};
    for (const n of names) project.manifest.dependencies[n] ??= `^${chosen.get(n).version}`;
    project.saveManifest();
    const installed = await installResolved(client, project, chosen, { registry });
    log.ok(`${chosen.size} filters in ${path.relative(process.cwd(), project.accessorsDir) || '.'}/ (${installed.length} downloaded)`);
  }
}

/* Scripts go just before </body>, or </html>, or at the end of the document. */
function findScriptInsertionPoint(html) {
  for (const close of ['</body>', '</html>']) {
    const at = html.toLowerCase().lastIndexOf(close);
    if (at < 0) continue;
    const lineStart = html.lastIndexOf('\n', at) + 1;
    return { offset: lineStart, indent: /^(\s*)/.exec(html.slice(lineStart, at))?.[1] ?? '' };
  }
  return { offset: html.length, indent: '' };
}

function print(r, opts, registry) {
  console.log(`${color.bold(r.file)}${r.changed ? '' : color.dim(' — unchanged')}`);
  for (const e of r.elements) {
    if (e.skipped) { console.log(`  ${color.dim('·')} ${String(e.line).padStart(4)} ${color.dim(`<${e.tag}> ${e.src} — ${e.skipped}`)}`); continue; }
    console.log(`  ${color.green('→')} ${String(e.line).padStart(4)} <${e.tag}> ${e.src}  ${color.bold(e.format)} ${color.dim(e.streams.join(' + '))}`);
    console.log(`         ${color.dim(`is="${e.is}" using="${e.using}" with="${e.with.join(';')}"`)}`);
    if (e.missing?.length) log.warn(`       not published on ${registry}: ${e.missing.join(', ')}`);
  }
  if (r.scripts.length) console.log(`  ${color.green('+')} ${r.scripts.map((s) => `<script src="${s}">`).join(', ')}`);
  for (const w of r.warnings) log.warn('  ' + w);

  if (r.changed && !opts.write) {
    console.log();
    for (const block of r.preview) {
      for (const { line, old, now } of block) {
        // A pure insertion keeps the original line as the last of the new ones.
        const insertion = now.length > 1 && now[now.length - 1] === old;
        if (!insertion) console.log(color.red(`  ${String(line + 1).padStart(4)} - ${old.trim()}`));
        for (const n of insertion ? now.slice(0, -1) : now) console.log(color.green(`  ${' '.repeat(4)} + ${n.trim()}`));
      }
      console.log();
    }
  }
}
