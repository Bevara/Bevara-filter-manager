import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { log, color, table, formatBytes, CliError } from '../lib/ui.js';
import { clientFor, Project } from '../lib/ctx.js';
import { sniff } from '../lib/sniff.js';
import { readSource } from '../lib/source.js';
import { mediaTracks, closeMediaInfo } from '../lib/mediainfo.js';
import { writePackage, readPackage, findMP4Box, remuxToTracks, addItems } from '../lib/mp4-package.js';
import { writeBundle, readBundle, BUNDLE_SUFFIX } from '../lib/f3-package.js';
import { rewritePages } from './update-page.js';

export const options = {
  format: { type: 'string', short: 'f' },
  output: { type: 'string', short: 'o' },
  element: { type: 'string', short: 'e' },
  attrs: { type: 'string' },
  runtime: { type: 'string', multiple: true },
  viewer: { type: 'boolean' },
  item: { type: 'boolean' },
  keep: { type: 'boolean' },
};

export const help = `Preserves a media file with what plays it: the file, the accessors that
decode it, the solver they link against, the tag script and a page showing it
are packaged as one ISOBMFF (.mp4) file, readable without the registry (§5.3 of
the MMSys'27 paper, "Encapsulation in a Container").

The file is probed and its pipeline chosen on the registry as update-page does;
then, as MP4Box -set-meta html -add-item … -set-primary would, a meta box with
the "html" handler lists the items - each with its name and MIME type - and
the bytes go in the mdat: the page (the primary item), the tag script, the
solver (.js and .wasm), the accessors (Wasm bytecode) and the media file,
unchanged. The package is read back with mp4box.js before the command ends.

A browser opens the package through a service worker that serves its page in
place of the file (GPAC's MP4 Service Worker, extended): --viewer writes it next
to the .mp4, with a page that installs it and opens the package.

  bevara preserve photo.jxl                    photo.bevara.mp4
  bevara preserve clip.ogv -o clip.mp4 --viewer
  bevara preserve clip.ogv --element video --attrs "progressive use-webcodec"

Two containers are offered. "mp4" is the ISOBMFF package described above.
"f3" stages the same pipeline for an F3 file (Zeng et al., PACMMOD 2025),
whose Footer carries a "WASMBinaries" optional section with a lib_urls field
for each binary: the accessors are written with the registry URL and digest a
reader should resolve and check, and the solver is named as the entry point
of the graph they compose. This is the payload an F3 writer serialises, not
an F3 file - producing the container needs fff-poc. See the F3 article.

Options:
  -f, --format <mp4|f3>    container (default: mp4)
  -o, --output <file>      the package (default: <name>.bevara.mp4, or
                           <name>.bevara.f3/ for f3)
  -e, --element <tag>      img, audio, video or canvas (default: from the media:
                           img for an image, audio for audio, canvas for video)
      --attrs "a b"        extra attributes on the element, e.g. "use-webcodec"
      --runtime <dir>      tag scripts and solvers from this directory first
                           (repeatable; then the registry)
      --viewer             write the service worker and an <name>.html that opens
                           the package with it
      --item               carry the media as an item even when GPAC could
                           import it as a track
      --keep               keep the staging directory (the unpacked page)
      --json               machine-readable report`;

const ELEMENTS = new Set(['img', 'audio', 'video', 'canvas']);
const ELEMENT_FOR = { image: 'img', audio: 'audio', video: 'canvas' };
const ITEM_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../templates/preserve');

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* The page of the package: the media in the element that shows it, which
 * update-page then turns into the universal element. */
function pageFor(name, element) {
  const src = escapeHtml(encodeURI(name));
  const tag = element === 'canvas' ? `<canvas data-url="${src}"></canvas>`
    : element === 'img' ? `<img src="${src}" alt="${escapeHtml(name)}">`
      : `<${element} src="${src}" controls></${element}>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; }
    img, video, canvas { max-width: 100vw; max-height: 100vh; }
  </style>
</head>
<body>
  ${tag}
</body>
</html>
`;
}

// The kind of media, as a page shows it: video first, then audio (the cover
// of an MP3 is an Image track), then image.
function kindOf(tracks, info) {
  const has = (t) => tracks?.some((x) => x['@type'] === t);
  return has('Video') ? 'video' : has('Audio') ? 'audio' : has('Image') ? 'image' : info.kind;
}

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara preserve <file...>');
  if (opts.output && args.length > 1) throw new CliError('--output names one package: preserve one file at a time with it');
  if (opts.element && !ELEMENTS.has(opts.element)) throw new CliError(`--element ${opts.element}: one of ${[...ELEMENTS].join(', ')}`);
  const format = opts.format ?? 'mp4';
  if (!['mp4', 'f3'].includes(format)) throw new CliError(`--format ${format}: one of mp4, f3`);
  const project = Project.load({ required: false });
  const { registry, client } = clientFor(opts, project);
  const index = await client.get('/accessors/index.json', { auth: false });
  const reports = [];

  try {
    for (const file of args) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { log.error(`${file}: not found`); process.exitCode = 1; continue; }
      try { reports.push(await preserve(file, { opts, index, client, registry, format })); }
      catch (e) {
        if (!(e instanceof CliError)) throw e;
        log.error(`${file}: ${e.message}`);
        if (e.hint) console.log(color.dim(`  ${e.hint}`));
        process.exitCode = 1;
      }
    }
  } finally { await closeMediaInfo(); }

  if (opts.json) console.log(JSON.stringify(reports, null, 2));
}

async function preserve(file, { opts, index, client, registry, format }) {
  const name = path.basename(file);
  const source = await readSource(path.resolve(file));
  const info = sniff({ head: source.head, tail: source.tail, name, mime: source.mime, size: source.size });
  const tracks = await mediaTracks(path.resolve(file), source);
  const general = tracks?.find((t) => t['@type'] === 'General');
  const kind = kindOf(tracks, info);
  const element = opts.element ?? ELEMENT_FOR[kind];
  if (!element) throw new CliError('the kind of media is not identified: say which element shows it', { hint: '--element img|audio|video|canvas' });

  // The page and the media, staged as the page will see them.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bevara-preserve-'));
  try {
    const base = name.replace(/\.[^.]+$/, '');
    const pkgName = path.basename(opts.output ?? (format === 'f3' ? `${base}${BUNDLE_SUFFIX}` : `${base}.bevara.mp4`));

    /* §5.3 writes the media as a track, so the package stays a movie a native
     * player can open. That is only possible for a file GPAC can import - a
     * PSD or a camera raw has no track representation - so it is attempted
     * and the item form is the fallback. In the track form the page points at
     * the package itself: the service worker finds no item under that name
     * and falls through to the network, which returns the movie. The pipeline
     * is then resolved against the *remuxed* file, so the demultiplexer
     * becomes isobmff rather than the source container's. */
    let track = null;
    if (format === 'mp4' && !opts.item) {
      const gpac = findMP4Box();
      if (gpac) {
        const remuxed = path.join(stage, pkgName);
        const r = remuxToTracks(gpac.bin, path.resolve(file), remuxed);
        if (!r.tracks) log.step(`${name}: GPAC does not import it (${r.why}); carried as an item`);
        else {
          /* Importing is not enough: the track has to still say what it is.
           * ISOBMFF has no registered sample entry for Theora, Dirac or Ut
           * Video, so GPAC stores them under a generic mp4v with a private
           * object type - which MediaInfo, and therefore the resolver, reads
           * as MPEG-4 Visual. The package would then carry an Xvid decoder
           * for a Theora track and would not play. So the codecs of the
           * remuxed file are compared with the source's, and the item form
           * is kept whenever they disagree. */
          const after = await mediaTracks(path.resolve(remuxed), await readSource(path.resolve(remuxed)));
          const codecs = (ts) => (ts ?? []).filter((t) => t['@type'] === 'Video' || t['@type'] === 'Audio')
            .map((t) => `${t['@type']}:${t.Format}`).sort().join(', ');
          const before = codecs(tracks), now = codecs(after);
          if (before && now && before !== now) {
            log.step(`${name}: importing it would restate ${before} as ${now}; carried as an item`);
            fs.rmSync(remuxed, { force: true });
          } else {
            track = { gpac, remuxed, tracks: r.tracks };
            log.step(`${name}: imported as ${r.tracks} track(s) by ${gpac.version}`);
          }
        }
      }
    }

    const shownName = track ? pkgName : name;
    const media = path.join(stage, shownName);
    if (!track) fs.symlinkSync(path.resolve(file), media);
    const page = path.join(stage, 'index.html');
    fs.writeFileSync(page, pageFor(shownName, element));

    log.step(`${name}: ${general?.Format ?? info.format ?? '?'} (${kind ?? '?'}) in <${element}>`);
    const { reports: [r] } = await rewritePages([page], { index, client, opts: { write: true, scripts: './', attrs: opts.attrs, runtime: opts.runtime, refresh: true } });
    const e = r.elements[0];
    if (!e || e.skipped) throw new CliError(`no pipeline for it: ${e?.skipped ?? 'the page has no media element'}`);
    for (const w of r.warnings) log.warn(w);
    const broken = (r.files ?? []).filter((f) => f.status === 'missing' || f.status === 'failed');
    if (broken.length) throw new CliError(broken.map((f) => `${f.ref}: ${f.missing ?? f.error}`).join('; '));

    // The items: the page first (the primary item), the modules in the order
    // the page loads them, the media last.
    const rel = (p) => path.relative(stage, p).split(path.sep).join('/');
    const modules = (r.files ?? []).map((f) => ({ name: rel(f.dest), path: f.dest, kind: f.kind, from: f.source?.label }));
    if (shownName === 'index.html' || modules.some((m) => m.name === shownName)) throw new CliError(`the file is named like an item of the package (${name})`, { hint: 'rename it, then preserve it' });
    const mime = info.mime ?? general?.InternetMediaType ?? 'application/octet-stream';
    const items = [
      { name: 'index.html', path: page, kind: 'page' },
      ...modules,
      /* in the track form the media is in the movie, not in the item list */
      ...(track ? [] : [{ name, path: fs.realpathSync(media), kind: 'media', type: mime }]),
    ].map((it, i) => ({ ...it, id: i + 1, type: it.type ?? ITEM_TYPES[path.extname(it.name)] ?? 'application/octet-stream' }));

    const out = path.resolve(opts.output ?? pkgName);
    if (out === path.resolve(file)) throw new CliError('the package would replace the file it preserves', { hint: 'name another one with -o' });

    let written, check, viewer = null;
    if (format === 'f3') {
      written = writeBundle(items, out, {
        pipeline: e, registry,
        media: { name, type: mime, size: source.size },
      });
      check = readBundle(out);
      if (!check.ok) throw new CliError(`the bundle does not read back: ${check.problems.join('; ')}`);
      if (!opts.json) printF3Report({ file, out, e, items: written.items, size: written.size, wasmBytes: written.wasmBytes });
    } else {
      if (track) {
        fs.copyFileSync(track.remuxed, out);
        const size = addItems(track.gpac.bin, out, items, { primary: 1 });
        written = { items: items.map((it) => ({ ...it, size: fs.statSync(it.path).size })), size };
      } else {
        written = await writePackage(items, out, { primary: 1 });
      }
      // Read back as the service worker reads it: the page, then each item by name.
      check = verify(out, items);
      if (check.ok === false) throw new CliError(`the package does not read back: ${check.problems.join('; ')}`);
      if (!opts.json) printReport({ file, out, e, items: written.items, size: written.size, check, track });
      if (opts.viewer) viewer = writeViewer(out, { quiet: opts.json });
    }

    return {
      file, format, package: out, size: written.size, element: e.is, using: e.using, with: e.with,
      items: written.items.map(({ id, name: n, type, size, kind: k, from }) => ({ id, name: n, type, size, kind: k, from })),
      verified: check.ok, viewer, registry,
    };
  } finally {
    if (opts.keep) log.step(`staging kept in ${stage}`);
    else fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Files above this are not read back whole (the check holds the package in memory).
const VERIFY_LIMIT = 1024 ** 3;

function verify(out, items) {
  if (fs.statSync(out).size > VERIFY_LIMIT) return { ok: null, why: 'too large to read back in memory' };
  const pkg = readPackage(out);
  const problems = [];
  if (pkg.handler !== 'html') problems.push(`meta handler "${pkg.handler}", not "html"`);
  if (pkg.primary?.name !== 'index.html') problems.push('the primary item is not the page');
  for (const it of items) {
    const got = pkg.items.find((x) => x.id === pkg.hasItem(it.name));
    if (!got) { problems.push(`${it.name}: not found by name`); continue; }
    if (!got.data || !Buffer.from(got.data).equals(fs.readFileSync(it.path))) problems.push(`${it.name}: bytes differ`);
    if (got.type !== it.type) problems.push(`${it.name}: MIME ${got.type}, expected ${it.type}`);
  }
  return { ok: !problems.length, problems };
}

function printReport({ file, out, e, items, size, check, track }) {
  console.log(`${color.bold(path.basename(file))}  ${color.dim(`is="${e.is}" using="${e.using}" with="${e.with.join(';')}"`)}`);
  const rows = items.map((it) => [String(it.id), it.name, it.type, formatBytes(it.size), color.dim(it.kind === 'page' ? 'primary item' : it.from ?? it.kind)]);
  console.log(table(rows, { header: ['#', 'Item', 'MIME', 'Size', 'From'], indent: '  ', shrink: [1, 4] }));
  const verified = check.ok ? 'read back with mp4box.js' : `not read back (${check.why})`;
  const form = track ? `${track.tracks} track(s) + ${items.length} items` : `${items.length} items`;
  log.ok(`${path.relative(process.cwd(), out) || out}  ${formatBytes(size)}, ${form}, ${verified}`);
}

function printF3Report({ file, out, e, items, size, wasmBytes }) {
  console.log(`${color.bold(path.basename(file))}  ${color.dim(`solver="${e.using}" accessors="${e.with.join(';')}"`)}`);
  const rows = items.map((it) => [String(it.id), it.file, it.type, formatBytes(it.size), color.dim(it.from ?? it.kind)]);
  console.log(table(rows, { header: ['#', 'In bundle', 'MIME', 'Size', 'From'], indent: '  ', shrink: [1, 4] }));
  console.log(color.dim(`  WASMBinaries section ${formatBytes(wasmBytes)}, lib_urls point at the registry`));
  log.ok(`${path.relative(process.cwd(), out) || out}  ${formatBytes(size)}, ${items.length} items, digests verified`);
  log.warn('this is the payload for an F3 Footer, not an F3 file: serialising it into OptionalMetadataSections needs fff-poc');
}

/* The service worker that opens the package, mp4box.js, and a page that
 * installs the worker and opens the package - next to the .mp4. */
function writeViewer(out, { quiet = false } = {}) {
  const dir = path.dirname(out);
  const pkgName = path.basename(out);
  fs.copyFileSync(path.join(TEMPLATES, 'bevara-sw.js'), path.join(dir, 'bevara-sw.js'));
  const require = createRequire(import.meta.url);
  const dist = path.dirname(require.resolve('mp4box'));
  const libDir = path.join(dir, 'mp4box');
  fs.mkdirSync(libDir, { recursive: true });
  for (const f of fs.readdirSync(dist)) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(dist, f), path.join(libDir, f));
  fs.copyFileSync(path.join(dist, '..', 'LICENSE'), path.join(libDir, 'LICENSE'));
  const html = fs.readFileSync(path.join(TEMPLATES, 'viewer.html'), 'utf8')
    .replaceAll('{{title}}', escapeHtml(pkgName))
    .replaceAll('{{package}}', escapeHtml(pkgName))
    .replaceAll('{{packageJson}}', JSON.stringify(encodeURI(pkgName)));
  const viewer = path.join(dir, pkgName.replace(/\.mp4$/i, '') + '.html');
  fs.writeFileSync(viewer, html);
  if (!quiet) log.ok(`${path.relative(process.cwd(), viewer) || viewer}  opens it (serve the directory over http: bevara-sw.js and mp4box/ beside it)`);
  return viewer;
}
