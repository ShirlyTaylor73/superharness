#!/bin/bash
# Scenario A: 单轮内多次 chain — intake → trivial → intake
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

WS_RAW=$(mktemp -d)
WS=$(cygpath -m "$WS_RAW" 2>/dev/null || echo "$WS_RAW")
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

# 0. UserPromptSubmit 创建 turn_id
echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs" > /dev/null
TURN=$(sqlite3 "$DB" "SELECT turn_id FROM workflow_turn")
[ -n "$TURN" ] || { echo "FAIL: no turn_id created"; exit 1; }

# 1. 模拟 transition_state(intake → trivial) 写 transition_log
sqlite3 "$DB" "INSERT INTO workflow_transition_log (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at) VALUES ('$WS', 'intake', 'trivial', NULL, 'test scenario A', 'agent-tool', '$TURN', $(date +%s%3N 2>/dev/null || python -c 'import time; print(int(time.time()*1000))'))"

# 2. PostToolUse 注入 trivial SKILL
INJECT=$(echo "{\"cwd\":\"$WS\",\"tool_input\":{\"to_state\":\"trivial\"}}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-post-transition.mjs")
echo "$INJECT" | grep -q "Active skill: trivial" || { echo "FAIL: trivial SKILL not injected"; echo "Got: $INJECT"; exit 1; }

# 3. 模拟 transition_state(trivial → intake)
sqlite3 "$DB" "INSERT INTO workflow_transition_log (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at) VALUES ('$WS', 'trivial', 'intake', NULL, 'back to intake', 'agent-tool', '$TURN', $(date +%s%3N 2>/dev/null || python -c 'import time; print(int(time.time()*1000))'))"

# 4. Stop hook 检查 — 本轮有 ≥1 条 transition，应该放行
STOP=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-stop.mjs")
if echo "$STOP" | grep -q '"decision"'; then
  echo "FAIL: Stop blocked when transition exists"
  echo "Got: $STOP"
  exit 1
fi

echo "PASS: scenario-A"
