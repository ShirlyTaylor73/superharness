#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [, , workspaceRootArg, actionArg] = process.argv;
const action = actionArg || 'status';

if (!workspaceRootArg || !['on', 'off', 'status'].includes(action)) {
  console.error('usage: set-free-mode.mjs <workspaceRoot> [on|off|status]');
  process.exit(1);
}

const workspaceRoot = path.resolve(workspaceRootArg);
const dbPath = path.join(workspaceRoot, '.superharness', 'workflow-state.db');

if (!fs.existsSync(dbPath)) {
  console.error('workspace 未初始化');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const stateModule = await import(pathToFileURL(path.join(pluginRoot, 'workflow-state-server', 'state.js')).href);

const store = stateModule.openWorkflowStateStore({ dbPath });

try {
  const cur = store.prepare('SELECT state, free_mode, free_started_at FROM workflow_state WHERE workspace_id = ?').get(workspaceRoot);
  if (!cur) {
    console.error('workspace state 不存在');
    process.exit(1);
  }

  if (action === 'status') {
    if (cur.free_mode === 1) {
      console.log(`当前在 free mode（自 ${new Date(cur.free_started_at).toISOString()}）`);
    } else {
      console.log('当前不在 free mode');
    }
    process.exit(0);
  }

  if (action === 'on') {
    if (cur.free_mode === 1) {
      console.log(`已在 free mode（自 ${new Date(cur.free_started_at).toISOString()}）`);
      process.exit(0);
    }
    const now = Date.now();
    store.prepare(`UPDATE workflow_state SET free_mode = 1, free_started_at = ?, updated_at = ? WHERE workspace_id = ?`).run(now, now, workspaceRoot);
    store.prepare(`
      INSERT INTO workflow_transition_log
        (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at)
      VALUES (?, ?, ?, NULL, '[free-on] 用户输入 /free on', 'user-reset', NULL, ?)
    `).run(workspaceRoot, cur.state, cur.state, now);
    console.log('已进入 free mode；workflow context 注入已暂停');
    process.exit(0);
  }

  if (action === 'off') {
    if (cur.free_mode === 0) {
      console.log('未在 free mode，无需操作');
      process.exit(0);
    }
    const now = Date.now();
    store.prepare(`UPDATE workflow_state SET free_mode = 0, free_started_at = NULL, updated_at = ? WHERE workspace_id = ?`).run(now, workspaceRoot);
    store.prepare(`
      INSERT INTO workflow_transition_log
        (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at)
      VALUES (?, ?, ?, NULL, '[free-off] 用户输入 /free off', 'user-reset', NULL, ?)
    `).run(workspaceRoot, cur.state, cur.state, now);
    console.log('已退出 free mode；workflow 恢复');
    process.exit(0);
  }
} finally {
  store.close();
}
