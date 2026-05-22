import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR_LABEL = '.' + 'superharness/';

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function resolvePluginRoot() {
  return path.resolve(
    process.env.CLAUDE_PLUGIN_ROOT
      || process.env.CODEX_PLUGIN_ROOT
      || path.join(__dirname, '..'),
  );
}

function workflowStateRoot(pluginRoot) {
  return path.join(pluginRoot, 'workflow-state-server');
}

function hasWorkflowStateDeps(workflowStateDir) {
  const nativeSqlite = path.join(
    workflowStateDir,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  return fs.existsSync(nativeSqlite)
    && fs.existsSync(path.join(workflowStateDir, 'node_modules', 'yaml'))
    && fs.existsSync(path.join(workflowStateDir, 'node_modules', '@modelcontextprotocol', 'sdk'));
}

function ensureWorkflowStateDeps(workflowStateDir) {
  if (hasWorkflowStateDeps(workflowStateDir)) return { ok: true };

  // Node 22+ on Windows refuses to spawn .cmd / .bat without shell: true
  // (CVE-2024-27980 mitigation). To avoid DEP0190 warnings from
  // shell: true + args[], pass the full command as a single string and
  // omit the args array on Windows. Arguments here are hard-coded constants,
  // so there is no injection surface.
  const isWin = process.platform === 'win32';
  const result = isWin
    ? spawnSync('npm.cmd install --omit=dev --no-audit --no-fund', {
      cwd: workflowStateDir,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: true,
    })
    : spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: workflowStateDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });

  if (result.status === 0 && hasWorkflowStateDeps(workflowStateDir)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: result.error?.message
      || result.stderr
      || result.stdout
      || `npm install exited with ${result.status}`,
  };
}

function importFrom(workflowStateDir, file) {
  return import(pathToFileURL(path.join(workflowStateDir, file)).href);
}

function loadInstalledSkills(pluginRoot) {
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return new Set();
  return new Set(
    fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry) => entry.name),
  );
}

function hookOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

const fallbackStopWorkContext = (reason) => [
  '<SUPERHARNESS_WORKFLOW_STATE>',
  'Runtime status: unavailable',
  `Reason: ${reason || 'workflow state context could not be loaded'}`,
  '',
  'Rules:',
  '- Stop business work.',
  '- Report the workflow error to the user.',
  '- Do not invent workflow state.',
  `- Do not edit ${STATE_DIR_LABEL} directly.`,
  '</SUPERHARNESS_WORKFLOW_STATE>',
].join('\n');

export async function main() {
  let store;
  const pluginRoot = resolvePluginRoot();
  const workflowStateDir = workflowStateRoot(pluginRoot);

  const deps = ensureWorkflowStateDeps(workflowStateDir);
  if (!deps.ok) {
    process.stdout.write(`${JSON.stringify(hookOutput(fallbackStopWorkContext(`workflow-state-server dependencies are unavailable: ${deps.error}`)))}\n`);
    return;
  }

  try {
    const input = await readStdinJson();
    const workspaceRoot = path.resolve(input.cwd || process.cwd());

    // Free-mode check: skip injection entirely
    const { isFreeMode } = await import(pathToFileURL(path.join(pluginRoot, 'hooks', 'lib', 'free-mode-check.mjs')).href);
    if (await isFreeMode({ pluginRoot, workspaceRoot })) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }

    const [
      { loadWorkflowConfig, buildWorkflowGraph },
      { openWorkflowStateStore, getWorkflowState, resolveWorkflowDbPath, createTurn },
      { renderWorkflowContext },
    ] = await Promise.all([
      importFrom(workflowStateDir, 'validate-workflow.js'),
      importFrom(workflowStateDir, 'state.js'),
      importFrom(workflowStateDir, 'render-context.js'),
    ]);
    const config = loadWorkflowConfig({ pluginRoot, workspaceRoot });
    const workflowGraph = buildWorkflowGraph(config, {
      installedSkills: loadInstalledSkills(pluginRoot),
    });
    store = openWorkflowStateStore({
      mode: process.env.SUPERHARNESS_WORKFLOW_STATE_MODE,
      dbPath: process.env.SUPERHARNESS_WORKFLOW_STATE_DB
        || resolveWorkflowDbPath({ workspaceRoot }),
    });
    const turnId = crypto.randomUUID();
    createTurn(store, { workspaceRoot, turnId });
    const stateInfo = getWorkflowState(store, {
      workspaceRoot,
      workflowGraph,
    });
    const context = renderWorkflowContext({
      stateInfo,
      workflowGraph,
      skillsDir: path.join(pluginRoot, 'skills'),
    });
    process.stdout.write(`${JSON.stringify(hookOutput(context))}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const { renderStopWorkContext } = await importFrom(workflowStateDir, 'render-context.js');
      process.stdout.write(`${JSON.stringify(hookOutput(renderStopWorkContext({ reason })))}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify(hookOutput(fallbackStopWorkContext(reason)))}\n`);
    }
  } finally {
    store?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
