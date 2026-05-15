# 程序化状态机与 Hook 动态注入实现计划

> **面向 AI 代理的工作者：** 必需子技能：平台支持子代理且计划较大/可安全分 wave 时使用 superharness:parallel-executing-plans；计划较小、任务强耦合或平台不支持子代理时使用 superharness:serial-executing-plans。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 `superharness` 实现一期程序化状态机、SQLite 状态事实源、MCP 状态工具，以及 OpenCode / Claude Code / Codex 三端动态上下文注入；OpenCode 使用每轮 `experimental.chat.system.transform`，Claude Code / Codex 使用 hook `additionalContext` 注入上下文，不把 Claude/Codex 描述为 system prompt 注入。

**架构：** 新增 `workflow-state-server` 作为共享核心，包含 SQLite store、状态图校验、context renderer 和 MCP server。OpenCode 的 `.opencode/plugins/superharness.js` 是运行在 Bun 环境里的本地插件，先确保共享核心依赖可用，再动态导入共享核心、注册 MCP、执行 system transform 和 tool guard；Claude/Codex 通过 hook 脚本调用同一 renderer，并用 PreToolUse 尽力保护 `.superharness/`。默认状态图只覆盖现有主开发生命周期 skill，不新增或修改任何 `SKILL.md`。

**技术栈：** Node.js ESM, Bun plugin runtime, `bun:sqlite`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `vitest`, Bash/Windows `run-hook.cmd`, OpenCode plugin hooks, Claude/Codex JSON hooks。

---

## 文件结构

- `plugins/superharness/workflow/default-workflow.yaml`：内置一期状态图配置。
- `plugins/superharness/workflow-state-server/package.json`：状态服务独立依赖和测试脚本。
- `plugins/superharness/workflow-state-server/package-lock.json`：锁定 MCP SDK、`better-sqlite3`、`vitest` 依赖。
- `plugins/superharness/workflow-state-server/schema.sql`：SQLite schema。
- `plugins/superharness/workflow-state-server/validate-workflow.js`：状态图 schema 校验和 skill 引用校验。
- `plugins/superharness/workflow-state-server/state.js`：SQLite store、状态初始化、跳转、审计和状态目录解析。
- `plugins/superharness/workflow-state-server/render-context.js`：按当前状态渲染动态注入上下文。
- `plugins/superharness/workflow-state-server/server.js`：MCP stdio server，暴露五个状态工具。
- `plugins/superharness/workflow-state-server/test/*.test.js`：状态核心、配置校验、renderer、MCP server 测试。
- `plugins/superharness/hooks/workflow-context`：跨平台 bash hook 入口，调用 Node renderer CLI。
- `plugins/superharness/hooks/workflow-context.mjs`：Claude/Codex hook JSON 输出。
- `plugins/superharness/hooks/workflow-pre-tool-use`：跨平台 bash hook 入口，调用 Node 写保护 CLI。
- `plugins/superharness/hooks/workflow-pre-tool-use.mjs`：解析 PreToolUse 输入并阻断 `.superharness/` 写操作。
- `plugins/superharness/hooks/hooks.json`：Claude Code hooks，新增 `UserPromptSubmit` 和 `PreToolUse`。
- `plugins/superharness/hooks/hooks-codex.json`：Codex hooks，新增 `UserPromptSubmit` 和 `PreToolUse`。
- `plugins/superharness/.opencode/plugins/superharness.js`：注册 state MCP，OpenCode 每轮注入，保护状态目录。
- `plugins/superharness/.codex-plugin/plugin.json`：确认 Codex 插件 hooks 指向更新后的 hooks 文件。
- `plugins/superharness/.claude-plugin/plugin.json`：如 Claude 插件 manifest 需要 hooks 字段，则补充指向 `hooks/hooks.json`。
- `tests/opencode/test-workflow-state-contract.sh`：OpenCode 插件契约测试。
- `tests/opencode/run-tests.sh`：纳入 OpenCode workflow contract 测试。

不修改 `plugins/superharness/skills/**/SKILL.md`。

## 平台契约约束

- OpenCode：源码确认 `@opencode-ai/plugin` 支持 `experimental.chat.system.transform`，输出为可追加的 `system: string[]`；支持 `tool.execute.before`；本地插件位于 `.opencode/plugins/` 并运行在 Bun 插件运行时。OpenCode config MCP schema 支持 `{ type: "local", command: string[], enabled?: boolean }`。本计划不得假设 `workflow-state-server/node_modules` 已存在；OpenCode 插件中不得在文件顶层静态导入需要该目录依赖的共享核心，必须先执行依赖检查，再动态导入。
- Codex：源码确认 `UserPromptSubmit` 支持 `hookSpecificOutput.additionalContext`，并把它记录为 developer role 的额外上下文；`PreToolUse` 支持 `hookSpecificOutput.permissionDecision: "deny"` 和 `permissionDecisionReason`。Codex 的 apply patch hook canonical tool name 是 `apply_patch`，`Write` 和 `Edit` 是 matcher alias。Codex 不支持本方案所需的每轮 system prompt 修改，计划中只能称为 additionalContext 注入。
- Claude Code：源码确认 `UserPromptSubmit` / `SessionStart` / `PreToolUse` 支持 `hookSpecificOutput.additionalContext`，并把它作为 hook additional context / system reminder 进入模型上下文；`systemMessage` 是面向用户的 hook system message，不用于注入 workflow skill 正文。Claude Code 不支持本方案所需的每轮 system prompt 修改，计划中只能称为 additionalContext 注入。后续清理中已废弃 `SessionStart` 旧入口，只保留 `UserPromptSubmit` 注入工作流上下文。

## 任务 1：建立默认状态图与配置校验

**依赖：** 无
**文件集：** `plugins/superharness/workflow/default-workflow.yaml`, `plugins/superharness/workflow-state-server/validate-workflow.js`, `plugins/superharness/workflow-state-server/test/validate-workflow.test.js`
**导出/变更接口：** `plugins/superharness/workflow-state-server/validate-workflow.js::loadWorkflowConfig`, `plugins/superharness/workflow-state-server/validate-workflow.js::validateWorkflowConfig`, `plugins/superharness/workflow-state-server/validate-workflow.js::buildWorkflowGraph`
**消费接口：** 无
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/workflow/default-workflow.yaml`
- 创建：`plugins/superharness/workflow-state-server/validate-workflow.js`
- 创建：`plugins/superharness/workflow-state-server/test/validate-workflow.test.js`

- [x] **步骤 1：编写失败测试覆盖配置校验**

在 `validate-workflow.test.js` 中使用 `node:test` 或 `vitest` 断言以下用例：

```js
import { describe, it, expect } from 'vitest';
import { validateWorkflowConfig, buildWorkflowGraph } from '../validate-workflow.js';

const installedSkills = new Set([
  'brainstorming',
  'writing-plans',
  'serial-executing-plans',
  'parallel-executing-plans',
  'verification-before-completion',
  'finishing-a-development-branch',
  'systematic-debugging',
]);

it('rejects a missing entryState', () => {
  expect(() => validateWorkflowConfig({ version: 1, states: {} }, { installedSkills }))
    .toThrow(/entryState/);
});
```

覆盖用例：缺失 `entryState`、`next` 指向不存在状态、状态引用不存在 skill、terminal 状态绑定 skill、非 terminal 状态无出口、`systematic_debugging` 缺少 `previous_state` 出口。

- [x] **步骤 2：创建默认 workflow YAML**

写入 spec 中的一期状态图，状态名必须为：

```yaml
version: 1
entryState: brainstorming
terminalStates:
  - done
states:
  brainstorming:
    type: interactive
    skill: brainstorming
    next:
      - planning
      - systematic_debugging
  planning:
    type: interactive
    skill: writing-plans
    next:
      - execution_choice
      - systematic_debugging
  execution_choice:
    type: router
    next:
      - serial_execution
      - parallel_execution
      - systematic_debugging
  serial_execution:
    type: execution
    skill: serial-executing-plans
    next:
      - verification
      - systematic_debugging
  parallel_execution:
    type: execution
    skill: parallel-executing-plans
    next:
      - verification
      - systematic_debugging
  verification:
    type: gate
    skill: verification-before-completion
    next:
      - finishing
      - systematic_debugging
  finishing:
    type: gate
    skill: finishing-a-development-branch
    next:
      - done
      - systematic_debugging
  systematic_debugging:
    type: preemptive
    skill: systematic-debugging
    next:
      - previous_state
      - serial_execution
      - planning
  done:
    type: terminal
```

- [x] **步骤 3：实现配置读取和校验**

实现接口：

```js
export function loadWorkflowConfig({ pluginRoot, workspaceRoot } = {}) {}
export function validateWorkflowConfig(config, { installedSkills } = {}) {}
export function buildWorkflowGraph(config, { installedSkills } = {}) {}
```

规则：
- 优先读取 `${workspaceRoot}/.superharness/workflow.yaml`。
- 文件不存在时读取 `${pluginRoot}/workflow/default-workflow.yaml`。
- 一期不把项目级 workflow 配置作为正式用户能力；但存在时必须严格校验。
- 校验失败抛出包含具体状态名和字段名的 `Error`。
- `previous_state` 是唯一允许的特殊目标。

- [x] **步骤 4：运行配置校验测试**

运行：

```bash
cd plugins/superharness/workflow-state-server
npm test -- validate-workflow.test.js
```

预期：新增测试全部通过。

## 任务 2：实现 SQLite 状态事实源

**依赖：** 任务 1
**文件集：** `plugins/superharness/workflow-state-server/package.json`, `plugins/superharness/workflow-state-server/package-lock.json`, `plugins/superharness/workflow-state-server/schema.sql`, `plugins/superharness/workflow-state-server/state.js`, `plugins/superharness/workflow-state-server/test/state.test.js`
**导出/变更接口：** `plugins/superharness/workflow-state-server/state.js::openWorkflowStateStore`, `plugins/superharness/workflow-state-server/state.js::initializeWorkflowState`, `plugins/superharness/workflow-state-server/state.js::getWorkflowState`, `plugins/superharness/workflow-state-server/state.js::classifyRequest`, `plugins/superharness/workflow-state-server/state.js::transitionWorkflowState`, `plugins/superharness/workflow-state-server/state.js::listWorkflowHistory`, `plugins/superharness/workflow-state-server/state.js::resetWorkflowState`, `plugins/superharness/workflow-state-server/state.js::resolveWorkflowDbPath`
**消费接口：** `plugins/superharness/workflow-state-server/validate-workflow.js::buildWorkflowGraph`
**复杂度：** deep

**文件：**
- 创建：`plugins/superharness/workflow-state-server/package.json`
- 创建：`plugins/superharness/workflow-state-server/package-lock.json`
- 创建：`plugins/superharness/workflow-state-server/schema.sql`
- 创建：`plugins/superharness/workflow-state-server/state.js`
- 创建：`plugins/superharness/workflow-state-server/test/state.test.js`

- [x] **步骤 1：创建状态服务 package**

`package.json` 内容：

```json
{
  "name": "superharness-workflow-state-mcp",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "main": "server.js",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^12.0.0",
    "yaml": "^2.8.0"
  },
  "devDependencies": {
    "vitest": "^4.0.0"
  }
}
```

运行：

```bash
cd plugins/superharness/workflow-state-server
npm install
```

预期：生成 `package-lock.json`。

- [x] **步骤 2：编写 SQLite schema**

`schema.sql` 必须包含：

```sql
CREATE TABLE IF NOT EXISTS workflow_state (
  workspace_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  previous_state TEXT,
  active_skill TEXT,
  task_summary TEXT,
  failure_summary TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_transition_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  previous_state TEXT,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('hook','agent-tool','user-reset')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_transition_workspace
  ON workflow_transition_log(workspace_id, id);
```

- [x] **步骤 3：编写失败测试覆盖状态核心**

在 `state.test.js` 中覆盖：
- 无状态 workspace 初始化为 `brainstorming`。
- 合法跳转 `brainstorming -> planning` 成功。
- 非法跳转 `brainstorming -> finishing` 抛错且状态不变。
- `from_state` 与存储状态不一致时抛错。
- 空 `reason` 抛错。
- 跳入 `systematic_debugging` 记录 `previous_state`。
- 只有当前状态为 `systematic_debugging` 时才能跳转到 `previous_state`。
- `resetWorkflowState` 重置为 `brainstorming` 并写 `user-reset` 日志。

- [x] **步骤 4：实现 SQLite store**

`state.js` 使用与 `novel-workflow` 一致的跨运行时加载策略：

```js
const IS_BUN = typeof process !== 'undefined' && !!process.versions?.bun;
const Database = IS_BUN
  ? (await import('bun:sqlite')).Database
  : (await import('better-sqlite3')).default;
```

约束：
- OpenCode Bun 插件直接复用 `state.js` 时必须走 `bun:sqlite`，不要求 `.opencode/plugins/` 自己安装 `better-sqlite3`。
- Node MCP server、Node hook CLI 和 Vitest 测试必须走 `better-sqlite3`，依赖安装位置固定为 `workflow-state-server/node_modules`。
- 共享核心中导入 `yaml`、`@modelcontextprotocol/sdk`、`better-sqlite3` 的模块必须允许 OpenCode 插件在依赖检查完成后动态导入；不要让 OpenCode 插件顶层静态导入这些模块。

`openWorkflowStateStore({ dbPath, mode })`：
- `mode === 'memory'` 时使用 `:memory:`。
- 文件模式时创建父目录。
- 执行 `PRAGMA journal_mode = WAL`。
- 执行 `PRAGMA foreign_keys = ON`。
- 加载并执行 `schema.sql`。

`resolveWorkflowDbPath({ workspaceRoot })`：
- `SUPERHARNESS_WORKFLOW_STATE_DB` 存在时使用该路径。
- 否则使用 `${workspaceRoot}/.superharness/workflow-state.db`。

- [x] **步骤 5：实现状态操作**

实现：

```js
export function initializeWorkflowState(store, { workspaceRoot, workflowGraph, reason }) {}
export function getWorkflowState(store, { workspaceRoot, workflowGraph }) {}
export function classifyRequest(store, { workspaceRoot, task_summary, failure_summary, reason }) {}
export function transitionWorkflowState(store, { workspaceRoot, from_state, to_state, previous_state, reason, source }) {}
export function listWorkflowHistory(store, { workspaceRoot }) {}
export function resetWorkflowState(store, { workspaceRoot, reason }) {}
```

规则：
- `workspace_id` 使用 `path.resolve(workspaceRoot)`。
- `initializeWorkflowState` 幂等；已有状态时直接返回。
- 初始化状态为 workflow graph 的 `entryState`。
- `transitionWorkflowState` 必须使用 workflow graph 校验出口。
- `to_state === 'previous_state'` 时解析为当前 row 的 `previous_state`。
- 所有写操作必须插入 `workflow_transition_log`。

- [x] **步骤 6：运行状态测试**

运行：

```bash
cd plugins/superharness/workflow-state-server
npm test -- state.test.js
```

预期：状态核心测试全部通过。

## 任务 3：实现动态上下文 renderer

**依赖：** 任务 1, 任务 2
**文件集：** `plugins/superharness/workflow-state-server/render-context.js`, `plugins/superharness/workflow-state-server/test/render-context.test.js`
**导出/变更接口：** `plugins/superharness/workflow-state-server/render-context.js::renderWorkflowContext`, `plugins/superharness/workflow-state-server/render-context.js::renderStopWorkContext`, `plugins/superharness/workflow-state-server/render-context.js::stripFrontmatter`, `plugins/superharness/workflow-state-server/render-context.js::resolveSkillPath`
**消费接口：** `plugins/superharness/workflow-state-server/state.js::getWorkflowState`, `plugins/superharness/workflow-state-server/validate-workflow.js::buildWorkflowGraph`
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/workflow-state-server/render-context.js`
- 创建：`plugins/superharness/workflow-state-server/test/render-context.test.js`

- [x] **步骤 1：编写 renderer 测试**

覆盖：
- `planning` 注入 `writing-plans` 正文。
- `serial_execution` 注入 `serial-executing-plans` 正文。
- `parallel_execution` 注入 `parallel-executing-plans` 正文。
- `execution_choice` 只注入短 guard。
- 输出包含 `current_state`、`active_skill`、`allowed_transitions`、`.superharness/` 禁写规则。
- skill frontmatter 被剥离。
- skill 缺失时抛出明确错误。

- [x] **步骤 2：实现 skill 路径解析和 frontmatter 剥离**

实现：

```js
export function resolveSkillPath({ skillsDir, skillName }) {}
export function stripFrontmatter(markdown) {}
```

规则：
- `skillName` 只能匹配 `/^[a-z0-9][a-z0-9-]*$/`。
- 路径固定为 `${skillsDir}/${skillName}/SKILL.md`。
- 缺失文件抛出 `skill not found: <name>`。

- [x] **步骤 3：实现 context 渲染**

`renderWorkflowContext({ stateInfo, workflowGraph, skillsDir })` 返回：

```text
<SUPERHARNESS_WORKFLOW_STATE>
Runtime facts:
- current_state: planning
- previous_state: null
- active_skill: writing-plans
- allowed_transitions: ["execution_choice","systematic_debugging"]
- state_directory: .superharness/

Rules:
- Follow the active skill below for this turn.
- If the state exit condition is met, call transition_state with a non-empty reason.
- Do not edit .superharness/ directly.
- If workflow config or state cannot be loaded, stop business work and report the error.

--- Active skill: writing-plans ---
...
</SUPERHARNESS_WORKFLOW_STATE>
```

`execution_choice` 返回短 guard，不读取 skill。

- [x] **步骤 4：实现 stop-work context**

`renderStopWorkContext({ reason })` 返回 `<SUPERHARNESS_WORKFLOW_STATE>` 块，要求 agent 停止业务工作、报告错误、不编造状态、不直接写 `.superharness/`。

- [x] **步骤 5：运行 renderer 测试**

运行：

```bash
cd plugins/superharness/workflow-state-server
npm test -- render-context.test.js
```

预期：renderer 测试全部通过。

## 任务 4：实现 MCP 状态工具

**依赖：** 任务 1, 任务 2, 任务 3
**文件集：** `plugins/superharness/workflow-state-server/server.js`, `plugins/superharness/workflow-state-server/test/server.test.js`
**导出/变更接口：** `plugins/superharness/workflow-state-server/server.js::TOOLS`
**消费接口：** `plugins/superharness/workflow-state-server/state.js::getWorkflowState`, `plugins/superharness/workflow-state-server/state.js::classifyRequest`, `plugins/superharness/workflow-state-server/state.js::transitionWorkflowState`, `plugins/superharness/workflow-state-server/state.js::listWorkflowHistory`, `plugins/superharness/workflow-state-server/state.js::resetWorkflowState`, `plugins/superharness/workflow-state-server/render-context.js::renderWorkflowContext`
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/workflow-state-server/server.js`
- 创建：`plugins/superharness/workflow-state-server/test/server.test.js`

- [x] **步骤 1：编写 MCP server 测试**

测试直接导入 `TOOLS`，不需要启动真实客户端。断言工具名精确为：

```js
[
  'get_state',
  'classify_request',
  'transition_state',
  'list_history',
  'reset_state'
]
```

并覆盖 `transition_state` 成功写日志、非法跳转返回错误。

- [x] **步骤 2：实现 server 初始化**

`server.js`：
- 读取 `SUPERHARNESS_WORKFLOW_STATE_MODE=memory` 支持内存测试。
- 读取 `SUPERHARNESS_WORKFLOW_STATE_DB` 支持显式 DB 路径。
- 默认 DB 路径为 `.superharness/workflow-state.db`，相对当前工作目录。
- 加载 workflow config 和 installed skills。
- 初始化 `Server` + `StdioServerTransport`。

- [x] **步骤 3：实现五个 MCP tools**

每个 tool 的 handler 返回可 JSON.stringify 的对象：

```js
{
  name: 'transition_state',
  description: 'Validate and execute a workflow state transition.',
  inputSchema: {
    type: 'object',
    required: ['workspaceRoot', 'from_state', 'to_state', 'reason'],
    properties: {
      workspaceRoot: { type: 'string' },
      from_state: { type: 'string' },
      to_state: { type: 'string' },
      previous_state: { type: 'string' },
      reason: { type: 'string' }
    }
  },
  handler: (args) => transitionWorkflowState(store, args)
}
```

`classify_request` 一期只写 `task_summary`、`failure_summary`、`reason`，不实现二期 route/difficulty。

- [x] **步骤 4：运行 MCP server 测试**

运行：

```bash
cd plugins/superharness/workflow-state-server
npm test -- server.test.js
```

预期：MCP 工具测试全部通过。

## 任务 5：实现 Claude/Codex hook 注入和状态目录保护

**依赖：** 任务 3, 任务 4
**文件集：** `plugins/superharness/hooks/workflow-context`, `plugins/superharness/hooks/workflow-context.mjs`, `plugins/superharness/hooks/workflow-pre-tool-use`, `plugins/superharness/hooks/workflow-pre-tool-use.mjs`, `plugins/superharness/hooks/hooks.json`, `plugins/superharness/hooks/hooks-codex.json`, `plugins/superharness/workflow-state-server/test/hook-cli.test.js`
**导出/变更接口：** `plugins/superharness/hooks/workflow-context.mjs::main`, `plugins/superharness/hooks/workflow-pre-tool-use.mjs::main`
**消费接口：** `plugins/superharness/workflow-state-server/render-context.js::renderWorkflowContext`, `plugins/superharness/workflow-state-server/render-context.js::renderStopWorkContext`
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/hooks/workflow-context`
- 创建：`plugins/superharness/hooks/workflow-context.mjs`
- 创建：`plugins/superharness/hooks/workflow-pre-tool-use`
- 创建：`plugins/superharness/hooks/workflow-pre-tool-use.mjs`
- 修改：`plugins/superharness/hooks/hooks.json`
- 修改：`plugins/superharness/hooks/hooks-codex.json`
- 创建：`plugins/superharness/workflow-state-server/test/hook-cli.test.js`

- [x] **步骤 1：编写 hook CLI 测试**

测试 `workflow-context.mjs`：
- Claude 环境变量 `CLAUDE_PLUGIN_ROOT` 存在时输出 `hookSpecificOutput.hookEventName === "UserPromptSubmit"` 和 `hookSpecificOutput.additionalContext`。
- Codex 环境下输出同样的 `hookSpecificOutput.additionalContext`。
- Claude/Codex 输出中不得包含 `systemMessage`，避免把 workflow skill 正文当作面向用户的 warning message。
- 发生配置错误时输出 stop-work context。

测试 `workflow-pre-tool-use.mjs`：
- 输入包含 `.superharness/workflow-state.db` 的写操作时返回 `hookSpecificOutput.permissionDecision === "deny"`。
- 只读操作不阻断。

- [x] **步骤 2：实现 workflow-context bash 入口**

`workflow-context` 内容：

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/workflow-context.mjs"
```

- [x] **步骤 3：实现 workflow-context.mjs**

行为：
- 从 stdin 读取 hook JSON；无 stdin 时允许 `{}`。
- 解析 `cwd` 作为 workspaceRoot；缺失时使用 `process.cwd()`。
- 解析 pluginRoot：优先 `CLAUDE_PLUGIN_ROOT`，其次 `CODEX_PLUGIN_ROOT`，否则从脚本目录上推一级。
- 调用共享核心加载状态、配置和 renderer。
- Claude Code / Codex 只通过 `additionalContext` 注入；不要输出 `systemMessage`。
- 输出：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<SUPERHARNESS_WORKFLOW_STATE>...</SUPERHARNESS_WORKFLOW_STATE>"
  }
}
```

不使用 `systemMessage` 表示注入内容。Codex 会把 `additionalContext` 记录为 developer context；Claude Code 会把它作为 hook additional context / system reminder 进入上下文。

- [x] **步骤 4：实现 workflow-pre-tool-use**

`workflow-pre-tool-use` 内容：

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/workflow-pre-tool-use.mjs"
```

- [x] **步骤 5：实现 workflow-pre-tool-use.mjs**

阻断条件：
- 任意字符串参数包含 `/.superharness/`。
- 任意字符串参数以 `.superharness/` 开头。
- Windows 路径先将 `\` 替换为 `/` 再判断。
- Bash 命令触及 `.superharness/` 且包含 `>`, `>>`, `rm`, `del`, `move`, `mv`, `copy`, `cp`, `set-content`, `add-content`, `out-file`, `sqlite3` 时阻断。

Claude/Codex block 输出使用：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Workflow state is managed by superharness workflow tools; do not edit .superharness/ directly."
  }
}
```

- [x] **步骤 6：更新 Claude hooks**

历史计划原写法是在 `hooks.json` 保留现有 `SessionStart` 并新增以下 hook；后续废弃旧入口后，实际只保留以下 `UserPromptSubmit` 与 `PreToolUse`：

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" workflow-context",
        "async": false
      }
    ]
  }
],
"PreToolUse": [
  {
    "matcher": "Write|Edit|MultiEdit|Bash",
    "hooks": [
      {
        "type": "command",
        "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" workflow-pre-tool-use",
        "async": false
      }
    ]
  }
]
```

- [x] **步骤 7：更新 Codex hooks**

历史计划原写法是在 `hooks-codex.json` 保留现有 `SessionStart` 并新增以下 hook；后续废弃旧入口后，实际只保留以下 `UserPromptSubmit` 与 `PreToolUse`：

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "./hooks/run-hook.cmd workflow-context",
        "async": false
      }
    ]
  }
],
"PreToolUse": [
  {
    "matcher": "Bash|apply_patch|Write|Edit",
    "hooks": [
      {
        "type": "command",
        "command": "./hooks/run-hook.cmd workflow-pre-tool-use",
        "async": false
      }
    ]
  }
]
```

- [x] **步骤 8：运行 hook CLI 测试**

运行：

```bash
cd plugins/superharness/workflow-state-server
npm test -- hook-cli.test.js
```

预期：hook CLI 测试全部通过。

## 任务 6：集成 OpenCode 插件

**依赖：** 任务 2, 任务 3, 任务 4
**文件集：** `plugins/superharness/.opencode/plugins/superharness.js`, `plugins/superharness/.codex-plugin/plugin.json`, `plugins/superharness/.claude-plugin/plugin.json`, `tests/opencode/test-workflow-state-contract.sh`
**导出/变更接口：** `plugins/superharness/.opencode/plugins/superharness.js::SuperharnessPlugin`
**消费接口：** `plugins/superharness/workflow-state-server/state.js::openWorkflowStateStore`, `plugins/superharness/workflow-state-server/render-context.js::renderWorkflowContext`, `plugins/superharness/workflow-state-server/server.js::TOOLS`
**复杂度：** deep

**文件：**
- 修改：`plugins/superharness/.opencode/plugins/superharness.js`
- 修改：`plugins/superharness/.codex-plugin/plugin.json`
- 修改：`plugins/superharness/.claude-plugin/plugin.json`
- 创建：`tests/opencode/test-workflow-state-contract.sh`

- [x] **步骤 1：编写 OpenCode 契约测试**

`test-workflow-state-contract.sh` 静态检查：
- `superharness.js` 包含 `experimental.chat.system.transform`。
- `superharness.js` 包含 `tool.execute.before`。
- `superharness.js` 注册 `superharness-workflow-state` MCP。
- `superharness.js` 动态导入 `workflow-state-server/state.js`。
- `superharness.js` 动态导入 `render-context.js`。
- `superharness.js` 顶层不静态导入 `workflow-state-server/**`。
- `superharness.js` 在动态导入共享核心前调用依赖检查。
- `superharness.js` 包含 `.superharness/` 写保护。
- `hooks.json` 和 `hooks-codex.json` 包含 `UserPromptSubmit`。
- `hooks-codex.json` 的 `PreToolUse` matcher 覆盖 `Bash`、`apply_patch`、`Write`、`Edit`。
- 文档或代码中不出现 `Claude/Codex system prompt injection` 这类误称。

- [x] **步骤 2：为 OpenCode 插件增加 MCP 依赖安装保护**

参考 `novel-workflow` 的 `ensureMcpDeps`：
- 检查 `workflow-state-server/node_modules/better-sqlite3/build/Release/better_sqlite3.node`。
- 检查 `workflow-state-server/node_modules/yaml` 和 `workflow-state-server/node_modules/@modelcontextprotocol/sdk`。
- 不存在时运行 `npm install --omit=dev --no-audit --no-fund`。
- Windows 使用 `npm.cmd`。
- 安装失败不让插件整体崩溃；后续 system transform 注入 stop-work context。
- 插件运行在 Bun 中；依赖检查只为 Node MCP server、renderer 依赖和动态导入共享核心准备 `node_modules`，SQLite 直接状态访问使用 `bun:sqlite`。

- [x] **步骤 3：注册 MCP server**

在 `config` hook 中追加：

```js
config.mcp = config.mcp || {};
config.mcp['superharness-workflow-state'] = {
  type: 'local',
  command: ['node', STATE_MCP_ENTRY],
  enabled: true
};
```

同时继续注册 `skills.paths`。

- [x] **步骤 4：把 messages transform 迁移到 state-aware system transform**

历史计划原写法保留了 `using-superpowers` bootstrap 辅助函数；后续废弃旧入口后，实际删除 bootstrap，只保留 OpenCode 每轮注入 workflow context：
- `superharness.js` 顶层只保留 Node/Bun 内置模块导入和纯路径常量，不顶层导入共享核心。
- `config` hook 中先执行 `ensureWorkflowStateDeps()`，再注册 MCP server。
- `experimental.chat.system.transform` 中调用 `loadWorkflowRuntime()` 动态导入共享核心；导入失败时调用轻量 fallback stop-work renderer。
- 成功加载状态核心时，调用 `renderWorkflowContext` 并 push 到 `output.system`。
- 加载失败时，调用 `renderStopWorkContext`。
- 不再把 `using-superpowers` 塞入第一条 user message，也不再保留旧 bootstrap helper。

`output.system` 不是数组时先初始化为数组。

- [x] **步骤 5：实现 OpenCode 状态目录写保护**

新增 `pathTouchesWorkflowState(value)` 和 `isWorkflowStateWrite(tool, args)`：
- `write` / `edit` 命中 `args.filePath`。
- `apply_patch` 扫描所有字符串值。
- `bash` 使用与任务 5 一致的写命令检测。
- 命中时抛错：

```js
throw new Error('Workflow state is managed by superharness-workflow-state; use workflow tools instead of editing .superharness/ directly');
```

- [x] **步骤 6：补齐 plugin manifest**

确认：
- `.codex-plugin/plugin.json` 的 `hooks` 仍指向 `./hooks/hooks-codex.json`。
- `.claude-plugin/plugin.json` 如缺少 hooks 字段，则加入 `"hooks": "./hooks/hooks.json"`。

不修改 skills 目录声明。

- [x] **步骤 7：运行 OpenCode 契约测试**

运行：

```bash
bash tests/opencode/test-workflow-state-contract.sh
```

预期：契约测试通过。

## 任务 7：串联测试入口并执行验收

**依赖：** 任务 1, 任务 2, 任务 3, 任务 4, 任务 5, 任务 6
**文件集：** `tests/opencode/run-tests.sh`, `docs/superharness/plans/2026-05-15-programmatic-state-machine-hook-injection.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** standard

**文件：**
- 修改：`tests/opencode/run-tests.sh`
- 修改：`docs/superharness/plans/2026-05-15-programmatic-state-machine-hook-injection.md`

- [x] **步骤 1：把 OpenCode contract 纳入测试入口**

在 `tests/opencode/run-tests.sh` 的 `tests=(...)` 中加入：

```bash
"test-workflow-state-contract.sh"
```

- [x] **步骤 2：运行状态服务完整测试**

运行：

```bash
cd plugins/superharness/workflow-state-server
npm test
```

预期：`validate-workflow`、`state`、`render-context`、`server`、`hook-cli` 测试全部通过。

- [x] **步骤 3：运行 OpenCode 非集成测试**

运行：

```bash
bash tests/opencode/run-tests.sh
```

预期：plugin loading 和 workflow state contract 均通过。

- [x] **步骤 4：手动检查三端 hooks 配置**

检查：

```bash
node -e "JSON.parse(require('fs').readFileSync('plugins/superharness/hooks/hooks.json','utf8')); JSON.parse(require('fs').readFileSync('plugins/superharness/hooks/hooks-codex.json','utf8')); console.log('hooks json ok')"
```

预期：输出 `hooks json ok`。

- [x] **步骤 5：检查没有修改 skill 文件**

运行：

```bash
git diff --name-only -- plugins/superharness/skills
```

预期：无输出。

- [x] **步骤 6：检查 Claude/Codex 注入术语**

运行：

```bash
rg -n "Claude.*system prompt|Codex.*system prompt|system prompt injection" plugins docs/superharness
```

预期：没有把 Claude/Codex 描述为 system prompt 注入的新增内容；允许出现否定性说明。

- [x] **步骤 7：更新本计划执行状态**

执行完成后，把本计划中实际完成的复选框勾选。不要追加变更记录；如果计划内容与实现偏离，原地修正对应任务。

## 并行执行图

> 仅 `parallel-executing-plans` 使用；`serial-executing-plans` 忽略本节。

**Critical Path:** 任务 1 → 任务 2 → 任务 4 → 任务 6 → 任务 7

- Wave 1（无依赖）：任务 1
- Wave 2（依赖 Wave 1）：任务 2（依赖 1）
- Wave 3（依赖 Wave 2）：任务 3（依赖 1, 2）
- Wave 4（依赖 Wave 3）：任务 4（依赖 1, 2, 3）
- Wave 5（依赖 Wave 4）：任务 5（依赖 3, 4）, 任务 6（依赖 2, 3, 4）
- Wave 6（依赖 Wave 5）：任务 7（依赖 1, 2, 3, 4, 5, 6）
- Wave FINAL（所有任务完成后）：F1 规格合规、F2 代码质量、F3 真实手测、F4 范围保真



