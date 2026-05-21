# Turn-Completion Hooks + Platform Cleanup 实现计划

> **面向 AI 代理的工作者：** 必需子技能：平台支持子代理且计划较大/可安全分 wave 时使用 superharness:parallel-execution；计划较小、任务强耦合或平台不支持子代理时使用 superharness:serial-execution。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 superharness 插件加入三 hook 联动机制（UserPromptSubmit / PostToolUse / Stop），让 agent 切态后本轮立即 chain 下一态、防止 strict state 内 agent 干一半就走、给 agent 用户授权的 escape 通道；同步撤掉 OpenCode/Cursor 平台支持。

**架构：** 数据层加 `workflow_turn` 表 + `turn_id` 列追踪本轮切态；新 2 个 hook 脚本（workflow-post-transition.mjs / workflow-stop.mjs）配合改造现有 UserPromptSubmit；新 1 个 MCP 工具 `release_stop_block`；default-workflow.yaml 每 state 加 `silent_stop_allowed` 字段；删 OpenCode/Cursor 集成文件 + 清理引用。

**技术栈：** Node.js + better-sqlite3 / bun:sqlite + Vitest + MCP SDK + Claude Code hooks + Codex hooks（hooks-codex.json）

---

## 文件结构

### 新建文件

| 路径 | 职责 |
|---|---|
| `plugins/superharness/hooks/workflow-post-transition.mjs` | PostToolUse hook：transition_state 成功后通过 additionalContext 注入 to_state SKILL.md |
| `plugins/superharness/hooks/workflow-stop.mjs` | Stop hook：5 步算法决策放行/拦截/逃生 |
| `plugins/superharness/workflow-state-server/test/turn.test.js` | 单元测试：workflow_turn CRUD / turn_id 流转 / 旧 NULL 处理 |
| `plugins/superharness/workflow-state-server/test/release-stop-block.test.js` | 单元测试：release_stop_block MCP 工具 |
| `tests/hooks/scenario-A.test.sh` | 端到端测试：单轮内多次 chain |
| `tests/hooks/scenario-B.test.sh` | 端到端测试：跨多轮等用户审 + 批准后 chain |
| `tests/hooks/scenario-C.test.sh` | 端到端测试：silent=false state 内 agent 干一半溜了 |
| `tests/hooks/scenario-D.test.sh` | 端到端测试：transition_state 工具失败 |
| `tests/hooks/scenario-E.test.sh` | 端到端测试：agent 无法继续 + 用户授权 escape |

### 修改文件

| 路径 | 改动概要 |
|---|---|
| `plugins/superharness/workflow/default-workflow.yaml` | 每 state 加 `silent_stop_allowed` 字段（10 个 state） |
| `plugins/superharness/workflow-state-server/schema.sql` | 新表 `workflow_turn`（5 字段）+ `transition_log` 新索引 |
| `plugins/superharness/workflow-state-server/state.js` | workflow_turn CRUD + ALTER 升级路径（PRAGMA 检测 turn_id 列）+ transition_state 写 turn_id |
| `plugins/superharness/workflow-state-server/validate-workflow.js` | `buildWorkflowGraph()` 解析 `silent_stop_allowed` 字段挂在 state 节点上 |
| `plugins/superharness/workflow-state-server/render-context.js` | 新增 `renderActiveSkill()` 导出 + UserPromptSubmit 路径追加 strict 提示 |
| `plugins/superharness/workflow-state-server/server.js` | 新 MCP 工具 `release_stop_block(workspaceRoot, reason)` |
| `plugins/superharness/hooks/workflow-context.mjs` | UserPromptSubmit hook 加 turn_id 生成 + workflow_turn write |
| `plugins/superharness/hooks/hooks.json` | 新增 PostToolUse + Stop matcher（${CLAUDE_PLUGIN_ROOT}） |
| `plugins/superharness/hooks/hooks-codex.json` | 新增 PostToolUse + Stop matcher（${PLUGIN_ROOT}） |
| `plugins/superharness/workflow-state-server/test/validate-workflow.test.js` | 扩展：`silent_stop_allowed` 解析 + 缺省值 + 10 state 取值匹配 |
| `CLAUDE.md` | "Three integration paths" → 两个；删 OpenCode/Cursor 段落 |
| `README.md` | 平台列表删 OpenCode/Cursor |
| `plugins/superharness/README.md` | 同上 |
| `plugins/superharness/skills/workflow-runner/SKILL.md` | 删 OpenCode/Cursor 提及 |
| `GEMINI.md` | 同上 |
| `package.json` | 描述/keywords 清理 + 版本 1.2.4 → 1.3.0 |
| `.claude-plugin/marketplace.json` | 版本 1.2.4 → 1.3.0 + 描述清理 |
| `plugins/superharness/.claude-plugin/plugin.json` | 版本 1.2.4 → 1.3.0 |
| `plugins/superharness/.codex-plugin/plugin.json` | 版本 1.2.4 → 1.3.0 + 描述清理 |
| `.github/PULL_REQUEST_TEMPLATE.md` | 删 OpenCode/Cursor 选项 |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 同上 |

### 删除文件

| 路径 | 说明 |
|---|---|
| `plugins/superharness/.opencode/` (整个目录) | OpenCode Bun 插件入口 |
| `plugins/superharness/hooks/hooks-cursor.json` | Cursor hook 配置 |
| `.cursor-plugin/` (整个目录) | Cursor 插件 manifest |
| `tests/opencode/` (整个目录) | OpenCode 契约测试 6 个 .sh |
| `docs/README.opencode.md` | OpenCode 用户指南 |
| `.opencode/` (顶层目录) | 用户级 OpenCode 安装文档 |

---

## 任务列表

### 任务 1：数据层 schema + state.js + 迁移

**依赖：** 无
**文件集：** `plugins/superharness/workflow-state-server/schema.sql`, `plugins/superharness/workflow-state-server/state.js`, `plugins/superharness/workflow-state-server/test/turn.test.js`
**导出/变更接口：** `state.js::createTurn`, `state.js::getTurn`, `state.js::incrementBlockCount`, `state.js::releaseTurnBlock`, `state.js::ensureTurnIdColumn`
**消费接口：** 无
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/workflow-state-server/schema.sql`
- 修改：`plugins/superharness/workflow-state-server/state.js`
- 创建：`plugins/superharness/workflow-state-server/test/turn.test.js`

- [ ] **步骤 1：编写失败的测试 turn.test.js**

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkflowStateStore, createTurn, getTurn, incrementBlockCount, releaseTurnBlock } from '../state.js';

describe('workflow_turn CRUD', () => {
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
  });

  it('createTurn inserts new turn_id and resets block_count + release fields', () => {
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-1' });
    const row = getTurn(store, { workspaceRoot: '/ws/a' });
    expect(row.turn_id).toBe('uuid-1');
    expect(row.block_count).toBe(0);
    expect(row.stop_block_released).toBe(0);
    expect(row.release_reason).toBeNull();
  });

  it('createTurn overwrites previous turn for same workspace', () => {
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-1' });
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-2' });
    const row = getTurn(store, { workspaceRoot: '/ws/a' });
    expect(row.turn_id).toBe('uuid-2');
  });

  it('incrementBlockCount increases by 1', () => {
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-1' });
    incrementBlockCount(store, { workspaceRoot: '/ws/a' });
    incrementBlockCount(store, { workspaceRoot: '/ws/a' });
    expect(getTurn(store, { workspaceRoot: '/ws/a' }).block_count).toBe(2);
  });

  it('releaseTurnBlock sets stop_block_released=1 and release_reason', () => {
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-1' });
    releaseTurnBlock(store, { workspaceRoot: '/ws/a', reason: 'user authorized escape' });
    const row = getTurn(store, { workspaceRoot: '/ws/a' });
    expect(row.stop_block_released).toBe(1);
    expect(row.release_reason).toBe('user authorized escape');
  });
});

describe('transition_log turn_id', () => {
  it('appendTransition writes turn_id from current workflow_turn row', () => {
    // existing appendTransition signature with new turn_id resolution
    // ...
  });

  it('legacy rows with turn_id=NULL do not match new queries', () => {
    // insert legacy log row with NULL turn_id
    // query WHERE turn_id='some-uuid' should return 0 rows
  });
});

describe('ensureTurnIdColumn migration', () => {
  it('idempotent: running twice does not throw', () => {
    // open store, ensureTurnIdColumn, ensureTurnIdColumn again → no error
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd plugins/superharness/workflow-state-server && npx vitest run test/turn.test.js`
预期：FAIL（函数 / 表未定义）

- [ ] **步骤 3：改 schema.sql 加 workflow_turn 表 + 索引**

在文件末尾追加：

```sql
-- 每 workspace 仅一条当前轮记录（覆盖式更新）
CREATE TABLE IF NOT EXISTS workflow_turn (
  workspace_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  block_count INTEGER NOT NULL DEFAULT 0,
  stop_block_released INTEGER NOT NULL DEFAULT 0,
  release_reason TEXT,
  created_at INTEGER NOT NULL
);

-- 新索引（在 ALTER 添加 turn_id 列后才有效，但 IF NOT EXISTS 保护幂等）
CREATE INDEX IF NOT EXISTS idx_workflow_transition_turn
  ON workflow_transition_log(turn_id);
```

- [ ] **步骤 4：在 state.js 加 ensureTurnIdColumn 升级路径**

在 `openWorkflowStateStore` 内 schema 执行后调用：

```javascript
function ensureTurnIdColumn(db) {
  const columns = db.prepare("PRAGMA table_info(workflow_transition_log)").all();
  const hasTurnId = columns.some((c) => c.name === 'turn_id');
  if (!hasTurnId) {
    db.exec("ALTER TABLE workflow_transition_log ADD COLUMN turn_id TEXT");
  }
}
```

- [ ] **步骤 5：在 state.js 加 workflow_turn CRUD 函数**

```javascript
export function createTurn(store, { workspaceRoot, turnId }) {
  const stmt = store.db.prepare(`
    INSERT OR REPLACE INTO workflow_turn
    (workspace_id, turn_id, block_count, stop_block_released, release_reason, created_at)
    VALUES (?, ?, 0, 0, NULL, ?)
  `);
  stmt.run(workspaceRoot, turnId, Date.now());
}

export function getTurn(store, { workspaceRoot }) {
  return store.db.prepare('SELECT * FROM workflow_turn WHERE workspace_id = ?').get(workspaceRoot) ?? null;
}

export function incrementBlockCount(store, { workspaceRoot }) {
  store.db.prepare('UPDATE workflow_turn SET block_count = block_count + 1 WHERE workspace_id = ?').run(workspaceRoot);
}

export function releaseTurnBlock(store, { workspaceRoot, reason }) {
  store.db.prepare('UPDATE workflow_turn SET stop_block_released = 1, release_reason = ? WHERE workspace_id = ?').run(reason, workspaceRoot);
}
```

- [ ] **步骤 6：改 appendTransition 写 turn_id**

修改现有 `appendTransition`，从 `workflow_turn` 取当前 turn_id 写入 transition_log：

```javascript
export function appendTransition(store, { workspaceRoot, fromState, toState, previousState, reason, source }) {
  const turnRow = store.db.prepare('SELECT turn_id FROM workflow_turn WHERE workspace_id = ?').get(workspaceRoot);
  const turnId = turnRow?.turn_id ?? null;
  store.db.prepare(`
    INSERT INTO workflow_transition_log
    (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceRoot, fromState, toState, previousState, reason, source, turnId, Date.now());
}
```

- [ ] **步骤 7：运行测试验证通过**

运行：`cd plugins/superharness/workflow-state-server && npx vitest run test/turn.test.js && npx vitest run`
预期：全 PASS（含原有 61 个测试 + 新增）

- [ ] **步骤 8：Commit**

```bash
git add plugins/superharness/workflow-state-server/schema.sql \
        plugins/superharness/workflow-state-server/state.js \
        plugins/superharness/workflow-state-server/test/turn.test.js
git commit -m "feat(state): add workflow_turn table + turn_id tracking on transition_log"
```

---

### 任务 2：default-workflow.yaml + validate-workflow.js 解析 silent_stop_allowed

**依赖：** 无
**文件集：** `plugins/superharness/workflow/default-workflow.yaml`, `plugins/superharness/workflow-state-server/validate-workflow.js`, `plugins/superharness/workflow-state-server/test/validate-workflow.test.js`
**导出/变更接口：** `validate-workflow.js::buildWorkflowGraph`
**消费接口：** 无
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/workflow/default-workflow.yaml`
- 修改：`plugins/superharness/workflow-state-server/validate-workflow.js`
- 修改：`plugins/superharness/workflow-state-server/test/validate-workflow.test.js`

- [ ] **步骤 1：扩展 validate-workflow.test.js 测试**

在文件末尾追加 describe block：

```javascript
describe('silent_stop_allowed parsing', () => {
  it('parses silent_stop_allowed=true on state node', () => {
    const config = {
      version: 1, entryState: 's1', terminalStates: [],
      states: { s1: { type: 'router', skill: 's1', next: [], silent_stop_allowed: true } }
    };
    const graph = buildWorkflowGraph(config, { installedSkills });
    expect(graph.states.get('s1').silent_stop_allowed).toBe(true);
  });

  it('defaults silent_stop_allowed to false when omitted', () => {
    const config = {
      version: 1, entryState: 's1', terminalStates: [],
      states: { s1: { type: 'router', skill: 's1', next: [] } }
    };
    const graph = buildWorkflowGraph(config, { installedSkills });
    expect(graph.states.get('s1').silent_stop_allowed).toBe(false);
  });

  it('default workflow has expected silent_stop_allowed values', () => {
    const pluginRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
    const yamlConfig = loadWorkflowConfig({ pluginRoot });
    const graph = buildWorkflowGraph(yamlConfig, { installedSkills });

    const expected = {
      intake: true, exploration: true, trivial: false,
      brainstorming: true, planning: true,
      serial_execution: false, parallel_execution: false,
      systematic_debugging: true, verification: true, finishing: false,
    };
    for (const [name, exp] of Object.entries(expected)) {
      expect(graph.states.get(name).silent_stop_allowed, `${name}.silent_stop_allowed`).toBe(exp);
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd plugins/superharness/workflow-state-server && npx vitest run test/validate-workflow.test.js`
预期：FAIL（字段未解析、默认 yaml 未配置）

- [ ] **步骤 3：改 default-workflow.yaml 加 silent_stop_allowed 字段**

10 个 state 全部加（按表）：

```yaml
states:
  intake:
    type: interactive
    skill: intake
    next: [exploration, trivial, brainstorming]
    silent_stop_allowed: true
  exploration:
    type: interactive
    skill: exploration
    next: [intake]
    silent_stop_allowed: true
  trivial:
    type: execution
    skill: trivial
    next: [intake, systematic_debugging]
    silent_stop_allowed: false
  brainstorming:
    type: interactive
    skill: brainstorming
    next: [planning]
    silent_stop_allowed: true
  planning:
    type: interactive
    skill: planning
    next: [serial_execution, parallel_execution]
    silent_stop_allowed: true
  serial_execution:
    type: execution
    skill: serial-execution
    next: [verification, systematic_debugging]
    silent_stop_allowed: false
  parallel_execution:
    type: execution
    skill: parallel-execution
    next: [verification, systematic_debugging]
    silent_stop_allowed: false
  verification:
    type: gate
    skill: verification
    next: [finishing, systematic_debugging]
    silent_stop_allowed: true
  finishing:
    type: gate
    skill: finishing
    next: [intake, systematic_debugging]
    silent_stop_allowed: false
  systematic_debugging:
    type: preemptive
    skill: systematic-debugging
    next: [previous_state, serial_execution, planning]
    silent_stop_allowed: true
```

- [ ] **步骤 4：改 validate-workflow.js buildWorkflowGraph 解析新字段**

在 state 节点构造时加：

```javascript
const silentStopAllowed = stateConfig.silent_stop_allowed === true;
states.set(name, {
  name,
  type: stateConfig.type,
  skill: stateConfig.skill,
  next: stateConfig.next ?? [],
  terminal: terminalStates.has(name),
  silent_stop_allowed: silentStopAllowed,
});
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd plugins/superharness/workflow-state-server && npx vitest run`
预期：全 PASS

- [ ] **步骤 6：Commit**

```bash
git add plugins/superharness/workflow/default-workflow.yaml \
        plugins/superharness/workflow-state-server/validate-workflow.js \
        plugins/superharness/workflow-state-server/test/validate-workflow.test.js
git commit -m "feat(workflow): add silent_stop_allowed flag per state"
```

---

### 任务 3：render-context.js 新增 renderActiveSkill + UserPromptSubmit strict 提示追加

**依赖：** 无
**文件集：** `plugins/superharness/workflow-state-server/render-context.js`, `plugins/superharness/workflow-state-server/test/render-context.test.js`
**导出/变更接口：** `render-context.js::renderActiveSkill`, `render-context.js::renderStrictAppendix`
**消费接口：** 无
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/workflow-state-server/render-context.js`
- 创建：`plugins/superharness/workflow-state-server/test/render-context.test.js`

- [ ] **步骤 1：编写失败的测试**

```javascript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderActiveSkill, renderStrictAppendix } from '../render-context.js';

const skillsDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'skills');

describe('renderActiveSkill', () => {
  it('returns SKILL.md body of given state (no SUPERHARNESS_WORKFLOW_STATE wrapper)', () => {
    const out = renderActiveSkill({
      stateName: 'intake',
      skillsDir,
    });
    expect(out).toContain('Active skill: intake');
    expect(out).not.toContain('<SUPERHARNESS_WORKFLOW_STATE>');
  });

  it('throws on unknown state', () => {
    expect(() => renderActiveSkill({ stateName: 'nonexistent', skillsDir })).toThrow();
  });
});

describe('renderStrictAppendix', () => {
  it('returns non-empty append text when silent_stop_allowed=false', () => {
    const out = renderStrictAppendix({ silent_stop_allowed: false });
    expect(out).toContain('本轮');
    expect(out).toContain('transition_state');
  });

  it('returns empty string when silent_stop_allowed=true', () => {
    expect(renderStrictAppendix({ silent_stop_allowed: true })).toBe('');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd plugins/superharness/workflow-state-server && npx vitest run test/render-context.test.js`
预期：FAIL（函数未导出）

- [ ] **步骤 3：在 render-context.js 加两个导出**

```javascript
export function renderActiveSkill({ stateName, skillsDir }) {
  // 复用现有 SKILL.md 加载逻辑（去 frontmatter，原样输出 body）
  const skillBody = loadSkillBody(skillsDir, stateName);
  return [
    `[Superharness] 已切到新状态，本轮继续遵循以下 SKILL：`,
    ``,
    `--- Active skill: ${stateName} ---`,
    skillBody,
  ].join('\n');
}

export function renderStrictAppendix({ silent_stop_allowed }) {
  if (silent_stop_allowed) return '';
  return [
    '',
    '⚠ 当前 state 不允许本轮沉默结束——必须在本轮调用 transition_state 切到下一态，',
    '若本轮工作未完成请继续完成再切；若无法继续请用 AskUserQuestion 让用户决定。',
  ].join('\n');
}
```

并在现有 `renderWorkflowContext` 末尾根据 `stateInfo.silent_stop_allowed` 调用 `renderStrictAppendix` 拼接到 additionalContext。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd plugins/superharness/workflow-state-server && npx vitest run`
预期：全 PASS

- [ ] **步骤 5：Commit**

```bash
git add plugins/superharness/workflow-state-server/render-context.js \
        plugins/superharness/workflow-state-server/test/render-context.test.js
git commit -m "feat(render): add renderActiveSkill + renderStrictAppendix"
```

---

### 任务 4：删除 OpenCode/Cursor 文件

**依赖：** 无
**文件集：** `plugins/superharness/.opencode/`, `plugins/superharness/hooks/hooks-cursor.json`, `.cursor-plugin/`, `tests/opencode/`, `docs/README.opencode.md`, `.opencode/`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 删除：`plugins/superharness/.opencode/` (递归)
- 删除：`plugins/superharness/hooks/hooks-cursor.json`
- 删除：`.cursor-plugin/` (递归)
- 删除：`tests/opencode/` (递归)
- 删除：`docs/README.opencode.md`
- 删除：`.opencode/` (顶层目录，递归)

- [ ] **步骤 1：执行删除**

```bash
rm -rf plugins/superharness/.opencode \
       plugins/superharness/hooks/hooks-cursor.json \
       .cursor-plugin \
       tests/opencode \
       docs/README.opencode.md \
       .opencode
```

- [ ] **步骤 2：验证目录已删**

运行：`ls plugins/superharness/.opencode .cursor-plugin tests/opencode docs/README.opencode.md .opencode 2>&1 | grep -c "No such file"`
预期：5（每个路径报 "No such file"）

- [ ] **步骤 3：Commit**

```bash
git add -A plugins/superharness/.opencode plugins/superharness/hooks/hooks-cursor.json \
            .cursor-plugin tests/opencode docs/README.opencode.md .opencode
git commit -m "chore: drop OpenCode and Cursor platform support — delete files"
```

---

### 任务 5：清理 OpenCode/Cursor 引用

**依赖：** 无
**文件集：** `CLAUDE.md`, `README.md`, `plugins/superharness/README.md`, `plugins/superharness/skills/workflow-runner/SKILL.md`, `GEMINI.md`, `package.json`, `plugins/superharness/.codex-plugin/plugin.json`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/bug_report.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`CLAUDE.md`
- 修改：`README.md`
- 修改：`plugins/superharness/README.md`
- 修改：`plugins/superharness/skills/workflow-runner/SKILL.md`
- 修改：`GEMINI.md`
- 修改：`package.json`
- 修改：`plugins/superharness/.codex-plugin/plugin.json`
- 修改：`.github/PULL_REQUEST_TEMPLATE.md`
- 修改：`.github/ISSUE_TEMPLATE/bug_report.md`

- [ ] **步骤 1：CLAUDE.md 改造**

打开文件，定位 "Three integration paths, one engine" 段：
- 改 "Three" → "Two"
- 删 OpenCode Bun plugin 段落（编号 3）
- 删 hooks-cursor.json 提及
- 删 "Bash on Windows" 段中 OpenCode 相关提示
- 删 "Version bumps touch five files" 中 `.cursor-plugin/plugin.json` 行（5 → 4）

- [ ] **步骤 2：README.md 改造**

定位 "Platform support" 或类似段，删 OpenCode/Cursor 列表项，留 Claude Code + Codex 两项。

- [ ] **步骤 3：plugins/superharness/README.md 同样改造**

- [ ] **步骤 4：plugins/superharness/skills/workflow-runner/SKILL.md 改造**

grep "OpenCode\|Cursor" 找所有提及，按上下文删/改。SKILL description 字段如果提到 4 平台则改为 2 平台。

- [ ] **步骤 5：GEMINI.md 改造**

同 README.md（删平台列表里的 OpenCode/Cursor）。

- [ ] **步骤 6：package.json 改造**

- description 字段：删 OpenCode/Cursor 提及，保留 Claude Code + Codex
- keywords：删 opencode、cursor

- [ ] **步骤 7：plugins/superharness/.codex-plugin/plugin.json 改造**

description 字段清理同 package.json。

- [ ] **步骤 8：.github/PULL_REQUEST_TEMPLATE.md + bug_report.md 改造**

如果有 "affected platform" 选项列表，删 OpenCode/Cursor 项。

- [ ] **步骤 9：grep 验证主代码 0 命中**

运行：

```bash
grep -rnE "opencode|cursor" --include="*.md" --include="*.json" --include="*.mjs" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=archived-skills \
  --exclude-dir=docs/superharness/plans --exclude-dir=docs/superharness/specs \
  --exclude-dir=references \
  . 2>&1 | head -20
```

预期：0 命中（或仅在历史 spec/plan/references 里命中）

- [ ] **步骤 10：Commit**

```bash
git add CLAUDE.md README.md plugins/superharness/README.md \
        plugins/superharness/skills/workflow-runner/SKILL.md \
        GEMINI.md package.json plugins/superharness/.codex-plugin/plugin.json \
        .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE/bug_report.md
git commit -m "chore: drop OpenCode and Cursor platform support — cleanup references"
```

---

### 任务 6：server.js 新 MCP 工具 release_stop_block

**依赖：** 任务 1
**文件集：** `plugins/superharness/workflow-state-server/server.js`, `plugins/superharness/workflow-state-server/test/release-stop-block.test.js`
**导出/变更接口：** `server.js::releaseStopBlockTool`
**消费接口：** `state.js::releaseTurnBlock`, `state.js::appendTransition`
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/workflow-state-server/server.js`
- 创建：`plugins/superharness/workflow-state-server/test/release-stop-block.test.js`

- [ ] **步骤 1：编写失败的测试**

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkflowStateStore, createTurn, getTurn } from '../state.js';
import { handleReleaseStopBlock } from '../server.js';

describe('release_stop_block MCP tool', () => {
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
    createTurn(store, { workspaceRoot: '/ws', turnId: 'uuid-1' });
  });

  it('sets stop_block_released=1 and release_reason', async () => {
    const res = await handleReleaseStopBlock({
      store,
      args: { workspaceRoot: '/ws', reason: '环境错误，用户授权终止' },
    });
    expect(res.ok).toBe(true);
    const row = getTurn(store, { workspaceRoot: '/ws' });
    expect(row.stop_block_released).toBe(1);
    expect(row.release_reason).toBe('环境错误，用户授权终止');
  });

  it('writes audit row with [escape] prefix', async () => {
    await handleReleaseStopBlock({
      store,
      args: { workspaceRoot: '/ws', reason: '磁盘满' },
    });
    const auditRows = store.db.prepare("SELECT * FROM workflow_transition_log WHERE reason LIKE '[escape]%'").all();
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].reason).toContain('磁盘满');
  });

  it('rejects empty reason', async () => {
    await expect(handleReleaseStopBlock({
      store,
      args: { workspaceRoot: '/ws', reason: '' },
    })).rejects.toThrow(/reason/);
  });

  it('rejects placeholder reason (ok / start)', async () => {
    await expect(handleReleaseStopBlock({
      store,
      args: { workspaceRoot: '/ws', reason: 'ok' },
    })).rejects.toThrow();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd plugins/superharness/workflow-state-server && npx vitest run test/release-stop-block.test.js`
预期：FAIL（handleReleaseStopBlock 未定义）

- [ ] **步骤 3：在 server.js 注册新 MCP 工具**

```javascript
// 工具 description 必须明确强约束：必须先 AskUserQuestion 拿到用户授权
const RELEASE_STOP_BLOCK_DESCRIPTION =
  '在 silent_stop_allowed=false 的 state 内 agent 无法继续工作时，由用户通过 AskUserQuestion 明确授权"终止本轮"后调用此工具。绝不可在没有用户明确授权前调用。';

export async function handleReleaseStopBlock({ store, args }) {
  const { workspaceRoot, reason } = args;
  if (!reason || ['ok', 'start', '用户请求'].includes(reason.trim())) {
    throw new Error('reason must be non-empty and non-placeholder');
  }
  const turnRow = getTurn(store, { workspaceRoot });
  if (!turnRow) {
    throw new Error('no active turn for workspace');
  }
  releaseTurnBlock(store, { workspaceRoot, reason });
  // 同步写 audit 行
  appendTransition(store, {
    workspaceRoot,
    fromState: turnRow.last_state ?? null,
    toState: turnRow.last_state ?? null,
    previousState: null,
    reason: `[escape] ${reason}`,
    source: 'agent-tool',
  });
  return { ok: true };
}

server.tool('release_stop_block', RELEASE_STOP_BLOCK_DESCRIPTION, {
  workspaceRoot: z.string(),
  reason: z.string(),
}, async (args) => {
  const result = await handleReleaseStopBlock({ store, args });
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd plugins/superharness/workflow-state-server && npx vitest run`
预期：全 PASS

- [ ] **步骤 5：Commit**

```bash
git add plugins/superharness/workflow-state-server/server.js \
        plugins/superharness/workflow-state-server/test/release-stop-block.test.js
git commit -m "feat(mcp): add release_stop_block tool for user-authorized escape"
```

---

### 任务 7：PostToolUse hook 脚本 workflow-post-transition.mjs

**依赖：** 任务 3
**文件集：** `plugins/superharness/hooks/workflow-post-transition.mjs`
**导出/变更接口：** `workflow-post-transition.mjs::main`
**消费接口：** `render-context.js::renderActiveSkill`, `validate-workflow.js::loadWorkflowConfig`, `validate-workflow.js::buildWorkflowGraph`
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/hooks/workflow-post-transition.mjs`

- [ ] **步骤 1：创建 hook 脚本**

```javascript
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

function hookOutput(additionalContext) {
  return additionalContext
    ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }
    : {};
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

export async function main() {
  try {
    const input = await readStdinJson();
    const toState = input?.tool_input?.to_state;
    if (!toState) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }
    const pluginRoot = resolvePluginRoot();
    const workflowStateDir = path.join(pluginRoot, 'workflow-state-server');
    const { renderActiveSkill } = await import(pathToFileURL(path.join(workflowStateDir, 'render-context.js')).href);

    const skillsDir = path.join(pluginRoot, 'skills');
    const installedSkills = loadInstalledSkills(pluginRoot);
    if (!installedSkills.has(toState)) {
      // to_state 没对应 skill 目录（例如 router state 不一定有 skill）—— fail-open 不注入
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }
    const skillContext = renderActiveSkill({ stateName: toState, skillsDir });
    process.stdout.write(JSON.stringify(hookOutput(skillContext)) + '\n');
  } catch {
    // fail-open: hook 错误绝不阻塞 agent
    process.stdout.write(JSON.stringify({}) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
```

- [ ] **步骤 2：测试 hook 脚本（手动 smoke test）**

运行：

```bash
echo '{"cwd":"/tmp","tool_input":{"to_state":"intake","from_state":"intake"}}' | \
  node plugins/superharness/hooks/workflow-post-transition.mjs
```

预期：输出 JSON 含 `hookSpecificOutput.additionalContext`，其中包含 "Active skill: intake"。

测试 fail-open：

```bash
echo 'invalid json' | node plugins/superharness/hooks/workflow-post-transition.mjs
```

预期：输出 `{}`。

测试空 to_state：

```bash
echo '{"cwd":"/tmp","tool_input":{}}' | node plugins/superharness/hooks/workflow-post-transition.mjs
```

预期：输出 `{}`。

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/hooks/workflow-post-transition.mjs
git commit -m "feat(hooks): add PostToolUse workflow-post-transition hook"
```

---

### 任务 8：Stop hook 脚本 workflow-stop.mjs

**依赖：** 任务 1, 任务 2
**文件集：** `plugins/superharness/hooks/workflow-stop.mjs`
**导出/变更接口：** `workflow-stop.mjs::main`
**消费接口：** `state.js::openWorkflowStateStore`, `state.js::getTurn`, `state.js::incrementBlockCount`, `validate-workflow.js::loadWorkflowConfig`, `validate-workflow.js::buildWorkflowGraph`, `state.js::getWorkflowState`
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/hooks/workflow-stop.mjs`

- [ ] **步骤 1：创建 hook 脚本**

```javascript
#!/usr/bin/env node
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
  try {
    const input = await readStdinJson();
    const workspaceRoot = path.resolve(input.cwd || process.cwd());
    const pluginRoot = resolvePluginRoot();
    const workflowStateDir = path.join(pluginRoot, 'workflow-state-server');

    const { loadWorkflowConfig, buildWorkflowGraph } = await import(pathToFileURL(path.join(workflowStateDir, 'validate-workflow.js')).href);
    const { openWorkflowStateStore, getWorkflowState, getTurn, incrementBlockCount, resolveWorkflowDbPath } =
      await import(pathToFileURL(path.join(workflowStateDir, 'state.js')).href);

    const config = loadWorkflowConfig({ pluginRoot, workspaceRoot });
    const installedSkills = new Set();  // 内联实现或抽出 util
    const graph = buildWorkflowGraph(config, { installedSkills });

    const store = openWorkflowStateStore({
      mode: process.env.SUPERHARNESS_WORKFLOW_STATE_MODE,
      dbPath: process.env.SUPERHARNESS_WORKFLOW_STATE_DB || resolveWorkflowDbPath({ workspaceRoot }),
    });
    try {
      const stateInfo = getWorkflowState(store, { workspaceRoot, workflowGraph: graph });
      const turn = getTurn(store, { workspaceRoot });

      if (!turn) {
        // 无 current turn → 放行（首次启动或异常）
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

      // 5. block_count >= 3 → 兜底逃生（不告诉 agent）
      console.error(`[superharness-stop] escape after ${MAX_BLOCKS} blocks: ws=${workspaceRoot} state=${stateInfo.state}`);
      process.stdout.write(JSON.stringify({}) + '\n');
    } finally {
      store.close();
    }
  } catch {
    // fail-open
    process.stdout.write(JSON.stringify({}) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
```

- [ ] **步骤 2：手动 smoke test**

写一个 sqlite shell 测试场景：
1. 创建临时 db，插入 workflow_turn + workflow_state state=trivial
2. 给脚本喂 `{"cwd": "/tmp/test"}`
3. 预期：返回 block + reason

```bash
SUPERHARNESS_WORKFLOW_STATE_DB=/tmp/test.db \
  echo '{"cwd":"/tmp/test"}' | \
  node plugins/superharness/hooks/workflow-stop.mjs
```

预期：根据 DB 状态，要么 `{}` 要么 `{"decision":"block","reason":"..."}`。

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/hooks/workflow-stop.mjs
git commit -m "feat(hooks): add Stop hook with 5-step decision algorithm + 3-block escape"
```

---

### 任务 9：UserPromptSubmit hook 改造 workflow-context.mjs

**依赖：** 任务 1, 任务 2
**文件集：** `plugins/superharness/hooks/workflow-context.mjs`
**导出/变更接口：** 无（现有 main 函数行为扩展，签名不变）
**消费接口：** `state.js::createTurn`, `state.js::openWorkflowStateStore`, `validate-workflow.js::loadWorkflowConfig`, `validate-workflow.js::buildWorkflowGraph`, `render-context.js::renderWorkflowContext`
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/hooks/workflow-context.mjs`

- [ ] **步骤 1：在现有 main 函数加 turn 生成 + workflow_turn 写**

定位 `openWorkflowStateStore` 调用后、`getWorkflowState` 之前：

```javascript
import crypto from 'node:crypto';
// ...
const turnId = crypto.randomUUID();
createTurn(store, { workspaceRoot, turnId });
```

确保 `createTurn` 从 state.js 导入。

- [ ] **步骤 2：手动 smoke test**

```bash
echo '{"cwd":"/path/to/workspace"}' | node plugins/superharness/hooks/workflow-context.mjs
```

预期：输出 JSON 含 hookSpecificOutput.additionalContext（现有行为），同时 DB 里 workflow_turn 表新增 / 覆盖一条记录。

验证 DB：

```bash
sqlite3 /path/to/workspace/.superharness/workflow-state.db "SELECT * FROM workflow_turn"
```

预期：一条记录，turn_id 是 UUID v4，block_count=0。

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/hooks/workflow-context.mjs
git commit -m "feat(hooks): UserPromptSubmit creates new turn_id + resets workflow_turn"
```

---

### 任务 10：hooks.json + hooks-codex.json 加 PostToolUse + Stop 配置

**依赖：** 任务 7, 任务 8, 任务 9
**文件集：** `plugins/superharness/hooks/hooks.json`, `plugins/superharness/hooks/hooks-codex.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`plugins/superharness/hooks/hooks.json`
- 修改：`plugins/superharness/hooks/hooks-codex.json`

- [ ] **步骤 1：在 hooks.json 加 PostToolUse + Stop**

打开文件，在 PreToolUse 配置之后追加：

```json
"PostToolUse": [
  {
    "matcher": "mcp__plugin_superharness_superharness-workflow-state__transition_state",
    "hooks": [{
      "type": "command",
      "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" workflow-post-transition",
      "async": false
    }]
  }
],
"Stop": [
  {
    "hooks": [{
      "type": "command",
      "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" workflow-stop",
      "async": false
    }]
  }
]
```

- [ ] **步骤 2：在 hooks-codex.json 加同样配置**

`${CLAUDE_PLUGIN_ROOT}` 换成 `${PLUGIN_ROOT}`。

- [ ] **步骤 3：JSON 语法验证**

运行：`node -e "JSON.parse(require('fs').readFileSync('plugins/superharness/hooks/hooks.json'))"`
预期：无报错。

同样验证 hooks-codex.json。

- [ ] **步骤 4：Commit**

```bash
git add plugins/superharness/hooks/hooks.json plugins/superharness/hooks/hooks-codex.json
git commit -m "feat(hooks): wire PostToolUse + Stop in hooks.json and hooks-codex.json"
```

---

### 任务 11：Integration scenario A test — 单轮多次 chain

**依赖：** 任务 10
**文件集：** `tests/hooks/scenario-A.test.sh`
**导出/变更接口：** 无
**消费接口：** `workflow-post-transition.mjs::main`, `workflow-stop.mjs::main`, `workflow-context.mjs::main`
**复杂度：** standard

**文件：**
- 创建：`tests/hooks/scenario-A.test.sh`

- [ ] **步骤 1：编写测试脚本**

```bash
#!/bin/bash
# Scenario A: 单轮内多次 chain — intake → trivial → intake
set -e
WS=$(mktemp -d)
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

# 0. UserPromptSubmit 创建 turn_id
echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-context.mjs > /dev/null
TURN=$(sqlite3 "$DB" "SELECT turn_id FROM workflow_turn")
[ -n "$TURN" ] || { echo "FAIL: no turn_id created"; exit 1; }

# 1. 模拟 transition_state(intake → trivial) 写 transition_log
sqlite3 "$DB" "INSERT INTO workflow_transition_log (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at) VALUES ('$WS', 'intake', 'trivial', NULL, 'test', 'agent-tool', '$TURN', $(date +%s%3N))"

# 2. PostToolUse 注入 trivial SKILL
INJECT=$(echo "{\"cwd\":\"$WS\",\"tool_input\":{\"to_state\":\"trivial\"}}" | node plugins/superharness/hooks/workflow-post-transition.mjs)
echo "$INJECT" | grep -q "Active skill: trivial" || { echo "FAIL: trivial SKILL not injected"; exit 1; }

# 3. 模拟 transition_state(trivial → intake)
sqlite3 "$DB" "INSERT INTO workflow_transition_log (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at) VALUES ('$WS', 'trivial', 'intake', NULL, 'test', 'agent-tool', '$TURN', $(date +%s%3N))"

# 4. Stop hook 检查 — 本轮有 ≥1 条 transition，应该放行
STOP=$(echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-stop.mjs)
echo "$STOP" | grep -q "decision" && { echo "FAIL: Stop blocked when transition exists"; exit 1; }

echo "PASS: scenario-A"
```

- [ ] **步骤 2：运行测试**

运行：`"D:\Git\bin\bash.exe" tests/hooks/scenario-A.test.sh`
预期：`PASS: scenario-A`

- [ ] **步骤 3：Commit**

```bash
git add tests/hooks/scenario-A.test.sh
git commit -m "test(hooks): scenario A — multiple chains in single turn"
```

---

### 任务 12：Integration scenario B test — 跨多轮等用户审 + chain

**依赖：** 任务 10
**文件集：** `tests/hooks/scenario-B.test.sh`
**导出/变更接口：** 无
**消费接口：** `workflow-post-transition.mjs::main`, `workflow-stop.mjs::main`, `workflow-context.mjs::main`
**复杂度：** standard

**文件：**
- 创建：`tests/hooks/scenario-B.test.sh`

- [ ] **步骤 1：编写测试脚本**

```bash
#!/bin/bash
# Scenario B: brainstorming 多轮等审 → 批准 → chain 到 planning
set -e
WS=$(mktemp -d)
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

# 0. UserPromptSubmit 轮 N — 创建 turn_1
echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-context.mjs > /dev/null
TURN1=$(sqlite3 "$DB" "SELECT turn_id FROM workflow_turn")

# 模拟 agent 当前在 brainstorming
sqlite3 "$DB" "UPDATE workflow_state SET state='brainstorming' WHERE workspace_id='$WS'"

# 1. 本轮 agent 输出"请审 spec"，不切态 → Stop 检查
STOP1=$(echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-stop.mjs)
echo "$STOP1" | grep -q "decision" && { echo "FAIL: brainstorming silent stop should pass"; exit 1; }

# 2. 下一轮用户回复 → UserPromptSubmit 创建新 turn_2 (block_count 清零)
echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-context.mjs > /dev/null
TURN2=$(sqlite3 "$DB" "SELECT turn_id FROM workflow_turn")
[ "$TURN1" != "$TURN2" ] || { echo "FAIL: new turn_id not generated"; exit 1; }

# 3. 模拟 agent 调 transition(brainstorming → planning) 写 log
sqlite3 "$DB" "INSERT INTO workflow_transition_log (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at) VALUES ('$WS', 'brainstorming', 'planning', NULL, 'spec approved', 'agent-tool', '$TURN2', $(date +%s%3N))"

# 4. PostToolUse 无脑注入 planning SKILL
INJECT=$(echo "{\"cwd\":\"$WS\",\"tool_input\":{\"to_state\":\"planning\"}}" | node plugins/superharness/hooks/workflow-post-transition.mjs)
echo "$INJECT" | grep -q "Active skill: planning" || { echo "FAIL: planning SKILL not injected after brainstorming transition"; exit 1; }

echo "PASS: scenario-B"
```

- [ ] **步骤 2：运行测试**

运行：`"D:\Git\bin\bash.exe" tests/hooks/scenario-B.test.sh`
预期：`PASS: scenario-B`

- [ ] **步骤 3：Commit**

```bash
git add tests/hooks/scenario-B.test.sh
git commit -m "test(hooks): scenario B — cross-turn user review + chain after approval"
```

---

### 任务 13：Integration scenario C test — silent=false state agent 干一半溜了

**依赖：** 任务 10
**文件集：** `tests/hooks/scenario-C.test.sh`
**导出/变更接口：** 无
**消费接口：** `workflow-stop.mjs::main`, `workflow-context.mjs::main`
**复杂度：** standard

**文件：**
- 创建：`tests/hooks/scenario-C.test.sh`

- [ ] **步骤 1：编写测试脚本**

```bash
#!/bin/bash
# Scenario C: serial_execution silent=false，agent 不切态 → 拦 3 次 → 第 4 次逃生
set -e
WS=$(mktemp -d)
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

# 准备
echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-context.mjs > /dev/null
sqlite3 "$DB" "UPDATE workflow_state SET state='serial_execution' WHERE workspace_id='$WS'"

# 拦截 3 次（每次 block_count++）
for i in 1 2 3; do
  STOP=$(echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-stop.mjs)
  echo "$STOP" | grep -q '"decision":"block"' || { echo "FAIL: block #$i did not happen"; exit 1; }
  COUNT=$(sqlite3 "$DB" "SELECT block_count FROM workflow_turn")
  [ "$COUNT" = "$i" ] || { echo "FAIL: expected block_count=$i, got $COUNT"; exit 1; }
done

# 第 4 次：兜底逃生，放行
STOP4=$(echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-stop.mjs)
echo "$STOP4" | grep -q "decision" && { echo "FAIL: 4th call should escape, not block"; exit 1; }

echo "PASS: scenario-C"
```

- [ ] **步骤 2：运行测试**

运行：`"D:\Git\bin\bash.exe" tests/hooks/scenario-C.test.sh`
预期：`PASS: scenario-C`

- [ ] **步骤 3：Commit**

```bash
git add tests/hooks/scenario-C.test.sh
git commit -m "test(hooks): scenario C — strict state agent stalls + 3-block escape"
```

---

### 任务 14：Integration scenario D test — transition_state 工具失败

**依赖：** 任务 10
**文件集：** `tests/hooks/scenario-D.test.sh`
**导出/变更接口：** 无
**消费接口：** `workflow-post-transition.mjs::main`
**复杂度：** quick

**文件：**
- 创建：`tests/hooks/scenario-D.test.sh`

- [ ] **步骤 1：编写测试脚本**

```bash
#!/bin/bash
# Scenario D: transition_state 工具失败 → PostToolUse 不应被触发（平台行为）
# 我们只测 hook 在工具未实际成功调用情况下的 fail-open 行为
set -e

# 模拟工具失败 — PostToolUse 永远不会被平台触发（Claude Code / Codex 都如此）
# 这里测：即使强行喂一个 tool_input 没有 to_state 的事件，hook 也要 fail-open

OUT=$(echo '{"cwd":"/tmp","tool_input":{}}' | node plugins/superharness/hooks/workflow-post-transition.mjs)
[ "$OUT" = "{}" ] || { echo "FAIL: missing to_state should fail-open, got: $OUT"; exit 1; }

OUT2=$(echo 'not json' | node plugins/superharness/hooks/workflow-post-transition.mjs)
[ "$OUT2" = "{}" ] || { echo "FAIL: invalid input should fail-open, got: $OUT2"; exit 1; }

echo "PASS: scenario-D"
```

- [ ] **步骤 2：运行测试**

运行：`"D:\Git\bin\bash.exe" tests/hooks/scenario-D.test.sh`
预期：`PASS: scenario-D`

- [ ] **步骤 3：Commit**

```bash
git add tests/hooks/scenario-D.test.sh
git commit -m "test(hooks): scenario D — PostToolUse fail-open on missing/invalid input"
```

---

### 任务 15：Integration scenario E test — 用户授权 escape

**依赖：** 任务 10
**文件集：** `tests/hooks/scenario-E.test.sh`
**导出/变更接口：** 无
**消费接口：** `workflow-stop.mjs::main`, `workflow-context.mjs::main`, `server.js::releaseStopBlockTool`
**复杂度：** standard

**文件：**
- 创建：`tests/hooks/scenario-E.test.sh`

- [ ] **步骤 1：编写测试脚本**

```bash
#!/bin/bash
# Scenario E: silent=false state，agent 无法继续 → 用户授权 escape
set -e
WS=$(mktemp -d)
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

# 准备
echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-context.mjs > /dev/null
sqlite3 "$DB" "UPDATE workflow_state SET state='serial_execution' WHERE workspace_id='$WS'"

# 第 1 次 Stop：拦截
STOP1=$(echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-stop.mjs)
echo "$STOP1" | grep -q '"decision":"block"' || { echo "FAIL: first Stop should block"; exit 1; }

# 模拟 release_stop_block 调用：UPDATE workflow_turn SET stop_block_released=1
sqlite3 "$DB" "UPDATE workflow_turn SET stop_block_released=1, release_reason='用户授权终止' WHERE workspace_id='$WS'"

# 第 2 次 Stop：检测到 escape，放行
STOP2=$(echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-stop.mjs)
echo "$STOP2" | grep -q "decision" && { echo "FAIL: Stop should release after user escape"; exit 1; }

# 验证 audit 留痕（可选 — 直接 release_stop_block 工具会写 audit；这里 sqlite 直 UPDATE 跳过了）
# 实际 release_stop_block 测试在任务 6 单元测试覆盖

# 验证下一轮清零
echo "{\"cwd\":\"$WS\"}" | node plugins/superharness/hooks/workflow-context.mjs > /dev/null
RELEASED=$(sqlite3 "$DB" "SELECT stop_block_released FROM workflow_turn")
[ "$RELEASED" = "0" ] || { echo "FAIL: next turn should reset stop_block_released, got $RELEASED"; exit 1; }

echo "PASS: scenario-E"
```

- [ ] **步骤 2：运行测试**

运行：`"D:\Git\bin\bash.exe" tests/hooks/scenario-E.test.sh`
预期：`PASS: scenario-E`

- [ ] **步骤 3：Commit**

```bash
git add tests/hooks/scenario-E.test.sh
git commit -m "test(hooks): scenario E — user-authorized escape via release_stop_block"
```

---

### 任务 16：Release v1.3.0

**依赖：** 任务 11, 任务 12, 任务 13, 任务 14, 任务 15
**文件集：** `package.json`, `.claude-plugin/marketplace.json`, `plugins/superharness/.claude-plugin/plugin.json`, `plugins/superharness/.codex-plugin/plugin.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`package.json`
- 修改：`.claude-plugin/marketplace.json`
- 修改：`plugins/superharness/.claude-plugin/plugin.json`
- 修改：`plugins/superharness/.codex-plugin/plugin.json`

注意：`.cursor-plugin/plugin.json` 已在任务 4 被删除，不再需要。

- [ ] **步骤 1：4 个 manifest version 1.2.4 → 1.3.0**

精确替换每个文件的 `"version": "1.2.4"` → `"version": "1.3.0"`。

- [ ] **步骤 2：最终验证**

运行完整测试套件：

```bash
cd plugins/superharness/workflow-state-server && npx vitest run
```

预期：全 PASS（含本次新增 turn.test.js / release-stop-block.test.js / render-context.test.js / 扩展的 validate-workflow.test.js）

运行所有 integration scenario：

```bash
for s in A B C D E; do
  "D:\Git\bin\bash.exe" tests/hooks/scenario-$s.test.sh || exit 1
done
```

预期：全 PASS。

grep 验证 OpenCode/Cursor 引用清零：

```bash
grep -rnE "opencode|cursor" --include="*.md" --include="*.json" --include="*.mjs" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=archived-skills \
  --exclude-dir=docs/superharness/plans --exclude-dir=docs/superharness/specs \
  --exclude-dir=references \
  . 2>&1 | grep -v "Cursor support" | grep -v "OpenCode support"
```

预期：0 命中（或仅在已知的"删除说明"措辞里命中）。

- [ ] **步骤 3：Commit + push 到 main**

```bash
git add package.json .claude-plugin/marketplace.json \
        plugins/superharness/.claude-plugin/plugin.json \
        plugins/superharness/.codex-plugin/plugin.json
git commit -m "chore(release): bump to 1.3.0 — turn-completion hooks + drop OpenCode/Cursor"
git push origin main
```

预期：push 成功，origin/main 同步到本地 HEAD。

---

## 并行执行图

> 仅 `parallel-execution` 使用；`serial-execution` 忽略本节。

**Critical Path:** 任务 1 → 任务 8 → 任务 10 → 任务 11 → 任务 16

- **Wave 1**（无依赖）：任务 1, 任务 2, 任务 3, 任务 4, 任务 5
- **Wave 2**（依赖 Wave 1）：任务 6（依赖 1）, 任务 7（依赖 3）, 任务 8（依赖 1, 2）, 任务 9（依赖 1, 2）
- **Wave 3**（依赖 Wave 2）：任务 10（依赖 7, 8, 9）
- **Wave 4**（依赖 Wave 3，5 个 scenario 并行）：任务 11, 任务 12, 任务 13, 任务 14, 任务 15（均依赖 10）
- **Wave 5**（依赖 Wave 4）：任务 16（依赖 11, 12, 13, 14, 15）
- **Wave FINAL**（所有任务完成后并发派发）：F1 规格合规、F2 代码质量、F3 真实手测、F4 范围保真

**Wave 安全前提核对（pairwise 4 条规则）：**

- **Wave 1 (T1, T2, T3, T4, T5)**：
  - T1 文件集（state.js / schema.sql / turn.test.js）∩ T2 / T3 / T4 / T5 = ∅
  - T2 文件集（yaml / validate-workflow.js / validate-workflow.test.js）∩ T3 / T4 / T5 = ∅
  - T3 文件集（render-context.js / test）∩ T4 / T5 = ∅
  - T4（删除目录）∩ T5（修改文件）= ∅
  - 所有任务 `**导出/变更接口：**` 互不相交（不同模块 / 不同函数 / 删除任务无导出）
  - `导出 ∩ 消费` 互不相交（5 任务都消费"无"或纯文档，不消费彼此导出）
  - ✓ 4 条规则全过

- **Wave 2 (T6, T7, T8, T9)**：
  - T6 (server.js / release-stop-block.test.js) ∩ T7 (workflow-post-transition.mjs) ∩ T8 (workflow-stop.mjs) ∩ T9 (workflow-context.mjs) = ∅
  - 4 个 hook script + MCP 工具的导出互不相交
  - 消费交集：T6/T8/T9 都消费 state.js 的 workflow_turn CRUD；T7/T8 都消费 validate-workflow.js + render-context.js — 但 `A.消费 ∩ B.消费 ≠ ∅` 允许
  - T6 导出 `releaseStopBlockTool` ∩ T7/T8/T9 消费 = ∅（T7/T8/T9 不调 release_stop_block 工具）
  - T7 导出 main ∩ T6/T8/T9 消费 = ∅
  - T8 导出 main ∩ T6/T7/T9 消费 = ∅
  - T9 导出 main 无 / ∩ T6/T7/T8 消费 = ∅
  - ✓ 4 条规则全过

- **Wave 3 (T10)**：单任务，无 pairwise 检查需要。

- **Wave 4 (T11, T12, T13, T14, T15)**：
  - 5 个 .sh 文件互不相交 ✓
  - 5 个 shell 脚本无导出（独立可执行）✓
  - 消费交集：5 个都消费 hook scripts + state.js — `A.消费 ∩ B.消费 ≠ ∅` 允许 ✓
  - 导出 ∩ 消费：5 个都无导出 → ∅ ✓
  - ✓ 4 条规则全过

- **Wave 5 (T16)**：单任务，无 pairwise 检查需要。

**目标 wave 大小：** Wave 1 = 5 / Wave 2 = 4 / Wave 3 = 1 / Wave 4 = 5 / Wave 5 = 1。Wave 3 和 Wave 5 是 1 任务（合理：单点配置 / 单点 release）。

**Critical Path 长度：** 5 个 wave，5 步关键路径。
