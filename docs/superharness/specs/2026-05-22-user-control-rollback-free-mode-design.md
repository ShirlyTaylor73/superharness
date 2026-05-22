# 用户控制权增强：rollback + free-mode — Design

> 2026-05-22 | 候选版本：v1.4.0 | 状态：design (brainstorming → planning)

## 1. 背景与问题陈述

### 1.1 触发问题

v1.3.x 把工作流约束做得很硬：状态机严格按 YAML `next` 校验、hook 强制注入 SKILL.md、Stop hook 拦截。但没有**用户对 agent 失控时的接管通道**：

- **场景 A — 流程出错回退**：agent 在 brainstorming 出了岔切到了 planning，但用户发现 brainstorming 还没问清楚，**没有任何机制能回到 brainstorming**。`reset_state` 会清零到 intake（粒度太粗）；YAML `next` 不允许 planning → brainstorming（设计上就是单向）。
- **场景 B — 跳出状态机**：某些任务不适合 superharness 流程（如临时跑个一次性脚本、查个无关问题、debug 一个 hook 本身），但 hook 仍在每轮注入 SUPERHARNESS_WORKFLOW_STATE，污染上下文且强迫 agent 走 intake → trivial 等已知路径。**没有"暂停工作流"开关**。

### 1.2 设计目标

- ✅ 提供 `/rollback` slash command，让用户回退到 transition_log 中**走过的任意 state**
- ✅ 提供 `/free` slash command，让用户**会话级**暂停 workflow context 注入
- ✅ 严格保持"用户控制权"语义：**agent 不能调用 rollback / free 能力**（避免 game the system）
- ✅ free-mode 期间 MCP 层全锁 mutating tool（防 agent 偷偷推进 state）
- ✅ `.superharness/` 写保护始终生效（即使 free-mode 也禁止 agent 直接改 DB）
- ✅ audit log 完整保留（rollback / free-on / free-off 都进 transition_log）

### 1.3 非目标 / YAGNI

- ❌ **不新增任何 agent-callable MCP tool**（rollback / set-free-mode 都是用户脚本）
- ❌ **不支持 Codex 平台**（Codex slash command 是硬编码 enum，plugin 不能贡献；Codex 用户 v1.4.0 看不到这两个 command）
- ❌ **不支持 `/rollback <state>` 回到"从未走过"的 state**（语义错位，rollback ≠ set_state）
- ❌ **不支持 persistent free-mode**（不写文件持久化；会话结束自动失效）
- ❌ **不支持 `/free` 部分关 hook**（一刀切关 UPS + Stop + PostToolUse，保 PreToolUse）
- ❌ **不在 free-mode 期间允许 transition_state / classify_request**（全锁，必须 `/free off` 才能恢复）

## 2. 方案对比

| 方案 | 描述 | 状态 |
|---|---|---|
| **S** | Slash command + `!node` 脚本，不加 MCP tool | ✓ 采纳 |
| M | 新增 `rollback_state` / `set_free_mode` MCP tool，slash command 让 agent 调 | ✗ agent 被暴露 mutating 能力，复现 [feedback-no-game-the-system] 风险 |
| H | UserPromptSubmit hook 检测用户输入的魔法字符串（如 `[ROLLBACK]`） | ✗ 字符串易泄露到 LLM 上下文，UX 差，且不适配 Claude Code 现成的 slash 通道 |

S 方案的核心洞察：Claude Code 的 slash command 支持 `!command` 语法在 prompt 渲染期（agent 看到之前）执行 shell。意味着"用户输入 → 脚本写 DB → 反馈 stdout"这条通路**完全绕过 agent tool 层**，是真正的用户主导操作。

## 3. 架构总览

### 3.1 数据流

```
用户输入 /rollback brainstorming
   │
   ▼
commands/rollback.md 渲染期执行
   ├─ !node scripts/rollback.mjs $CLAUDE_PROJECT_DIR brainstorming "..."
   │     │
   │     └─ 直接 open DB，写 workflow_state + workflow_transition_log
   │
   └─ stdout 嵌入 prompt（"已从 X 回到 brainstorming"）
        │
        ▼
   agent 看到反馈（不调任何 tool）
        │
        ▼
   下一轮 UserPromptSubmit hook 注入新 state（brainstorming）的 SKILL.md
```

### 3.2 组件分工

| 组件 | 职责 | 是否新增 |
|---|---|---|
| `scripts/rollback.mjs` | 用户脚本，直写 DB 完成 rollback | ✓ 新增 |
| `scripts/set-free-mode.mjs` | 用户脚本，翻转 `workflow_state.free_mode` | ✓ 新增 |
| `commands/rollback.md` | slash command，无参用 AskUserQuestion 选择 + `!node`；有参直接 `!node` | ✓ 新增 |
| `commands/free.md` | slash command，`on`/`off`/`status` 调脚本 | ✓ 新增 |
| `workflow-state-server/state.js` | mutating tool 入口加 free-mode read check | ✏ 改 |
| `workflow-state-server/render-context.js` | free-mode 不渲染 | ✏ 改 |
| `hooks/workflow-context.mjs` | free-mode 不注入 | ✏ 改 |
| `hooks/workflow-stop.mjs` | free-mode silent exit 0 | ✏ 改 |
| `hooks/workflow-post-transition.mjs` | free-mode silent exit 0 | ✏ 改 |
| `hooks/workflow-pre-tool-use.mjs` | **不变**，`.superharness/` 写保护始终生效 | — |

### 3.3 关键不变量

1. **agent 永远看不到 mutating 能力**：rollback / set-free-mode 仅作为 stand-alone node 脚本暴露，不进 MCP tool registry
2. **`.superharness/` 写保护始终生效**：PreToolUse 拦截 agent 的 Bash/Write tool 调用对 `.superharness/` 的写入。slash command 的 `!node` 在渲染期执行，**不走 agent tool 层**，所以脚本能写——这正是 PreToolUse 的设计意图（拦 agent，不拦用户）
3. **free-mode 期间 MCP 层全锁 mutating**：MCP 仍服务，但每个 mutating tool（classify_request / transition_state / release_stop_block）入口检查 `free_mode=1` 就返回错误"workspace is in free mode; /free off first"
4. **唯一退出 free-mode 路径**：`/free off` 直写 DB；MCP 层不能改 free_mode（保证 agent 无法关 free-mode）

## 4. 数据模型

### 4.1 schema 变更（`workflow-state-server/schema.sql`）

`workflow_state` 表新增两列：

```sql
ALTER TABLE workflow_state ADD COLUMN free_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_state ADD COLUMN free_started_at INTEGER DEFAULT NULL;
```

- `free_mode = 0`：正常工作流（默认值，保 v1.3.x 行为）
- `free_mode = 1`：用户启用 free-mode
- `free_started_at`：进入 free-mode 的 epoch ms（仅 audit / 可选诊断显示）

### 4.2 transition_log 复用

不动 schema。rollback / free 操作通过 `reason` 字段加前缀打 audit 标签：

| 操作 | reason 格式示例 | source |
|---|---|---|
| /rollback | `[rollback] 用户 /rollback brainstorming` | `user-reset` |
| /free on | `[free-on] 用户输入 /free on` | `user-reset` |
| /free off | `[free-off] 用户输入 /free off` | `user-reset` |

复用现有 `user-reset` source 避免改 VALID_SOURCES + render-context + tests。前缀方案对齐 v1.3.0 的 `[escape]` 模式 [feedback-hotfix-workflow]。

### 4.3 rollback 时 turn 状态清零

`workflow_turn` 表对应行被清零：

```sql
UPDATE workflow_turn
   SET turn_id = NULL,
       block_count = 0,
       stop_block_released = 0,
       release_reason = NULL
 WHERE workspace_id = ?;
```

理由：rollback = "重新开始那个 state"，之前 turn 的 `stop_block_released = 1` 不应该污染新 state 的 Stop hook 判断。

## 5. /rollback 命令

### 5.1 命令形式

```
/rollback                    # 无参，弹列表让用户选
/rollback <state>            # 直接回到指定 state（要求 state 在 transition_log 中）
```

### 5.2 commands/rollback.md 内容

```markdown
---
description: 回退 workflow state 到 transition_log 中走过的某个 state
allowed-tools: mcp__plugin_superharness_superharness-workflow-state__list_history, AskUserQuestion, Bash
---

# /rollback $ARGS

用户输入了 `/rollback $ARGS`。请按以下步骤执行：

**步骤 1 — 拿历史**：调 `list_history(workspaceRoot=$CLAUDE_PROJECT_DIR)`。

**步骤 2 — 解析参数**：

- 如果 `$ARGS` 非空：把 `$ARGS` 当作目标 state 名。检查它是否**曾作为 to_state 在 transition_log 中出现过**（即"agent 曾经到达过该 state"）：
  - 出现过 → 跳到步骤 4
  - 没出现过 → 报错并列出"曾经走过的 state"让用户重选

- 如果 `$ARGS` 为空：
  - 从 transition_log 的 **to_state 列**按时间倒序提取并去重，取**最近 5 个独特 state**
  - 用 AskUserQuestion 让用户从这 5 个里选一个 → 用户选中后作为目标 state

**步骤 3 — 跳到步骤 4**

**步骤 4 — 执行 rollback**：

```bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/rollback.mjs" "$CLAUDE_PROJECT_DIR" "<chosen_state>" "[rollback] 用户 /rollback $ARGS"
```

**步骤 5 — 反馈**：根据脚本 stdout 报告"已从 X 回到 Y"。

**不要**做其他事：不要继续之前 state 的任务，不要主动调 transition_state。下一轮 UserPromptSubmit hook 会注入新 state 的 SKILL.md，那时再按新 state 工作。
```

### 5.3 scripts/rollback.mjs 行为

调用形式：

```bash
node rollback.mjs <workspaceRoot> <to_state> <reason>
```

执行逻辑：

1. 打开 `<workspaceRoot>/.superharness/workflow-state.db`（better-sqlite3）
2. 验证 `to_state` 在 transition_log 中出现过；否则 stderr 报错 + exit 1
3. UPDATE `workflow_state` SET state=to_state, previous_state=NULL, active_skill=<skill of to_state>, status='active'
4. INSERT transition_log（from_state=当前, to_state=to_state, reason=<reason>, source='user-reset'）
5. UPDATE workflow_turn 清零 turn_id / block_count / stop_block_released / release_reason
6. stdout 输出 `已从 <from> 回到 <to>`，exit 0

**不验证 YAML next 约束**——rollback 本质就是绕过约束。

## 6. /free 命令

### 6.1 命令形式

```
/free on          # 进入 free-mode
/free off         # 退出 free-mode
/free             # 等价 /free status
/free status      # 显示当前状态
```

### 6.2 commands/free.md 内容

```markdown
---
description: 进入或退出 free-mode，暂停 superharness workflow context 注入
allowed-tools: Bash
---

# /free $ARGS

用户输入了 `/free $ARGS`。请按以下逻辑执行：

- `$ARGS` 为 `on`：执行 `!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" on`
- `$ARGS` 为 `off`：执行 `!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" off`
- `$ARGS` 为 `status` 或空：执行 `!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" status`

读脚本 stdout 反馈结果。**不要**做其他事。
```

### 6.3 scripts/set-free-mode.mjs 行为

调用形式：

```bash
node set-free-mode.mjs <workspaceRoot> <on|off|status>
```

执行逻辑：

- `on`：UPDATE workflow_state SET free_mode=1, free_started_at=now()；INSERT transition_log（from=to=当前 state, reason='[free-on] 用户输入 /free on', source='user-reset'）；stdout "已进入 free mode"
- `off`：UPDATE workflow_state SET free_mode=0, free_started_at=NULL；INSERT 同上前缀 `[free-off]`；stdout "已退出 free mode，恢复工作流"
- `status`：SELECT free_mode, free_started_at；stdout 报告状态

### 6.4 free-mode 期间的行为矩阵

| 组件 | free_mode=1 时的行为 |
|---|---|
| `workflow-context.mjs`（UPS） | 不渲染 `<SUPERHARNESS_WORKFLOW_STATE>` 块；输出 `{}` |
| `workflow-pre-tool-use.mjs`（PreToolUse） | **不变**——`.superharness/` 写保护继续拦截 agent |
| `workflow-stop.mjs`（Stop） | 入口检查 free_mode，=1 直接 `{}` exit 0（不拦 stop） |
| `workflow-post-transition.mjs`（PostToolUse） | 同上，silent exit 0 |
| MCP `get_state` | 仍可调用（read-only），返回中带 `free_mode: true` |
| MCP `list_history` | 仍可调用 |
| MCP `classify_request` | 报错 `workspace is in free mode; /free off first` |
| MCP `transition_state` | 报错（同上） |
| MCP `release_stop_block` | 报错（同上） |
| MCP `reset_state` | 报错（同上）—— reset 也是 mutating |

## 7. MCP 层实现细节（`state.js`）

### 7.1 free-mode read helper

```javascript
function readFreeMode(store, workspaceRoot) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  const row = store.prepare(
    'SELECT free_mode FROM workflow_state WHERE workspace_id = ?'
  ).get(workspaceId);
  return row?.free_mode === 1;
}

function assertNotFreeMode(store, workspaceRoot) {
  if (readFreeMode(store, workspaceRoot)) {
    throw new Error('workspace is in free mode; /free off first');
  }
}
```

### 7.2 各 mutating 函数入口

在 `classifyRequest()` / `transitionWorkflowState()` / `handleReleaseStopBlock()` 入口（args 解构之后、业务逻辑之前）调用 `assertNotFreeMode(store, workspaceRoot)`。

`initializeWorkflowState()` 不查 free_mode——init 是 hook 在 free_mode 列尚未存在的初始化阶段调用，需要无条件成功。

## 8. 错误处理

### 8.1 /rollback

- `to_state` 不在 transition_log：脚本 stderr "state '<x>' 未在历史中出现过；可用：[列表]"；exit 1
- 当前在 free-mode：脚本本身**不查 free_mode**（rollback 是用户授权的直写脚本，free-mode 只锁 agent 通道）。但用户的实际意图通常是先 `/free off` 再 `/rollback`——文档提示
- DB 文件不存在：stderr "workspace 未初始化，无 state 可回退"；exit 1

### 8.2 /free

- `/free on` 时已在 free-mode：stdout "已在 free mode（自 <free_started_at>）"；exit 0
- `/free off` 时不在 free-mode：stdout "未在 free mode，无需操作"；exit 0

## 9. 测试

### 9.1 单元测试（`workflow-state-server/test/`）

- `free-mode.test.js`：
  - mutating tool 在 free_mode=1 时全部报错
  - `get_state` / `list_history` 在 free_mode=1 时正常工作
  - schema 迁移（旧 DB 无 free_mode 列时自动 ALTER TABLE）

- `rollback-script.test.js`：
  - 直接调脚本进程，验证 DB 写入正确
  - 验证 to_state 不在 log 时报错
  - 验证 turn 字段被清零
  - 验证 transition_log 写了 `[rollback]` 前缀

### 9.2 E2E（`tests/hooks/`）

- `scenario-F.test.sh`（rollback）：
  - 模拟 intake → trivial → intake → brainstorming 序列
  - 执行 `node scripts/rollback.mjs <ws> trivial "[rollback] test"`
  - 验证 workflow_state 回到 trivial、log 多一条 `[rollback]` 记录、workflow_turn 清零

- `scenario-G.test.sh`（free-mode 全锁）：
  - 模拟进入 free-mode
  - 调用 MCP transition_state，断言返回 error
  - 用 set-free-mode.mjs off 退出
  - 再调 transition_state，断言成功

### 9.3 既有测试

- 现有 7 test files / 77 tests 必须全部 PASS（无回归）
- 5 个既有 scenario A-E 必须全部 PASS

## 10. 文件改动清单

| 类型 | 文件 |
|---|---|
| 新增 | `plugins/superharness/scripts/rollback.mjs` |
| 新增 | `plugins/superharness/scripts/set-free-mode.mjs` |
| 新增 | `plugins/superharness/commands/rollback.md` |
| 新增 | `plugins/superharness/commands/free.md` |
| 改 | `plugins/superharness/workflow-state-server/schema.sql`（加 2 列） |
| 改 | `plugins/superharness/workflow-state-server/state.js`（schema 迁移 + assertNotFreeMode + 各 mutating 入口） |
| 改 | `plugins/superharness/workflow-state-server/render-context.js`（free_mode=1 不渲染） |
| 改 | `plugins/superharness/hooks/workflow-context.mjs`（free_mode=1 不注入） |
| 改 | `plugins/superharness/hooks/workflow-stop.mjs`（free_mode=1 silent exit） |
| 改 | `plugins/superharness/hooks/workflow-post-transition.mjs`（同上） |
| 新增 | `plugins/superharness/workflow-state-server/test/free-mode.test.js` |
| 新增 | `plugins/superharness/workflow-state-server/test/rollback-script.test.js` |
| 新增 | `tests/hooks/scenario-F.test.sh` |
| 新增 | `tests/hooks/scenario-G.test.sh` |
| 改 | `README.md` / `plugins/superharness/README.md`（说明两个 slash command + Codex 暂不支持） |
| 改 | 版本号 4 件套：`package.json` / `.claude-plugin/marketplace.json` / `plugins/superharness/.claude-plugin/plugin.json` / `plugins/superharness/.codex-plugin/plugin.json` 1.3.2 → 1.4.0 |

## 11. 版本与发布

- v1.4.0 minor 版本，走 feature branch + PR 流程（参考 v1.3.0 `feat/turn-completion-hooks-v1.3.0` 模式）
- 不沿用 hotfix patch 直推（[feedback-hotfix-workflow] 规定 minor 走 PR）
- README 显式标注："Codex 平台 v1.4.0 暂不支持 `/rollback` 和 `/free`；这是 Codex slash command 系统的当前限制，待 Codex 出 plugin-prompts 能力后补"

## 12. 风险与边界

- **`.superharness/` 写保护与脚本冲突**：PreToolUse 只拦 agent tool；`!node` 在渲染期执行不属于 agent tool 层，没有冲突
- **并发 DB 访问**：MCP server + 脚本可能同时打开 DB；SQLite WAL 模式正常支持
- **schema 迁移失败**：旧用户升级到 v1.4.0 时，state.js 在 `openWorkflowStateStore` 中 IDEMPOTENT 执行 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（SQLite 3.35+），或用类似 `ensureTurnIdColumn` 的探测+加列模式
- **rollback 到 systematic_debugging**：systematic_debugging 是 preemptive 分支，rollback 到它需要把 `previous_state` 字段写对——v1 直接拒绝 rollback 目标 = systematic_debugging（设计上 rollback 只回主流程态）
- **/free 期间用户也想 rollback**：脚本不查 free_mode，所以用户可以同时 `/rollback` + `/free on` 期间执行 rollback 脚本生效。但 agent 看不到状态变化（hook 不注入），下一次 `/free off` 后才看到新 state
