---
description: 回退 workflow state 到 transition_log 中走过的某个 state（Codex 用户控制）
allowed-tools: mcp__plugin_superharness_superharness-workflow-state__list_history, shell_command, request_user_input
---

# /rollback $ARGS

用户输入了 `/rollback $ARGS`。这是 Codex 兼容 command：最终 rollback 命令必须由 agent 调用 shell tool 直接执行。

步骤 1：调用 `list_history()` 获取历史。
Codex 的 workspace source-of-truth 另行设计；不要手动给 Superharness MCP tool 传 `workspaceRoot`。

步骤 2：解析参数。

- `$ARGS` 非空：把 `$ARGS` 当目标 state 名。从 transition_log 中过滤 `to_state == $ARGS` 是否存在。不存在就报错，并列出曾走过的 state。
- `$ARGS` 为空：从 transition_log 提取 `to_state`，按时间倒序去重，取最近 5 个独特 state，让用户选择。

步骤 3：执行 rollback。

PowerShell：

```powershell
node "{{SUPERHARNESS_PLUGIN_ROOT}}\scripts\rollback.mjs" (Get-Location).Path "<chosen_state>" "[rollback] 用户 /rollback $ARGS"
```

bash/Git Bash：

```bash
node "{{SUPERHARNESS_PLUGIN_ROOT}}/scripts/rollback.mjs" "$PWD" "<chosen_state>" "[rollback] 用户 /rollback $ARGS"
```

步骤 4：根据 stdout 简短报告“已从 X 回到 Y”。

不要调用 `transition_state`，不要继续之前 state 的任务。下一轮 UserPromptSubmit hook 会注入新 state SKILL.md。
