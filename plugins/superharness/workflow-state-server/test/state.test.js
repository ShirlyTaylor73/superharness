import { describe, it, expect, afterEach } from 'vitest';
import {
  openWorkflowStateStore,
  initializeWorkflowState,
  getWorkflowState,
  classifyRequest,
  transitionWorkflowState,
  listWorkflowHistory,
  resetWorkflowState,
  resolveWorkflowDbPath,
} from '../state.js';
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
    brainstorming: {
      type: 'interactive',
      skill: 'brainstorming',
      next: ['planning', 'systematic_debugging'],
    },
    planning: {
      type: 'interactive',
      skill: 'writing-plans',
      next: ['execution_choice', 'systematic_debugging'],
    },
    execution_choice: {
      type: 'router',
      next: ['serial_execution', 'parallel_execution', 'systematic_debugging'],
    },
    serial_execution: {
      type: 'execution',
      skill: 'serial-executing-plans',
      next: ['verification', 'systematic_debugging'],
    },
    parallel_execution: {
      type: 'execution',
      skill: 'parallel-executing-plans',
      next: ['verification', 'systematic_debugging'],
    },
    verification: {
      type: 'gate',
      skill: 'verification-before-completion',
      next: ['finishing', 'systematic_debugging'],
    },
    finishing: {
      type: 'gate',
      skill: 'finishing-a-development-branch',
      next: ['done', 'systematic_debugging'],
    },
    systematic_debugging: {
      type: 'preemptive',
      skill: 'systematic-debugging',
      next: ['previous_state', 'serial_execution', 'planning'],
    },
    done: {
      type: 'terminal',
    },
  },
}, { installedSkills });

const stores = [];

function openStore() {
  const store = openWorkflowStateStore({ mode: 'memory' });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length) {
    stores.pop().close();
  }
});

describe('workflow state store', () => {
  it('initializes an empty workspace to brainstorming', () => {
    const store = openStore();
    const state = initializeWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      reason: 'start',
    });

    expect(state.state).toBe('brainstorming');
    expect(state.active_skill).toBe('brainstorming');
    expect(state.status).toBe('active');
  });

  it('allows a legal transition and writes history', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    const state = transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'brainstorming',
      to_state: 'planning',
      reason: 'requirements are clear',
      source: 'agent-tool',
    });

    expect(state.state).toBe('planning');
    expect(state.active_skill).toBe('writing-plans');
    expect(listWorkflowHistory(store, { workspaceRoot: '/workspace/a' }).at(-1).to_state).toBe('planning');
  });

  it('rejects an illegal transition without changing state', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'brainstorming',
      to_state: 'finishing',
      reason: 'skip',
      source: 'agent-tool',
    })).toThrow(/brainstorming.*finishing/);

    expect(getWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph }).state)
      .toBe('brainstorming');
  });

  it('rejects from_state mismatch', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'planning',
      to_state: 'execution_choice',
      reason: 'wrong source',
      source: 'agent-tool',
    })).toThrow(/from_state.*planning.*current.*brainstorming/);
  });

  it('rejects an empty reason', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'brainstorming',
      to_state: 'planning',
      reason: ' ',
      source: 'agent-tool',
    })).toThrow(/reason/);
  });

  it('records previous_state when entering systematic_debugging', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    const state = transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'brainstorming',
      to_state: 'systematic_debugging',
      reason: 'test failure',
      source: 'agent-tool',
    });

    expect(state.state).toBe('systematic_debugging');
    expect(state.previous_state).toBe('brainstorming');
  });

  it('resolves previous_state only from systematic_debugging', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'brainstorming',
      to_state: 'previous_state',
      reason: 'return',
      source: 'agent-tool',
    })).toThrow(/previous_state.*systematic_debugging/);

    transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'brainstorming',
      to_state: 'systematic_debugging',
      reason: 'debug',
      source: 'agent-tool',
    });

    const state = transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'systematic_debugging',
      to_state: 'previous_state',
      reason: 'fixed',
      source: 'agent-tool',
    });

    expect(state.state).toBe('brainstorming');
    expect(state.previous_state).toBeNull();
  });

  it('updates request classification fields without changing state', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    const state = classifyRequest(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      task_summary: 'implement state machine',
      failure_summary: 'none',
      reason: 'classified user request',
    });

    expect(state.state).toBe('brainstorming');
    expect(state.task_summary).toBe('implement state machine');
    expect(state.failure_summary).toBe('none');
  });

  it('resets state to brainstorming and writes a user-reset log', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });
    transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'brainstorming',
      to_state: 'planning',
      reason: 'ready',
      source: 'agent-tool',
    });

    const state = resetWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      reason: 'manual reset',
    });

    expect(state.state).toBe('brainstorming');
    expect(listWorkflowHistory(store, { workspaceRoot: '/workspace/a' }).at(-1).source).toBe('user-reset');
  });

  it('uses an explicit environment db path when provided', () => {
    const previous = process.env.SUPERHARNESS_WORKFLOW_STATE_DB;
    process.env.SUPERHARNESS_WORKFLOW_STATE_DB = '/tmp/custom-workflow.db';
    try {
      expect(resolveWorkflowDbPath({ workspaceRoot: '/workspace/a' })).toBe('/tmp/custom-workflow.db');
    } finally {
      if (previous === undefined) {
        delete process.env.SUPERHARNESS_WORKFLOW_STATE_DB;
      } else {
        process.env.SUPERHARNESS_WORKFLOW_STATE_DB = previous;
      }
    }
  });
});
