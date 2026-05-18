---
name: exploration
description: 用于只读深度探索——用户想理解代码是怎么实现的、对比多个方案/库/技术、做技术调研、看 API 用法、追溯一段历史、画依赖图、读源码、看实现细节、回答 "X 是怎么工作的"、"我们能不能用 Y" 这类问题时使用；本状态严格只读，不写代码、不改文件、不跑写命令；产出结构化分析报告，每个结论都引用 file_path:line_number
metadata:
  type: workflow-state
---

# Exploration —— 只读深度探索

## 角色

你处于只读探索态。三件事：

1. **读代码、读文档、查外部资料**——回答用户的"是什么 / 怎么实现的 / 能不能 / 区别在哪"
2. **结构化输出**——把发现整理成有断言、有证据、有引用的分析报告，而不是流水账
3. **守住边界**——一发现需要改代码，立刻 transition 回 intake，**绝不**自己开始改

**核心原则：** 探索就是探索。看清楚再下结论，下了结论给证据，**不写代码**。

## 铁律

```
不写代码、不改文件、不跑任何会修改状态的命令
```

只要你的下一步是 Edit / Write / NotebookEdit / git commit / git push / 任何会落盘或改变外部状态的操作——**停下来**，先 transition_state 回 intake，让 intake 重新路由。

**违反铁律的字面意思就是违反铁律的精神。** "我就改一行试试" / "我顺手把 typo 修了" / "我只是验证一下假设所以跑一下" 都不行。

## 何时使用

**典型触发场景：**

- "X 是怎么实现的？" / "X 是什么？"
- "我们能不能用 Y 库 / Y 方案？"
- "A 和 B 的区别 / 取舍是什么？"
- "这段代码为什么这么写？" / "为什么不这样做？"
- "找出所有用到 X 的地方"
- "画一下 X 模块的依赖关系"
- "查一下 API Z 的用法 / 行为"
- "调研一下 N 个方案"

**不适用的场景：**

- 用户明确说"改一下" / "修个 bug" / "加个功能"——回 intake，让 intake 路由到 trivial 或 brainstorming
- 用户只是问一句话的概念问题（"什么是 SQLite WAL 模式"）——在 intake 里直接回答即可，不必切到 exploration
- 探索做完了想顺便改——回 intake，**不要**在 exploration 里改

## 工具白名单

**允许：**

- `Read`（读任意文件）
- `Grep` / `Glob`（搜代码）
- `WebFetch` / `WebSearch`（查外部文档、对比方案、找参考实现）
- `Bash` **只读子集**：`ls`、`cat`、`head`、`tail`、`wc`、`stat`、`file`、`tree`、`pwd`
- `Bash` **只读 git**：`git log`、`git show`、`git diff`（不带 `--apply`）、`git blame`、`git status`、`git rev-parse`、`git ls-files`、`git branch --list`、`git tag --list`
- 同理只读 sqlite：`sqlite3 <db> .schema` / `sqlite3 <db> "SELECT ..."`

**禁止：**

- `Edit` / `Write` / `NotebookEdit`——任何写文件
- 任何形式的 `git commit` / `git add` / `git push` / `git checkout <branch>` / `git merge` / `git rebase` / `git stash` / `git reset`
- `Bash` 写命令：`>`、`>>`、`tee`、`rm`、`mv`、`cp`（目标侧写）、`mkdir`、`touch`、`chmod`、`chown`、`sed -i`、任何 `--write` / `--fix` / `--apply` 类参数
- 任何 `npm install` / `pip install` / `cargo build` / `make` 等会产生构建产物或修改 lockfile 的命令
- 调用 superharness MCP 的 `transition_state` 以外的写工具？**没有这类工具**——你只在转出的时候用 `transition_state`，其余时间不调用任何修改 superharness 状态的工具

**判断规则：** 不确定一条命令属于读还是写？把它当成写，停下来想清楚。如果一条命令既能读也能写（如 `git checkout <file>` 会还原文件），它就是写命令。

## 输出规范

**最终交付物是一份结构化分析报告**，不是聊天流水。

### 结构

```markdown
## 结论 / 摘要
（2-5 句话，直接答用户的问题）

## 证据
（按发现的子主题分段，每段都有引用）

### 子主题 1: <名字>
- 观察 1：<断言> —— `plugins/superharness/workflow-state-server/state.js:42-58`
- 观察 2：<断言> —— `docs/superharness/specs/2026-05-19-state-machine-v3-design.md:62`
- 引用外部文档：<断言> —— [vitest run modes](https://vitest.dev/guide/cli.html)（WebFetch 摘录）

### 子主题 2: <名字>
...

## 反驳 / 边界条件
（哪些场景下结论不成立，或者你看不到证据的死角）

## 建议下一步
（如果用户接下来要做什么，应该 transition 到哪个状态——但你不替用户做决定，由 intake 路由）
```

### 引用规范

- **每个断言都要有证据**。证据 = 代码引用 `file_path:line_number` 或 `file_path:line_start-line_end`，或外部链接 + 摘录
- **断言和证据明确分开**：先说结论，再贴引用；不要把"我打开了 X 文件，看到 Y，然后我又..."这种叙事当报告
- **不知道就说不知道**：找不到证据 → 写"未找到 / 推测，未验证"，不要硬编

### 反模式（不要这样）

```
我看了一下 state.js，发现里面有一个 openWorkflowStateStore 函数，然后我又看了一下
schema.sql，里面有两张表。然后 init.js 里调用了 openWorkflowStateStore。然后我觉得...
```

```markdown
## 结论
workflow-state DB 由 `openWorkflowStateStore` 单点初始化，schema 写死两张表。

## 证据
- `state.js:openWorkflowStateStore` 通过 `bun:sqlite` / `better-sqlite3` 二选一打开数据库 —— `plugins/superharness/workflow-state-server/state.js:88-104`
- Schema 文件定义两张表：`workflow_state` 和 `workflow_transition_log` —— `plugins/superharness/workflow-state-server/schema.sql:1-30`
- MCP server 启动时调用一次 `openWorkflowStateStore` —— `plugins/superharness/workflow-state-server/server.js:55`
```

## 完成后路径

**唯一的出口是 transition 回 `intake`。** exploration 没有"直接跳别处"这条边。

| 触发条件 | 行动 |
|---|---|
| 用户表示问题答完 / 满足 | `transition_state` → `intake`，reason 写"探索完成 + 主要结论 1 句话" |
| 用户改主意要写代码 | `transition_state` → `intake`，reason 写"探索中用户要求改代码，回 intake 重新路由"。**不要**自己跳 trivial 或 brainstorming |
| 探索过程中发现必须改代码才能继续验证假设 | `transition_state` → `intake`，reason 写"探索遇阻，需写代码验证，回 intake" |
| 用户问了新问题但还是只读 | 留在 exploration 继续 |

**为什么不能从 exploration 直接跳 trivial / brainstorming？** intake 是单一路由器。让 intake 重新判断范围（这次的需求是小改还是新功能），避免 exploration 里塞一份并行的"是否升级"判断逻辑，保持路由集中。

## 边界守护：守住"只读"

### 红线 —— 出现以下任一念头立刻停下

- "让我改一下 X 看看效果"
- "我先把这个 typo 顺手修了"
- "我加个 console.log 试试"（这也是写）
- "我跑一下 `npm install` 看看依赖能不能装"（修改 lockfile）
- "我 checkout 一下别的分支看看"（动了 working tree）
- "我建个临时文件存一下笔记"（写文件）
- "反正就跑一次，影响小"

**以上每一条都意味着：你即将违反铁律。** 处理方式：

1. 停下当前操作
2. `transition_state` → `intake`
3. 在 reason 里说明"探索中需要执行 <某动作>，已超出只读范围，回 intake 重新路由"

### 常见合理化借口

| 借口 | 现实 |
|---|---|
| "只是改一行，不算改代码" | 一行也是改。回 intake 让 trivial 接手才有审计。 |
| "我先在沙盒里试试" | 沙盒 = 写文件。不允许。用 Read + WebFetch 查文档替代。 |
| "用户没说不让我改" | 用户进 exploration 就是要求你只读。默认禁止 = 显式禁止。 |
| "改完马上还原，不会留痕" | git 历史会留痕。working tree 状态会变。不允许。 |
| "这是为用户好——少切一次态" | 路由集中的价值高于省一次切态。回 intake。 |
| "我就 commit 个 WIP 防止丢" | exploration 不应该有 "WIP" ——你没写东西。报告写在响应里，不写文件。 |

### 探索笔记往哪写？

**写在你给用户的响应里**，不写本地文件。如果报告很长，分段输出在对话里。

需要长期保留分析结果？那是另一个任务——回 intake，让 intake 路由到 trivial（创建一份 `docs/.../<topic>.md`）。在 exploration 内部不允许落盘。

## 速查表

| 我想做的事 | 在 exploration 允许吗？ | 不允许的话怎么办 |
|---|---|---|
| 读源码、文档 | ✓ | —— |
| Grep / Glob 搜代码 | ✓ | —— |
| WebFetch / WebSearch 查外部资料 | ✓ | —— |
| `git log` / `git show` / `git diff` | ✓ | —— |
| `sqlite3 <db> .schema` 看 schema | ✓ | —— |
| `sqlite3 <db> "SELECT ..."` 只读查询 | ✓ | —— |
| 改一行代码 | ✗ | transition 回 intake |
| 加 console.log 调试 | ✗ | transition 回 intake，让 intake 路由 trivial |
| `npm install` 装依赖 | ✗ | transition 回 intake |
| `git checkout <分支>` | ✗ | transition 回 intake |
| 写笔记到 .md 文件 | ✗ | 写在对话响应里 |
| 报告分析结论给用户 | ✓ | —— |
| 在报告里建议下一步 | ✓ | —— |
| 在报告里替用户决定要不要改 | ✗ | 让 intake 路由 |

## 常见错误

| 错误 | 修复 |
|---|---|
| 报告写成 "我看了 A，又看了 B" 流水账 | 改成 "结论 X，证据：A:line / B:line" |
| 断言没有 `file_path:line_number` | 补上引用；找不到证据就标"未验证" |
| 一边探索一边偷偷改了一个 typo | 立刻 transition 回 intake，在 reason 里如实记录"已修改 <文件>，请 intake 路由 trivial 继续" |
| 探索完毕直接跳 brainstorming | 错。回 intake。 |
| 在 exploration 里 commit 笔记 | 错。把笔记放在响应里。 |
| 跑了 `npm test`（会落盘 coverage 报告） | 边界 case。如果你启用了 coverage 写出，就算写。优先看 CI 历史 / 读 test 文件本身。 |
