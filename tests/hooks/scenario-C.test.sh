#!/bin/bash
# Scenario C: serial_execution silent=false，agent 不切态 → 拦 3 次 → 第 4 次逃生
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

# workflow_state 用 DB 里实际的 workspace_id（windows path 正/反斜杠差异）
WS_IN_DB=$(sqlite3 "$DB" "SELECT workspace_id FROM workflow_state LIMIT 1")
sqlite3 "$DB" "UPDATE workflow_state SET state='serial_execution', active_skill='serial-execution' WHERE workspace_id='$WS_IN_DB'"

# 拦截 3 次（每次 block_count++）
for i in 1 2 3; do
  STOP=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-stop.mjs")
  echo "$STOP" | grep -q '"decision":"block"' || { echo "FAIL: block #$i did not happen"; echo "Got: $STOP"; exit 1; }
  COUNT=$(sqlite3 "$DB" "SELECT block_count FROM workflow_turn")
  [ "$COUNT" = "$i" ] || { echo "FAIL: expected block_count=$i, got $COUNT"; exit 1; }
done

# 第 4 次：兜底逃生，放行
STOP4=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-stop.mjs")
if echo "$STOP4" | grep -q '"decision"'; then
  echo "FAIL: 4th call should escape (block_count>=3), not block"
  echo "Got: $STOP4"
  exit 1
fi

echo "PASS: scenario-C"
