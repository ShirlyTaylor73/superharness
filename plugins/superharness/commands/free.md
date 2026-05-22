---
description: 进入或退出 free-mode；暂停 superharness workflow context 注入
allowed-tools: Bash
---

# /free $ARGS

用户输入了 `/free $ARGS`。按以下逻辑执行：

- `$ARGS` 为 `on`：
```bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" on
```

- `$ARGS` 为 `off`：
```bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" off
```

- `$ARGS` 为 `status` 或空：
```bash
!node "${CLAUDE_PLUGIN_ROOT}/scripts/set-free-mode.mjs" "$CLAUDE_PROJECT_DIR" status
```

读脚本 stdout 反馈结果。**不要**做其他事。
