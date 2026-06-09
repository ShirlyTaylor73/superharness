# Workspace Source of Truth 实现计划

> **面向 AI 代理的工作者：** 必需子技能：平台支持子代理且计划较大/可安全分 wave 时使用 superpowers:parallel-executing-plans；计划较小、任务强耦合或平台不支持子代理时使用 superpowers:serial-executing-plans。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Claude Code 下的 hooks 和 MCP workflow-state tools 全部使用 `CLAUDE_PROJECT_DIR` 作为唯一 workspace 真值，并从 agent 面向的 MCP schema 中移除 `workspaceRoot`。

**架构：** 新增共享 workspace resolver，hooks 和 MCP server 都从 `process.env.CLAUDE_PROJECT_DIR` 解析项目根。MCP runtime 在启动时绑定该 workspace，tool handlers 不再读取 agent 参数中的路径；缺失或无效环境变量时返回 stop-work/结构化错误，不创建 cwd 下的状态库。

**技术栈：** Node.js >=20 ES modules, Vitest, Node `node:test`, Claude Code hook env, MCP stdio server config

---

## 文件结构

- `plugins/superharness/workflow-state-server/workspace.js`：新增共享 resolver；导出 `resolveTrustedWorkspaceRoot` 和错误信息常量。
- `plugins/superharness/hooks/workflow-context.mjs`：改用 resolver 解析 workspace；`input.cwd` 仅用于诊断。
- `plugins/superharness/hooks/workflow-stop.mjs`：改用 resolver，保证 stop-block 读取同一 workspace。
- `plugins/superharness/hooks/workflow-post-transition.mjs`：改用 resolver，保证 free-mode 和 graph 上下文一致。
- `plugins/superharness/hooks/lib/free-mode-check.mjs`：保持接口不变，消费已解析 workspace。
- `plugins/superharness/workflow-state-server/server.js`：MCP runtime 从 `CLAUDE_PROJECT_DIR` 初始化；tool schema 移除 `workspaceRoot`。
- `plugins/superharness/.mcp.json`：显式传递 `CLAUDE_PROJECT_DIR` 给 stdio MCP server。
- `plugins/superharness/workflow-state-server/test/workspace.test.js`：新增 resolver 单元测试。
- `plugins/superharness/workflow-state-server/test/hook-cli.test.js`：新增 hook cwd 与 project dir 不一致的回归测试。
- `plugins/superharness/workflow-state-server/test/server.test.js`：新增 MCP schema 和 runtime workspace 测试。
- `plugins/superharness/commands/rollback.md`：移除 `workspaceRoot` 调用说明。
- `plugins/superharness/commands-codex/rollback.md`：移除 `workspaceRoot` 调用说明，或标注 Codex 另行决策。
- `README.md`, `plugins/superharness/README.md`：更新 MCP tool 调用说明，不再要求 agent 传 workspace path。

## 任务 1：新增 workspace resolver 失败测试

**依赖：** 无
**文件集：** `plugins/superharness/workflow-state-server/test/workspace.test.js`, `plugins/superharness/workflow-state-server/test/hook-cli.test.js`, `plugins/superharness/workflow-state-server/test/server.test.js`
**导出/变更接口：** 无
**消费接口：** `plugins/superharness/workflow-state-server/workspace.js::resolveTrustedWorkspaceRoot`, `plugins/superharness/workflow-state-server/server.js::createTools`
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/workflow-state-server/test/workspace.test.js`
- 修改：`plugins/superharness/workflow-state-server/test/hook-cli.test.js`
- 修改：`plugins/superharness/workflow-state-server/test/server.test.js`

- [ ] **步骤 1：添加 resolver 单元测试**

创建 `workspace.test.js`：

```js
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTrustedWorkspaceRoot } from '../workspace.js';

describe('resolveTrustedWorkspaceRoot', () => {
  it('uses CLAUDE_PROJECT_DIR as the trusted workspace', () => {
    const project = path.resolve('/project/root');
    expect(resolveTrustedWorkspaceRoot({ CLAUDE_PROJECT_DIR: project })).toBe(project);
  });

  it('rejects missing CLAUDE_PROJECT_DIR', () => {
    expect(() => resolveTrustedWorkspaceRoot({})).toThrow(/CLAUDE_PROJECT_DIR is required/);
  });

  it('rejects blank CLAUDE_PROJECT_DIR', () => {
    expect(() => resolveTrustedWorkspaceRoot({ CLAUDE_PROJECT_DIR: '   ' })).toThrow(/CLAUDE_PROJECT_DIR is required/);
  });
});
```

- [ ] **步骤 2：添加 hook/MCP 同步回归测试**

在 `hook-cli.test.js` 新增测试：

- `sessionRoot = mkdtempSync(... 'superharness-session-')`
- `projectRoot = mkdtempSync(... 'superharness-project-')`
- 先用 state API 在 `projectRoot` 初始化并 transition 到 `exploration`
- 运行 `workflow-context.mjs`，输入 `{ cwd: sessionRoot, hook_event_name: 'UserPromptSubmit' }`
- env 包含 `CLAUDE_PROJECT_DIR: projectRoot` 和 `CLAUDE_PLUGIN_ROOT: pluginRoot`
- 断言输出包含 `current_state: exploration`
- 断言 `sessionRoot/.superharness/workflow-state.db` 不存在

- [ ] **步骤 3：添加 MCP schema 失败测试**

在 `server.test.js` 新增测试：

```js
const transition = toolByName(createTools(() => runtimeFor(store, '/workspace/a')), 'transition_state');
expect(transition.inputSchema.required).not.toContain('workspaceRoot');
expect(transition.inputSchema.properties.workspaceRoot).toBeUndefined();
```

同时新增 tool handler 测试：调用 `transition_state` 时不传 `workspaceRoot`，runtime 使用内部 workspace `/workspace/a`，最终状态变为目标状态。

- [ ] **步骤 4：运行测试确认失败**

运行：

```bash
cd plugins/superharness/workflow-state-server && npm test
```

预期：FAIL，原因包括 `workspace.js` 不存在、schema 仍包含 `workspaceRoot`、hook 仍使用 `input.cwd`。

- [ ] **步骤 5：Commit**

```bash
git add plugins/superharness/workflow-state-server/test/workspace.test.js plugins/superharness/workflow-state-server/test/hook-cli.test.js plugins/superharness/workflow-state-server/test/server.test.js
git commit -m "test(workspace): cover project dir source of truth"
```

## 任务 2：实现共享 workspace resolver 并迁移 hooks

**依赖：** 任务 1
**文件集：** `plugins/superharness/workflow-state-server/workspace.js`, `plugins/superharness/hooks/workflow-context.mjs`, `plugins/superharness/hooks/workflow-stop.mjs`, `plugins/superharness/hooks/workflow-post-transition.mjs`
**导出/变更接口：** `plugins/superharness/workflow-state-server/workspace.js::resolveTrustedWorkspaceRoot`, `plugins/superharness/workflow-state-server/workspace.js::WORKSPACE_ENV_ERROR`
**消费接口：** 无
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/workflow-state-server/workspace.js`
- 修改：`plugins/superharness/hooks/workflow-context.mjs`
- 修改：`plugins/superharness/hooks/workflow-stop.mjs`
- 修改：`plugins/superharness/hooks/workflow-post-transition.mjs`

- [ ] **步骤 1：创建 resolver**

实现：

```js
import fs from 'node:fs';
import path from 'node:path';

export const WORKSPACE_ENV_ERROR =
  'CLAUDE_PROJECT_DIR is required to resolve the Superharness workspace';

export function resolveTrustedWorkspaceRoot(env = process.env) {
  const raw = env.CLAUDE_PROJECT_DIR;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(WORKSPACE_ENV_ERROR);
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${WORKSPACE_ENV_ERROR}: path does not exist: ${resolved}`);
  }
  return resolved;
}
```

- [ ] **步骤 2：迁移 `workflow-context.mjs`**

在动态 import 列表中加入 `workspace.js`：

```js
{ resolveTrustedWorkspaceRoot }
```

将：

```js
const workspaceRoot = path.resolve(input.cwd || process.cwd());
```

替换为：

```js
const observedCwd = path.resolve(input.cwd || process.cwd());
const workspaceRoot = resolveTrustedWorkspaceRoot(process.env);
```

`observedCwd` 只用于后续错误诊断；不要传给 state API。

- [ ] **步骤 3：迁移 `workflow-stop.mjs`**

同样用 `resolveTrustedWorkspaceRoot(process.env)` 替换 `input.cwd || process.cwd()`。所有 `isFreeMode`、`loadWorkflowConfig`、`resolveWorkflowDbPath`、`getWorkflowState`、`getTurn`、`incrementBlockCount` 调用继续消费 `workspaceRoot`。

- [ ] **步骤 4：迁移 `workflow-post-transition.mjs`**

将 workspace 解析替换为 resolver，确保 free-mode 检查与 graph 加载使用 trusted workspace。`toState` 仍来自 `input.tool_input.to_state`。

- [ ] **步骤 5：运行 hook/resolver 测试**

运行：

```bash
cd plugins/superharness/workflow-state-server && npm test -- workspace.test.js hook-cli.test.js
```

预期：resolver 和 hook CLI 测试 PASS；server schema 测试仍 FAIL。

- [ ] **步骤 6：Commit**

```bash
git add plugins/superharness/workflow-state-server/workspace.js plugins/superharness/hooks/workflow-context.mjs plugins/superharness/hooks/workflow-stop.mjs plugins/superharness/hooks/workflow-post-transition.mjs
git commit -m "fix(hooks): resolve workspace from claude project dir"
```

## 任务 3：移除 MCP tool schema 的 `workspaceRoot`

**依赖：** 任务 2
**文件集：** `plugins/superharness/workflow-state-server/server.js`, `plugins/superharness/workflow-state-server/test/server.test.js`
**导出/变更接口：** `plugins/superharness/workflow-state-server/server.js::createTools`, `plugins/superharness/workflow-state-server/server.js::createRuntime`
**消费接口：** `plugins/superharness/workflow-state-server/workspace.js::resolveTrustedWorkspaceRoot`
**复杂度：** deep

**文件：**
- 修改：`plugins/superharness/workflow-state-server/server.js`
- 修改：`plugins/superharness/workflow-state-server/test/server.test.js`

- [ ] **步骤 1：导入 resolver**

在 `server.js` 中加入：

```js
import { resolveTrustedWorkspaceRoot } from './workspace.js';
```

- [ ] **步骤 2：让 runtime 持有 trusted workspace**

修改 `createRuntime`：

```js
export function createRuntime({
  workspaceRoot = resolveTrustedWorkspaceRoot(process.env),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
} = {}) {
  const config = loadWorkflowConfig({ pluginRoot, workspaceRoot });
  const workflowGraph = buildWorkflowGraph(config, { installedSkills: loadInstalledSkills(pluginRoot) });
  const store = openWorkflowStateStore({
    mode: process.env.SUPERHARNESS_WORKFLOW_STATE_MODE,
    dbPath: process.env.SUPERHARNESS_WORKFLOW_STATE_DB ?? resolveWorkflowDbPath({ workspaceRoot }),
  });
  return { store, workflowGraph, skillsDir: path.join(pluginRoot, 'skills'), workspaceRoot };
}
```

如果 `createRuntime` 当前未导出，导出它以便测试。

- [ ] **步骤 3：移除 public schema 的 `workspaceRoot`**

对 5 个 tools 修改 schema：

- `get_state`：`required: []`，`properties: {}`
- `classify_request`：`required: ['reason']`
- `transition_state`：`required: ['from_state', 'to_state', 'reason']`
- `list_history`：`required: []`，`properties: {}`
- `release_stop_block`：`required: ['reason']`

所有 handler 使用：

```js
const { workspaceRoot } = runtime;
```

不要读取 `args.workspaceRoot`。

- [ ] **步骤 4：更新 release stop block helper**

`handleReleaseStopBlock` 可以保持内部签名，但调用方必须传：

```js
handleReleaseStopBlock({ store: runtime.store, workspaceRoot: runtime.workspaceRoot, args })
```

或者改成：

```js
export async function handleReleaseStopBlock({ store, workspaceRoot, reason })
```

测试同步使用新签名；不要把 workspace 暴露回 tool schema。

- [ ] **步骤 5：运行 MCP 测试**

运行：

```bash
cd plugins/superharness/workflow-state-server && npm test -- server.test.js
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add plugins/superharness/workflow-state-server/server.js plugins/superharness/workflow-state-server/test/server.test.js
git commit -m "fix(mcp): bind workflow tools to trusted workspace"
```

## 任务 4：更新 plugin config、commands 和文档

**依赖：** 任务 3
**文件集：** `plugins/superharness/.mcp.json`, `plugins/superharness/commands/rollback.md`, `plugins/superharness/commands-codex/rollback.md`, `README.md`, `plugins/superharness/README.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/.mcp.json`
- 修改：`plugins/superharness/commands/rollback.md`
- 修改：`plugins/superharness/commands-codex/rollback.md`
- 修改：`README.md`
- 修改：`plugins/superharness/README.md`

- [ ] **步骤 1：显式传递 `CLAUDE_PROJECT_DIR`**

更新 `plugins/superharness/.mcp.json`：

```json
{
  "mcpServers": {
    "superharness-workflow-state": {
      "command": "node",
      "args": ["workflow-state-server/bootstrap.js"],
      "cwd": ".",
      "env": {
        "CLAUDE_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}"
      }
    }
  }
}
```

- [ ] **步骤 2：更新 rollback command 文档**

把 `plugins/superharness/commands/rollback.md` 中要求 agent 给 `list_history` 传工作目录参数的旧说明改为：

```text
调用 `list_history()` 获取当前 Claude 项目的历史。
```

Codex command 中不要承诺 Claude Code 的 `CLAUDE_PROJECT_DIR` 语义；如果 Codex 暂无等价可信源，标注：

```text
Codex workspace source-of-truth 另行设计；不要手动传 workspaceRoot 给 Superharness MCP tool。
```

- [ ] **步骤 3：更新 README**

在根 README 和插件 README 中更新 MCP tool 使用说明：

- `transition_state` 不再需要 `workspaceRoot`
- 状态目录仍位于当前 Claude 项目的 `.superharness/`
- Claude Code 依赖 `CLAUDE_PROJECT_DIR` 作为项目根
- 如果 hook 报缺失 `CLAUDE_PROJECT_DIR`，应从项目目录启动 Claude Code 或检查插件 MCP env

- [ ] **步骤 4：搜索残留**

运行：

```bash
rg -n "workspaceRoot|workspaceRoot=|workspaceRoot <|<当前工作目录>|\\$PWD" README.md plugins/superharness/README.md plugins/superharness/commands plugins/superharness/commands-codex plugins/superharness/skills
```

预期：不再有 agent-facing MCP tool 参数说明。允许源码 API、测试、设计文档中出现 `workspaceRoot`。

- [ ] **步骤 5：运行文档相关验证**

运行：

```bash
node -e "JSON.parse(require('fs').readFileSync('plugins/superharness/.mcp.json','utf8')); console.log('mcp json ok')"
npm run test:installer
```

预期：JSON 解析成功，installer 测试 PASS。

- [ ] **步骤 6：Commit**

```bash
git add plugins/superharness/.mcp.json plugins/superharness/commands/rollback.md plugins/superharness/commands-codex/rollback.md README.md plugins/superharness/README.md
git commit -m "docs(workflow): remove agent workspace arguments"
```

## 任务 5：最终集成验证和发布准备

**依赖：** 任务 4
**文件集：** `plugins/superharness/workflow-state-server/workspace.js`, `plugins/superharness/hooks/workflow-context.mjs`, `plugins/superharness/hooks/workflow-stop.mjs`, `plugins/superharness/hooks/workflow-post-transition.mjs`, `plugins/superharness/workflow-state-server/server.js`, `plugins/superharness/.mcp.json`, `plugins/superharness/workflow-state-server/test/workspace.test.js`, `plugins/superharness/workflow-state-server/test/hook-cli.test.js`, `plugins/superharness/workflow-state-server/test/server.test.js`, `plugins/superharness/commands/rollback.md`, `plugins/superharness/commands-codex/rollback.md`, `README.md`, `plugins/superharness/README.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** standard

**文件：**
- 检查：全部实现文件

- [ ] **步骤 1：运行核心测试**

运行：

```bash
cd plugins/superharness/workflow-state-server && npm test
```

预期：全部 PASS。

- [ ] **步骤 2：运行 installer 测试**

运行：

```bash
npm run test:installer
```

预期：全部 PASS。

- [ ] **步骤 3：运行 hook scenario smoke**

运行：

```bash
bash tests/hooks/scenario-A.test.sh
bash tests/hooks/scenario-B.test.sh
bash tests/hooks/scenario-G.test.sh
```

如果本机缺少 bash 或场景脚本依赖，记录失败环境原因；不要声称场景测试通过。

- [ ] **步骤 4：运行 package 预检**

运行：

```bash
npm pack --dry-run --cache ./.tmp-npm-cache
```

预期：tarball 包含 `plugins/superharness/workflow-state-server/workspace.js` 和更新后的 `.mcp.json`。

完成后删除 `.tmp-npm-cache`。

- [ ] **步骤 5：最终残留检查**

运行：

```bash
rg -n "workspaceRoot" plugins/superharness/commands plugins/superharness/commands-codex README.md plugins/superharness/README.md
git status --short
```

预期：

- agent-facing docs 不再要求 `workspaceRoot`
- 只剩本计划允许的实现变更；不要修改 `.mindfs/`、`AGENTS.md`、`docs/human/`

- [ ] **步骤 6：Commit**

如果任务 1-4 已逐步 commit 且无剩余变更，则跳过。若有收口修正：

```bash
git add plugins/superharness/workflow-state-server/workspace.js plugins/superharness/hooks/workflow-context.mjs plugins/superharness/hooks/workflow-stop.mjs plugins/superharness/hooks/workflow-post-transition.mjs plugins/superharness/workflow-state-server/server.js plugins/superharness/.mcp.json plugins/superharness/workflow-state-server/test/workspace.test.js plugins/superharness/workflow-state-server/test/hook-cli.test.js plugins/superharness/workflow-state-server/test/server.test.js plugins/superharness/commands/rollback.md plugins/superharness/commands-codex/rollback.md README.md plugins/superharness/README.md
git commit -m "fix(workflow): finalize claude project workspace source"
```

## 并行执行图

> 仅 `parallel-executing-plans` 使用；`serial-executing-plans` 忽略本节。

**Critical Path:** 任务 1 → 任务 2 → 任务 3 → 任务 4 → 任务 5

- Wave 1（无依赖）：任务 1
- Wave 2（依赖 Wave 1）：任务 2（依赖 1）
- Wave 3（依赖 Wave 2）：任务 3（依赖 2）
- Wave 4（依赖 Wave 3）：任务 4（依赖 3）
- Wave 5（依赖 Wave 4）：任务 5（依赖 4）
- Wave FINAL（所有任务完成后）：F1 规格合规、F2 代码质量、F3 真实手测、F4 范围保真

## 执行交接

计划已完成并保存到 `docs/superharness/plans/2026-06-09-workspace-source-of-truth.md`。两种执行方式：

1. 子代理驱动：本计划依赖链较直，只有测试编写与文档审查可局部并行，收益有限。
2. 串行执行：推荐方式。使用 serial-executing-plans 按任务编号执行，能保持 API、hook、文档变更一致。
