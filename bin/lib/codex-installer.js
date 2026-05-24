import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const INSTALLER_TOKEN = '{{SUPERHARNESS_PLUGIN_ROOT}}';
export const COMMAND_NAMES = ['free.md', 'rollback.md'];

export function parseArgs(argv) {
  const parsed = { mode: null, force: false, help: false };

  for (const arg of argv) {
    if (arg === '--project') {
      setMode(parsed, 'project');
    } else if (arg === '--user' || arg === '--global') {
      setMode(parsed, 'user');
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function setMode(parsed, mode) {
  if (parsed.mode && parsed.mode !== mode) {
    throw new Error('choose only one install target');
  }
  parsed.mode = mode;
}

export function resolveInstallTarget({
  mode,
  cwd = process.cwd(),
  homeDir = process.env.USERPROFILE || process.env.HOME,
}) {
  if (mode !== 'project' && mode !== 'user') {
    throw new Error('install target must be project or user');
  }
  if (mode === 'user' && !homeDir) {
    throw new Error('cannot resolve user home directory');
  }

  const codexRoot = mode === 'project'
    ? path.resolve(cwd, '.codex')
    : path.resolve(homeDir, '.codex');

  return {
    mode,
    codexRoot,
    pluginRoot: path.join(codexRoot, 'plugins', 'superharness'),
    commandsRoot: path.join(codexRoot, 'commands'),
  };
}

export async function backupExistingPath(target, timestamp) {
  if (!(await exists(target))) {
    return null;
  }

  let backupPath = `${target}.bak-${timestamp}`;
  let counter = 1;
  while (await exists(backupPath)) {
    backupPath = `${target}.bak-${timestamp}-${counter}`;
    counter += 1;
  }

  await fs.rename(target, backupPath);
  return backupPath;
}

export async function copyPluginRuntime({ packageRoot, pluginRoot, timestamp }) {
  const source = path.join(packageRoot, 'plugins', 'superharness');
  const backup = await backupExistingPath(pluginRoot, timestamp);
  await fs.mkdir(path.dirname(pluginRoot), { recursive: true });
  await fs.cp(source, pluginRoot, { recursive: true });
  return backup;
}

export function renderCommandTemplate(template, pluginRoot) {
  const rendered = template.replaceAll(INSTALLER_TOKEN, pluginRoot);
  if (rendered.includes(INSTALLER_TOKEN) || rendered.includes('installed-plugin-root')) {
    throw new Error('command template still contains unresolved plugin root placeholder');
  }
  return rendered;
}

export async function installWorkflowDependencies({ pluginRoot, runCommand = spawnCommand }) {
  const cwd = path.join(pluginRoot, 'workflow-state-server');
  try {
    await runCommand('npm', ['install', '--omit=dev'], { cwd });
  } catch (error) {
    throw new Error(`npm install --omit=dev failed in ${cwd}: ${error.message}`);
  }
}

export async function installCodexSupport({
  mode,
  cwd = process.cwd(),
  homeDir = process.env.USERPROFILE || process.env.HOME,
  packageRoot,
  now = () => new Date(),
  runCommand,
} = {}) {
  assertSupportedNode();
  if (!packageRoot) {
    throw new Error('packageRoot is required');
  }

  const target = resolveInstallTarget({ mode, cwd, homeDir });
  const timestamp = formatTimestamp(now());
  const backups = [];

  await fs.mkdir(target.commandsRoot, { recursive: true });
  const pluginBackup = await copyPluginRuntime({
    packageRoot,
    pluginRoot: target.pluginRoot,
    timestamp,
  });
  if (pluginBackup) {
    backups.push(pluginBackup);
  }

  for (const commandName of COMMAND_NAMES) {
    const source = path.join(packageRoot, 'plugins', 'superharness', 'commands-codex', commandName);
    const destination = path.join(target.commandsRoot, commandName);
    const template = await fs.readFile(source, 'utf8');
    const rendered = renderCommandTemplate(template, target.pluginRoot);
    const backup = await backupExistingPath(destination, timestamp);
    if (backup) {
      backups.push(backup);
    }
    await fs.writeFile(destination, rendered, 'utf8');
  }

  await installWorkflowDependencies({ pluginRoot: target.pluginRoot, runCommand });

  return {
    mode: target.mode,
    pluginRoot: target.pluginRoot,
    commandsRoot: target.commandsRoot,
    backups,
  };
}

function assertSupportedNode() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    throw new Error(`Superharness Codex installer requires Node.js >=20; current version is ${process.version}`);
  }
}

function formatTimestamp(date) {
  const parts = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ].map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')));

  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function spawnCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(signal ? `terminated by ${signal}` : `exited with code ${code}`));
      }
    });
  });
}
