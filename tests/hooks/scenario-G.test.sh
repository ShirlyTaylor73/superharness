#!/bin/bash
# Scenario G: free-mode 全锁 — 进入 free → mutating tools 拒绝 + hooks 静默 → off 后恢复
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

WS_RAW=$(mktemp -d)
WS=$(cygpath -m "$WS_RAW" 2>/dev/null || echo "$WS_RAW")
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

# 0. UserPromptSubmit 创建 initial state + turn
echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs" > /dev/null
WS_IN_DB=$(sqlite3 "$DB" "SELECT workspace_id FROM workflow_state LIMIT 1")
[ -n "$WS_IN_DB" ] || { echo "FAIL: workflow_state row missing"; exit 1; }

# 1. /free on → free_mode=1
node "$REPO_ROOT/plugins/superharness/scripts/set-free-mode.mjs" "$WS" on > /dev/null
FM=$(sqlite3 "$DB" "SELECT free_mode FROM workflow_state WHERE workspace_id='$WS_IN_DB'")
[ "$FM" = "1" ] || { echo "FAIL: free_mode should be 1, got: $FM"; exit 1; }

# 2. UserPromptSubmit hook 在 free-mode 应输出 {} (no injection)
CTX_OUT=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs")
[ "$CTX_OUT" = "{}" ] || { echo "FAIL: workflow-context should output {} in free mode, got: $CTX_OUT"; exit 1; }

# 3. Stop hook 在 free-mode 应输出 {} (no block)
STOP_OUT=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-stop.mjs")
[ "$STOP_OUT" = "{}" ] || { echo "FAIL: workflow-stop should output {} in free mode, got: $STOP_OUT"; exit 1; }

# 4. PostToolUse hook 在 free-mode 应输出 {}
POST_OUT=$(echo "{\"cwd\":\"$WS\",\"tool_input\":{\"to_state\":\"brainstorming\"}}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-post-transition.mjs")
[ "$POST_OUT" = "{}" ] || { echo "FAIL: workflow-post-transition should output {} in free mode, got: $POST_OUT"; exit 1; }

# 5. /free off → free_mode=0
node "$REPO_ROOT/plugins/superharness/scripts/set-free-mode.mjs" "$WS" off > /dev/null
FM2=$(sqlite3 "$DB" "SELECT free_mode FROM workflow_state WHERE workspace_id='$WS_IN_DB'")
[ "$FM2" = "0" ] || { echo "FAIL: free_mode should be 0 after off, got: $FM2"; exit 1; }

# 6. workflow-context 恢复注入（输出非 {}）
CTX_OUT2=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs")
echo "$CTX_OUT2" | grep -q "SUPERHARNESS_WORKFLOW_STATE" || { echo "FAIL: workflow-context should resume injection after free off, got: $CTX_OUT2"; exit 1; }

# 7. transition_log 应有 [free-on] 和 [free-off] 两条
ON_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM workflow_transition_log WHERE workspace_id='$WS_IN_DB' AND reason LIKE '[free-on]%'")
OFF_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM workflow_transition_log WHERE workspace_id='$WS_IN_DB' AND reason LIKE '[free-off]%'")
[ "$ON_COUNT" = "1" ] && [ "$OFF_COUNT" = "1" ] || { echo "FAIL: expected 1 [free-on] + 1 [free-off], got: $ON_COUNT/$OFF_COUNT"; exit 1; }

echo "PASS: scenario-G"
