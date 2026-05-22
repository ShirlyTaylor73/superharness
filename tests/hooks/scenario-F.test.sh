#!/bin/bash
# Scenario F: /rollback 流程 — intake → brainstorming → planning → rollback to brainstorming
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

WS_RAW=$(mktemp -d)
WS=$(cygpath -m "$WS_RAW" 2>/dev/null || echo "$WS_RAW")
DB="$WS/.superharness/workflow-state.db"
mkdir -p "$WS/.superharness"

# 0. UserPromptSubmit 创建 initial state (intake) + turn
echo "{\"cwd\":\"$WS\"}" | node "$REPO_ROOT/plugins/superharness/hooks/workflow-context.mjs" > /dev/null

# 1. 拿 DB 里真实的 workspace_id 格式（与 path.resolve 在 node 中返回值一致）
WS_IN_DB=$(sqlite3 "$DB" "SELECT workspace_id FROM workflow_state LIMIT 1")
[ -n "$WS_IN_DB" ] || { echo "FAIL: workflow_state row missing"; exit 1; }

# 2. 模拟 intake → brainstorming → planning（直接写表，rollback 校验只看 transition_log）
NOW1=$(date +%s%3N 2>/dev/null || python -c 'import time; print(int(time.time()*1000))')
sqlite3 "$DB" "UPDATE workflow_state SET state='planning', updated_at=$NOW1 WHERE workspace_id='$WS_IN_DB'"
sqlite3 "$DB" "INSERT INTO workflow_transition_log (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at) VALUES ('$WS_IN_DB', 'intake', 'brainstorming', NULL, 'test', 'agent-tool', NULL, $NOW1)"
NOW2=$((NOW1 + 100))
sqlite3 "$DB" "INSERT INTO workflow_transition_log (workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at) VALUES ('$WS_IN_DB', 'brainstorming', 'planning', NULL, 'test', 'agent-tool', NULL, $NOW2)"

# 3. 执行 rollback to brainstorming
OUTPUT=$(node "$REPO_ROOT/plugins/superharness/scripts/rollback.mjs" "$WS" brainstorming "[rollback] scenario F" 2>&1)
echo "$OUTPUT" | grep -q "已从 planning 回到 brainstorming" || { echo "FAIL: rollback output unexpected: $OUTPUT"; exit 1; }

# 4. 断言 workflow_state.state = brainstorming
STATE=$(sqlite3 "$DB" "SELECT state FROM workflow_state WHERE workspace_id='$WS_IN_DB'")
[ "$STATE" = "brainstorming" ] || { echo "FAIL: state should be brainstorming, got: $STATE"; exit 1; }

# 5. 断言 transition_log 多一条 [rollback] 前缀
ROLLBACK_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM workflow_transition_log WHERE workspace_id='$WS_IN_DB' AND reason LIKE '[rollback]%'")
[ "$ROLLBACK_COUNT" = "1" ] || { echo "FAIL: expected 1 [rollback] log, got: $ROLLBACK_COUNT"; exit 1; }

# 6. 断言 workflow_turn 被 DELETE（rollback 清零路径；turn_id NOT NULL 约束所以走 DELETE 而非 SET NULL）
TURN_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM workflow_turn WHERE workspace_id='$WS_IN_DB'")
[ "$TURN_COUNT" = "0" ] || { echo "FAIL: expected workflow_turn deleted, got count: $TURN_COUNT"; exit 1; }

echo "PASS: scenario-F"
