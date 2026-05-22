import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openWorkflowStateStore, initializeWorkflowState } from '../state.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/set-free-mode.mjs');
const PLUGIN_ROOT = path.resolve(__dirname, '../..');

function seed(workspaceRoot) {
  const store = openWorkflowStateStore({ dbPath: path.join(workspaceRoot, '.superharness', 'workflow-state.db') });
  const config = loadWorkflowConfig({ pluginRoot: PLUGIN_ROOT, workspaceRoot });
  const graph = buildWorkflowGraph(config, { installedSkills: new Set(['intake','brainstorming','exploration','trivial','planning','serial-execution','parallel-execution','verification','finishing','systematic-debugging']) });
  initializeWorkflowState(store, { workspaceRoot, workflowGraph: graph });
  store.close();
}

describe('set-free-mode.mjs', () => {
  let ws;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-free-')); seed(ws); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('on flips free_mode to 1 + writes audit log', () => {
    const r = spawnSync('node', [SCRIPT, ws, 'on'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/已进入 free mode/);

    const store = openWorkflowStateStore({ dbPath: path.join(ws, '.superharness', 'workflow-state.db') });
    const row = store.prepare('SELECT free_mode, free_started_at FROM workflow_state WHERE workspace_id = ?').get(ws);
    expect(row.free_mode).toBe(1);
    expect(row.free_started_at).toBeGreaterThan(0);
    const log = store.prepare("SELECT reason FROM workflow_transition_log WHERE reason LIKE '[free-on]%'").get();
    expect(log).toBeDefined();
    store.close();
  });

  it('off flips back + clears free_started_at', () => {
    spawnSync('node', [SCRIPT, ws, 'on'], { encoding: 'utf8' });
    const r = spawnSync('node', [SCRIPT, ws, 'off'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/已退出 free mode/);

    const store = openWorkflowStateStore({ dbPath: path.join(ws, '.superharness', 'workflow-state.db') });
    const row = store.prepare('SELECT free_mode, free_started_at FROM workflow_state WHERE workspace_id = ?').get(ws);
    expect(row.free_mode).toBe(0);
    expect(row.free_started_at).toBeNull();
    store.close();
  });

  it('status reports current state', () => {
    const r = spawnSync('node', [SCRIPT, ws, 'status'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/free mode/i);
  });
});
