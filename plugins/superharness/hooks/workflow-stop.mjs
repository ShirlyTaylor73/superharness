#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function resolvePluginRoot() {
  return path.resolve(
    process.env.CLAUDE_PLUGIN_ROOT
      || process.env.CODEX_PLUGIN_ROOT
      || process.env.PLUGIN_ROOT
      || path.join(__dirname, '..'),
  );
}

function loadInstalledSkills(pluginRoot) {
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return new Set();
  return new Set(
    fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
      .map((e) => e.name),
  );
}

const MAX_BLOCKS = 3;

function blockReason({ state, allowedTransitions }) {
  return [
    `[Superharness Workflow] 本轮检测到未完成的状态切换。`,
    ``,
    `- 当前 state: ${state}`,
    `- 该 state 要求 agent 在每轮结束前显式调用 transition_state`,
    ``,
    `请用 AskUserQuestion 让用户在以下类别的选项中决定本轮去向：`,
    ``,
    `1. **继续/调整工作方向** — 1~2 个选项（agent 根据本轮上下文拟）。用户选了 → 继续干。`,
    `2. **切到允许的下一态** — 列出 [${allowedTransitions.join(', ')}] 里合适的目标。用户选了 → 调 transition_state。`,
    `3. **终止本轮，让用户先看结果** — 用户选了 → 调 release_stop_block(reason="<原话>") 然后结束输出。`,
    ``,
    `(AskUserQuestion 工具会自动提供 "Other" 开放输入。)`,
  ].join('\n');
}

export async function main() {
  let store;
  try {
    const input = await readStdinJson();
    const pluginRoot = resolvePluginRoot();
    const workflowStateDir = path.join(pluginRoot, 'workflow-state-server');
    const { resolveTrustedWorkspaceRoot } = await import(pathToFileURL(path.join(workflowStateDir, 'workspace.js')).href);
    const workspaceRoot = resolveTrustedWorkspaceRoot(process.env);

    // Free-mode check: skip stop-block entirely
    const { isFreeMode } = await import(pathToFileURL(path.join(pluginRoot, 'hooks', 'lib', 'free-mode-check.mjs')).href);
    if (await isFreeMode({ pluginRoot, workspaceRoot })) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }

    const { loadWorkflowConfig, buildWorkflowGraph } = await import(pathToFileURL(path.join(workflowStateDir, 'validate-workflow.js')).href);
    const { openWorkflowStateStore, getWorkflowState, getTurn, incrementBlockCount, resolveWorkflowDbPath } =
      await import(pathToFileURL(path.join(workflowStateDir, 'state.js')).href);

    const config = loadWorkflowConfig({ pluginRoot, workspaceRoot });
    const installedSkills = loadInstalledSkills(pluginRoot);
    const graph = buildWorkflowGraph(config, { installedSkills });

    store = openWorkflowStateStore({
      mode: process.env.SUPERHARNESS_WORKFLOW_STATE_MODE,
      dbPath: process.env.SUPERHARNESS_WORKFLOW_STATE_DB || resolveWorkflowDbPath({ workspaceRoot }),
    });

    const stateInfo = getWorkflowState(store, { workspaceRoot, workflowGraph: graph });
    const turn = getTurn(store, { workspaceRoot });

    if (!turn) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }

    // 1. 本轮 turn_id 内有 source='agent-tool' 的 transition → 放行
    const hasTransition = store.db.prepare(
      "SELECT 1 FROM workflow_transition_log WHERE turn_id = ? AND source = 'agent-tool' LIMIT 1"
    ).get(turn.turn_id);
    if (hasTransition) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }

    // 2. 用户已授权 escape → 放行
    if (turn.stop_block_released === 1) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }

    // 3. silent_stop_allowed=true → 放行
    const stateNode = graph.states.get(stateInfo.state);
    if (stateNode?.silent_stop_allowed) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }

    // 4. block_count < 3 → 拦截
    if (turn.block_count < MAX_BLOCKS) {
      incrementBlockCount(store, { workspaceRoot });
      const reason = blockReason({
        state: stateInfo.state,
        allowedTransitions: stateNode?.next ?? [],
      });
      process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
      return;
    }

    // 5. block_count >= 3 → 兜底逃生
    console.error(`[superharness-stop] escape after ${MAX_BLOCKS} blocks: ws=${workspaceRoot} state=${stateInfo.state}`);
    process.stdout.write(JSON.stringify({}) + '\n');
  } catch {
    // fail-open
    process.stdout.write(JSON.stringify({}) + '\n');
  } finally {
    store?.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
