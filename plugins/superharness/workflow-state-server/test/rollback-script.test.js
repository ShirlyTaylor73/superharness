import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openWorkflowStateStore, transitionWorkflowState } from '../state.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROLLBACK = path.resolve(__dirname, '../../scripts/rollback.mjs');
const PLUGIN_ROOT = path.resolve(__dirname, '../..');

function seedHistory(workspaceRoot) {
  const dbPath = path.join(workspaceRoot, '.superharness', 'workflow-state.db');
  const store = openWorkflowStateStore({ dbPath });
  const config = loadWorkflowConfig({ pluginRoot: PLUGIN_ROOT, workspaceRoot });
  const graph = buildWorkflowGraph(config, { installedSkills: new Set([
    'intake','brainstorming','exploration','trivial','planning',
    'serial-execution','parallel-execution','verification','finishing','systematic-debugging',
  ]) });
  transitionWorkflowState(store, { workspaceRoot, workflowGraph: graph, from_state: 'intake', to_state: 'brainstorming', reason: 'go to brainstorm' });
  transitionWorkflowState(store, { workspaceRoot, workflowGraph: graph, from_state: 'brainstorming', to_state: 'planning', reason: 'to plan' });
  store.close();
}

describe('rollback.mjs', () => {
  let ws;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-rb-'));
    seedHistory(ws);
  });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('rolls back to a visited state', () => {
    const r = spawnSync('node', [ROLLBACK, ws, 'brainstorming', '[rollback] test'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/已从 planning 回到 brainstorming/);

    const store = openWorkflowStateStore({ dbPath: path.join(ws, '.superharness', 'workflow-state.db') });
    const row = store.prepare('SELECT state FROM workflow_state WHERE workspace_id = ?').get(ws);
    expect(row.state).toBe('brainstorming');
    const log = store.prepare("SELECT reason FROM workflow_transition_log WHERE reason LIKE '[rollback]%'").all();
    expect(log.length).toBe(1);
    const turn = store.prepare('SELECT turn_id, block_count, stop_block_released FROM workflow_turn WHERE workspace_id = ?').get(ws);
    if (turn) {
      expect(turn.block_count).toBe(0);
      expect(turn.stop_block_released).toBe(0);
    }
    store.close();
  });

  it('rejects unknown state', () => {
    const r = spawnSync('node', [ROLLBACK, ws, 'nonexistent-state', '[rollback] x'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/未在历史中出现过/);
  });

  it('rejects when workspace not initialized', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-rb-empty-'));
    const r = spawnSync('node', [ROLLBACK, empty, 'intake', '[rollback] x'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/未初始化/);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('rejects systematic_debugging as target', () => {
    const r = spawnSync('node', [ROLLBACK, ws, 'systematic_debugging', '[rollback] x'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/不支持目标 systematic_debugging/);
  });
});
