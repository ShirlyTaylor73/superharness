# 移除 reset_state MCP tool 暴露 — v1.4.1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：平台支持子代理且计划较大/可安全分 wave 时使用 superharness:parallel-execution；计划较小、任务强耦合或平台不支持子代理时使用 superharness:serial-execution。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 从 MCP tool registry 移除 `reset_state` 并删除底层 `resetWorkflowState` 函数；更新相关测试、文档、版本号；v1.4.1 patch 直推 origin/main。

**架构：** 单任务串行——删除 1 个 MCP tool entry + 1 个底层函数 + 3 处测试 + 3 处文档提及 + 4 件套版本号 bump。

**技术栈：** Node ESM、Vitest、Markdown / JSON 文本编辑。

**规格依据：** [docs/superharness/specs/2026-05-22-remove-reset-state-mcp-tool-design.md](../specs/2026-05-22-remove-reset-state-mcp-tool-design.md)

**版本：** 1.4.0 → 1.4.1（patch，[[feedback-hotfix-workflow]] 直推 origin/main 不开 PR）

---

## 文件结构

### 修改

| 路径 | 改动概要 |
|---|---|
| `plugins/superharness/workflow-state-server/server.js` | L17 import 行移除 `resetWorkflowState`；L223-242 删除 `reset_state` tool entry（注意前后逗号语法） |
| `plugins/superharness/workflow-state-server/state.js` | L425-449 删除 `resetWorkflowState` 函数 + export |
| `plugins/superharness/workflow-state-server/test/state.test.js` | L10 import 行移除 `resetWorkflowState`；L285-293 删除 `it('resets state and writes user-reset history', ...)` |
| `plugins/superharness/workflow-state-server/test/free-mode-mutating-guard.test.js` | L4 import 行移除 `resetWorkflowState`；L42-46 删除 `it('resetWorkflowState throws', ...)` |
| `plugins/superharness/workflow-state-server/test/server.test.js` | L60-67 TOOLS 列表断言中移除 `'reset_state'` 行（保留其它 5 项）|
| `CLAUDE.md` | L56 移除 `reset_state` 字面，列表改为 `get_state, classify_request, transition_state, list_history, release_stop_block`；L75 移除 `reset_state`，改为 `transition_state / classify_request` |
| `README.md` | L22 v1.4.0 章节括号里 mutating 工具列表，从 4 项降到 3 项（去 `reset_state`），改为 `transition_state / classify_request / release_stop_block` |
| `plugins/superharness/README.md` | 英文版同步：找对应"4 mutating tools locked"句子，改成 3 项不含 reset_state |
| `package.json` | `"version"`: `"1.4.0"` → `"1.4.1"` |
| `.claude-plugin/marketplace.json` | plugins 数组 entry 的 `"version"` 同步 |
| `plugins/superharness/.claude-plugin/plugin.json` | 顶层 `"version"` 同步 |
| `plugins/superharness/.codex-plugin/plugin.json` | 顶层 `"version"` 同步 |

---

## 任务

### 任务 1：删除 reset_state（代码 + 测试 + 文档 + 版本）

**依赖：** 无
**文件集：** `plugins/superharness/workflow-state-server/server.js`, `plugins/superharness/workflow-state-server/state.js`, `plugins/superharness/workflow-state-server/test/state.test.js`, `plugins/superharness/workflow-state-server/test/free-mode-mutating-guard.test.js`, `plugins/superharness/workflow-state-server/test/server.test.js`, `CLAUDE.md`, `README.md`, `plugins/superharness/README.md`, `package.json`, `.claude-plugin/marketplace.json`, `plugins/superharness/.claude-plugin/plugin.json`, `plugins/superharness/.codex-plugin/plugin.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** standard

- [ ] **步骤 1：修改 server.js — 删 import + tool entry**

打开 `plugins/superharness/workflow-state-server/server.js`：

L17 找 import 行（含 `resetWorkflowState`），从中移除该 symbol；保留其它 import 符号。

L223-242 删除整个 `reset_state` tool entry，包括前导逗号或后置逗号（视语法上下文调整，确保 tool 数组语法仍合法）：

```javascript
// 删除这块：
{
  name: 'reset_state',
  description: 'Reset workflow state back to the entry state.',
  inputSchema: { ... },
  handler: wrap((args) => {
    const runtime = getRuntime();
    return resetWorkflowState(runtime.store, { ... });
  }),
},
```

- [ ] **步骤 2：修改 state.js — 删 resetWorkflowState 函数**

打开 `plugins/superharness/workflow-state-server/state.js`：

L425-449 删除：

```javascript
export function resetWorkflowState(store, { workspaceRoot, workflowGraph, reason } = {}) {
  // ... 整个函数体
}
```

**不动** L10 的 `VALID_SOURCES` 里的 `'user-reset'`——rollback.mjs / set-free-mode.mjs / legacy migration 仍在使用此 source。

- [ ] **步骤 3：修改 3 个测试文件**

`test/state.test.js`：
- L10 import 行移除 `resetWorkflowState`
- L285-293 删除整个 `it(...)` 块（"resets state and writes user-reset history"）

`test/free-mode-mutating-guard.test.js`：
- L4 import 行移除 `resetWorkflowState`
- L42-46 删除 `it('resetWorkflowState throws', ...)` 块

`test/server.test.js`：
- L60-67 TOOLS 列表断言数组移除 `'reset_state'`，留下：
  ```javascript
  expect(TOOLS.map((tool) => tool.name)).toEqual([
    'get_state',
    'classify_request',
    'transition_state',
    'list_history',
    'release_stop_block',
  ]);
  ```

- [ ] **步骤 4：修改 CLAUDE.md**

L56 那一行 MCP 工具列表去掉 `reset_state`：

```markdown
1. **MCP server** ([server.js](...)) — exposes `get_state`, `classify_request`, `transition_state`, `list_history`, `release_stop_block` as MCP tools. ...
```

L75 那一句话改写：

```markdown
... All mutations must go through the MCP `transition_state` / `classify_request` tools, every one of which requires a non-empty `reason` string that lands in the transition log.
```

- [ ] **步骤 5：修改 README.md**

L22 那一行：

```markdown
- free-mode 期间 hook 不再注入 SKILL.md，MCP 的 mutating 工具（`transition_state` / `classify_request` / `release_stop_block`）全部锁定。
```

- [ ] **步骤 6：修改 plugin README**

打开 `plugins/superharness/README.md`，找 v1.4.0 章节里对应英文"4 mutating tools"那句，改为 3 项不含 reset_state（保持英文风格与既有文本一致）。

- [ ] **步骤 7：4 件套版本号 bump**

精确把 `"version": "1.4.0"` 改成 `"1.4.1"` 在这 4 个 JSON 文件：

```bash
# 验证 1.4.0 残留
grep -l '"version": "1.4.0"' package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json plugins/superharness/.codex-plugin/plugin.json
```

- [ ] **步骤 8：运行 vitest 全套**

```bash
cd plugins/superharness/workflow-state-server && npx vitest run
```

预期：12 test files / 93 tests PASS（96 - 3 = 93：state.reset + free-mode-guard.reset + server.TOOLS.reset-assertion）。

- [ ] **步骤 9：跑全 7 个 scenario**

```bash
cd ../../..
for s in A B C D E F G; do bash tests/hooks/scenario-$s.test.sh 2>&1 | tail -1; done
```

预期：7/7 PASS。

- [ ] **步骤 10：残留扫描**

```bash
grep -rn "reset_state\|resetWorkflowState" plugins/ CLAUDE.md README.md 2>&1
```

预期：只剩 `plugins/superharness/scripts/` 和 `docs/superharness/specs/2026-05-22-*` / `docs/superharness/plans/2026-05-22-*` 里历史快照（不修改）。**`plugins/superharness/workflow-state-server/` 和 README/CLAUDE.md 应无残留。**

注：rollback.mjs 和 set-free-mode.mjs 仍写 `source='user-reset'` 字符串，这是数据值不是 API 符号，**不计为残留**。

- [ ] **步骤 11：Commit + push（patch 直推）**

```bash
git add plugins/superharness/workflow-state-server/server.js \
        plugins/superharness/workflow-state-server/state.js \
        plugins/superharness/workflow-state-server/test/state.test.js \
        plugins/superharness/workflow-state-server/test/free-mode-mutating-guard.test.js \
        plugins/superharness/workflow-state-server/test/server.test.js \
        CLAUDE.md \
        README.md \
        plugins/superharness/README.md \
        package.json \
        .claude-plugin/marketplace.json \
        plugins/superharness/.claude-plugin/plugin.json \
        plugins/superharness/.codex-plugin/plugin.json

git commit -m "$(cat <<'EOF'
chore(release): remove reset_state MCP tool — v1.4.1

agent 不应有"清零 workflow"的 shortcut；用户 /rollback intake 已可替代。
- 删 server.js reset_state tool entry + state.js resetWorkflowState 函数
- 3 个测试同步更新（state.test / free-mode-guard / server.tools-list）
- CLAUDE.md / README × 2 文档同步
- 版本 1.4.0 → 1.4.1

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"

git -c http.sslBackend=openssl push origin main
```

预期：`f9bba15..<new-sha> main -> main` 或类似输出。

---

## 并行执行图

> 仅 `parallel-execution` 使用；`serial-execution` 忽略本节。

**Critical Path:** 任务 1

- Wave 1（无依赖）：任务 1
- Wave FINAL（所有任务完成后）：F1 规格合规、F2 代码质量、F3 真实手测、F4 范围保真

**注**：本计划只有 1 个任务，并行调度退化为单任务执行；serial-execution 直接跑步骤 1-11 即可。Wave FINAL 仍跑 F1-F4 reviewer 做最终把关。
