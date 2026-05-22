# 移除 reset_state MCP tool 暴露 — Design

> 2026-05-22 | 候选版本：v1.4.1 | 状态：design (brainstorming → planning)

## 1. 背景与问题陈述

### 1.1 触发问题

`reset_state` 是 v1.x 起暴露给 agent 的 mutating MCP tool，能把 workflow_state 清回 `intake`。它**不该暴露给 agent**：

- 给 agent 一个"出错就清零"的 shortcut，违反 v1.4.0 spec 的"用户控制权"原则
- agent 没有合法的"重置整个 workflow"用例——错路应该用 `transition_state` 沿 YAML next 推进，或由用户 `/rollback`
- v1.4.0 新增的 `/rollback intake` 已可完整替代（语义上更优：用户主导 + workflow_turn 同步清零）

### 1.2 设计目标

- ✅ 从 MCP tool registry 移除 `reset_state`（agent 永远看不到它）
- ✅ 底层 `resetWorkflowState` 函数一并删除（**无内部调用方**，YAGNI）
- ✅ `VALID_SOURCES` 里的 `'user-reset'` source **保留**（rollback.mjs / set-free-mode.mjs / legacy migration 还在写）
- ✅ vitest 全 PASS；7 个 scenario E2E 不受影响
- ✅ v1.4.1 patch 版本（直推 origin/main，沿用 hotfix 模式）

### 1.3 非目标 / YAGNI

- ❌ 不动 legacy migration（独立写 `source='user-reset'` 不调函数）
- ❌ 不删 `VALID_SOURCES` 的 `'user-reset'`
- ❌ 不改历史 spec/plan 文档（v1.4.0 时代提到 reset_state 的部分作为历史快照保留）
- ❌ 不保留 `resetWorkflowState` 函数（"删 MCP 但保留函数"无意义——没人调，又增加心智负担）

## 2. 方案对比

| 方案 | 描述 | 状态 |
|---|---|---|
| **D** | 删 MCP tool 注册 + 删底层函数 + 改 3 个测试 + 改文档 + 版本 bump | ✓ 采纳 |
| U | 只 unexpose MCP tool，保留底层函数 | ✗ server.js 仍 import 它但无人调，浪费且让人困惑 |
| K | 完全保留（不动） | ✗ agent 仍有 game-the-system shortcut |

## 3. 改动总览

### 3.1 删除点

| 文件 | 删除内容 |
|---|---|
| `plugins/superharness/workflow-state-server/server.js` | L17 import + L223-242 tool entry |
| `plugins/superharness/workflow-state-server/state.js` | L425-449 `resetWorkflowState` 函数 + export |
| `plugins/superharness/workflow-state-server/test/state.test.js` | L10 import + L285-293 reset 测试 |
| `plugins/superharness/workflow-state-server/test/free-mode-mutating-guard.test.js` | L4 import + L42-46 reset free-mode 测试 |
| `plugins/superharness/workflow-state-server/test/server.test.js` | L65 `reset_state` 在 TOOLS 列表的断言 |

### 3.2 文档更新

| 文件 | 改动 |
|---|---|
| `CLAUDE.md` | L56 / L75 提及 `reset_state` 的句子改写，不再列举它 |
| `README.md` | L39 v1.4.0 章节"4 个 mutating tool 全锁"→"3 个" |
| `plugins/superharness/README.md` | 英文版同步 |

### 3.3 版本号 4 件套

`package.json` / `.claude-plugin/marketplace.json` / `plugins/superharness/.claude-plugin/plugin.json` / `plugins/superharness/.codex-plugin/plugin.json`：1.4.0 → 1.4.1

## 4. 语义对照（reset 的替代）

| | 旧 `reset_state` MCP tool | 新 `/rollback intake` slash |
|---|---|---|
| 触发方 | agent | 用户 |
| audit prefix | 无 | `[rollback]` |
| source | `user-reset` | `user-reset` |
| workflow_turn | 不动 | DELETE |
| 受 YAML next 约束 | 不受 | 不受 |
| 受 free-mode 锁 | 是 | 否（脚本绕 MCP 层）|

workflow_turn 被 DELETE 是 rollback 的"清零本轮 escape 计数"语义，比 reset 更彻底，符合"用户接管"的设计意图。

## 5. 测试

- vitest：96 → 93（减 3：state.reset / free-mode-guard.reset / server.tools-list reset 断言）
- 7 scenario A-G：不变（无人引用 reset_state）

## 6. 验证

```bash
# 1. 单元测试
cd plugins/superharness/workflow-state-server && npx vitest run     # 93/93 PASS

# 2. 全 scenario
for s in A B C D E F G; do bash tests/hooks/scenario-$s.test.sh 2>&1 | tail -1; done    # 7/7 PASS

# 3. 残留扫描（应只剩 docs/superharness/specs|plans/2026-05-22-* 历史文档）
grep -rn "reset_state\|resetWorkflowState" plugins/ CLAUDE.md README.md
```

## 7. 风险与边界

- **`server.test.js` TOOLS 数量断言**：如果是 `.length === 6`，要降到 5；若按名字检索 reset_state，删该名字
- **`/rollback intake` 是否依然 work**：rollback.mjs 用直 SQL，与 reset_state 删除无关；scenario F 已覆盖 rollback 路径
- **breaking API change**：移除 MCP tool 严格说是 breaking 改动；但本项目唯一消费者是维护者自己，patch 版本 acceptable
- **legacy migration 仍写 `source='user-reset'`**：state.js `migrateLegacyState` 第 L229 行 inline 写 log，**不调** `resetWorkflowState`，删除函数无影响
