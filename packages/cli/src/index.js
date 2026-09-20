import { parseArgs } from 'node:util';
import { CliError, log, color } from './lib/ui.js';
import { RegistryError } from './lib/registry-client.js';

export const COMMANDS = {
  init: { desc: 'Create a new filter (accessor) project in the current directory', mod: './commands/init.js' },
  install: { alias: ['i', 'add'], desc: 'Install filters into the accessors directory', usage: '[filter[@range]...]', mod: './commands/install.js' },
  uninstall: { alias: ['remove', 'rm'], desc: 'Remove filters from the project', usage: '<filter...>', mod: './commands/uninstall.js' },
  update: { alias: ['up', 'upgrade'], desc: 'Update installed filters to the newest allowed versions', usage: '[filter...]', mod: './commands/update.js' },
  outdated: { desc: 'Show filters with newer versions on the registry', mod: './commands/outdated.js' },
  audit: { desc: 'Check installed filters: integrity, advisories, deprecations, licences', mod: './commands/audit.js' },
  list: { alias: ['ls'], desc: 'List filters (installed in the project, or on the registry with --remote)', mod: './commands/list.js' },
  search: { alias: ['find'], desc: 'Search filters on the registry', usage: '<query>', mod: './commands/search.js' },
  info: { alias: ['view', 'show'], desc: 'Show details about a filter', usage: '<filter[@version]>', mod: './commands/info.js' },
  build: { desc: 'Build the filter (.wasm side module) with Emscripten', mod: './commands/build.js' },
  pack: { desc: 'Create the publishable tarball without uploading it', mod: './commands/pack.js' },
  publish: { desc: 'Publish the filter in the current directory to the registry', mod: './commands/publish.js' },
  unpublish: { desc: 'Remove a published version (or a whole filter)', usage: '<filter[@version]>', mod: './commands/unpublish.js' },
  deprecate: { desc: 'Mark a filter or version range as deprecated', usage: '<filter[@range]> <message>', mod: './commands/deprecate.js' },
  owner: { desc: 'Manage who can publish a filter', usage: '<add|rm|ls> [user] <filter>', mod: './commands/owner.js' },
  advisory: { desc: 'Manage security/quality advisories (admin)', usage: '<add|rm|ls> ...', mod: './commands/advisory.js' },
  login: { desc: 'Authenticate against the registry', mod: './commands/login.js' },
  logout: { desc: 'Forget the stored token', mod: './commands/login.js', fn: 'logout' },
  whoami: { desc: 'Show the logged-in user', mod: './commands/login.js', fn: 'whoami' },
  adduser: { alias: ['register', 'signup'], desc: 'Create an account on the registry', mod: './commands/login.js', fn: 'adduser' },
  config: { desc: 'Get/set CLI settings (registry URL)', usage: '<get|set|list> [key] [value]', mod: './commands/config.js' },
  ping: { desc: 'Check that the registry is reachable', mod: './commands/config.js', fn: 'ping' },
};

const GLOBAL_OPTIONS = {
  registry: { type: 'string', short: 'r' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  verbose: { type: 'boolean' },
};

export function help() {
  const rows = Object.entries(COMMANDS).map(([name, c]) => [color.bold(`bevara ${name}`) + (c.usage ? ' ' + color.dim(c.usage) : ''), c.desc]);
  const width = Math.max(...rows.map(([a]) => a.replace(/\x1b\[\d+m/g, '').length));
  console.log(`${color.bold('bevara')} — package manager for Bevara WebAssembly filters\n`);
  console.log(color.bold('Usage:') + ' bevara <command> [options]\n');
  for (const [a, b] of rows) console.log('  ' + a + ' '.repeat(width - a.replace(/\x1b\[\d+m/g, '').length + 2) + b);
  console.log(`\n${color.bold('Global options:')}\n  -r, --registry <url>   registry to talk to (default: config/registry or ${color.dim('https://registry.bevara.ddns.net')})\n  --json                 machine-readable output\n  -y, --yes              accept defaults, no prompts\n  -h, --help             show help for a command`);
}

// A module exports either a flat option map, or one map per exported function
// (e.g. login.js: { run: {...}, adduser: {...} }).
function commandOptions(mod, fn) {
  const o = mod.options ?? {};
  const perFn = Object.values(o).every((v) => v && typeof v === 'object' && !('type' in v));
  return perFn ? (o[fn] ?? {}) : o;
}

export async function main(argv) {
  const [cmdName, ...rest] = argv;
  if (!cmdName || cmdName === 'help' || (cmdName.startsWith('-') && /^(-h|--help)$/.test(cmdName))) { help(); return; }
  if (/^(-v|--version)$/.test(cmdName)) {
    const { readFileSync } = await import('node:fs');
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return;
  }
  const entry = Object.entries(COMMANDS).find(([n, c]) => n === cmdName || c.alias?.includes(cmdName));
  if (!entry) { log.error(`unknown command "${cmdName}"`); help(); process.exitCode = 2; return; }
  const [name, cmd] = entry;
  const mod = await import(cmd.mod);
  const fn = mod[cmd.fn ?? 'run'];
  const options = { ...GLOBAL_OPTIONS, ...commandOptions(mod, cmd.fn ?? 'run') };
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  } catch (e) {
    log.error(e.message);
    process.exitCode = 2;
    return;
  }
  if (parsed.values.help) {
    console.log(`${color.bold('bevara ' + name)} ${color.dim(cmd.usage ?? '')}\n  ${cmd.desc}\n`);
    if (mod.help) console.log(typeof mod.help === 'function' ? mod.help(cmd.fn ?? 'run') : mod.help);
    return;
  }
  try {
    await fn({ args: parsed.positionals, opts: parsed.values, command: name });
  } catch (e) {
    if (e instanceof CliError || e instanceof RegistryError) {
      log.error(e.message);
      if (e.extra?.errors) for (const x of e.extra.errors) log.error('  ' + x);
      if (e.hint) console.error(color.dim(`  hint: ${e.hint}`));
      if (parsed.values.verbose && e.stack) console.error(color.dim(e.stack));
      process.exitCode = e.exitCode ?? 1;
    } else {
      log.error(e.stack ?? String(e));
      process.exitCode = 1;
    }
  }
}
