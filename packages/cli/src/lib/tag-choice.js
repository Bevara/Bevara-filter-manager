/* Which tag each kind of element gets, for update-page --tags.
 *
 * By default every element gets its universal tag (universal-img_1…). A page
 * may ask for others, published as tags packages: each such tag replaces the
 * universal tag of the element it extends, which the registry index gives per
 * script ("extends": "universal-canvas_1"). A choice is
 *   - a tags package:  art-player, or bevara:art-player - each of its scripts;
 *   - a tag:           art-player_1;
 *   - element=tag:     canvas=art-player_1 - no registry needed.
 */
import { CliError } from './ui.js';

export const ELEMENTS = ['img', 'audio', 'video', 'canvas'];
const UNIVERSAL_RE = /^universal-([a-z]+)_\d+$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*_\d+$/;

// The universal tag of an element, the default.
export const universalTag = (element) => `universal-${element}_1`;

/* The universal canvas reads its source from data-url, a canvas having no
 * src; every other tag, a canvas built on it included (art-player_1), reads
 * src, as the other elements do. */
export const sourceAttrFor = (element, tag) => (element === 'canvas' && /^universal-canvas_\d+$/.test(tag) ? 'data-url' : 'src');

// The element a tag stands for: its own if universal, else that of the tag it
// extends, followed through the index (a tag may build on a tag).
function elementOf(tag, index, seen = new Set()) {
  const u = UNIVERSAL_RE.exec(tag);
  if (u) return ELEMENTS.includes(u[1]) ? u[1] : null;
  if (seen.has(tag)) return null;
  seen.add(tag);
  const base = index?.tags?.find((t) => t.file === `${tag}.js`)?.extends;
  return base ? elementOf(base, index, seen) : null;
}

/**
 * @param {string[]} specs  the --tags values; each may hold several, comma-separated
 * @param {object|null} index  the registry index, null offline
 * @returns {Map<string, string>} element → tag, for the elements not left universal
 */
export function chooseTags(specs, index) {
  const chosen = new Map();
  const set = (element, tag) => {
    const prev = chosen.get(element);
    if (prev && prev !== tag) throw new CliError(`--tags gives <${element}> two tags: ${prev} and ${tag}`, { hint: 'keep one tag per element' });
    chosen.set(element, tag);
  };
  for (const spec of specs.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean)) {
    const eq = spec.indexOf('=');
    if (eq >= 0) {
      const element = spec.slice(0, eq).trim(), tag = spec.slice(eq + 1).trim().replace(/\.js$/, '');
      if (!ELEMENTS.includes(element)) throw new CliError(`--tags ${spec}: <${element}> is not a media element (${ELEMENTS.join(', ')})`);
      if (!TAG_RE.test(tag)) throw new CliError(`--tags ${spec}: "${tag}" is not a tag name, which ends in its generation: art-player_1`);
      set(element, tag);
      continue;
    }
    if (!index) throw new CliError(`--tags ${spec} needs the registry, to know which element it extends`, { hint: `drop --offline, or name the element: --tags canvas=${spec}` });
    const name = spec.replace(/\.js$/, '');
    const entries = index.tags ?? [];
    // A tag by its name, else every script of a package.
    let scripts = entries.filter((t) => t.file === `${name}.js`);
    if (!scripts.length) scripts = entries.filter((t) => t.name === name || t.name.split(':').pop() === name);
    if (!scripts.length) throw new CliError(`no tags package nor tag named ${spec} on this registry`, { hint: 'bevara tags lists them' });
    let any = false;
    for (const s of scripts) {
      const tag = s.file.replace(/\.js$/, '');
      const element = elementOf(tag, index);
      // universal-tags_1.js defines them all and stands for no element.
      if (!element) {
        if (scripts.length === 1) throw new CliError(`${tag} does not say which element it extends`, { hint: `name it: --tags canvas=${tag}` });
        continue;
      }
      set(element, tag);
      any = true;
    }
    if (!any) throw new CliError(`none of the scripts of ${spec} says which element it extends`, { hint: `name them: --tags canvas=${scripts[0].file.replace(/\.js$/, '')}` });
  }
  // A universal tag chosen explicitly is the default anyway.
  for (const [element, tag] of chosen) if (tag === universalTag(element)) chosen.delete(element);
  return chosen;
}
