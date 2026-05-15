import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadWorkflowConfig, buildWorkflowGraph } from './validate-workflow.js';
import {
  openWorkflowStateStore,
  getWorkflowState,
  classifyRequest,
  transitionWorkflowState,
  listWorkflowHistory,
  resetWorkflowState,
  resolveWorkflowDbPath,
} from './state.js';
import { renderWorkflowContext } from './render-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..');

function loadInstalledSkills(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return new Set();
  return new Set(
    fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry) => entry.name),
  );
}

function createRuntime({
  workspaceRoot = process.cwd(),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
} = {}) {
  const config = loadWorkflowConfig({ pluginRoot, workspaceRoot });
  const workflowGraph = buildWorkflowGraph(config, {
    installedSkills: loadInstalledSkills(pluginRoot),
  });
  const store = openWorkflowStateStore({
    mode: process.env.SUPERHARNESS_WORKFLOW_STATE_MODE,
    dbPath: process.env.SUPERHARNESS_WORKFLOW_STATE_DB
      ?? resolveWorkflowDbPath({ workspaceRoot }),
  });

  return {
    store,
    workflowGraph,
    skillsDir: path.join(pluginRoot, 'skills'),
  };
}

let defaultRuntime;
function getDefaultRuntime() {
  if (!defaultRuntime) {
    defaultRuntime = createRuntime();
  }
  return defaultRuntime;
}

function wrap(handler) {
  return async (args = {}) => {
    try {
      return await handler(args);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createTools(getRuntime = getDefaultRuntime) {
  return [
    {
      name: 'get_state',
      description: 'Return current workflow state and rendered workflow context.',
      inputSchema: {
        type: 'object',
        required: ['workspaceRoot'],
        properties: {
          workspaceRoot: { type: 'string' },
        },
      },
      handler: wrap((args) => {
        const runtime = getRuntime();
        const state = getWorkflowState(runtime.store, {
          workspaceRoot: args.workspaceRoot,
          workflowGraph: runtime.workflowGraph,
        });
        return {
          ...state,
          context: renderWorkflowContext({
            stateInfo: state,
            workflowGraph: runtime.workflowGraph,
            skillsDir: runtime.skillsDir,
          }),
        };
      }),
    },
    {
      name: 'classify_request',
      description: 'Record a task or failure summary for the active workflow.',
      inputSchema: {
        type: 'object',
        required: ['workspaceRoot', 'reason'],
        properties: {
          workspaceRoot: { type: 'string' },
          task_summary: { type: 'string' },
          failure_summary: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: wrap((args) => {
        const runtime = getRuntime();
        return classifyRequest(runtime.store, {
          workspaceRoot: args.workspaceRoot,
          workflowGraph: runtime.workflowGraph,
          task_summary: args.task_summary,
          failure_summary: args.failure_summary,
          reason: args.reason,
        });
      }),
    },
    {
      name: 'transition_state',
      description: 'Validate and execute a workflow state transition.',
      inputSchema: {
        type: 'object',
        required: ['workspaceRoot', 'from_state', 'to_state', 'reason'],
        properties: {
          workspaceRoot: { type: 'string' },
          from_state: { type: 'string' },
          to_state: { type: 'string' },
          previous_state: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: wrap((args) => {
        const runtime = getRuntime();
        return transitionWorkflowState(runtime.store, {
          workspaceRoot: args.workspaceRoot,
          workflowGraph: runtime.workflowGraph,
          from_state: args.from_state,
          to_state: args.to_state,
          previous_state: args.previous_state,
          reason: args.reason,
          source: 'agent-tool',
        });
      }),
    },
    {
      name: 'list_history',
      description: 'List workflow transition history for a workspace.',
      inputSchema: {
        type: 'object',
        required: ['workspaceRoot'],
        properties: {
          workspaceRoot: { type: 'string' },
        },
      },
      handler: wrap((args) => {
        const runtime = getRuntime();
        return listWorkflowHistory(runtime.store, {
          workspaceRoot: args.workspaceRoot,
        });
      }),
    },
    {
      name: 'reset_state',
      description: 'Reset workflow state back to the entry state.',
      inputSchema: {
        type: 'object',
        required: ['workspaceRoot', 'reason'],
        properties: {
          workspaceRoot: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      handler: wrap((args) => {
        const runtime = getRuntime();
        return resetWorkflowState(runtime.store, {
          workspaceRoot: args.workspaceRoot,
          workflowGraph: runtime.workflowGraph,
          reason: args.reason,
        });
      }),
    },
  ];
}

export const TOOLS = createTools(getDefaultRuntime);

export function createMcpServer({ tools = TOOLS } = {}) {
  const server = new Server(
    {
      name: 'superharness-workflow-state',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
      };
    }

    const result = await tool.handler(request.params.arguments ?? {});
    return {
      isError: !!result?.error,
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}

export async function main() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
