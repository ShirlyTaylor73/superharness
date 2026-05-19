// Bootstrap wrapper for the MCP server.
//
// Why: Claude Code spawns this MCP server directly via `node bootstrap.js`,
// bypassing any UserPromptSubmit hook self-heal. When the plugin cache is
// freshly populated (e.g. after a version bump), node_modules is missing,
// and statically importing @modelcontextprotocol/sdk in server.js throws
// ERR_MODULE_NOT_FOUND before the server can do anything.
//
// This file installs deps if needed (synchronously, on stderr to avoid
// corrupting MCP stdio) and then dynamically imports the real server.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkPath = path.join(here, 'node_modules', '@modelcontextprotocol', 'sdk');

if (!fs.existsSync(sdkPath)) {
  process.stderr.write('[superharness] MCP server deps not found, running npm install...\n');
  const isWin = process.platform === 'win32';
  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: here,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: isWin,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(
      `[superharness] npm install failed (status=${result.status}, error=${result.error?.message ?? 'none'})\n`,
    );
    process.exit(1);
  }
  process.stderr.write('[superharness] deps installed, starting server\n');
}

await import('./server.js');
