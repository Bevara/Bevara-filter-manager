/* The files a page needs to work, and putting them where it looks for them.
 *
 * A universal element - or one of a tag built on them (is="art-player_1") -
 * loads three kinds of file:
 *   - its definition, <tag>_<N>.js (universal-img_1.js…), from the <script src>
 *     of the page;
 *   - the solver named by using="…": <using>.js and <using>.wasm;
 *   - the accessors named by with="…": <module>.wasm.
 * Without script-directory, the player resolves the last two against the page
 * itself, so they go next to it (the layout of the Showcase pages). A
 * script-directory is only honoured as an absolute URL - the player checks
 * that it is one and otherwise drops it - so a page pointing there needs
 * nothing copied.
 *
 * Accessors, solvers (runtime packages) and tag scripts (tags packages) come
 * from the registry index, verified against their integrity hashes; local
 * directories (--runtime) are looked in first for scripts and solvers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanTags, getAttr } from './html.js';
import { isUrl } from './source.js';
import { splitModule } from './manifest.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest();
const SCRIPT_RE = /(?:^|\/)([A-Za-z0-9][A-Za-z0-9._-]*_\d+\.js)(?:[?#].*)?$/;

/* The elements of a page that go through the pipeline: a universal tag, or
 * another customised element that names its solver (using="…"). Their "is"
 * names the scripts the page loads for them. */
const isPipelineElement = (t) => {
  const is = getAttr(t, 'is')?.value;
  return !!is && (/^universal-/.test(is) || !!getAttr(t, 'using'));
};
export const pageTagNames = (tags) => new Set(tags.filter(isPipelineElement).map((t) => getAttr(t, 'is').value));

/**
 * What the page loads, from its final HTML.
 * @returns {Array<{ kind: 'script'|'solver'|'accessor', name: string, dest: string, ref: string }>}
 *   name: the file to fetch; dest: where the page will look for it (absolute);
 *   ref: how the page refers to it, for messages.
 */
export function pageRequirements(html, pageDir) {
  const out = new Map();
  const add = (kind, name, rel) => {
    const dest = path.resolve(pageDir, rel);
    if (!out.has(dest)) out.set(dest, { kind, name, dest, ref: rel });
  };
  const tags = scanTags(html);
  const names = pageTagNames(tags);
  for (const t of tags) {
    if (t.name !== 'script') continue;
    const src = getAttr(t, 'src')?.value;
    const m = src && !isUrl(src) && !src.startsWith('/') ? SCRIPT_RE.exec(src) : null;
    // The definition of a universal tag, or of a tag an element of the page uses.
    if (m && (/^universal-/.test(m[1]) || names.has(m[1].slice(0, -3)))) add('script', m[1], decodeURI(src.replace(/[?#].*$/, '')));
  }
  for (const t of tags) {
    if (!isPipelineElement(t)) continue;
    // An absolute script-directory serves the modules from elsewhere.
    const dirAttr = getAttr(t, 'script-directory')?.value ?? '';
    if (dirAttr.split(';').some((d) => d && isUrl(d))) continue;
    const using = getAttr(t, 'using')?.value;
    if (using) { add('solver', `${using}.js`, `${using}.js`); add('solver', `${using}.wasm`, `${using}.wasm`); }
    for (const m of (getAttr(t, 'with')?.value ?? '').split(';').map((x) => x.trim()).filter(Boolean)) add('accessor', `${m}.wasm`, `${m}.wasm`);
  }
  return [...out.values()];
}

/**
 * Where each required file comes from: the registry index for accessors; for
 * scripts and solvers, the local directories first, then for solvers the
 * runtime packages of the index. Returns the requirements with a `source`, or
 * a `missing` reason.
 */
export function locateSources(reqs, { index, runtimeDirs = [] }) {
  return reqs.map((r) => {
    if (r.kind === 'accessor') {
      const e = index?.filters?.find((f) => f.file === r.name);
      if (!e) return { ...r, missing: index ? 'not published on this registry' : 'the registry is unreachable' };
      return { ...r, source: { url: e.url, integrity: e.integrity, label: `${e.name}@${e.version}` } };
    }
    for (const d of runtimeDirs) {
      const local = path.join(d, r.name);
      if (fs.existsSync(local)) return { ...r, source: { file: local, label: local } };
    }
    if (r.kind === 'solver') {
      const rt = index?.runtimes?.find((x) => x.file === r.name || x.js === r.name);
      if (rt) {
        const js = rt.js === r.name;
        return { ...r, source: { url: js ? rt.jsUrl : rt.url, integrity: js ? rt.jsIntegrity : rt.integrity, label: `${rt.name}@${rt.version}` } };
      }
      // An earlier release, pinned by version: the index lists only the latest
      // one, but /accessors/<module>.<ext> serves any release.
      const id = splitModule(r.name.replace(/\.(js|wasm)$/, ''));
      const family = id?.version && index?.runtimes?.find((x) => splitModule(x.module)?.base === id.base);
      if (family) return { ...r, source: { url: new URL(`../../${r.name}`, family.url).href, label: `${family.name}@${id.version}` } };
      return { ...r, missing: index ? `no runtime ${r.name.replace(/\.(js|wasm)$/, '')} on this registry${runtimeDirs.length ? `, nor in ${runtimeDirs.join(', ')}` : ''}` : 'the registry is unreachable' };
    }
    // A tag script: from a tags package of the registry (bevara:universal-tags, bevara:art-player).
    const tag = index?.tags?.find((t) => t.file === r.name);
    if (tag) return { ...r, source: { url: tag.url, integrity: tag.integrity, label: `${tag.name}@${tag.version}` } };
    return { ...r, missing: index ? `no tags package on this registry provides ${r.name}${runtimeDirs.length ? `, nor ${runtimeDirs.join(', ')}` : ''} (bevara tags lists them)` : 'the registry is unreachable' };
  });
}

/**
 * Copies or downloads what is missing next to the page. An existing file is
 * kept when it already matches, and when it differs unless `refresh`: a
 * hand-built module next to a page is not overwritten silently.
 * @returns the requirements with `status`: present | added | replaced | kept | failed | missing
 */
export async function deployFiles(located, { client, refresh = false, dryRun = false, onReplace = null }) {
  const results = [];
  for (const r of located) {
    if (r.missing) { results.push({ ...r, status: 'missing' }); continue; }
    try {
      const data = r.source.file ? fs.readFileSync(r.source.file) : await client.download(r.source.url);
      if (r.source.integrity && `sha256-${sha256(data).toString('base64')}` !== r.source.integrity) {
        results.push({ ...r, status: 'failed', error: `integrity mismatch for ${r.source.url}` });
        continue;
      }
      let existing = null;
      try { existing = fs.readFileSync(r.dest); } catch { /* not there */ }
      if (existing && existing.equals(data)) { results.push({ ...r, status: 'present' }); continue; }
      if (existing && !refresh) { results.push({ ...r, status: 'kept' }); continue; }
      if (!dryRun) {
        if (existing && onReplace) onReplace(r.dest);      // revert-page restores it
        fs.mkdirSync(path.dirname(r.dest), { recursive: true });
        fs.writeFileSync(r.dest, data);
      }
      results.push({ ...r, status: existing ? 'replaced' : 'added', size: data.length });
    } catch (e) {
      results.push({ ...r, status: 'failed', error: e.message });
    }
  }
  return results;
}
