#!/usr/bin/env bash
# Test: Plugin Loading
# Verifies that the Superharness plugin loads correctly in OpenCode
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Test: Plugin Loading ==="

# Source setup to create isolated environment
source "$SCRIPT_DIR/setup.sh"

# Trap to cleanup on exit
trap cleanup_test_env EXIT

# Test 1: Verify plugin file exists and is registered
echo "Test 1: Checking plugin registration..."
if [ -f "$HOME/opencode.json" ] && grep -q "file://$PLUGIN_FILE" "$HOME/opencode.json"; then
    echo "  [PASS] Plugin registered in opencode.json"
else
    echo "  [FAIL] Plugin registration not found in $HOME/opencode.json"
    exit 1
fi

if [ -f "$PLUGIN_FILE" ]; then
    echo "  [PASS] Plugin file exists"
else
    echo "  [FAIL] Plugin file does not exist at $PLUGIN_FILE"
    exit 1
fi

# Test 2: Verify skills directory is populated
echo "Test 2: Checking skills directory..."
skill_count=$(find "$INSTALLED_PLUGIN_ROOT/skills" -name "SKILL.md" | wc -l)
if [ "$skill_count" -gt 0 ]; then
    echo "  [PASS] Found $skill_count skills installed"
else
    echo "  [FAIL] No skills found in installed location"
    exit 1
fi

# Test 4: Check archived using-superpowers is not registered as an active skill
echo "Test 4: Checking using-superpowers is archived and disabled..."
if [ ! -f "$INSTALLED_PLUGIN_ROOT/skills/using-superpowers/SKILL.md" ] \
   && [ -f "$INSTALLED_PLUGIN_ROOT/archived-skills/using-superpowers/SKILL.md" ]; then
    echo "  [PASS] using-superpowers is archived outside active skills"
else
    echo "  [FAIL] using-superpowers should be archived outside skills/"
    exit 1
fi

# Test 5: Verify plugin JavaScript syntax (basic check)
echo "Test 5: Checking plugin JavaScript syntax..."
plugin_file="$INSTALLED_PLUGIN_ROOT/.opencode/plugins/superharness.js"
if node --check "$plugin_file" 2>/dev/null; then
    echo "  [PASS] Plugin JavaScript syntax is valid"
else
    echo "  [FAIL] Plugin has JavaScript syntax errors"
    exit 1
fi

# Test 6: Verify personal test skill was created
echo "Test 6: Checking test fixtures..."
if [ -f "$HOME/.config/opencode/skills/personal-test/SKILL.md" ]; then
    echo "  [PASS] Personal test skill fixture created"
else
    echo "  [FAIL] Personal test skill fixture not found"
    exit 1
fi

echo ""
echo "=== All plugin loading tests passed ==="
