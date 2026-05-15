#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLUGIN="$ROOT/plugins/superharness/.opencode/plugins/superharness.js"
HOOKS="$ROOT/plugins/superharness/hooks/hooks.json"
CODEX_HOOKS="$ROOT/plugins/superharness/hooks/hooks-codex.json"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

grep -q "experimental.chat.system.transform" "$PLUGIN" || fail "missing system transform hook"
grep -q "tool.execute.before" "$PLUGIN" || fail "missing tool execute guard"
grep -q "superharness-workflow-state" "$PLUGIN" || fail "missing workflow state MCP registration"
grep -q "workflow-state-server/state.js" "$PLUGIN" || fail "missing dynamic state.js import"
grep -q "workflow-state-server/render-context.js" "$PLUGIN" || fail "missing dynamic render-context.js import"
grep -q "ensureWorkflowStateDeps" "$PLUGIN" || fail "missing dependency check"
grep -q ".superharness/" "$PLUGIN" || fail "missing .superharness write protection"
grep -q "UserPromptSubmit" "$HOOKS" || fail "Claude hooks missing UserPromptSubmit"
grep -q "UserPromptSubmit" "$CODEX_HOOKS" || fail "Codex hooks missing UserPromptSubmit"
grep -q '"matcher": "Bash|apply_patch|Write|Edit"' "$CODEX_HOOKS" || fail "Codex PreToolUse matcher does not cover Bash/apply_patch/Write/Edit"

if grep -R "SessionStart\|session-start\|using-superpowers\|superpowers:using\|superharness:using\|You have superpowers" \
  "$ROOT/plugins/superharness/.opencode" \
  "$ROOT/plugins/superharness/hooks" >/dev/null 2>&1; then
  fail "runtime plugin or hooks still reference deprecated using-superpowers bootstrap"
fi

if grep -Eq "^import .*workflow-state-server" "$PLUGIN"; then
  fail "OpenCode plugin must not statically import workflow-state-server modules"
fi

bad_phrase="Claude/Codex system prompt"
bad_phrase="${bad_phrase} injection"
if grep -R "$bad_phrase" "$ROOT/plugins" "$ROOT/tests" >/dev/null 2>&1; then
  fail "Claude/Codex context injection terminology is incorrect in plugin code or tests"
fi

echo "workflow state OpenCode contract ok"


