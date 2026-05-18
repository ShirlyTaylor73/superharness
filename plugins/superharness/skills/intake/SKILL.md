---
name: intake
description: 会话入口和 triage——在新会话起点或任务完成回到默认态时使用，听需求、必要时澄清、把任务路由到 exploration / trivial / brainstorming，或当场回答无需切态的纯问答
metadata:
  type: workflow-state
---

# Intake — 入口分流

## 角色

你处在新会话起点（或者上一个任务结束后回到的默认态）。三件事：

1. **听** 用户表达需求
2. **必要时回问 1-2 个澄清问题**（不要过度盘问）
3. **把任务路由**到下一个状态（或当场答完不切态）

intake 不写代码、不做计划、不做深度探索。它的唯一价值是把请求精确地交给对的下家。

## 决策表

| 用户意图 | 该走 | transition_state 到 |
|---|---|---|
| 纯问答 / 解释 / 查 API 用法 / 闲聊 / 概念解释 | 当场答 | （**不切态**） |
| 看看 X 是怎么实现的 / 跨文件读懂某个模块 / 做技术调研 / 比较方案 | 只读探索 | `exploration` |
| 改个 typo / 调整一行配置 / 单文件小修复 / ≤3 文件 ≤50 行 | 快速改动 | `trivial` |
| 新功能 / bugfix / 多文件变更 / 涉及 API/schema/依赖 | 正式开发 | `brainstorming` |

## 反过度分类（红线）

intake 最容易犯的错是"为了走流程而切态"。以下都是**红线**，违反就停下重判：

- **用户问问题，你切到 brainstorming**——错。问题就答，answer-only 不调用 `transition_state`。
- **不确定大小直接切 trivial**——错。回问一句确认："这只是改 X 一处，还是还要碰 Y 和 Z？"
- **看到代码相关请求就切 exploration**——错。"为什么我这段 Python 报错"是答疑，不是探索；探索是用户主动想"走一遍代码理解一下"。
- **把澄清问题做成 10 连问**——错。最多 1-2 个澄清问题，确认完就路由；继续盘问该走 `brainstorming`。

## 反例对照

**例 1：纯问答**
- 用户："async/await 和 promise.then 有啥区别？"
- 错：切 `exploration` 去翻代码——这是概念问题，代码里也找不到答案。
- 对：当场答，不切态。

**例 2：模糊小修复**
- 用户："帮我把那个超时时间调一下。"
- 错：直接切 `trivial` 开干——不知道改哪、改成多少。
- 对：回问"是 X 文件里的 `timeout=5000` 那个吗？要改成多少？" → 拿到答案后再切 `trivial`。

**例 3：被低估的"小"改动**
- 用户："帮我把 `getUserById` 的返回类型加个字段。"
- 错：当 `trivial` 处理——公共 API 变更，所有调用点都要动。
- 对：先回问"这个函数有多少调用点？" → 如果跨多文件就切 `brainstorming`，不要走 `trivial`。

**例 4：被高估的"功能"**
- 用户："帮我新加一个功能：把 log 里的颜色关掉。"
- 错：切 `brainstorming` 走完整流程——其实就是一个 flag。
- 对：回问"是想加一个 `--no-color` 还是直接默认关掉？" → 拿到答案后切 `trivial`。

## answer-only 模式

判定为纯问答时：

- **不**调用 `transition_state`
- **不**调用 `classify_request`
- 直接答完，等用户下一条消息
- 答完后状态还是 `intake`，下一条消息照常再 triage 一次

什么算"纯问答"：

- 概念解释、原理科普、API 用法、报错含义
- 项目里的"X 在哪/做什么"——这种用 Read/Grep 答完就行，不需要切 exploration
- 闲聊、问候、确认收到

什么**不算**纯问答（要切态）：

- "顺便帮我改一下" → 切 `trivial` 或 `brainstorming`
- "完整读一遍这个模块给我讲讲" → 切 `exploration`
- "对比一下方案 A 和方案 B" → 切 `exploration`

## 切态时的 reason 要求

每次 `transition_state` 的 `reason` 字段必须包含两部分：

1. **用户原话摘要**（10-30 字，原话或贴近原话）
2. **判定理由**（为什么走这一档而不是另一档）

格式示例：

```
"用户说『帮我把 README 里的 typo 改一下』；单文件、无逻辑改动，走 trivial 而不是 brainstorming"
```

```
"用户说『我想看看 workflow-state-server 是怎么处理并发的』；只读理解需求，走 exploration"
```

reason 是**审计记录**，不是占位符。`"ok"` / `"start"` / `"用户请求"` 这种都会进 transition_log 留痕，不要写。

## 出口

| 出口 | 用途 |
|---|---|
| `exploration` | 只读探索：读懂代码、做调研、比较方案，**不写**任何文件 |
| `trivial` | 轻量改动：≤3 文件 ≤50 行，自带验证，不走 plan |
| `brainstorming` | 正式开发：新功能、bugfix、多文件变更——需要先做需求分析和规划 |

**不要**从 intake 直接跳 `planning` / `serial_execution` / `parallel_execution` / `verification` / `finishing`——这些状态都不在 intake 的允许出口里，需求未确认就跳到实现是反模式。需要正式开发**总是先去 `brainstorming`**。

## 红线清单

以下情况停下来，**不要**继续：

- 切态没填 reason 或填了占位符（`"ok"` / `"start"` / 空字符串）
- 切到 `planning` / `serial_execution` / `parallel_execution` / `verification` / `finishing` 任意一个——这些不是 intake 的合法出口
- 用户只是问问题，你却调用了 `transition_state`
- 不知道大小硬切 `trivial`——先回问 1 句确认范围
- 连问 3 个以上澄清问题——该走 `brainstorming` 了，那里有完整的盘问框架

## 流程

```
收到用户消息
   │
   ├─ 是纯问答？ ──→ 当场答，不切态，状态停留 intake
   │
   ├─ 范围/意图明确？
   │     │
   │     ├─ 是 ──→ 按决策表 transition_state
   │     │
   │     └─ 否 ──→ 回问 1-2 句确认 ──→ 拿到答案后按决策表 transition_state
   │
   └─ 连续澄清 >2 轮？ ──→ 切 brainstorming，让它接管深度盘问
```
