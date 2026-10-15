import fs from 'node:fs';
import path from 'node:path';
import { log, color, table, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { sniff } from '../lib/sniff.js';
import { readSource, isUrl } from '../lib/source.js';
import { scanTags, getAttr, setAttributes, renameAttr, applyEdits, previewEdits } from '../lib/html.js';
import { resolveTree, installResolved } from '../lib/resolve.js';
import { needsOf, videoTailNeeds, resolvePipeline, pageSolver, describeNeed } from '../lib/capabilities.js';
import { mediaTracks, closeMediaInfo } from '../lib/mediainfo.js';
import { extensionOf } from '../lib/formats.js';
import { pageRequirements, locateSources, deployFiles } from '../lib/page-files.js';

export const options = {
  write: { type: 'boolean', short: 'w' },
  force: { type: 'boolean', short: 'f' },
  'non-native': { type: 'boolean' },
  attrs: { type: 'string' },
  scripts: { type: 'string' },
  'no-scripts': { type: 'boolean' },
  install: { type: 'boolean', short: 'i' },
  offline: { type: 'boolean' },
  runtime: { type: 'string', multiple: true },
  'no-files': { type: 'boolean' },
  refresh: { type: 'boolean' },
};

export const help = `Rewrites a page so its media elements go through the universal tags: each
<img>, <audio>, <video> and <canvas> whose src can be identified gets the
customised built-in element and the pipeline that decodes it. A <canvas> takes
its source from data-url, as the player reads it; a src on it is renamed.

  <img src="photo.jxl">
  <img is="universal-img_1" src="photo.jxl" using="solver_minimal_1" with="libjxl_1">

The file is probed, not guessed: an .mp4 holding HEVC and one holding AV1 get
different \`with\` lists. Nothing is written unless --write is passed; by default
the changes are shown as a diff. Everything the command does not touch is kept
byte for byte, including quoting and indentation.

With --write, the files the page then loads are put where it looks for them:
the universal-*.js scripts under --scripts, and the solver (using="…") and the
accessors (with="…") next to the page, as the player resolves them. Accessors
and solvers (runtime packages) come from the registry, checked against their
integrity hashes; --runtime <dir> is looked in first, and is where the tag
scripts come from. A file already there is kept when it differs (a module
built by hand), unless --refresh.

  bevara update-page index.html
  bevara update-page site/**/*.html --write
  bevara update-page index.html --write --runtime ../player/build   scripts and solvers from a local build
  bevara update-page index.html --write --install     also record the accessors in bevara.json
  bevara update-page index.html --attrs "progressive use-worker"

Options:
  -w, --write        apply the changes (default: show the diff only)
  -f, --force        rewrite elements that already carry an "is" attribute
  -i, --install      also install the accessors into the site project (bevara.json, lockfile)
  --runtime <dir>    take the universal-*.js scripts and the solvers from this directory
                     (repeatable; looked in before the registry)
  --no-files         rewrite the HTML only, copy nothing
  --refresh          replace files next to the page that differ from their source
  --non-native       only convert formats no browser engine decodes natively
  --attrs "a b"      extra attributes to set, e.g. "progressive use-worker use-cache"
  --scripts <base>   where the universal-*.js scripts live (default: scripts/)
  --no-scripts       do not add the <script> tags for the universal elements
  --offline          use the built-in accessor names, unchecked: they may name
                     accessors nobody has published
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
    // Elements to rewrite, once the page's solver is known; and the solvers
    // of universal elements left as they are.
    const pending = [];
    const present = new Set();

    for (const tag of scanTags(html)) {
      if (tag.name === 'source') { report.warnings.push('<source> children are not rewritten: the universal tags read "src" on the element itself'); continue; }
      if (!MEDIA_TAGS.has(tag.name)) continue;
      // A universal canvas reads its source from data-url (canvas has no src);
      // a <canvas src> written for it is renamed below.
      const srcAttr = tag.name === 'canvas' ? (getAttr(tag, 'data-url') ? 'data-url' : 'src') : 'src';
      const src = getAttr(tag, srcAttr)?.value;
      const line = html.slice(0, tag.start).split('\n').length;
      if (!src) { if (tag.name !== 'canvas') report.warnings.push(`line ${line}: <${tag.name}> has no src`); continue; }
      if (src.startsWith('data:') || src.startsWith('blob:')) continue;
      const already = getAttr(tag, 'is');
      if (already && !opts.force) {
        const u = getAttr(tag, 'using')?.value;
        if (u) present.add(u);
        report.elements.push({ line, tag: tag.name, src, skipped: `already ${already.value}` });
        continue;
      }

      let info, tracks, target;
      try {
        target = isUrl(src) ? src : path.resolve(dir, decodeURIComponent(src));
        const source = await readSource(target);
        info = sniff({ head: source.head, tail: source.tail, name: target, mime: source.mime, size: source.size });
        tracks = await mediaTracks(target, source);
      } catch (e) {
        const why = /ENOENT/.test(e.message) ? 'file not found' : e.message.replace(/^cannot fetch \S+: /, '');
        report.elements.push({ line, tag: tag.name, src, skipped: why });
        continue;
      }
      // MediaInfo knows formats the built-in table does not, and the other way round.
      const general = tracks?.find((t) => t['@type'] === 'General');
      const kind = ['Video', 'Image', 'Audio'].map((t) => tracks?.some((x) => x['@type'] === t) && t.toLowerCase()).find(Boolean) ?? info.kind;
      if (!info.format && !general?.Format) { report.elements.push({ line, tag: tag.name, src, skipped: 'format not identified' }); continue; }
      if (!index && !info.with.length) { report.elements.push({ line, tag: tag.name, src, skipped: 'no built-in pipeline for this format (drop --offline to ask the registry)' }); continue; }
      info = { ...info, kind, format: info.format ?? general.Format };
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
      // With a registry, the accessors are the published ones that declare what
      // the file needs; a page is not pointed at modules nobody has published.
      // A <video> plays what was decoded once it is remuxed and re-encoded.
      const needs = index ? [...needsOf(tracks, { ext: extensionOf(target) }), ...(tag.name === 'video' ? videoTailNeeds() : [])] : null;
      const element = tag.name === 'canvas' ? 'canvas' : tag.name;
      const pipeline = index ? resolvePipeline(needs, index, { prefer: element === 'canvas' ? 'solver_1' : info.using }) : null;
      if (pipeline?.missing.length) {
        report.elements.push({ line, tag: tag.name, src, format: info.format, skipped: `nothing on this registry can ${pipeline.missing.map(describeNeed).join(', ')}` });
        continue;
      }
      if (pipeline?.conflict) {
        report.elements.push({ line, tag: tag.name, src, format: info.format, skipped: `no solver links all its accessors: ${pipeline.conflict.map((c) => `${c.module} needs ${c.using.join(' or ')}`).join(', ')}` });
        continue;
      }
      pending.push({ tag, srcAttr, line, src, info, element, pipeline });
    }

    /* One solver per page: the loader keeps the first one it loads. Take one
     * that every element's accessors link against; failing that, each keeps
     * its own and the page is flagged. */
    const pipelines = pending.map((p) => p.pipeline).filter(Boolean);
    const shared = pipelines.length ? pageSolver(pipelines, [...present]) : null;
    for (const p of pending) {
      const { tag, srcAttr, line, src, info, element, pipeline } = p;
      const using = pipeline ? (shared ?? pipeline.using) : info.using;
      const withList = pipeline ? (shared ? pipeline.bySolver.get(shared).with : pipeline.with) : info.with;
      const is = `universal-${element}_1`;
      needTags.add(element);

      const values = { is, using, with: withList.join(';') };
      for (const a of extra) values[a] = null;      // boolean attributes: progressive, use-worker…
      const tagEdits = [...setAttributes(html, tag, values), ...(srcAttr === 'src' && tag.name === 'canvas' ? renameAttr(tag, 'src', 'data-url') : [])];
      edits.push(...tagEdits);
      for (const m of withList) allModules.add(m);
      report.elements.push({ line, tag: tag.name, src, format: info.format, kind: info.kind, native: info.native,
        streams: info.streams.map((s) => `${s.type}/${s.codec ?? '?'}`), is, using, with: withList,
        changed: tagEdits.length > 0 });
    }
    const solvers = new Set([...present, ...report.elements.filter((e) => e.using).map((e) => e.using)]);
    if (solvers.size > 1) report.warnings.push(`this page loads several solvers (${[...solvers].join(', ')}): only the first one loaded is kept, so the elements asking for another fail`);
    report.elements.sort((a, b) => a.line - b.line);

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
      }
    }

    report.changed = edits.length > 0;
    report.updated = report.changed ? applyEdits(html, edits) : html;
    report.dir = dir;
    report.preview = report.changed ? previewEdits(html, edits) : [];
    reports.push(report);

    if (report.changed && opts.write) await fs.promises.writeFile(file, report.updated);
  }

  // What the pages load once rewritten, put where they look for it.
  if (!opts['no-files']) {
    const runtimeDirs = (opts.runtime ?? []).map((d) => path.resolve(d));
    for (const d of runtimeDirs) if (!fs.existsSync(d)) throw new CliError(`--runtime ${d}: no such directory`);
    for (const r of reports) {
      const reqs = pageRequirements(r.updated, r.dir);
      if (!reqs.length) continue;
      r.files = await deployFiles(locateSources(reqs, { index, runtimeDirs }), { client, refresh: opts.refresh, dryRun: !opts.write });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(reports.map(({ updated, preview, dir, ...r }) => r), null, 2));
    return;
  }

  await closeMediaInfo();
  for (const r of reports) print(r, opts, registry);

  const touched = reports.filter((r) => r.changed);
  const copied = reports.flatMap((r) => (r.files ?? []).filter((f) => f.status === 'added' || f.status === 'replaced'));
  const parts = [touched.length && `${touched.length} page${touched.length === 1 ? '' : 's'}`, copied.length && `${copied.length} file${copied.length === 1 ? '' : 's'} next to ${touched.length || reports.length === 1 ? 'it' : 'them'}`].filter(Boolean);
  if (!parts.length) log.info('nothing to change');
  else if (opts.write) log.ok(`updated ${parts.join(', ')}`);
  else log.info(color.dim(`${parts.join(' and ')} to update: run again with ${color.bold('--write')} to apply`));

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

const FILE_MARK = { added: '+', replaced: '↻', present: '=', kept: '!', missing: '✖', failed: '✖' };

function printFiles(r, opts) {
  if (!r.files?.length) return;
  const would = !opts.write;
  const present = r.files.filter((f) => f.status === 'present');
  for (const f of r.files) {
    if (f.status === 'present') continue;
    const mark = FILE_MARK[f.status];
    const where = color.dim(`← ${f.source?.label ?? ''}`);
    if (f.status === 'added' || f.status === 'replaced') console.log(`  ${color.green(mark)} ${f.ref}  ${where}${would ? color.dim(` (with --write)`) : ''}`);
    else if (f.status === 'kept') log.warn(`  ${f.ref} differs from ${f.source.label}; kept (--refresh replaces it)`);
    else log.warn(`  ${f.ref}: ${f.status === 'missing' ? f.missing : f.error}`);
  }
  if (present.length) console.log(color.dim(`  = ${present.length} file${present.length > 1 ? 's' : ''} already up to date next to the page`));
  const missing = r.files.filter((f) => f.status === 'missing' && f.kind !== 'accessor');
  if (missing.some((f) => f.kind === 'solver')) log.info('  solvers are runtime packages: publish one with bevara publish --build in its directory, or pass --runtime <dir> with a player build');
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
  }
  if (r.scripts.length) console.log(`  ${color.green('+')} ${r.scripts.map((s) => `<script src="${s}">`).join(', ')}`);
  for (const w of r.warnings) log.warn('  ' + w);
  printFiles(r, opts);

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
