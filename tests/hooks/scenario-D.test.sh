#!/bin/bash
# Scenario D: transition_state 工具失败 → PostToolUse fail-open
# 验证：PostToolUse 在 missing/invalid input 时输出 {} 不阻塞 agent
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# 1. 缺 to_state → fail-open
OUT=$(echo '{"cwd":"/tmp","tool_input":{}}' | node "$REPO_ROOT/plugins/superharness/hooks/workflow-post-transition.mjs")
[ "$OUT" = "{}" ] || { echo "FAIL: missing to_state should fail-open, got: $OUT"; exit 1; }

# 2. 无效 JSON → fail-open
OUT2=$(echo 'not json' | node "$REPO_ROOT/plugins/superharness/hooks/workflow-post-transition.mjs")
[ "$OUT2" = "{}" ] || { echo "FAIL: invalid input should fail-open, got: $OUT2"; exit 1; }

# 3. unknown state → fail-open（SKILL 找不到）
OUT3=$(echo '{"cwd":"/tmp","tool_input":{"to_state":"nonexistent_state_xyz"}}' | node "$REPO_ROOT/plugins/superharness/hooks/workflow-post-transition.mjs")
[ "$OUT3" = "{}" ] || { echo "FAIL: unknown state should fail-open, got: $OUT3"; exit 1; }

echo "PASS: scenario-D"
