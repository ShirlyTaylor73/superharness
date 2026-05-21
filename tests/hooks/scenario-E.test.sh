#!/bin/bash
# Scenario E: silent=false state agent 无法继续 → 用户授权 escape
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

WS_RAW=$(mktemp -d)
WS=$(cygpath -m "$WS_RAW" 2>/dev/null || echo "$WS_RAW")
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

# 准备
echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs" > /dev/null
WS_IN_DB=$(sqlite3 "$DB" "SELECT workspace_id FROM workflow_state LIMIT 1")
sqlite3 "$DB" "UPDATE workflow_state SET state='serial_execution', active_skill='serial-execution' WHERE workspace_id='$WS_IN_DB'"

# 第 1 次 Stop：拦截（silent_stop_allowed=false, block_count=0 → 拦）
STOP1=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-stop.mjs")
echo "$STOP1" | grep -q '"decision":"block"' || { echo "FAIL: first Stop should block"; echo "Got: $STOP1"; exit 1; }

# 模拟 release_stop_block：UPDATE workflow_turn SET stop_block_released=1（用 DB 实际 workspace_id）
sqlite3 "$DB" "UPDATE workflow_turn SET stop_block_released=1, release_reason='用户授权终止本轮' WHERE workspace_id='$WS_IN_DB'"

# 第 2 次 Stop：检测到 escape，放行
STOP2=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-stop.mjs")
if echo "$STOP2" | grep -q '"decision"'; then
  echo "FAIL: Stop should release after user authorized escape"
  echo "Got: $STOP2"
  exit 1
fi

# 下一轮 UserPromptSubmit 清零 stop_block_released
echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs" > /dev/null
RELEASED=$(sqlite3 "$DB" "SELECT stop_block_released FROM workflow_turn")
[ "$RELEASED" = "0" ] || { echo "FAIL: next turn should reset stop_block_released, got $RELEASED"; exit 1; }

echo "PASS: scenario-E"
