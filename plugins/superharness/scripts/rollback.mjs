#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [, , workspaceRootArg, toStateArg, reasonArg] = process.argv;

if (!workspaceRootArg || !toStateArg || !reasonArg) {
  console.error('usage: rollback.mjs <workspaceRoot> <to_state> <reason>');
  process.exit(1);
}

const workspaceRoot = path.resolve(workspaceRootArg);
const dbPath = path.join(workspaceRoot, '.superharness', 'workflow-state.db');

if (!fs.existsSync(dbPath)) {
  console.error('workspace 未初始化，无 state 可回退');
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const stateModule = await import(pathToFileURL(path.join(pluginRoot, 'workflow-state-server', 'state.js')).href);
const validateModule = await import(pathToFileURL(path.join(pluginRoot, 'workflow-state-server', 'validate-workflow.js')).href);

const store = stateModule.openWorkflowStateStore({ dbPath });

try {
  // 1. 校验 to_state 是否在历史中曾以 to_state 出现过
  const seen = store.prepare(
    'SELECT 1 FROM workflow_transition_log WHERE workspace_id = ? AND to_state = ? LIMIT 1'
  ).get(workspaceRoot, toStateArg);
  if (!seen) {
    const choices = store.prepare(
      'SELECT DISTINCT to_state FROM workflow_transition_log WHERE workspace_id = ? ORDER BY id DESC LIMIT 10'
    ).all(workspaceRoot).map((r) => r.to_state);
    console.error(`state '${toStateArg}' 未在历史中出现过；可用：${choices.join(', ')}`);
    process.exit(1);
  }

  // 2. 取当前 state 用于 stdout 和 log
  const cur = store.prepare('SELECT state FROM workflow_state WHERE workspace_id = ?').get(workspaceRoot);
  const fromState = cur?.state ?? null;

  // 3. 加载 workflow graph 解析目标 state 的 active_skill
  const skillsDir = path.join(pluginRoot, 'skills');
  const installedSkills = new Set(
    fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  const config = validateModule.loadWorkflowConfig({ pluginRoot, workspaceRoot });
  const graph = validateModule.buildWorkflowGraph(config, { installedSkills });
  const activeSkill = graph.states.get(toStateArg)?.skill ?? null;

  const now = Date.now();

  // 4. 写 workflow_state
  store.prepare(`
    UPDATE workflow_state
       SET state = ?, status = 'active', previous_state = NULL, active_skill = ?, updated_at = ?
     WHERE workspace_id = ?
  `).run(toStateArg, activeSkill, now, workspaceRoot);

  // 5. 写 transition_log（source = user-reset）
  store.prepare(`
    INSERT INTO workflow_transition_log
      (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at)
    VALUES (?, ?, ?, NULL, ?, 'user-reset', NULL, ?)
  `).run(workspaceRoot, fromState, toStateArg, reasonArg, now);

  // 6. 清零 turn 状态
  //    注意：workflow_turn.turn_id 是 NOT NULL，不能 SET turn_id = NULL，所以 DELETE。
  //    下一次 UserPromptSubmit 时 createTurn 会重新 INSERT OR REPLACE。
  store.prepare('DELETE FROM workflow_turn WHERE workspace_id = ?').run(workspaceRoot);

  console.log(`已从 ${fromState} 回到 ${toStateArg}`);
  process.exit(0);
} finally {
  store.close();
}
