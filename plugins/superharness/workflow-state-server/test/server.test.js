import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { TOOLS, createTools } from '../server.js';
import { openWorkflowStateStore, initializeWorkflowState, getWorkflowState } from '../state.js';
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
    intake: { type: 'interactive', skill: 'intake', next: ['exploration', 'trivial', 'brainstorming'] },
    exploration: { type: 'interactive', skill: 'exploration', next: ['intake'] },
    trivial: { type: 'execution', skill: 'trivial', next: ['intake', 'systematic_debugging'] },
    brainstorming: { type: 'interactive', skill: 'brainstorming', next: ['planning'] },
    planning: { type: 'interactive', skill: 'planning', next: ['serial_execution', 'parallel_execution'] },
    serial_execution: { type: 'execution', skill: 'serial-execution', next: ['verification', 'systematic_debugging'] },
    parallel_execution: { type: 'execution', skill: 'parallel-execution', next: ['verification', 'systematic_debugging'] },
    verification: { type: 'gate', skill: 'verification', next: ['finishing', 'systematic_debugging'] },
    finishing: { type: 'gate', skill: 'finishing', next: ['intake', 'systematic_debugging'] },
    systematic_debugging: { type: 'preemptive', skill: 'systematic-debugging', next: ['previous_state', 'serial_execution', 'planning'] },
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

    // intake -> brainstorming is the v3 entry-to-development path
    const result = await toolByName(tools, 'transition_state').handler({
      workspaceRoot: '/workspace/a',
      from_state: 'intake',
      to_state: 'brainstorming',
      reason: 'ready to brainstorm',
    });

    expect(result.state).toBe('brainstorming');
    expect(getWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph }).state).toBe('brainstorming');

    const history = await toolByName(tools, 'list_history').handler({ workspaceRoot: '/workspace/a' });
    expect(history.at(-1).to_state).toBe('brainstorming');
  });

  it('returns a structured error for illegal transitions', async () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    initializeWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph, reason: 'start' });
    const tools = createTools(() => runtimeFor(store));

    // intake -> finishing is not a legal transition in v3
    const result = await toolByName(tools, 'transition_state').handler({
      workspaceRoot: '/workspace/a',
      from_state: 'intake',
      to_state: 'finishing',
      reason: 'skip',
    });

    expect(result.error).toMatch(/intake.*finishing/);
    expect(getWorkflowState(store, { workspaceRoot: '/workspace/a', workflowGraph }).state).toBe('intake');
  });
});

describe('v3 transitions', () => {
  // Helper: open a store, initialize, force-seed to `from` state, run transition_state.
  // Returns { result, finalState } so the caller can assert either the success shape
  // (`result.state`) or the structured error shape (`result.error`).
  async function runTransition({ from, to }) {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    const workspaceRoot = '/workspace/v3';
    initializeWorkflowState(store, { workspaceRoot, workflowGraph, reason: 'start' });

    // If the test wants to start from a state other than the entry state, seed it
    // directly via raw SQL to bypass transition validation (we are testing the
    // transition_state handler, not the seeding path).
    if (from !== workflowGraph.entryState) {
      // systematic_debugging requires a previous_state so the `previous_state`
      // transition test can resolve. Use 'planning' as a safe default — it is in
      // systematic_debugging.next so it is reachable.
      const previousState = from === 'systematic_debugging' ? 'planning' : null;
      store.prepare(`
        UPDATE workflow_state
           SET state = ?,
               previous_state = ?,
               active_skill = ?,
               updated_at = ?
         WHERE workspace_id = ?
      `).run(
        from,
        previousState,
        workflowGraph.states.get(from)?.skill ?? null,
        Date.now(),
        path.resolve(workspaceRoot),
      );
    }

    const tools = createTools(() => runtimeFor(store));
    const result = await toolByName(tools, 'transition_state').handler({
      workspaceRoot,
      from_state: from,
      to_state: to,
      reason: `test ${from} -> ${to}`,
    });
    const finalState = getWorkflowState(store, { workspaceRoot, workflowGraph }).state;
    return { result, finalState };
  }

  // Legal transitions — every edge present in the v3 fixture above.
  it.each([
    ['intake', 'exploration'],
    ['intake', 'trivial'],
    ['intake', 'brainstorming'],
    ['exploration', 'intake'],
    ['trivial', 'intake'],
    ['trivial', 'systematic_debugging'],
    ['brainstorming', 'planning'],
    ['planning', 'serial_execution'],
    ['planning', 'parallel_execution'],
    ['finishing', 'intake'],
    ['finishing', 'systematic_debugging'],
  ])('allows %s -> %s', async (from, to) => {
    const { result, finalState } = await runTransition({ from, to });
    expect(result.error).toBeUndefined();
    expect(result.state).toBe(to);
    expect(finalState).toBe(to);
  });

  // Illegal transitions — these edges are *not* in the v3 graph and must be
  // rejected by the engine's `assertTransitionAllowed` check, which formats the
  // error as "transition X -> Y is not allowed".
  it.each([
    ['brainstorming', 'systematic_debugging'], // brainstorming has no preempt edge
    ['planning', 'systematic_debugging'],       // planning has no preempt edge
    ['intake', 'systematic_debugging'],         // intake has no preempt edge
    ['exploration', 'systematic_debugging'],    // exploration has no preempt edge
    ['intake', 'planning'],                      // must go through brainstorming first
    ['exploration', 'trivial'],                  // must return to intake to re-triage
  ])('rejects %s -> %s', async (from, to) => {
    const { result, finalState } = await runTransition({ from, to });
    expect(result.error).toMatch(/not allowed/);
    expect(finalState).toBe(from);
  });
});
