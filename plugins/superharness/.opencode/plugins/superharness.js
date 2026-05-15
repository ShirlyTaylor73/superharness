/**
 * Superharness plugin for OpenCode.ai
 *
 * Injects workflow state context via system transform.
 * Auto-registers skills directory via config hook (no symlinks needed).
 */

import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const WORKFLOW_STATE_ROOT = path.join(PLUGIN_ROOT, 'workflow-state-server');
const STATE_MCP_ENTRY = path.join(WORKFLOW_STATE_ROOT, 'server.js');
const STATE_MODULE = path.join(WORKFLOW_STATE_ROOT, 'state.js');
const VALIDATE_MODULE = path.join(WORKFLOW_STATE_ROOT, 'validate-workflow.js');
const RENDER_MODULE = path.join(WORKFLOW_STATE_ROOT, 'render-context.js');

const fallbackStopWorkContext = (reason) => [
  '<SUPERHARNESS_WORKFLOW_STATE>',
  'Runtime status: unavailable',
  `Reason: ${reason || 'workflow state context could not be loaded'}`,
  '',
  'Rules:',
  '- Stop business work.',
  '- Report the workflow error to the user.',
  '- Do not invent workflow state.',
  '- Do not edit .superharness/ directly.',
  '</SUPERHARNESS_WORKFLOW_STATE>',
].join('\n');

const loadInstalledSkills = (pluginRoot) => {
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return new Set();
  return new Set(
    fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry) => entry.name),
  );
};

const hasWorkflowStateDeps = () => {
  const nativeSqlite = path.join(
    WORKFLOW_STATE_ROOT,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  return fs.existsSync(nativeSqlite)
    && fs.existsSync(path.join(WORKFLOW_STATE_ROOT, 'node_modules', 'yaml'))
    && fs.existsSync(path.join(WORKFLOW_STATE_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk'));
};

let depsResult = null;
const ensureWorkflowStateDeps = () => {
  if (depsResult) return depsResult;
  if (hasWorkflowStateDeps()) {
    depsResult = { ok: true };
    return depsResult;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npmCommand,
    ['install', '--omit=dev', '--no-audit', '--no-fund'],
    {
      cwd: WORKFLOW_STATE_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );

  depsResult = result.status === 0 && hasWorkflowStateDeps()
    ? { ok: true }
    : {
        ok: false,
        error: result.stderr || result.stdout || `npm install exited with ${result.status}`,
      };
  return depsResult;
};

const importWorkflowModule = (modulePath) => import(pathToFileURL(modulePath).href);

const loadWorkflowRuntime = async ({ workspaceRoot }) => {
  const deps = ensureWorkflowStateDeps();
  if (!deps.ok) {
    throw new Error(`workflow-state-server dependencies are unavailable: ${deps.error}`);
  }

  const [
    stateModule,
    validateModule,
    renderModule,
  ] = await Promise.all([
    importWorkflowModule(STATE_MODULE), // workflow-state-server/state.js
    importWorkflowModule(VALIDATE_MODULE),
    importWorkflowModule(RENDER_MODULE), // workflow-state-server/render-context.js
  ]);

  const config = validateModule.loadWorkflowConfig({
    pluginRoot: PLUGIN_ROOT,
    workspaceRoot,
  });
  const workflowGraph = validateModule.buildWorkflowGraph(config, {
    installedSkills: loadInstalledSkills(PLUGIN_ROOT),
  });
  const store = stateModule.openWorkflowStateStore({
    dbPath: stateModule.resolveWorkflowDbPath({ workspaceRoot }),
  });

  return {
    store,
    workflowGraph,
    skillsDir: path.join(PLUGIN_ROOT, 'skills'),
    stateModule,
    renderModule,
  };
};

const normalizePathText = (value) => value.replaceAll('\\', '/').toLowerCase();

const pathTouchesWorkflowState = (value) => {
  const normalized = normalizePathText(value);
  return normalized.includes('/.superharness/')
    || normalized.startsWith('.superharness/')
    || normalized.includes('.superharness/');
};

const collectStrings = (value, output = []) => {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
};

const isWriteCommand = (command) => (
  />>?|(^|\s)(rm|del|move|mv|copy|cp|set-content|add-content|out-file|sqlite3)(\s|$)/i
    .test(command)
);

const isWorkflowStateWrite = (tool, args = {}) => {
  const toolName = String(tool || '').toLowerCase();
  const strings = collectStrings(args);

  if (toolName === 'bash' || toolName === 'shell') {
    const command = typeof args.command === 'string' ? args.command : strings.join('\n');
    return pathTouchesWorkflowState(command) && isWriteCommand(command);
  }

  if (toolName === 'write' || toolName === 'edit') {
    return typeof args.filePath === 'string' && pathTouchesWorkflowState(args.filePath);
  }

  if (toolName === 'apply_patch') {
    return strings.some(pathTouchesWorkflowState);
  }

  return strings.some(pathTouchesWorkflowState) && /write|edit/i.test(toolName);
};

export const SuperharnessPlugin = async ({ directory } = {}) => {
  const workspaceRoot = path.resolve(directory || process.cwd());
  const superharnessSkillsDir = path.join(PLUGIN_ROOT, 'skills');

  return {
    config: async (config) => {
      ensureWorkflowStateDeps();
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(superharnessSkillsDir)) {
        config.skills.paths.push(superharnessSkillsDir);
      }

      config.mcp = config.mcp || {};
      config.mcp['superharness-workflow-state'] = {
        type: 'local',
        command: ['node', STATE_MCP_ENTRY],
        enabled: true
      };
    },

    'tool.execute.before': async (input, output) => {
      if (isWorkflowStateWrite(input.tool, output.args)) {
        throw new Error('Workflow state is managed by superharness-workflow-state; use workflow tools instead of editing .superharness/ directly');
      }
    },

    'experimental.chat.system.transform': async (_input, output) => {
      output.system = Array.isArray(output.system) ? output.system : [];
      let runtime;
      try {
        runtime = await loadWorkflowRuntime({ workspaceRoot });
        const stateInfo = runtime.stateModule.getWorkflowState(runtime.store, {
          workspaceRoot,
          workflowGraph: runtime.workflowGraph,
        });
        output.system.push(runtime.renderModule.renderWorkflowContext({
          stateInfo,
          workflowGraph: runtime.workflowGraph,
          skillsDir: runtime.skillsDir,
        }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        try {
          const renderModule = await importWorkflowModule(RENDER_MODULE);
          output.system.push(renderModule.renderStopWorkContext({ reason }));
        } catch {
          output.system.push(fallbackStopWorkContext(reason));
        }
      } finally {
        runtime?.store?.close();
      }
    }
  };
};
