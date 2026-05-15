import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pluginRoot = path.resolve('..');
const hooksDir = path.join(pluginRoot, 'hooks');
const workflowContext = path.join(hooksDir, 'workflow-context.mjs');
const workflowPreToolUse = path.join(hooksDir, 'workflow-pre-tool-use.mjs');

function runNode(script, {
  input = {},
  env = {},
  cwd = mkdtempSync(path.join(tmpdir(), 'superharness-hook-cwd-')),
} = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    env: {
      ...process.env,
      SUPERHARNESS_WORKFLOW_STATE_DB: path.join(cwd, '.superharness', 'workflow-state.db'),
      ...env,
    },
    input: JSON.stringify(input),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`hook failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

describe('workflow-context hook CLI', () => {
  it('outputs Claude UserPromptSubmit additionalContext without systemMessage', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'superharness-hook-'));
    const output = runNode(workflowContext, {
      cwd,
      env: { CLAUDE_PLUGIN_ROOT: pluginRoot },
      input: { cwd, hook_event_name: 'UserPromptSubmit' },
    });

    expect(output.systemMessage).toBeUndefined();
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain('<SUPERHARNESS_WORKFLOW_STATE>');
  });

  it('outputs Codex UserPromptSubmit additionalContext', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'superharness-hook-'));
    const output = runNode(workflowContext, {
      cwd,
      env: { CODEX_PLUGIN_ROOT: pluginRoot },
      input: { cwd, hook_event_name: 'UserPromptSubmit' },
    });

    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain('current_state: brainstorming');
  });

  it('renders stop-work context on configuration failure', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'superharness-hook-'));
    const output = runNode(workflowContext, {
      cwd,
      env: { CLAUDE_PLUGIN_ROOT: path.join(cwd, 'missing-plugin') },
      input: { cwd, hook_event_name: 'UserPromptSubmit' },
    });

    expect(output.hookSpecificOutput.additionalContext).toContain('Stop business work');
    expect(output.hookSpecificOutput.additionalContext).toContain('workflow');
  });
});

describe('workflow-pre-tool-use hook CLI', () => {
  it('denies writes touching .superharness', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'superharness-hook-'));
    const output = runNode(workflowPreToolUse, {
      cwd,
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'echo bad > .superharness/workflow-state.db',
        },
      },
    });

    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('do not edit .superharness/');
  });

  it('does not deny read-only access', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'superharness-hook-'));
    const output = runNode(workflowPreToolUse, {
      cwd,
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'cat .superharness/workflow-state.db',
        },
      },
    });

    expect(output.hookSpecificOutput).toBeUndefined();
  });
});
