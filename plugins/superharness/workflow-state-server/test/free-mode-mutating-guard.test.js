import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openWorkflowStateStore, transitionWorkflowState, classifyRequest, resetWorkflowState } from '../state.js';
import { handleReleaseStopBlock } from '../server.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setupFreeMode(store, ws) {
  store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, free_mode, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(ws, 'intake', 'active', 1, Date.now());
  store.prepare(`INSERT INTO workflow_turn (workspace_id, turn_id, block_count, stop_block_released, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(ws, 't1', 0, 0, Date.now());
}

describe('mutating tools rejected in free mode', () => {
  const pluginRoot = path.resolve(__dirname, '../..');
  // Use path.resolve since state.js helpers do requireWorkspaceRoot which calls path.resolve internally
  const workspaceRoot = path.resolve('/tmp/free-mode-guard-test');
  const config = loadWorkflowConfig({ pluginRoot, workspaceRoot });
  const graph = buildWorkflowGraph(config, { installedSkills: new Set(['intake','brainstorming','exploration','trivial','planning','serial-execution','parallel-execution','verification','finishing','systematic-debugging']) });
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
    setupFreeMode(store, workspaceRoot);
  });

  it('transitionWorkflowState throws', () => {
    expect(() => transitionWorkflowState(store, {
      workspaceRoot, workflowGraph: graph,
      from_state: 'intake', to_state: 'brainstorming', reason: 'test',
    })).toThrow(/free mode/);
  });

  it('classifyRequest throws', () => {
    expect(() => classifyRequest(store, {
      workspaceRoot, workflowGraph: graph, reason: 'test',
    })).toThrow(/free mode/);
  });

  it('resetWorkflowState throws', () => {
    expect(() => resetWorkflowState(store, {
      workspaceRoot, workflowGraph: graph, reason: 'test',
    })).toThrow(/free mode/);
  });

  it('handleReleaseStopBlock throws', async () => {
    const result = await handleReleaseStopBlock({
      store, args: { workspaceRoot, reason: 'test' },
    }).catch((e) => ({ error: e.message }));
    expect(result.error).toMatch(/free mode/);
  });
});
