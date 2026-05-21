#!/bin/bash
# Scenario B: brainstorming 多轮等审 → 批准 → chain 到 planning
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

WS_RAW=$(mktemp -d)
WS=$(cygpath -m "$WS_RAW" 2>/dev/null || echo "$WS_RAW")
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

now_ms() { date +%s%3N 2>/dev/null || python -c 'import time; print(int(time.time()*1000))'; }

# 0. UserPromptSubmit 轮 N — 创建 turn_1
echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs" > /dev/null
TURN1=$(sqlite3 "$DB" "SELECT turn_id FROM workflow_turn")

# 模拟 agent 当前在 brainstorming
sqlite3 "$DB" "UPDATE workflow_state SET state='brainstorming', active_skill='brainstorming' WHERE workspace_id='$WS'"

# 1. 本轮 agent 输出"请审 spec"，不切态 → Stop 检查
STOP1=$(echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-stop.mjs")
if echo "$STOP1" | grep -q '"decision"'; then
  echo "FAIL: brainstorming silent stop should pass (silent_stop_allowed=true)"
  echo "Got: $STOP1"
  exit 1
fi

# 2. 下一轮用户回复 → UserPromptSubmit 创建新 turn_2
echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs" > /dev/null
TURN2=$(sqlite3 "$DB" "SELECT turn_id FROM workflow_turn")
[ "$TURN1" != "$TURN2" ] || { echo "FAIL: new turn_id not generated on second UserPromptSubmit"; exit 1; }

# 3. 模拟 agent 调 transition(brainstorming → planning) 写 log
sqlite3 "$DB" "INSERT INTO workflow_transition_log (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at) VALUES ('$WS', 'brainstorming', 'planning', NULL, 'spec approved by user', 'agent-tool', '$TURN2', $(now_ms))"

# 4. PostToolUse 无脑注入 planning SKILL
INJECT=$(echo "{\"cwd\":\"$WS\",\"tool_input\":{\"to_state\":\"planning\"}}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-post-transition.mjs")
echo "$INJECT" | grep -q "Active skill: planning" || { echo "FAIL: planning SKILL not injected"; echo "Got: $INJECT"; exit 1; }

echo "PASS: scenario-B"
