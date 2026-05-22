import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  openWorkflowStateStore,
  initializeWorkflowState,
  getWorkflowState,
  classifyRequest,
  transitionWorkflowState,
  listWorkflowHistory,
  resolveWorkflowDbPath,
} from '../state.js';
import { buildWorkflowGraph } from '../validate-workflow.js';

const installedSkills = new Set([
  'intake',
  'exploration',
  'trivial',
  'brainstorming',
  'planning',
  'serial-execution',
  'parallel-execution',
  'verification',
  'finishing',
  'systematic-debugging',
]);

const workflowGraph = buildWorkflowGraph({
  version: 1,
  entryState: 'intake',
  terminalStates: [],
  states: {
    intake: {
      type: 'interactive',
      skill: 'intake',
      next: ['exploration', 'trivial', 'brainstorming'],
    },
    exploration: {
      type: 'interactive',
      skill: 'exploration',
      next: ['intake'],
    },
    trivial: {
      type: 'execution',
      skill: 'trivial',
      next: ['intake', 'systematic_debugging'],
    },
    brainstorming: {
      type: 'interactive',
      skill: 'brainstorming',
      next: ['planning'],
    },
    planning: {
      type: 'interactive',
      skill: 'planning',
      next: ['serial_execution', 'parallel_execution'],
    },
    serial_execution: {
      type: 'execution',
      skill: 'serial-execution',
      next: ['verification', 'systematic_debugging'],
    },
    parallel_execution: {
      type: 'execution',
      skill: 'parallel-execution',
      next: ['verification', 'systematic_debugging'],
    },
    verification: {
      type: 'gate',
      skill: 'verification',
      next: ['finishing', 'systematic_debugging'],
    },
    finishing: {
      type: 'gate',
      skill: 'finishing',
      next: ['intake', 'systematic_debugging'],
    },
    systematic_debugging: {
      type: 'preemptive',
      skill: 'systematic-debugging',
      next: ['previous_state', 'serial_execution', 'planning'],
    },
  },
}, { installedSkills });

const stores = [];

function openStore() {
  const store = openWorkflowStateStore({ mode: 'memory' });
  stores.push(store);
  return store;
}

// Seed the store at an arbitrary state for tests whose pre-conditions are not
// reachable from intake without a long transition chain. Bypasses transition
// validation by writing directly via raw SQL.
function seedState(store, { workspaceRoot, state, previousState = null }) {
  const workspaceId = path.resolve(workspaceRoot);
  store.prepare(`
    UPDATE workflow_state
       SET state = ?,
           previous_state = ?,
           active_skill = ?,
           updated_at = ?
     WHERE workspace_id = ?
  `).run(
    state,
    previousState,
    workflowGraph.states.get(state)?.skill ?? null,
    Date.now(),
    workspaceId,
  );
}

afterEach(() => {
  while (stores.length) {
    stores.pop().close();
  }
});

describe('workflow state store', () => {
  it('initializes an empty workspace to intake', () => {
    const store = openStore();
    const state = initializeWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      reason: 'start',
    });

    expect(state.state).toBe('intake');
    expect(state.active_skill).toBe('intake');
    expect(state.status).toBe('active');
  });

  it('allows a legal transition and writes history', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    const state = transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'intake',
      to_state: 'brainstorming',
      reason: 'requirements need brainstorming',
      source: 'agent-tool',
    });

    expect(state.state).toBe('brainstorming');
    expect(state.active_skill).toBe('brainstorming');
    expect(listWorkflowHistory(store, { workspaceRoot: '/workspace/a' }).at(-1).to_state).toBe('brainstorming');
  });

  it('rejects an illegal transition without changing state', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    // intake -> finishing skips the entire dev cycle and is not a legal v3 edge
    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'intake',
      to_state: 'finishing',
      reason: 'skip',
      source: 'agent-tool',
    })).toThrow(/intake.*finishing/);

    expect(getWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph }).state)
      .toBe('intake');
  });

  it('rejects from_state mismatch', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'planning',
      to_state: 'serial_execution',
      reason: 'wrong source',
      source: 'agent-tool',
    })).toThrow(/from_state.*planning.*current.*intake/);
  });

  it('rejects an empty reason', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'intake',
      to_state: 'brainstorming',
      reason: ' ',
      source: 'agent-tool',
    })).toThrow(/reason/);
  });

  it('records previous_state when entering systematic_debugging', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });
    // Seed to serial_execution (a state with a systematic_debugging exit in v3)
    seedState(store, { workspaceRoot: '/workspace/a', state: 'serial_execution' });

    const state = transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'serial_execution',
      to_state: 'systematic_debugging',
      reason: 'test failure',
      source: 'agent-tool',
    });

    expect(state.state).toBe('systematic_debugging');
    expect(state.previous_state).toBe('serial_execution');
  });

  it('resolves previous_state only from systematic_debugging', () => {
    const store = openStore();
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });

    // previous_state from intake is illegal (only systematic_debugging may use it)
    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'intake',
      to_state: 'previous_state',
      reason: 'return',
      source: 'agent-tool',
    })).toThrow(/previous_state.*systematic_debugging/);

    // Seed to serial_execution then preempt into systematic_debugging
    seedState(store, { workspaceRoot: '/workspace/a', state: 'serial_execution' });
    transitionWorkflowState(store, {
      workspaceRoot: '/workspace/a',
      workflowGraph,
      from_state: 'serial_execution',
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

    expect(state.state).toBe('serial_execution');
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

    expect(state.state).toBe('intake');
    expect(state.task_summary).toBe('implement state machine');
    expect(state.failure_summary).toBe('none');
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

describe('legacy state migration', () => {
  it('migrates legacy done state to intake on read', () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    const workspaceRoot = '/workspace/legacy-test';
    const workspaceId = path.resolve(workspaceRoot);
    store.prepare(`
      INSERT INTO workflow_state (workspace_id, state, status, previous_state, active_skill, task_summary, failure_summary, updated_at)
      VALUES (?, 'done', 'completed', null, null, null, null, ?)
    `).run(workspaceId, Date.now());

    const state = getWorkflowState(store, { workspaceRoot });
    expect(state.state).toBe('intake');

    const history = listWorkflowHistory(store, { workspaceRoot });
    const migration = history.find(h => h.to_state === 'intake' && h.from_state === 'done');
    expect(migration).toBeDefined();
    expect(migration.reason).toMatch(/legacy.*migration/i);
    expect(migration.source).toBe('user-reset');
  });

  it('migrates legacy execution_choice state to planning', () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    const workspaceRoot = '/workspace/legacy-ec';
    const workspaceId = path.resolve(workspaceRoot);
    store.prepare(`
      INSERT INTO workflow_state (workspace_id, state, status, previous_state, active_skill, task_summary, failure_summary, updated_at)
      VALUES (?, 'execution_choice', 'active', null, null, null, null, ?)
    `).run(workspaceId, Date.now());

    const state = getWorkflowState(store, { workspaceRoot });
    expect(state.state).toBe('planning');

    const history = listWorkflowHistory(store, { workspaceRoot });
    const migration = history.find(h => h.to_state === 'planning' && h.from_state === 'execution_choice');
    expect(migration).toBeDefined();
    expect(migration.reason).toMatch(/legacy.*migration/i);
  });

  it('does not migrate non-legacy states', () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    const workspaceRoot = '/workspace/normal-test';
    const workspaceId = path.resolve(workspaceRoot);
    store.prepare(`
      INSERT INTO workflow_state (workspace_id, state, status, previous_state, active_skill, task_summary, failure_summary, updated_at)
      VALUES (?, 'brainstorming', 'active', null, 'brainstorming', null, null, ?)
    `).run(workspaceId, Date.now());

    const state = getWorkflowState(store, { workspaceRoot });
    expect(state.state).toBe('brainstorming');

    const history = listWorkflowHistory(store, { workspaceRoot });
    expect(history).toHaveLength(0);
  });
});
