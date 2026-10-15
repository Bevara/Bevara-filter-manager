import fs from 'node:fs';
import path from 'node:path';
import { log, color, confirm, CliError } from '../lib/ui.js';
import { planRevert, applyRevert } from '../lib/page-record.js';

export const options = { force: { type: 'boolean', short: 'f' }, 'dry-run': { type: 'boolean', short: 'n' } };
export const help = `Undoes bevara update-page --write: the page goes back to what it was before
the first update-page, and the files it added next to it (tag scripts, solver,
accessors) are removed - those it replaced (--refresh) are restored.

update-page --write records what it does in .bevara/pages.json beside the
page. What changed since is left alone unless --force: a page edited by hand
afterwards, a file rebuilt in place. A file another page of the directory
still loads is never removed.

A page updated before this record existed is reverted without it: the
universal attributes (is, using, with…) and the universal-*.js <script> tags
are removed, and so are the files they made the page load - after a
confirmation, since nothing proves update-page added them.

  bevara revert-page index.html
  bevara revert-page site/*.html --dry-run

Options:
  -n, --dry-run   show what would be done
  -f, --force     restore and remove even what changed since update-page
  -y, --yes       no confirmation`;

const MARK = { restore: color.green('↺'), remove: color.red('-'), keep: color.yellow('='), missing: color.dim('·') };

export async function run({ args, opts }) {
  if (!args.length) throw new CliError('usage: bevara revert-page <file.html...>');
  for (const file of args) {
    if (!fs.existsSync(file)) { log.error(`${file}: not found`); process.exitCode = 1; continue; }
    const plan = planRevert(file, { force: opts.force });
    const name = path.basename(file);
    console.log(`${color.bold(file)}${plan.recorded ? '' : color.yellow('  (no update-page record: removing the universal markup)')}`);
    console.log(`  ${MARK[plan.page.action === 'restore' ? 'restore' : 'keep']} ${name}  ${color.dim(plan.page.action === 'restore' ? (plan.recorded ? 'the original page' : 'without its universal markup') : plan.page.why)}`);
    for (const f of plan.files) {
      const what = { restore: 'restored as it was', remove: 'removed', keep: `kept: ${f.why}`, missing: 'already gone' }[f.action];
      console.log(`  ${MARK[f.action]} ${f.rel}  ${color.dim(what)}`);
    }
    const work = plan.page.action === 'restore' || plan.files.some((f) => f.action === 'remove' || f.action === 'restore');
    if (!work) { log.info('nothing to revert'); continue; }
    if (opts['dry-run']) { log.info(color.dim('dry run: nothing changed')); continue; }
    // Without a record nothing proves update-page wrote those files: ask.
    if (!plan.recorded && !opts.yes) {
      if (!process.stdin.isTTY) throw new CliError(`${file} has no update-page record`, { hint: 'check the list above, then run again with --yes' });
      if (!(await confirm('remove the universal markup and these files?', false))) { log.info('left as it is'); continue; }
    }
    applyRevert(file, plan);
    log.ok(`reverted ${name}`);
  }
}
