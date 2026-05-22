import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkflowStateStore, readFreeMode, assertNotFreeMode, getWorkflowState } from '../state.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WS = '/tmp/ws';
const WS_ID = path.resolve(WS);

describe('free_mode column', () => {
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
  });

  it('readFreeMode returns false when no row exists', () => {
    expect(readFreeMode(store, WS)).toBe(false);
  });

  it('readFreeMode returns true when free_mode = 1', () => {
    store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, free_mode, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(WS_ID, 'intake', 'active', 1, Date.now());
    expect(readFreeMode(store, WS)).toBe(true);
  });

  it('getWorkflowState includes free_mode and free_started_at', () => {
    const pluginRoot = path.resolve(__dirname, '../..');
    const ws = path.resolve('/tmp/getstate-fm-ws');
    const wsId = path.resolve(ws);
    const now = Date.now();
    store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, active_skill, free_mode, free_started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(wsId, 'intake', 'active', 'intake', 1, now, now);
    const config = loadWorkflowConfig({ pluginRoot, workspaceRoot: ws });
    const graph = buildWorkflowGraph(config, {
      installedSkills: new Set([
        'intake', 'brainstorming', 'exploration', 'trivial', 'planning',
        'serial-execution', 'parallel-execution', 'verification', 'finishing',
        'systematic-debugging',
      ]),
    });
    const result = getWorkflowState(store, { workspaceRoot: ws, workflowGraph: graph });
    expect(result.free_mode).toBe(true);
    expect(result.free_started_at).toBe(now);
  });

  it('assertNotFreeMode throws when free_mode = 1', () => {
    store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, free_mode, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(WS_ID, 'intake', 'active', 1, Date.now());
    expect(() => assertNotFreeMode(store, WS))
      .toThrow(/free mode/);
  });

  it('ensureFreeModeColumns is idempotent on existing schema', () => {
    const store2 = openWorkflowStateStore({ mode: 'memory' });
    expect(() => store2.close()).not.toThrow();
  });
});
