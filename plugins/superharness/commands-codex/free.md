---
description: 进入或退出 free-mode；暂停 superharness workflow context 注入（Codex）
allowed-tools: shell_command
---

# /free $ARGS

用户输入了 `/free $ARGS`。这是 Codex 兼容 command：不要把下面的命令展示给用户后停止，必须由 agent 调用 shell tool 直接执行。

解析 `$ARGS`：

- 空或 `status`：查询状态
- `on`：进入 free mode
- `off`：退出 free mode
- 其他值：报告用法 `/free [on|off|status]` 并停止

在 PowerShell 中执行：

```powershell
node "{{SUPERHARNESS_PLUGIN_ROOT}}\scripts\set-free-mode.mjs" (Get-Location).Path "$ARGS"
```

在 bash/Git Bash 中执行：

```bash
node "{{SUPERHARNESS_PLUGIN_ROOT}}/scripts/set-free-mode.mjs" "$PWD" "$ARGS"
```

根据 stdout 简短报告结果。不要继续做其他事，不要补 transition_state。
