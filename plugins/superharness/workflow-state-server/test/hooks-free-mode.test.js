import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openWorkflowStateStore, initializeWorkflowState } from '../state.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const HOOK_CONTEXT = path.join(PLUGIN_ROOT, 'hooks', 'workflow-context.mjs');
const HOOK_STOP = path.join(PLUGIN_ROOT, 'hooks', 'workflow-stop.mjs');
const HOOK_POST = path.join(PLUGIN_ROOT, 'hooks', 'workflow-post-transition.mjs');

function seedFreeMode(ws) {
  const store = openWorkflowStateStore({ dbPath: path.join(ws, '.superharness', 'workflow-state.db') });
  const config = loadWorkflowConfig({ pluginRoot: PLUGIN_ROOT, workspaceRoot: ws });
  const graph = buildWorkflowGraph(config, { installedSkills: new Set(['intake','brainstorming','exploration','trivial','planning','serial-execution','parallel-execution','verification','finishing','systematic-debugging']) });
  initializeWorkflowState(store, { workspaceRoot: ws, workflowGraph: graph });
  store.prepare('UPDATE workflow_state SET free_mode = 1 WHERE workspace_id = ?').run(path.resolve(ws));
  store.close();
}

function runHook(scriptPath, ws, input) {
  return spawnSync('node', [scriptPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: ws,
    },
  });
}

describe('hooks short-circuit in free mode', () => {
  let ws;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-hk-')); seedFreeMode(ws); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('workflow-context outputs empty object (no injection)', () => {
    const r = runHook(HOOK_CONTEXT, ws, { cwd: ws });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toEqual({});
  });

  it('workflow-stop outputs empty object (no block)', () => {
    const r = runHook(HOOK_STOP, ws, { cwd: ws });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toEqual({});
  });

  it('workflow-post-transition outputs empty object', () => {
    const r = runHook(HOOK_POST, ws, { cwd: ws, tool_input: { to_state: 'brainstorming' } });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toEqual({});
  });
});
