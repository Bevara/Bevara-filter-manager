import readline from 'node:readline';
import { Writable } from 'node:stream';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const color = { bold: c(1), dim: c(2), red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36) };

export const log = {
  info: (...a) => console.log(...a),
  ok: (...a) => console.log(color.green('✔'), ...a),
  warn: (...a) => console.error(color.yellow('⚠'), ...a),
  error: (...a) => console.error(color.red('✖'), ...a),
  step: (...a) => console.error(color.dim('→'), ...a),
};

export class CliError extends Error {
  constructor(message, { exitCode = 1, hint } = {}) { super(message); this.exitCode = exitCode; this.hint = hint; }
}

export function table(rows, { header, indent = '' } = {}) {
  const all = header ? [header, ...rows] : rows;
  if (!all.length) return '';
  const widths = [];
  for (const r of all) r.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, strip(String(cell ?? '')).length); });
  const fmt = (r) => indent + r.map((cell, i) => { const s = String(cell ?? ''); return s + ' '.repeat(widths[i] - strip(s).length); }).join('  ').trimEnd();
  const lines = all.map(fmt);
  if (header) lines.splice(1, 0, indent + widths.map((w) => '─'.repeat(w)).join('  '));
  return lines.join('\n');
}

const strip = (s) => s.replace(/\x1b\[\d+m/g, '');

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* A single line rewritten in place: "label  42% ███░░░". On a non-TTY stderr
 * nothing is drawn until done(), which prints the final line once. */
export function progress(label) {
  const live = process.stderr.isTTY;
  const width = 24;
  let last = -1;
  const draw = (pct, suffix = '') => {
    const filled = Math.round((pct / 100) * width);
    process.stderr.write(`\r\x1b[2K${color.dim('→')} ${label} ${String(pct).padStart(3)}% ${color.cyan('█'.repeat(filled))}${color.dim('░'.repeat(width - filled))}${suffix}`);
  };
  return {
    update(done, total) {
      const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
      if (!live || pct === last) return;
      last = pct;
      draw(pct, pct === 100 ? color.dim('  waiting for the registry…') : '');
    },
    done() {
      if (live) { draw(100); process.stderr.write('\n'); }
      else log.step(`${label} 100%`);
    },
    fail() { if (live && last >= 0) process.stderr.write('\n'); },
  };
}

export async function prompt(question, { default: def, hidden = false, validate } = {}) {
  const muted = new Writable({ write(chunk, enc, cb) { if (!this.muted) process.stdout.write(chunk, enc); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: hidden ? muted : process.stdout, terminal: true });
  try {
    for (;;) {
      const label = def !== undefined && !hidden ? `${question} ${color.dim(`(${def})`)}: ` : `${question}: `;
      const answer = await new Promise((resolve, reject) => {
        rl.once('close', () => reject(new CliError('no input available for the prompt', { hint: 'pass values with flags (e.g. -u/-e) or BEVARA_PASSWORD for non-interactive use' })));
        // The label goes through readline: written before, it is erased when
        // readline draws its own (empty) prompt, leaving a blank line that waits.
        muted.muted = false;
        rl.question(label, resolve);
        muted.muted = hidden;
      });
      if (hidden) process.stdout.write('\n');
      const value = answer.trim() === '' && def !== undefined ? def : answer.trim();
      const err = validate?.(value);
      if (err) { log.warn(err); continue; }
      return value;
    }
  } finally { rl.close(); }
}

export async function confirm(question, def = false) {
  const a = await prompt(`${question} ${def ? '[Y/n]' : '[y/N]'}`, { default: def ? 'y' : 'n' });
  return /^y(es)?$/i.test(a);
}
