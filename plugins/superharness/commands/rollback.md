---
description: 回退 workflow state 到 transition_log 中走过的某个 state（用户控制）
allowed-tools: mcp__plugin_superharness_superharness-workflow-state__list_history, AskUserQuestion, Bash
---

# /rollback $ARGS

用户输入了 `/rollback $ARGS`。按以下步骤执行：

**步骤 1**：调 `list_history(workspaceRoot=$PWD)` 拿历史。

**步骤 2 解析参数**：

- 若 `$ARGS` 非空：把 `$ARGS` 当目标 state 名。从 transition_log 中过滤 `to_state == $ARGS` 是否存在：
  - 存在 → 跳到步骤 4，目标 = `$ARGS`
  - 不存在 → 报错并列出"曾走过的 state"让用户重新指定

- 若 `$ARGS` 为空：
  - 从 transition_log 提取 to_state，按时间倒序去重，取**最近 5 个独特 state**
  - 用 AskUserQuestion 让用户选 → 选中作为目标 state，跳到步骤 4

**步骤 4 执行 rollback**：

```bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/rollback.mjs" "$PWD" "<chosen_state>" "[rollback] 用户 /rollback $ARGS"
```

**步骤 5 报告**：根据脚本 stdout 简短报告"已从 X 回到 Y"。

**不要**继续做其他事：不要补 transition_state、不要继续之前 state 的任务。下一轮 UserPromptSubmit hook 会注入新 state SKILL.md。
