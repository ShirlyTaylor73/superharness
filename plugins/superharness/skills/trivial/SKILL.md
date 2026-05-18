---
name: trivial
description: 当用户描述 typo 修复、单文件配置调整、改个常量、改个文案、小幅且明确的轻量改动时使用——只对 ≤ 3 文件 / ≤ 50 行 / 不引新依赖 / 不动公共 API 与 schema 的小修适用；超出任一边界必须立即转回 intake
metadata:
  type: workflow-state
---

# Trivial — 单点小改 + 自带验证

## 概述

你处在快速通道。这条路把 plan / verification / finishing 全跳过——你既是 implementer，也是 reviewer，**所有事都在这一个状态内完成**。

**核心原则：** 改动必须真的轻量。任何"顺手再改一点"的冲动都意味着你不应该在 trivial 里。

## 何时使用 / 不使用

**适用**（**全部**满足才能留在 trivial）：

- 改 typo / 错别字 / 注释笔误
- 调整 1-3 个配置项（如 timeout、buffer 大小、feature flag 默认值）
- 改个常量或字面量
- 改文案 / log message / 错误信息
- 单文件函数体内的小幅 bugfix（不动签名、不动调用方）

**不适用**（出现任一条立即 transition 回 `intake`）：

- 改动会跨 ≥ 4 个文件
- 实质改动 > 50 行（不算空白行、纯重命名、纯格式化）
- 需要新增依赖、新增配置文件、新增 npm/pip 包
- 改动函数签名 / 导出接口 / 公共 API
- 改动 schema：DB schema、API contract、消息格式、配置文件结构
- 改动行为语义（哪怕只改一行——一行 `if` 反转都可能不是 trivial）
- 你需要先去查代码、对比方案、想架构才能决定怎么改

## 改动边界（硬约束）

```
≤ 3 个文件
≤ 50 行实质改动（不算空白行 / 纯重命名 / 纯格式化）
不引入新依赖
不改公共 API / 导出接口 / 函数签名
不改 schema（DB / API contract / 配置结构 / 消息格式）
```

**违反任一条 → 立即 transition_state 到 `intake`**，reason 写明"超出 trivial 边界：[具体哪条]"，让用户决定是否升级到 `brainstorming`。

**不要试图把改动"切碎"绕过边界**——边界的精神是"心智负担可以一眼读完"，违反字面就是违反精神。

## 自带验证（改完必须做）

改完代码后，**在 transition 出去之前**必须完成以下验证，并把结果写进 transition 的 reason：

1. **跑相关测试**：找到覆盖你改动的测试文件 / test 函数，运行它们。看到通过结果，不要"假设会过"。
2. **跑 lint**：项目有 lint 命令就跑（npm run lint / ruff / eslint / 等等）。
3. **跑类型检查**：项目有类型检查就跑（tsc --noEmit / mypy / 等等）。
4. **没有自动化测试时**：至少手动验证 happy path——明确写出"我手动验证了 X 场景，输出 Y"。

**验证不通过**：见下方"异常出口"。**不许**用"应该能过"、"看起来对了"、"改动很小不可能出错"这类话替代实际运行验证命令。

## 异常出口

| 情况 | 出口 |
|---|---|
| 测试失败 / lint 报错 / 类型错误 / 运行报错 | transition 到 `systematic_debugging` |
| 发现真实改动范围超过任一边界 | transition 回 `intake`，reason 注明超边界细节 |
| 改完发现需要顺手 refactor 才合理 | **不要 refactor**，transition 回 `intake` 让用户决定 |

## 完成后

完成 = 改动落地 + 自带验证全过。然后 transition_state 回 `intake`。

**reason 必须包含两段**：

1. **改了什么**：具体文件路径 + 函数名 / 行号 / 改动的本质（如 "src/utils/timeout.ts 把 DEFAULT_TIMEOUT 从 5000 改为 10000"）
2. **验证结果**：实际运行了哪些命令 + 看到了什么输出（如 "npm test src/utils/timeout.test.ts 通过 12/12；npm run lint 0 errors"）

reason 不写或敷衍 = 等同于在审计日志里说谎。

## 反 anti-pattern（红线）

以下任一条出现 → **停**，重新评估：

- 在 trivial 里搞 refactor（**不要**——transition 回 intake）
- "顺手优化"了一段无关代码（**回滚那段**，只保留任务本身的改动）
- 跳过 self-verification 直接 transition（**回头跑验证**）
- 改完之后想"我再多改一点点 X 就完美了"（**不要**——超出边界的征兆）
- 用 "应该" / "大概" / "看起来对了" 替代实际验证命令（**跑命令看输出**）
- 测试失败但跟自己说"这个 bug 跟我改的无关"（**transition 到 systematic_debugging**，不要绕过）

## 防止合理化

| 借口 | 现实 |
|---|---|
| "改动这么小不可能出错" | 小改动也会破测试，跑一遍 30 秒 |
| "测试覆盖的不是我改的地方所以不用跑" | 行为可能传染到任何 caller，跑相关测试 |
| "顺手把这段 if/else 改清楚一点" | 那是 refactor，不在 trivial 范围 |
| "lint warning 不算 error" | 看项目设定，CI 报红就是 error |
| "类型检查通过等于功能正确" | 错的——它只证明类型对 |
| "范围只超了一点点" | 边界数字是硬的，超了就 transition |
| "改完发现还得改另一个文件，但加上才 4 个" | 4 > 3，transition 回 intake 升级到 brainstorming |

## 红线——停下来 transition 回 intake

- 即将动第 4 个文件
- 实质改动已经 > 50 行
- 准备 npm install / pip install 任何东西
- 准备改某个 export / public 函数签名
- 准备改 schema / migration / API 契约
- 准备做"顺手的 refactor"

**以上任一条 = trivial 已经不适用。transition 回 intake，让用户决定是否走 brainstorming。**

## 底线

trivial 之所以快，是因为它**小到可以一眼审完**。一旦你需要"想一下"才能确定改对了——就不再 trivial。

不要用 trivial 偷渡你本该走 brainstorming / planning 的工作。这条快速通道的存在前提是：使用者诚实地遵守边界。
