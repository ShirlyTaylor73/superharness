import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowConfig,
  buildWorkflowGraph,
} from '../workflow-state-server/validate-workflow.js';
import {
  openWorkflowStateStore,
  getWorkflowState,
  resolveWorkflowDbPath,
} from '../workflow-state-server/state.js';
import {
  renderWorkflowContext,
  renderStopWorkContext,
} from '../workflow-state-server/render-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export async function main() {
  let store;
  try {
    const input = await readStdinJson();
    const workspaceRoot = path.resolve(input.cwd || process.cwd());
    const pluginRoot = resolvePluginRoot();
    const config = loadWorkflowConfig({ pluginRoot, workspaceRoot });
    const workflowGraph = buildWorkflowGraph(config, {
      installedSkills: loadInstalledSkills(pluginRoot),
    });
    store = openWorkflowStateStore({
      mode: process.env.SUPERHARNESS_WORKFLOW_STATE_MODE,
      dbPath: process.env.SUPERHARNESS_WORKFLOW_STATE_DB
        || resolveWorkflowDbPath({ workspaceRoot }),
    });
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
    process.stdout.write(`${JSON.stringify(hookOutput(renderStopWorkContext({ reason })))}\n`);
  } finally {
    store?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
