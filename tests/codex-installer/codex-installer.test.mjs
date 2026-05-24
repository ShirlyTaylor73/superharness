import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTALLER_TOKEN,
  installCodexSupport,
  parseArgs,
  renderCommandTemplate,
  resolveInstallTarget,
} from '../../bin/lib/codex-installer.js';
import { main } from '../../bin/superharness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const legacyPluginRootPlaceholder = ['installed', 'plugin-root'].join('-');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'superharness-codex-installer-'));
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createPackageRoot() {
  const packageRoot = await makeTempDir();
  const pluginRoot = path.join(packageRoot, 'plugins', 'superharness');
  await writeFile(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    '{"name":"superharness","version":"1.5.0"}\n',
  );
  await writeFile(path.join(pluginRoot, '.mcp.json'), '{}\n');
  await writeFile(path.join(pluginRoot, 'hooks', 'hooks-codex.json'), '[]\n');
  await writeFile(path.join(pluginRoot, 'scripts', 'set-free-mode.mjs'), 'console.log("free")\n');
  await writeFile(path.join(pluginRoot, 'scripts', 'rollback.mjs'), 'console.log("rollback")\n');
  await writeFile(
    path.join(pluginRoot, 'workflow-state-server', 'package.json'),
    '{"name":"workflow-state-server"}\n',
  );
  await writeFile(
    path.join(pluginRoot, 'workflow-state-server', 'node_modules', 'local-only.txt'),
    'do not copy\n',
  );
  await writeFile(
    path.join(pluginRoot, 'commands-codex', 'free.md'),
    `node "${INSTALLER_TOKEN}/scripts/set-free-mode.mjs"\n`,
  );
  await writeFile(
    path.join(pluginRoot, 'commands-codex', 'rollback.md'),
    `node "${INSTALLER_TOKEN}/scripts/rollback.mjs"\n`,
  );
  return packageRoot;
}

test('parseArgs resolves install flags', () => {
  assert.deepEqual(parseArgs(['--project']), { mode: 'project', force: false, help: false });
  assert.deepEqual(parseArgs(['--user', '--force']), { mode: 'user', force: true, help: false });
  assert.deepEqual(parseArgs(['--global']), { mode: 'user', force: false, help: false });
  assert.deepEqual(parseArgs(['--help']), { mode: null, force: false, help: true });
  assert.throws(() => parseArgs(['--project', '--user']), /choose only one/i);
  assert.throws(() => parseArgs(['--unknown']), /unknown argument: --unknown/i);
});

test('main rejects non-interactive install without explicit target', async () => {
  await assert.rejects(() => main([], { CI: '1' }), /requires --project or --user/i);
});

test('resolveInstallTarget returns project paths', async () => {
  const cwd = await makeTempDir();
  const target = resolveInstallTarget({ mode: 'project', cwd });

  assert.equal(target.mode, 'project');
  assert.equal(target.codexRoot, path.join(cwd, '.codex'));
  assert.equal(target.pluginRoot, path.join(cwd, '.codex', 'plugins', 'superharness'));
  assert.equal(target.commandsRoot, path.join(cwd, '.codex', 'commands'));
});

test('resolveInstallTarget returns user paths', async () => {
  const homeDir = await makeTempDir();
  const target = resolveInstallTarget({ mode: 'user', homeDir });

  assert.equal(target.mode, 'user');
  assert.equal(target.codexRoot, path.join(homeDir, '.codex'));
  assert.equal(target.pluginRoot, path.join(homeDir, '.codex', 'plugins', 'superharness'));
  assert.equal(target.commandsRoot, path.join(homeDir, '.codex', 'commands'));
});

test('renderCommandTemplate writes concrete plugin root', () => {
  const rendered = renderCommandTemplate(
    `node "${INSTALLER_TOKEN}/scripts/x.mjs"`,
    'D:\\Work\\p',
  );

  assert.match(rendered, /D:\\Work\\p/);
  assert.equal(rendered.includes(INSTALLER_TOKEN), false);
  assert.equal(rendered.includes(legacyPluginRootPlaceholder), false);
});

test('installCodexSupport installs project plugin and commands', async () => {
  const packageRoot = await createPackageRoot();
  const cwd = await makeTempDir();
  const homeDir = await makeTempDir();
  const calls = [];

  const result = await installCodexSupport({
    mode: 'project',
    cwd,
    homeDir,
    packageRoot,
    now: () => new Date('2026-05-25T07:30:00Z'),
    runCommand: async (command, args, options) => calls.push({ command, args, cwd: options.cwd }),
  });

  const installedPluginRoot = path.join(cwd, '.codex', 'plugins', 'superharness');
  const freeCommand = path.join(cwd, '.codex', 'commands', 'free.md');
  const rollbackCommand = path.join(cwd, '.codex', 'commands', 'rollback.md');
  const freeContent = await fs.readFile(freeCommand, 'utf8');
  const rollbackContent = await fs.readFile(rollbackCommand, 'utf8');
  const pluginRootPattern = new RegExp(installedPluginRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  assert.equal(result.mode, 'project');
  assert.equal(result.pluginRoot, installedPluginRoot);
  assert.equal(await pathExists(path.join(installedPluginRoot, 'scripts', 'set-free-mode.mjs')), true);
  assert.equal(
    await pathExists(path.join(installedPluginRoot, 'workflow-state-server', 'node_modules')),
    false,
  );
  assert.equal(await pathExists(freeCommand), true);
  assert.equal(await pathExists(rollbackCommand), true);
  assert.match(freeContent, /set-free-mode\.mjs/);
  assert.match(freeContent, pluginRootPattern);
  assert.equal(freeContent.includes(INSTALLER_TOKEN), false);
  assert.equal(freeContent.includes(legacyPluginRootPlaceholder), false);
  assert.match(rollbackContent, /rollback\.mjs/);
  assert.match(rollbackContent, pluginRootPattern);
  assert.equal(rollbackContent.includes(INSTALLER_TOKEN), false);
  assert.equal(rollbackContent.includes(legacyPluginRootPlaceholder), false);
  assert.deepEqual(calls, [
    {
      command: 'npm',
      args: ['install', '--omit=dev'],
      cwd: path.join(installedPluginRoot, 'workflow-state-server'),
    },
  ]);
});

test('installCodexSupport backs up existing targets before overwrite', async () => {
  const packageRoot = await createPackageRoot();
  const cwd = await makeTempDir();
  const homeDir = await makeTempDir();
  const freeCommand = path.join(cwd, '.codex', 'commands', 'free.md');
  const oldPluginFile = path.join(cwd, '.codex', 'plugins', 'superharness', 'old.txt');

  await writeFile(freeCommand, 'old command\n');
  await writeFile(oldPluginFile, 'old plugin\n');

  await installCodexSupport({
    mode: 'project',
    cwd,
    homeDir,
    packageRoot,
    now: () => new Date('2026-05-25T07:30:00Z'),
    runCommand: async () => {},
  });

  const commandBackup = `${freeCommand}.bak-20260525-073000`;
  const pluginBackup = `${path.join(cwd, '.codex', 'plugins', 'superharness')}.bak-20260525-073000`;

  assert.match(await fs.readFile(freeCommand, 'utf8'), /set-free-mode\.mjs/);
  assert.equal(await fs.readFile(commandBackup, 'utf8'), 'old command\n');
  assert.equal(await fs.readFile(path.join(pluginBackup, 'old.txt'), 'utf8'), 'old plugin\n');
});

test('installCodexSupport installs the real package layout into a temp project', async () => {
  const cwd = await makeTempDir();
  const calls = [];

  await installCodexSupport({
    mode: 'project',
    cwd,
    packageRoot: repoRoot,
    runCommand: async (command, args, options) => calls.push({ command, args, cwd: options.cwd }),
  });

  const installedPluginRoot = path.join(cwd, '.codex', 'plugins', 'superharness');
  const freeCommand = path.join(cwd, '.codex', 'commands', 'free.md');
  const rollbackCommand = path.join(cwd, '.codex', 'commands', 'rollback.md');
  const freeContent = await fs.readFile(freeCommand, 'utf8');
  const rollbackContent = await fs.readFile(rollbackCommand, 'utf8');

  assert.equal(
    await pathExists(path.join(installedPluginRoot, 'workflow-state-server', 'bootstrap.js')),
    true,
  );
  assert.equal(await pathExists(path.join(installedPluginRoot, '.codex-plugin', 'plugin.json')), true);
  assert.equal(await pathExists(freeCommand), true);
  assert.equal(await pathExists(rollbackCommand), true);
  assert.equal(freeContent.includes(INSTALLER_TOKEN), false);
  assert.equal(rollbackContent.includes(INSTALLER_TOKEN), false);
  assert.match(
    calls.at(-1).cwd,
    new RegExp(`\\.codex${escapePathSeparator()}plugins${escapePathSeparator()}superharness${escapePathSeparator()}workflow-state-server$`),
  );
});

function escapePathSeparator() {
  return path.sep === '\\' ? '\\\\' : '/';
}
