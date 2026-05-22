# v1.4.0 用户控制权增强 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：平台支持子代理且计划较大/可安全分 wave 时使用 superharness:parallel-execution；计划较小、任务强耦合或平台不支持子代理时使用 superharness:serial-execution。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 `/rollback`、`/free` 两个 Claude Code slash command，让用户可以回退 workflow state、临时暂停 hook 注入；agent 全程不被暴露 mutating 能力。

**架构：** slash command markdown 用 `!node` 在 prompt 渲染期执行 standalone 脚本直写 SQLite；MCP 层对所有 mutating tool 入口加 free-mode read-check guard；三个 hook（UserPromptSubmit / Stop / PostToolUse）在 free-mode 期间 short-circuit。

**技术栈：** Node ESM、better-sqlite3、Vitest、Bash（scenario e2e）。

**规格依据：** [docs/superharness/specs/2026-05-22-user-control-rollback-free-mode-design.md](../specs/2026-05-22-user-control-rollback-free-mode-design.md)

**版本：** 1.3.2 → 1.4.0（minor，走 PR 流程）

---

## 文件结构

### 新增

| 路径 | 职责 |
|---|---|
| `plugins/superharness/scripts/rollback.mjs` | Standalone 脚本：用户授权的 rollback DB 操作 |
| `plugins/superharness/scripts/set-free-mode.mjs` | Standalone 脚本：翻转 free_mode 列 |
| `plugins/superharness/commands/rollback.md` | Claude Code slash command 描述 + `!node` 调用 |
| `plugins/superharness/commands/free.md` | 同上 |
| `plugins/superharness/hooks/lib/free-mode-check.mjs` | 三个 hook 共享的 free_mode 读 helper |
| `plugins/superharness/workflow-state-server/test/free-mode-column.test.js` | T1 单元测试 |
| `plugins/superharness/workflow-state-server/test/free-mode-mutating-guard.test.js` | T2 单元测试 |
| `plugins/superharness/workflow-state-server/test/rollback-script.test.js` | T3 单元测试（spawn 子进程） |
| `plugins/superharness/workflow-state-server/test/set-free-mode-script.test.js` | T4 单元测试 |
| `plugins/superharness/workflow-state-server/test/hooks-free-mode.test.js` | T5 单元测试 |
| `tests/hooks/scenario-F.test.sh` | E2E：rollback 流程 |
| `tests/hooks/scenario-G.test.sh` | E2E：free-mode 全锁 |

### 修改

| 路径 | 改动概要 |
|---|---|
| `plugins/superharness/workflow-state-server/schema.sql` | `workflow_state` 加 `free_mode` 和 `free_started_at` 列 |
| `plugins/superharness/workflow-state-server/state.js` | 加 `ensureFreeModeColumns` 迁移、`readFreeMode`、`assertNotFreeMode` helpers；mutating 函数（`classifyRequest` / `transitionWorkflowState` / `resetWorkflowState`）入口加 guard |
| `plugins/superharness/workflow-state-server/server.js` | `handleReleaseStopBlock` 入口加 guard |
| `plugins/superharness/hooks/workflow-context.mjs` | free_mode=1 时 short-circuit 输出 `{}` |
| `plugins/superharness/hooks/workflow-stop.mjs` | free_mode=1 时 short-circuit 输出 `{}` |
| `plugins/superharness/hooks/workflow-post-transition.mjs` | 同上 |
| `README.md` | 标注 v1.4.0 新增 slash commands；Codex 暂不支持 |
| `plugins/superharness/README.md` | 同上 |
| `package.json` | 1.3.2 → 1.4.0 |
| `.claude-plugin/marketplace.json` | 1.3.2 → 1.4.0 |
| `plugins/superharness/.claude-plugin/plugin.json` | 1.3.2 → 1.4.0 |
| `plugins/superharness/.codex-plugin/plugin.json` | 1.3.2 → 1.4.0 |

---

## 任务

### 任务 1：schema 加列 + state.js helpers

**依赖：** 无
**文件集：** `plugins/superharness/workflow-state-server/schema.sql`, `plugins/superharness/workflow-state-server/state.js`, `plugins/superharness/workflow-state-server/test/free-mode-column.test.js`
**导出/变更接口：** `plugins/superharness/workflow-state-server/state.js::readFreeMode`, `plugins/superharness/workflow-state-server/state.js::assertNotFreeMode`, `plugins/superharness/workflow-state-server/state.js::ensureFreeModeColumns`
**消费接口：** 无
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/workflow-state-server/schema.sql`
- 修改：`plugins/superharness/workflow-state-server/state.js`
- 创建：`plugins/superharness/workflow-state-server/test/free-mode-column.test.js`

- [ ] **步骤 1：编写失败的单元测试**

`test/free-mode-column.test.js`：

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkflowStateStore, readFreeMode, assertNotFreeMode } from '../state.js';

describe('free_mode column', () => {
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
  });

  it('readFreeMode returns false when no row exists', () => {
    expect(readFreeMode(store, '/tmp/ws')).toBe(false);
  });

  it('readFreeMode returns true when free_mode = 1', () => {
    store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, free_mode, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run('/tmp/ws', 'intake', 'active', 1, Date.now());
    expect(readFreeMode(store, '/tmp/ws')).toBe(true);
  });

  it('assertNotFreeMode throws when free_mode = 1', () => {
    store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, free_mode, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run('/tmp/ws', 'intake', 'active', 1, Date.now());
    expect(() => assertNotFreeMode(store, '/tmp/ws'))
      .toThrow(/free mode/);
  });

  it('ensureFreeModeColumns is idempotent on existing schema', () => {
    // Open twice; second call must not throw
    const store2 = openWorkflowStateStore({ mode: 'memory' });
    expect(() => store2.close()).not.toThrow();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd plugins/superharness/workflow-state-server
npx vitest run test/free-mode-column.test.js
```

预期：FAIL — `readFreeMode is not exported`、`free_mode` 列不存在。

- [ ] **步骤 3：修改 schema.sql 加列**

`schema.sql` 在 `workflow_state` CREATE TABLE 内追加列（保持 IF NOT EXISTS 兼容）：

```sql
CREATE TABLE IF NOT EXISTS workflow_state (
  workspace_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  previous_state TEXT,
  active_skill TEXT,
  task_summary TEXT,
  failure_summary TEXT,
  updated_at INTEGER NOT NULL,
  free_mode INTEGER NOT NULL DEFAULT 0,
  free_started_at INTEGER
);
```

- [ ] **步骤 4：state.js 加 ensureFreeModeColumns 迁移**

`state.js` 加函数（模仿现有 `ensureTurnIdColumn`）：

```javascript
export function ensureFreeModeColumns(db) {
  const columns = db.prepare("PRAGMA table_info(workflow_state)").all();
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('free_mode')) {
    db.exec("ALTER TABLE workflow_state ADD COLUMN free_mode INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has('free_started_at')) {
    db.exec("ALTER TABLE workflow_state ADD COLUMN free_started_at INTEGER");
  }
}
```

在 `openWorkflowStateStore` 中 `ensureTurnIdColumn` 之后调用 `ensureFreeModeColumns(store)`。

- [ ] **步骤 5：state.js 加 readFreeMode 和 assertNotFreeMode**

```javascript
export function readFreeMode(store, workspaceRoot) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  const row = store.prepare(
    'SELECT free_mode FROM workflow_state WHERE workspace_id = ?'
  ).get(workspaceId);
  return row?.free_mode === 1;
}

export function assertNotFreeMode(store, workspaceRoot) {
  if (readFreeMode(store, workspaceRoot)) {
    throw new Error('workspace is in free mode; /free off first');
  }
}
```

- [ ] **步骤 6：运行测试验证通过**

```bash
cd plugins/superharness/workflow-state-server
npx vitest run test/free-mode-column.test.js
```

预期：PASS（4/4）。

- [ ] **步骤 7：运行全部既有测试不破坏**

```bash
cd plugins/superharness/workflow-state-server
npx vitest run
```

预期：所有既有 7 test files + 新增 1 个 PASS。

- [ ] **步骤 8：Commit**

```bash
git add plugins/superharness/workflow-state-server/schema.sql plugins/superharness/workflow-state-server/state.js plugins/superharness/workflow-state-server/test/free-mode-column.test.js
git commit -m "feat(state): add free_mode columns + readFreeMode/assertNotFreeMode helpers"
```

---

### 任务 2：MCP 层 mutating tool 加 free-mode guard

**依赖：** 任务 1
**文件集：** `plugins/superharness/workflow-state-server/state.js`, `plugins/superharness/workflow-state-server/server.js`, `plugins/superharness/workflow-state-server/test/free-mode-mutating-guard.test.js`
**导出/变更接口：** 无
**消费接口：** `plugins/superharness/workflow-state-server/state.js::assertNotFreeMode`
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/workflow-state-server/state.js`（`classifyRequest`, `transitionWorkflowState`, `resetWorkflowState` 入口）
- 修改：`plugins/superharness/workflow-state-server/server.js`（`handleReleaseStopBlock` 入口）
- 创建：`plugins/superharness/workflow-state-server/test/free-mode-mutating-guard.test.js`

- [ ] **步骤 1：编写失败的单元测试**

`test/free-mode-mutating-guard.test.js`：

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkflowStateStore, transitionWorkflowState, classifyRequest, resetWorkflowState } from '../state.js';
import { handleReleaseStopBlock } from '../server.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';
import path from 'node:path';

function setupFreeMode(store, ws) {
  store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, free_mode, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(ws, 'intake', 'active', 1, Date.now());
  store.prepare(`INSERT INTO workflow_turn (workspace_id, turn_id, block_count, stop_block_released, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(ws, 't1', 0, 0, Date.now());
}

describe('mutating tools rejected in free mode', () => {
  const pluginRoot = path.resolve(__dirname, '../..');
  const config = loadWorkflowConfig({ pluginRoot, workspaceRoot: '/tmp/ws' });
  const graph = buildWorkflowGraph(config, { installedSkills: new Set(['intake','brainstorming','exploration','trivial','planning','serial-execution','parallel-execution','verification','finishing','systematic-debugging']) });
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
    setupFreeMode(store, '/tmp/ws');
  });

  it('transitionWorkflowState throws', () => {
    expect(() => transitionWorkflowState(store, {
      workspaceRoot: '/tmp/ws', workflowGraph: graph,
      from_state: 'intake', to_state: 'brainstorming', reason: 'test',
    })).toThrow(/free mode/);
  });

  it('classifyRequest throws', () => {
    expect(() => classifyRequest(store, {
      workspaceRoot: '/tmp/ws', workflowGraph: graph, reason: 'test',
    })).toThrow(/free mode/);
  });

  it('resetWorkflowState throws', () => {
    expect(() => resetWorkflowState(store, {
      workspaceRoot: '/tmp/ws', workflowGraph: graph, reason: 'test',
    })).toThrow(/free mode/);
  });

  it('handleReleaseStopBlock throws', async () => {
    const result = await handleReleaseStopBlock({
      store, args: { workspaceRoot: '/tmp/ws', reason: 'test' },
    }).catch((e) => ({ error: e.message }));
    expect(result.error).toMatch(/free mode/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd plugins/superharness/workflow-state-server
npx vitest run test/free-mode-mutating-guard.test.js
```

预期：FAIL — 函数不抛错。

- [ ] **步骤 3：state.js 各 mutating 入口加 guard**

在 `classifyRequest`、`transitionWorkflowState`、`resetWorkflowState` 函数体最开头加：

```javascript
assertNotFreeMode(store, workspaceRoot);
```

- [ ] **步骤 4：server.js handleReleaseStopBlock 入口加 guard**

import `assertNotFreeMode`，在 `handleReleaseStopBlock` 函数 reason 校验之前加：

```javascript
assertNotFreeMode(store, workspaceRoot);
```

- [ ] **步骤 5：运行测试验证通过**

```bash
npx vitest run test/free-mode-mutating-guard.test.js
```

预期：PASS（4/4）。

- [ ] **步骤 6：全部既有测试不破坏**

```bash
npx vitest run
```

- [ ] **步骤 7：Commit**

```bash
git add plugins/superharness/workflow-state-server/state.js plugins/superharness/workflow-state-server/server.js plugins/superharness/workflow-state-server/test/free-mode-mutating-guard.test.js
git commit -m "feat(state): guard mutating MCP tools against free mode"
```

---

### 任务 3：scripts/rollback.mjs

**依赖：** 无
**文件集：** `plugins/superharness/scripts/rollback.mjs`, `plugins/superharness/workflow-state-server/test/rollback-script.test.js`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/scripts/rollback.mjs`
- 创建：`plugins/superharness/workflow-state-server/test/rollback-script.test.js`

- [ ] **步骤 1：编写失败的测试**

`test/rollback-script.test.js`（用 `spawnSync` 调子进程，文件 DB）：

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openWorkflowStateStore, transitionWorkflowState } from '../state.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

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
  // intake -> brainstorming -> planning
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

    // verify DB state
    const store = openWorkflowStateStore({ dbPath: path.join(ws, '.superharness', 'workflow-state.db') });
    const row = store.prepare('SELECT state FROM workflow_state WHERE workspace_id = ?').get(ws);
    expect(row.state).toBe('brainstorming');
    // verify log has [rollback] entry
    const log = store.prepare("SELECT reason FROM workflow_transition_log WHERE reason LIKE '[rollback]%'").all();
    expect(log.length).toBe(1);
    // verify workflow_turn cleared
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
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd plugins/superharness/workflow-state-server
npx vitest run test/rollback-script.test.js
```

预期：FAIL — 脚本不存在。

- [ ] **步骤 3：实现 scripts/rollback.mjs**

```javascript
#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

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

const pluginRoot = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');
const stateModule = await import(pathToFileURL(path.join(pluginRoot, 'workflow-state-server', 'state.js')).href);
const validateModule = await import(pathToFileURL(path.join(pluginRoot, 'workflow-state-server', 'validate-workflow.js')).href);

const store = stateModule.openWorkflowStateStore({ dbPath });

try {
  // Verify to_state ever appeared as to_state in transition_log
  const seen = store.prepare(
    'SELECT 1 FROM workflow_transition_log WHERE workspace_id = ? AND to_state = ? LIMIT 1'
  ).get(workspaceRoot, toStateArg);
  if (!seen) {
    const choices = store.prepare(
      `SELECT DISTINCT to_state FROM workflow_transition_log WHERE workspace_id = ? ORDER BY id DESC LIMIT 10`
    ).all(workspaceRoot).map((r) => r.to_state);
    console.error(`state '${toStateArg}' 未在历史中出现过；可用：${choices.join(', ')}`);
    process.exit(1);
  }

  // Get current state for stdout/log
  const cur = store.prepare('SELECT state FROM workflow_state WHERE workspace_id = ?').get(workspaceRoot);
  const fromState = cur?.state ?? null;

  // Load workflow graph to resolve active_skill of to_state
  const skillsDir = path.join(pluginRoot, 'skills');
  const installedSkills = new Set(fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name));
  const config = validateModule.loadWorkflowConfig({ pluginRoot, workspaceRoot });
  const graph = validateModule.buildWorkflowGraph(config, { installedSkills });
  const activeSkill = graph.states.get(toStateArg)?.skill ?? null;

  const now = Date.now();
  store.prepare(`
    UPDATE workflow_state
       SET state = ?, status = 'active', previous_state = NULL, active_skill = ?, updated_at = ?
     WHERE workspace_id = ?
  `).run(toStateArg, activeSkill, now, workspaceRoot);

  store.prepare(`
    INSERT INTO workflow_transition_log
      (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at)
    VALUES (?, ?, ?, NULL, ?, 'user-reset', NULL, ?)
  `).run(workspaceRoot, fromState, toStateArg, reasonArg, now);

  // Clear turn state
  store.prepare(`
    UPDATE workflow_turn
       SET turn_id = NULL, block_count = 0, stop_block_released = 0, release_reason = NULL
     WHERE workspace_id = ?
  `).run(workspaceRoot);

  console.log(`已从 ${fromState} 回到 ${toStateArg}`);
  process.exit(0);
} finally {
  store.close();
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx vitest run test/rollback-script.test.js
```

预期：PASS（3/3）。

- [ ] **步骤 5：Commit**

```bash
git add plugins/superharness/scripts/rollback.mjs plugins/superharness/workflow-state-server/test/rollback-script.test.js
git commit -m "feat(scripts): add rollback.mjs for user-driven state rollback"
```

---

### 任务 4：scripts/set-free-mode.mjs

**依赖：** 任务 1
**文件集：** `plugins/superharness/scripts/set-free-mode.mjs`, `plugins/superharness/workflow-state-server/test/set-free-mode-script.test.js`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/scripts/set-free-mode.mjs`
- 创建：`plugins/superharness/workflow-state-server/test/set-free-mode-script.test.js`

- [ ] **步骤 1：编写失败的测试**

`test/set-free-mode-script.test.js`：

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openWorkflowStateStore, initializeWorkflowState } from '../state.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

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
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx vitest run test/set-free-mode-script.test.js
```

预期：FAIL — 脚本不存在。

- [ ] **步骤 3：实现 scripts/set-free-mode.mjs**

```javascript
#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , workspaceRootArg, action] = process.argv;

if (!workspaceRootArg || !['on', 'off', 'status'].includes(action)) {
  console.error('usage: set-free-mode.mjs <workspaceRoot> <on|off|status>');
  process.exit(1);
}

const workspaceRoot = path.resolve(workspaceRootArg);
const dbPath = path.join(workspaceRoot, '.superharness', 'workflow-state.db');

if (!fs.existsSync(dbPath)) {
  console.error('workspace 未初始化');
  process.exit(1);
}

const pluginRoot = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');
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
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx vitest run test/set-free-mode-script.test.js
```

预期：PASS（3/3）。

- [ ] **步骤 5：Commit**

```bash
git add plugins/superharness/scripts/set-free-mode.mjs plugins/superharness/workflow-state-server/test/set-free-mode-script.test.js
git commit -m "feat(scripts): add set-free-mode.mjs for /free on/off/status"
```

---

### 任务 5：3 个 hook short-circuit + 共享 lib

**依赖：** 任务 1
**文件集：** `plugins/superharness/hooks/lib/free-mode-check.mjs`, `plugins/superharness/hooks/workflow-context.mjs`, `plugins/superharness/hooks/workflow-stop.mjs`, `plugins/superharness/hooks/workflow-post-transition.mjs`, `plugins/superharness/workflow-state-server/test/hooks-free-mode.test.js`
**导出/变更接口：** `plugins/superharness/hooks/lib/free-mode-check.mjs::isFreeMode`
**消费接口：** `plugins/superharness/workflow-state-server/state.js::readFreeMode`
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/hooks/lib/free-mode-check.mjs`
- 修改：`plugins/superharness/hooks/workflow-context.mjs`（入口加 check）
- 修改：`plugins/superharness/hooks/workflow-stop.mjs`（入口加 check）
- 修改：`plugins/superharness/hooks/workflow-post-transition.mjs`（入口加 check）
- 创建：`plugins/superharness/workflow-state-server/test/hooks-free-mode.test.js`

- [ ] **步骤 1：编写失败的测试**

`test/hooks-free-mode.test.js`：

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openWorkflowStateStore, initializeWorkflowState } from '../state.js';
import { loadWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const HOOK_CONTEXT = path.join(PLUGIN_ROOT, 'hooks', 'workflow-context.mjs');
const HOOK_STOP = path.join(PLUGIN_ROOT, 'hooks', 'workflow-stop.mjs');
const HOOK_POST = path.join(PLUGIN_ROOT, 'hooks', 'workflow-post-transition.mjs');

function seedFreeMode(ws) {
  const store = openWorkflowStateStore({ dbPath: path.join(ws, '.superharness', 'workflow-state.db') });
  const config = loadWorkflowConfig({ pluginRoot: PLUGIN_ROOT, workspaceRoot: ws });
  const graph = buildWorkflowGraph(config, { installedSkills: new Set(['intake','brainstorming','exploration','trivial','planning','serial-execution','parallel-execution','verification','finishing','systematic-debugging']) });
  initializeWorkflowState(store, { workspaceRoot: ws, workflowGraph: graph });
  store.prepare('UPDATE workflow_state SET free_mode = 1 WHERE workspace_id = ?').run(ws);
  store.close();
}

function runHook(scriptPath, ws, input) {
  return spawnSync('node', [scriptPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
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
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx vitest run test/hooks-free-mode.test.js
```

预期：FAIL — hooks 未实现 short-circuit。

- [ ] **步骤 3：创建共享 lib `hooks/lib/free-mode-check.mjs`**

```javascript
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Sync check of free_mode flag without depending on state.js.
 * Opens DB read-only, returns false if any error (fail-open).
 */
export async function isFreeMode({ pluginRoot, workspaceRoot }) {
  const dbPath = process.env.SUPERHARNESS_WORKFLOW_STATE_DB
    || path.join(path.resolve(workspaceRoot), '.superharness', 'workflow-state.db');
  if (!fs.existsSync(dbPath)) return false;

  try {
    const { openWorkflowStateStore, readFreeMode } = await import(
      pathToFileURL(path.join(pluginRoot, 'workflow-state-server', 'state.js')).href
    );
    const store = openWorkflowStateStore({ dbPath });
    try {
      return readFreeMode(store, workspaceRoot);
    } finally {
      store.close?.();
    }
  } catch {
    return false; // fail-open
  }
}
```

- [ ] **步骤 4：修改 workflow-context.mjs**

在 `main()` 中 readStdinJson 之后、加载 workflow graph 之前加：

```javascript
const { isFreeMode } = await import(pathToFileURL(path.join(pluginRoot, 'hooks', 'lib', 'free-mode-check.mjs')).href);
if (await isFreeMode({ pluginRoot, workspaceRoot })) {
  process.stdout.write(JSON.stringify({}) + '\n');
  return;
}
```

（注意：`pathToFileURL` 已经 import；如果没有，加 import。）

- [ ] **步骤 5：修改 workflow-stop.mjs**

同样在 try 块开头加 isFreeMode 检查，true 时直接输出 `{}` 返回。

- [ ] **步骤 6：修改 workflow-post-transition.mjs**

同上。

- [ ] **步骤 7：运行测试验证通过**

```bash
npx vitest run test/hooks-free-mode.test.js
```

预期：PASS（3/3）。

- [ ] **步骤 8：全部既有测试 + 5 个 scenario 不破坏**

```bash
npx vitest run
cd ../../..  # back to repo root
for s in A B C D E; do bash tests/hooks/scenario-$s.test.sh 2>&1 | tail -1; done
```

- [ ] **步骤 9：Commit**

```bash
git add plugins/superharness/hooks/lib/free-mode-check.mjs plugins/superharness/hooks/workflow-context.mjs plugins/superharness/hooks/workflow-stop.mjs plugins/superharness/hooks/workflow-post-transition.mjs plugins/superharness/workflow-state-server/test/hooks-free-mode.test.js
git commit -m "feat(hooks): short-circuit 3 hooks when free mode is active"
```

---

### 任务 6：slash command markdown

**依赖：** 任务 3, 任务 4
**文件集：** `plugins/superharness/commands/rollback.md`, `plugins/superharness/commands/free.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 创建：`plugins/superharness/commands/rollback.md`
- 创建：`plugins/superharness/commands/free.md`

- [ ] **步骤 1：创建 commands/rollback.md**

```markdown
---
description: 回退 workflow state 到 transition_log 中走过的某个 state（用户控制）
allowed-tools: mcp__plugin_superharness_superharness-workflow-state__list_history, AskUserQuestion, Bash
---

# /rollback $ARGS

用户输入了 `/rollback $ARGS`。按以下步骤执行：

**步骤 1**：调 `list_history(workspaceRoot=$CLAUDE_PROJECT_DIR)` 拿历史。

**步骤 2 解析参数**：

- 若 `$ARGS` 非空：把 `$ARGS` 当目标 state 名。从 transition_log 中过滤 `to_state == $ARGS` 是否存在：
  - 存在 → 跳到步骤 4，目标 = `$ARGS`
  - 不存在 → 报错并列出"曾走过的 state"让用户重新指定

- 若 `$ARGS` 为空：
  - 从 transition_log 提取 to_state，按时间倒序去重，取**最近 5 个独特 state**
  - 用 AskUserQuestion 让用户选 → 选中作为目标 state，跳到步骤 4

**步骤 4 执行 rollback**：

\`\`\`bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/rollback.mjs" "$CLAUDE_PROJECT_DIR" "<chosen_state>" "[rollback] 用户 /rollback $ARGS"
\`\`\`

**步骤 5 报告**：根据脚本 stdout 简短报告"已从 X 回到 Y"。

**不要**继续做其他事：不要补 transition_state、不要继续之前 state 的任务。下一轮 UserPromptSubmit hook 会注入新 state SKILL.md。
```

- [ ] **步骤 2：创建 commands/free.md**

```markdown
---
description: 进入或退出 free-mode；暂停 superharness workflow context 注入
allowed-tools: Bash
---

# /free $ARGS

用户输入了 `/free $ARGS`。按以下逻辑执行：

- `$ARGS` 为 `on`：
\`\`\`bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" on
\`\`\`

- `$ARGS` 为 `off`：
\`\`\`bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" off
\`\`\`

- `$ARGS` 为 `status` 或空：
\`\`\`bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" status
\`\`\`

读脚本 stdout 反馈结果。**不要**做其他事。
```

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/commands/rollback.md plugins/superharness/commands/free.md
git commit -m "feat(commands): add /rollback and /free slash commands"
```

---

### 任务 7：E2E scenario F + G

**依赖：** 任务 2, 任务 3, 任务 4, 任务 5, 任务 6
**文件集：** `tests/hooks/scenario-F.test.sh`, `tests/hooks/scenario-G.test.sh`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** standard

**文件：**
- 创建：`tests/hooks/scenario-F.test.sh`
- 创建：`tests/hooks/scenario-G.test.sh`

- [ ] **步骤 1：参考既有 scenario 模板**

```bash
head -50 tests/hooks/scenario-A.test.sh
```

复用同样的 setup pattern（建 tmp workspace、seed DB、调 hook、断言 sqlite 状态）。

- [ ] **步骤 2：创建 scenario-F.test.sh（rollback）**

测试目标：从 intake → brainstorming → planning 序列后，调 rollback.mjs 回到 brainstorming，验证：
- workflow_state.state = 'brainstorming'
- workflow_transition_log 多一条 `[rollback]` 前缀的记录
- workflow_turn 的 turn_id/block_count/stop_block_released 被清零

参考 scenario A-E 风格，写 `set -euo pipefail`、用 cygpath、用 sqlite3 CLI 断言。

- [ ] **步骤 3：创建 scenario-G.test.sh（free-mode 全锁）**

测试目标：
1. Seed workspace（init → intake）
2. 调 set-free-mode.mjs on
3. 验证 workflow_state.free_mode = 1
4. 调 workflow-context.mjs（stdin 模拟 UPS），断言 stdout = `{}`
5. 调 server.js 通过 MCP-like 调用 transition_state（或 node 内联调），断言返回 error 含 "free mode"
6. 调 set-free-mode.mjs off
7. 验证 free_mode = 0、可以正常 transition

- [ ] **步骤 4：本地跑通**

```bash
bash tests/hooks/scenario-F.test.sh
bash tests/hooks/scenario-G.test.sh
```

预期：两个都打印 PASS。

- [ ] **步骤 5：全部 7 个 scenario 不破坏**

```bash
for s in A B C D E F G; do bash tests/hooks/scenario-$s.test.sh 2>&1 | tail -1; done
```

预期：7/7 PASS。

- [ ] **步骤 6：Commit**

```bash
git add tests/hooks/scenario-F.test.sh tests/hooks/scenario-G.test.sh
git commit -m "test(e2e): add scenario F (rollback) + G (free-mode lock)"
```

---

### 任务 8：README + 版本号 bump

**依赖：** 任务 1, 任务 2, 任务 3, 任务 4, 任务 5, 任务 6, 任务 7
**文件集：** `README.md`, `plugins/superharness/README.md`, `package.json`, `.claude-plugin/marketplace.json`, `plugins/superharness/.claude-plugin/plugin.json`, `plugins/superharness/.codex-plugin/plugin.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`README.md`（中文项目 README）
- 修改：`plugins/superharness/README.md`
- 修改：`package.json`（1.3.2 → 1.4.0）
- 修改：`.claude-plugin/marketplace.json`（同）
- 修改：`plugins/superharness/.claude-plugin/plugin.json`（同）
- 修改：`plugins/superharness/.codex-plugin/plugin.json`（同）

- [ ] **步骤 1：README 加 v1.4.0 章节**

两个 README 各加一段，描述 `/rollback` `/free` 使用方法 + 显式标注 "Codex 平台暂不支持，待 Codex plugin-prompts 能力到位后补"。

- [ ] **步骤 2：版本号 4 件套 bump**

4 个 JSON 文件中 `"version": "1.3.2"` → `"1.4.0"`。

- [ ] **步骤 3：跑全部测试 + scenario 最终确认**

```bash
cd plugins/superharness/workflow-state-server && npx vitest run
cd ../../..
for s in A B C D E F G; do bash tests/hooks/scenario-$s.test.sh 2>&1 | tail -1; done
```

预期：所有测试 PASS。

- [ ] **步骤 4：Commit + push（PR 流程）**

```bash
git checkout -b feat/user-control-v1.4.0
git add README.md plugins/superharness/README.md package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json plugins/superharness/.codex-plugin/plugin.json
git commit -m "chore(release): bump to 1.4.0 — /rollback + /free slash commands"
git -c http.sslBackend=openssl push -u origin feat/user-control-v1.4.0
gh pr create --title "v1.4.0: user control — /rollback + /free" --body "..."
```

PR body 要点：参考规格、列任务概要、声明 Codex 暂不支持的范围限制。

---

## 并行执行图

> 仅 `parallel-execution` 使用；`serial-execution` 忽略本节。

**Critical Path:** 任务 1 → 任务 4 → 任务 6 → 任务 7 → 任务 8

- Wave 1（无依赖）：任务 1, 任务 3
- Wave 2（依赖 Wave 1）：任务 2（依赖 1）, 任务 4（依赖 1）, 任务 5（依赖 1）
- Wave 3（依赖 Wave 1-2）：任务 6（依赖 3, 4）
- Wave 4（依赖 Wave 1-3）：任务 7（依赖 2, 3, 4, 5, 6）
- Wave 5（依赖 Wave 1-4）：任务 8（依赖 1-7）
- Wave FINAL（所有任务完成后）：F1 规格合规、F2 代码质量、F3 真实手测、F4 范围保真
