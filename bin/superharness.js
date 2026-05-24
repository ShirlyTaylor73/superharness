#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCodexSupport, parseArgs } from './lib/codex-installer.js';
import { selectInstallTarget } from './lib/interactive-select.js';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  let mode = options.mode;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.CI);
  if (!mode) {
    if (!interactive) {
      throw new Error('non-interactive install requires --project or --user');
    }
    mode = await selectInstallTarget();
    if (mode === 'cancel') {
      return 0;
    }
  }

  const result = await installCodexSupport({ mode, packageRoot });
  process.stdout.write(successMessage(result));
  return 0;
}

export function usage() {
  return `Usage: superharness [--project|--user] [--force]

Install Superharness Codex support into a project or user Codex directory.

Options:
  --project   Install into the current repository's .codex directory
  --user      Install into ~/.codex for all Codex projects
  --global    Alias for --user
  --force     Backup and overwrite existing installed assets
  -h, --help  Show this help
`;
}

function successMessage({ mode, pluginRoot, commandsRoot, backups }) {
  const scope = mode === 'project' ? 'project' : 'user';
  const backupLine = backups.length > 0
    ? `Backups created:\n${backups.map((backup) => `  - ${backup}`).join('\n')}\n`
    : '';

  return `Superharness Codex support installed for ${scope} scope.
Plugin: ${pluginRoot}
Commands: ${commandsRoot}
${backupLine}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
