# Turn-Completion Hooks + Platform Cleanup — Design

> 2026-05-20 | 候选版本：v1.3.0 | 状态：design (brainstorming → planning)

## 1. 背景与问题陈述

### 1.1 触发问题

当前 superharness 模型里 agent 经常把 `transition_state` 切态推到下一轮，导致单次状态变更要走完三轮才真正开始下一态的工作：

- **第 1 轮**：agent 干完本态工作，认为完成，对用户输出"做完了，要进下一步吗？"
- **第 2 轮**：用户回复"继续"，agent 这才调 `transition_state` 切到下一态——但此时新态 SKILL.md 还没注入（注入由 `UserPromptSubmit` hook 在下一轮才触发）
- **第 3 轮**：UserPromptSubmit hook 终于把新态 SKILL.md 注入，agent 真正开始下一态工作

净结果：每次切态浪费 1 轮 SKILL 注入延迟 + 1 轮用户确认延迟，共浪费 2 轮。

### 1.2 设计目标

- ✅ 让 agent 在本轮完成的工作能立刻 chain 到下一态（消除"延迟注入"轮）
- ✅ 拦截 agent 在 strict state 中干一半就走的情况（防止状态错乱）
- ✅ 区分"需用户审查产出物"的 state（brainstorming / planning / verification）vs"自动衔接"的 state
- ✅ **不修改任何 SKILL.md 文件**（用户硬性约束 — 约束行为应该由 hook 注入，不能耦合到 skill 内容）
- ✅ 顺便撤掉 OpenCode/Cursor 集成（范围收缩，减少维护面）

### 1.3 非目标 / YAGNI

- ❌ 不实现 OpenCode/Cursor 的 PostToolUse/Stop（直接撤掉这两个平台支持）
- ❌ 不引入"按 state 可配置的逃生上限"（写死 3 次）
- ❌ 不在 Stop block reason 中告诉 agent 当前 `block_count`（避免 game the system）
- ❌ 不修改任何 SKILL.md 文件（不耦合行为约束到 skill 内容）
- ❌ 不引入 "Write/Edit/Bash 写痕迹" 普适前置规则（完全靠 `silent_stop_allowed` flag 决策）
- ❌ 不实现 OpenCode/Cursor 的"降级路径"（既然撤了就不维护）
- ❌ 不允许 agent 擅自 escape（必须先用 AskUserQuestion 拿到用户"终止本轮"明确选项才能调 `release_stop_block`，写在工具 description 强约束）

## 2. 方案对比

| 方案 | 描述 | 状态 |
|---|---|---|
| **P** | 三 hook 联动 + state-level 双 flag + turn_id + 3 次逃生 | ✓ 采纳 |
| R | Red Queen 式重构（agent 完全 out-of-process、orchestrator 决策切态） | ✗ 架构反演太大，违背 in-process 插件定位 |
| M | 仅 UserPromptSubmit 软提示 | ✗ 无强制力，不解决根本问题 |

R 方案参考 [references/red-queen/src/core/worker.ts:84](../../../references/red-queen/src/core/worker.ts#L84)（用 `claude -p ... --no-session-persistence` 一次性派遣 worker），但要求把 superharness 从 in-process 插件改造成 out-of-process 编排器——超出本次范围。

## 3. Part A — 三 hook 联动机制

### 3.1 架构总览

#### 三个 hook 的职责分工

| Hook | 触发时机 | 职责 |
|---|---|---|
| **UserPromptSubmit** | 用户消息进入时 | (1) 生成新 `turn_id` 并落 `workflow_turn` 表；(2) 注入 `<SUPERHARNESS_WORKFLOW_STATE>`（现有行为）；(3) 对 `silent_stop_allowed=false` 的 state，追加"本轮须 transition" 提示 |
| **PostToolUse** | `transition_state` 工具成功后 | 查"刚切走的那个 state"的 `inline_transition_to_next`（state 名从 `tool_input.from_state` 取）；若 true 则通过 `hookSpecificOutput.additionalContext` 把**目标 state 的 SKILL.md** 注入到 agent 后续 reasoning |
| **Stop** | agent 本轮 inference 结束 | 按 5 步算法决策（详见 3.3.4）：本轮已切态 / 用户授权 escape / silent_stop_allowed=true 任一 → 放行；否则 block_count++ 拦截 + 注入三选项 reason；block_count≥3 → 兜底逃生放行 |

#### 时序图（strict state 典型轮）

```
用户消息 ──→ UserPromptSubmit hook
              ├─ 生成新 turn_id（UUIDv4）写入 workflow_turn 表（覆盖旧值，block_count 清零）
              ├─ 注入 <SUPERHARNESS_WORKFLOW_STATE>（含当前态 SKILL.md）
              └─ silent_stop_allowed=false → 追加"本轮必须 transition_state"提示

agent 干活：调 Write/Edit/Bash/transition_state 等工具
              │
              ├─ 调 transition_state → ──→ PostToolUse hook
              │                                ├─ 取"刚切走的 state"（从 tool_input.from_state）
              │                                ├─ 该 state 的 inline_transition_to_next=true？
              │                                │   ├─ 是 → additionalContext 注入 to_state 的 SKILL.md
              │                                │   └─ 否 → 输出 {}（agent 本轮自然停下）
              │
              └─ 继续 reasoning（可能再 transition_state，链式 chain）

agent 输出完毕 ──→ Stop hook
                    ├─ SELECT turn_id, block_count, stop_block_released FROM workflow_turn
                    ├─ EXISTS (本 turn_id 内 source='agent-tool' 的 transition)？
                    │   ├─ 是 → 放行
                    │   └─ 否 → stop_block_released=1？（用户已授权 escape）
                    │           ├─ 是 → 放行
                    │           └─ 否 → silent_stop_allowed？
                    │                   ├─ true → 放行
                    │                   └─ false → block_count < 3？
                    │                               ├─ 是 → block_count++，返回 block + 三选项 reason
                    │                               └─ 否 → 兜底逃生放行（audit 日志 warning）
```

#### 关键不变量

1. **状态机正确性归 `transition_state` 工具管**——hook 只读写 `turn_id` 和 `block_count`，**绝不**直接改 state
2. **三 hook 全部 fail-open**：脚本异常时输出 `{}`，绝不阻塞 agent
3. **chain 注入是 best-effort**：PostToolUse 注入失败也不阻塞 transition_state 成功——切态已经发生，最坏退化到下一轮 UserPromptSubmit 时注入新 SKILL

### 3.2 数据模型

#### 3.2.1 YAML schema 改造（`plugins/superharness/workflow/default-workflow.yaml`）

每 state 节点加两个 bool 字段。`validate-workflow.js` 的 `buildWorkflowGraph()` 读取并挂在 state 节点对象上。

完整 flag 表：

| State | `inline_transition_to_next` | `silent_stop_allowed` | 理由 |
|---|---|---|---|
| `intake` | true | true | 决定走向不需要再确认；answer-only 模式合法 |
| `exploration` | true | true | 调研可跨多轮；切走时无产出物需审 |
| `trivial` | true | false | 改完切回 intake 立刻接下个任务；强制每轮闭环 |
| `brainstorming` | **false** | true | 多轮决策树盘问合法；spec 写完需用户审查再进 planning |
| `planning` | **false** | true | 多轮写 plan 合法；plan 写完需用户审查再进 execution |
| `serial_execution` | true | false | 干完切 verification 立刻验；中途不许停 |
| `parallel_execution` | true | false | 同 serial |
| `systematic_debugging` | true | true | 调试反复跨轮合法 |
| `verification` | **false** | false | gate 必须本轮明确 pass/fail；验完需用户审查再进 finishing |
| `finishing` | true | false | finishing 内部已有 commit 用户确认机制；结束后回 intake |

**两个 flag 都是 state 自身的属性**，描述 agent "在这个 state 时"的行为约束。区别只在被哪个 hook 读：

- `inline_transition_to_next`：**本 state 切到下一态时，是否允许在同一轮内继续干下一态的工作**（true=允许 chain；false=切完本轮停下让用户介入）。PostToolUse hook 读这个——查刚切走的那个 state 的此字段。
- `silent_stop_allowed`：**本 state 内 agent 本轮结束但未切态时，是否容忍**（true=放行；false=拦截）。Stop hook 读这个——查 agent 当前所在 state 的此字段。

**YAML 缺省值（向后兼容）**：缺省两个字段都视为 `false`（保守默认）。新增 vitest 测试要求 10 个内置 state 全部显式声明，缺省值只为外部 YAML 容错。

#### 3.2.2 SQLite schema 改造（`plugins/superharness/workflow-state-server/schema.sql`）

**schema.sql 改造（幂等部分）**：

```sql
-- 新表：每 workspace 仅一条当前轮记录
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

`stop_block_released` + `release_reason` 是**用户授权 escape 通道**——当 silent=false state 内 agent 真的无法继续时（环境错误、需求歧义、需要用户决策），agent 用 AskUserQuestion 让用户选择，用户选"终止本轮"后 agent 调 `release_stop_block` MCP 工具把这两个字段写入；Stop hook 下次检查到 `stop_block_released=1` 直接放行（详见 3.3.4 / 3.3.6）。

**升级路径（非幂等的 ALTER，state.js 初始化时条件执行）**：

```js
// state.js 伪代码
const columns = db.prepare("PRAGMA table_info(workflow_transition_log)").all();
const hasturnId = columns.some(c => c.name === 'turn_id');
if (!hasturnId) {
  db.exec("ALTER TABLE workflow_transition_log ADD COLUMN turn_id TEXT");
}
```

ALTER 在 schema.sql 里 hardcode 跑会让第二次启动时报 "duplicate column"——必须放到 state.js 的运行时升级逻辑里。

#### 3.2.3 hook + transition_state 工具的 DB 读写

| 触发点 | 操作 |
|---|---|
| **UserPromptSubmit** | `INSERT OR REPLACE INTO workflow_turn (workspace_id, turn_id, block_count, stop_block_released, release_reason, created_at) VALUES (?, NEW_UUIDv4, 0, 0, NULL, NOW)` — 覆盖前一轮所有字段 |
| **`transition_state` 工具内部** | 现有 INSERT INTO workflow_transition_log 加一列：`turn_id = (SELECT turn_id FROM workflow_turn WHERE workspace_id=?)` |
| **`release_stop_block` 工具内部** | `UPDATE workflow_turn SET stop_block_released=1, release_reason=? WHERE workspace_id=?` — 由 agent 在拿到用户"终止本轮"授权后调用 |
| **Stop hook** | 算法见 3.3.4 |

**关键不变量**：
- `workflow_turn` 每 workspace 仅 1 条（PK 强制覆盖式更新）
- 旧 `workflow_transition_log` 行 `turn_id=NULL`——不影响新查询（`WHERE turn_id=<新 UUID>` 永不命中 NULL）
- `source='agent-tool'` 是 Stop hook 关键过滤条件——只算 agent 主动切，排除 user-reset 和 hook 自己写的记录

### 3.3 三 hook 协议

#### 3.3.1 hooks.json（Claude Code）配置增量

```json
{
  "hooks": {
    "UserPromptSubmit": [现有不动],
    "PreToolUse": [现有不动],
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
  }
}
```

`hooks-codex.json` 结构相同，把 `${CLAUDE_PLUGIN_ROOT}` 换成 `${PLUGIN_ROOT}`（v1.2.4 修复延续）。matcher 字段在 Codex 上的精确语义可能略有差异——实施时通过实测核对。

#### 3.3.2 新增 hook 脚本

- `plugins/superharness/hooks/workflow-post-transition.mjs` — 新增
- `plugins/superharness/hooks/workflow-stop.mjs` — 新增
- 复用现有 `run-hook.cmd` polyglot wrapper

#### 3.3.3 三 hook 的输入/输出协议

| Hook | 输入（stdin JSON） | 输出 |
|---|---|---|
| **UserPromptSubmit** | `{cwd, prompt, ...}` | `{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext}}` |
| **PostToolUse** | `{cwd, tool_input:{from_state, to_state, ...}, tool_response, ...}` | `{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext}}` 或 `{}` |
| **Stop** | `{cwd, ...}` | 放行：`{}`；拦截：`{decision:"block", reason:"<文案>"}` |

**关键点**：PostToolUse 要查的是**"刚切走的那个 state"**——即 transition 发生时 agent 待在的 state。在 hook 看到的 stdin JSON 里，这个 state 名叫 `tool_input.from_state`（`transition_state` 工具的输入参数字段名）。**不能**用 `getWorkflowState()` 查"当前 state"——因为工具已经执行成功、状态已经更新为 `to_state` 了。

#### 3.3.4 Stop hook 算法与拦截 reason 文案

**Stop hook 算法**（决策顺序自上而下）：

```
1. EXISTS (本 turn_id 内 source='agent-tool' 的 transition_log)? → 放行
2. workflow_turn.stop_block_released=1? → 放行（用户已授权 escape）
3. <state>.silent_stop_allowed=true? → 放行
4. block_count < 3? → block_count++ + 返回 block + reason
5. block_count >= 3 → 兜底逃生放行（写 audit log 警告，理论不应到这里）
```

**拦截 reason 文案模板**（agent 收到这个 reason 在下一段 reasoning 开始时处理）：

```
[Superharness Workflow] 本轮检测到未完成的状态切换。

- 当前 state: <state>
- 该 state 要求 agent 在每轮结束前显式调用 transition_state

请用 AskUserQuestion 让用户在以下类别的选项中决定本轮去向（具体措辞由 agent 根据本轮工作上下文拟定，但必须涵盖这几类）：

1. **继续/调整工作方向** — 1~2 个选项，例如 "继续完成 X"、"先调整方向去做 Y"。用户选了 → agent 接着干。

2. **切到允许的下一态** — 列出 [<allowed_transitions>] 里合适的目标。用户选了 → agent 调 transition_state。

3. **终止本轮，让用户先看结果** — 固定语义选项。用户选了 → agent 调 `release_stop_block(reason="<复述用户原话或本轮上下文>")` 然后结束输出。

（AskUserQuestion 工具会自动提供 "Other" 开放输入选项让用户自定义。）
```

`<state>` / `<allowed_transitions>` 由 hook 渲染时填实际值。**注意**：文案中不暴露 `block_count` 或"N/3 次"——避免 agent 学会用 3 次拒绝 game the system 把兜底逃生口当 happy path。

#### 3.3.5 新增 MCP 工具 `release_stop_block`

`workflow-state-server/server.js` 注册新 MCP 工具：

```
release_stop_block(workspaceRoot: string, reason: string) → { ok: true }
```

- `reason` 必填、非空（语义同 transition_state 的 reason；占位符值会拒绝）
- 行为：`UPDATE workflow_turn SET stop_block_released=1, release_reason=? WHERE workspace_id=?`
- 同时在 `workflow_transition_log` 写一条 audit 行（`source='agent-tool'`, `from_state=to_state=current`, `reason="[escape] <reason>"`）便于审计
- agent **必须**在调此工具之前用 AskUserQuestion 拿到用户明确选择"终止本轮"——这条约束写在工具的 description 里，作为模型层面的约束

#### 3.3.6 PostToolUse 注入 SKILL.md 的格式

`render-context.js` 新增导出函数 `renderActiveSkill({stateInfo, workflowGraph, skillsDir})`，复用现有 SKILL.md 加载逻辑，但只返回 SKILL.md body（不包 `<SUPERHARNESS_WORKFLOW_STATE>` 外壳）：

```
[Superharness] 已切到新状态，本轮继续遵循以下 SKILL：

--- Active skill: <to_state> ---
<SKILL.md content>
```

### 3.4 跨平台 + 错误处理 + 边界场景 + 测试

#### 3.4.1 跨平台配置

| 平台 | 状态 |
|---|---|
| Claude Code | ✓ 支持（新增 PostToolUse + Stop） |
| Codex | ✓ 支持（新增 PostToolUse + Stop） |
| OpenCode | ✗ 撤掉支持（详见 Part B） |
| Cursor | ✗ 撤掉支持（详见 Part B） |

#### 3.4.2 失败模式（fail-open 表）

| 失败 | hook 行为 | 影响 |
|---|---|---|
| UserPromptSubmit hook 异常 | 现有 fallback 处理（输出 stop-work context） | 退化到现有行为 |
| PostToolUse hook 异常 | 输出 `{}` | transition 已成功，新 SKILL 不注入；最坏退化到下一轮 |
| Stop hook 异常 | 输出 `{}` | 不拦截 → 放行 → 用户至少能用插件 |
| `workflow_turn` 表无 workspace 行（首次） | Stop 视作"无当前轮"→ 放行 | 一次性，下一轮 UserPromptSubmit 创建后正常 |
| `workflow_transition_log.turn_id=NULL`（旧记录） | 不命中新查询 | 无影响 |
| `transition_state` 工具调用失败 | PostToolUse 不触发（平台行为） | state 不变，本轮 Stop 按当前 state 判 |
| MCP server 进程崩溃 | bootstrap.js 已有自愈机制（v1.2.1） | 现有行为 |

#### 3.4.3 关键边界场景

**A. 单轮内多次 chain**（intake → trivial → intake）
- intake.inline=true → PostToolUse 注入 trivial SKILL
- agent 干完 → transition 回 intake → PostToolUse 注入 intake SKILL
- transition_log 本轮 2 条记录，同 turn_id
- Stop 查到 ≥1 条 → 放行 ✓

**B. chain 到非 inline 的 state**（intake → brainstorming）
- intake.inline=true → PostToolUse 注入 brainstorming SKILL
- agent 多轮做盘问，每轮 silent=true 放行
- 完成 → transition 到 planning → PostToolUse 看 brainstorming.inline=**false** → **不注入**
- agent 自然在本轮输出"spec 已写到 .md，请审"
- Stop：本轮 1 条 transition → 放行 ✓
- 下一轮用户回复"已审"→ UserPromptSubmit 注入 planning SKILL

**C. silent=false state 内 agent 干一半溜了**
- agent 在 serial_execution 写代码写一半，没切态就停了
- Stop：silent=false + 0 transition → block_count<3 → 拦截 + 注入 reason
- agent 看到 reason 继续完成 → 切到 verification ✓
- 即便 agent 不肯继续，3 次后逃生放行（agent 不感知 N/3）

**D. transition_state 工具失败**
- agent 调 transition(intake→planning) 但非法（intake 不允许直跳 planning）
- 工具抛错；PostToolUse 不触发
- agent 看到错误，重调 transition(intake→brainstorming) → 成功 ✓

**E. agent 真的无法继续，用户授权 escape**
- agent 在 serial_execution（silent=false）写代码遇到环境错误（npm install 失败、磁盘满、外部 API 鉴权过期）
- agent 本轮输出"我做不了，请帮我" → Stop hook 触发 → block + 注入三选项 reason
- agent 下一段 reasoning 收到 reason → 调 AskUserQuestion 给用户：
  - "我先调整磁盘清理一下再继续"
  - "切到 systematic_debugging 让我系统性 debug"
  - "终止本轮，让我先看看 npm 错误日志"
- 用户选"终止本轮" → agent 调 `release_stop_block(reason="磁盘错误，用户要先看日志")` 然后结束输出
- 下一次 Stop hook 触发：检测 `stop_block_released=1` → 放行 ✓
- 下一轮 UserPromptSubmit：清零 `stop_block_released`，新 turn_id，回到正常流程

#### 3.4.4 测试策略

| 层级 | 文件 | 覆盖 |
|---|---|---|
| Unit | `workflow-state-server/test/turn.test.js`（新） | turn_id 生成 / workflow_turn CRUD（含 stop_block_released / release_reason）/ block_count 递增 / 旧 turn_id NULL 处理 |
| Unit | `workflow-state-server/test/release-stop-block.test.js`（新） | `release_stop_block` MCP 工具：参数校验 / DB 写 / audit 行写 |
| Unit | `workflow-state-server/test/validate-workflow.test.js`（扩） | YAML 新增 2 字段的解析 + 缺省值 + 10 state 取值匹配 |
| Integration | `tests/hooks/`（新目录） | 三 hook 脚本输入输出契约：给 stdin JSON 断言 stdout JSON |
| Integration | `tests/hooks/scenario-{A,B,C,D,E}.test.sh`（5 个新文件） | 3.4.3 五个边界场景的端到端覆盖（含场景 E 的 escape 通道） |
| Skill-trigger | `tests/skill-triggering/`（现有） | 不动 |

## 4. Part B — 撤掉 OpenCode/Cursor 支持

### 4.1 删除清单

| 路径 | 内容 |
|---|---|
| `plugins/superharness/.opencode/` | 整个目录 + `plugins/superharness.js`（Bun 插件入口） |
| `plugins/superharness/hooks/hooks-cursor.json` | 单文件 |
| `.cursor-plugin/` | 整个目录 + `plugin.json` |
| `tests/opencode/` | 整个目录 + 6 个 .sh 测试 |
| `docs/README.opencode.md` | 单文件 |
| `.opencode/` | 顶层目录 + `INSTALL.md` |

### 4.2 引用清理清单

| 文件 | 改动 |
|---|---|
| `CLAUDE.md` | "Three integration paths" 改成两个；删 OpenCode plugin / Cursor 段落 |
| `README.md` | 平台支持列表删 OpenCode/Cursor |
| `plugins/superharness/README.md` | 同上 |
| `plugins/superharness/skills/workflow-runner/SKILL.md` | 删 OpenCode/Cursor 提及（实施时具体看） |
| `GEMINI.md` | 同上 |
| `package.json` | 描述、keywords 清理 |
| `plugins/superharness/.codex-plugin/plugin.json` | description 清理 |
| `.github/PULL_REQUEST_TEMPLATE.md` | 删 "affected platform" 选项里的 OpenCode/Cursor |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 同上 |

### 4.3 不动的文件（历史记录）

- `docs/superharness/plans/*` — 历史 plan，是当时设计意图的快照
- `docs/superharness/specs/*` — 历史 spec，同上
- `docs/post-v1.1.9.md` / `docs/README.antigravity.md` / `docs/programmatic-*.md` — 历史/参考文档

删改历史文档会扭曲项目演化记录，保持原样。

## 5. 验收标准

- [ ] **Claude Code 实测**：在 `trivial` state 干一半（agent 模拟"我先停一下"）→ 下一轮 Stop hook 拦截 + 拦截 reason 出现在 agent 上下文
- [ ] **Claude Code 实测**：`intake → trivial → intake` 单轮内 chain 完成两态（PostToolUse 注入 trivial SKILL 后 agent 立即继续干）
- [ ] **Codex 实测**：同上两条
- [ ] **brainstorming/planning/verification 实测**：transition 后 PostToolUse 不注入下态 SKILL，agent 自然在本轮停下
- [ ] **escape 通道实测**：在 silent=false state 内模拟 agent 收到 block reason → 调 AskUserQuestion → 用户选"终止本轮" → agent 调 `release_stop_block` → 下次 Stop 放行
- [ ] **escape 留痕**：`release_stop_block` 调用后 `workflow_transition_log` 有 `[escape]` 前缀的 audit 行
- [ ] `workflow-state-server` vitest 通过率 100%（含新增 `turn.test.js`、`release-stop-block.test.js`）
- [ ] `tests/opencode/` 删除后无任何 CI 引用残留（`.github/workflows/` grep `opencode` 0 命中）
- [ ] grep `opencode|cursor` 在主代码（不含 `docs/superharness/{plans,specs}/`）后 0 命中
- [ ] CLAUDE.md / README / 各 plugin.json 描述统一为"两平台"
- [ ] Stop hook 在 hook 进程异常时输出 `{}`（fail-open 验证 — 故意注入 throw 测试）
- [ ] 3 次兜底逃生口验证 — 故意让 agent 反复 stop 不切态也不 escape，第 4 次 Stop 应放行 + audit 日志有 warning

## 6. 影响面 / 风险

### 6.1 影响面

- **新增文件**：2 个 hook 脚本（`workflow-post-transition.mjs` / `workflow-stop.mjs`）+ 1 个测试目录（`tests/hooks/`）
- **修改文件**：
  - `default-workflow.yaml`（每 state 加 2 字段）
  - `schema.sql`（新表 `workflow_turn` 含 5 字段 + ALTER）
  - `state.js`（schema 升级路径 + workflow_turn CRUD + turn_id 写 transition_log）
  - `validate-workflow.js`（buildWorkflowGraph 解析新字段）
  - `render-context.js`（新增 `renderActiveSkill` 导出 + UserPromptSubmit 追加 strict 提示）
  - `workflow-context.mjs`（UserPromptSubmit hook 写 workflow_turn）
  - `server.js`（新增 MCP 工具 `release_stop_block`）
  - `hooks.json` / `hooks-codex.json`（新增 PostToolUse + Stop 配置）
  - 现有 vitest 套件扩展
- **删除文件**：见 Part B 4.1

### 6.2 风险

| 风险 | 缓解 |
|---|---|
| Codex 的 PostToolUse `matcher` 字段语法可能与 Claude Code 不完全一致 | 实施时实测；fail-open 保护不会卡死 |
| ALTER TABLE 在已部署 workspace 上失败 | PRAGMA 检测先；失败也走 fail-open（hook 异常输出 `{}`） |
| 3 次逃生口被滥用（agent 学会撑过 3 次） | 不告诉 agent N/3，去掉激励；同时审计日志记录每次逃生供调试 |
| 撤掉 OpenCode 导致现有用户报错 | release notes 明确通知；MCP server 本身保留，OpenCode 用户仍可手动配 MCP |

## 7. 版本与发布

候选版本：**v1.3.0**（minor bump 因为有撤平台 + 行为新增）

需要同步更新 5 个 version 文件：
- `package.json`
- `.claude-plugin/marketplace.json`
- `plugins/superharness/.claude-plugin/plugin.json`
- `plugins/superharness/.codex-plugin/plugin.json`
- ~~`.cursor-plugin/plugin.json`~~（已删除）

## 8. 引用

- v1.2.4 Codex plugin fix（前置工作）：[2026-05-20-codex-plugin-fix-v1.2.4-design.md](2026-05-20-codex-plugin-fix-v1.2.4-design.md)
- v3 state machine（前置工作）：[2026-05-19-state-machine-v3-design.md](2026-05-19-state-machine-v3-design.md)
- Red Queen 一次性 worker 模式参考：[references/red-queen/src/core/worker.ts:84](../../../references/red-queen/src/core/worker.ts#L84)
- Codex hook event 清单（探索结论）：`codex-rs/hooks/src/schema.rs:75-92`、`events/stop.rs:41,244-250`
