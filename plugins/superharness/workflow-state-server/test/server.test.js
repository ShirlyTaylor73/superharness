import { describe, it, expect, afterEach } from 'vitest';
import { TOOLS, createTools } from '../server.js';
import { openWorkflowStateStore, initializeWorkflowState, getWorkflowState } from '../state.js';
import { buildWorkflowGraph } from '../validate-workflow.js';

const installedSkills = new Set([
  'brainstorming',
  'writing-plans',
  'serial-executing-plans',
  'parallel-executing-plans',
  'verification-before-completion',
  'finishing-a-development-branch',
  'systematic-debugging',
]);

const workflowGraph = buildWorkflowGraph({
  version: 1,
  entryState: 'brainstorming',
  terminalStates: ['done'],
  states: {
    brainstorming: { type: 'interactive', skill: 'brainstorming', next: ['planning', 'systematic_debugging'] },
    planning: { type: 'interactive', skill: 'writing-plans', next: ['execution_choice', 'systematic_debugging'] },
    execution_choice: { type: 'router', next: ['serial_execution', 'parallel_execution', 'systematic_debugging'] },
    serial_execution: { type: 'execution', skill: 'serial-executing-plans', next: ['verification', 'systematic_debugging'] },
    parallel_execution: { type: 'execution', skill: 'parallel-executing-plans', next: ['verification', 'systematic_debugging'] },
    verification: { type: 'gate', skill: 'verification-before-completion', next: ['finishing', 'systematic_debugging'] },
    finishing: { type: 'gate', skill: 'finishing-a-development-branch', next: ['done', 'systematic_debugging'] },
    systematic_debugging: { type: 'preemptive', skill: 'systematic-debugging', next: ['previous_state', 'serial_execution', 'planning'] },
    done: { type: 'terminal' },
  },
}, { installedSkills });

const stores = [];

function runtimeFor(store) {
  return {
    store,
    workflowGraph,
    skillsDir: 'unused',
  };
}

function toolByName(tools, name) {
  return tools.find((tool) => tool.name === name);
}

afterEach(() => {
  while (stores.length) {
    stores.pop().close();
  }
});

describe('TOOLS', () => {
  it('exports the expected tool names', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'get_state',
      'classify_request',
      'transition_state',
      'list_history',
      'reset_state',
    ]);
  });

  it('transitions state and writes history', async () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });
    const tools = createTools(() => runtimeFor(store));

    const result = await toolByName(tools, 'transition_state').handler({
      workspaceRoot: '/workspace/a',
      from_state: 'brainstorming',
      to_state: 'planning',
      reason: 'ready to plan',
    });

    expect(result.state).toBe('planning');
    expect(getWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph }).state).toBe('planning');

    const history = await toolByName(tools, 'list_history').handler({ workspaceRoot: '/workspace/a' });
    expect(history.at(-1).to_state).toBe('planning');
  });

  it('returns a structured error for illegal transitions', async () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });
    const tools = createTools(() => runtimeFor(store));

    const result = await toolByName(tools, 'transition_state').handler({
      workspaceRoot: '/workspace/a',
      from_state: 'brainstorming',
      to_state: 'finishing',
      reason: 'skip',
    });

    expect(result.error).toMatch(/brainstorming.*finishing/);
    expect(getWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph }).state).toBe('brainstorming');
  });
});
