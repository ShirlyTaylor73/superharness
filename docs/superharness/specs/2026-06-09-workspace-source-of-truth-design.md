# Workspace Source of Truth Design

## Summary

Superharness must use one authoritative workspace source for Claude Code runtime state: `CLAUDE_PROJECT_DIR`.

The current implementation splits workflow state because hooks derive `workspaceRoot` from hook input `cwd`, while MCP tools require the agent to pass `workspaceRoot` manually. In Claude Code, `cwd` is not the stable project identity. It can differ from the project root when sessions run from a shell home, remote environment, worktree flow, or with additional working directories. Claude Code exposes `CLAUDE_PROJECT_DIR` specifically as the stable project root for hooks, and stdio MCP servers can receive it through the process environment.

The fix is to remove agent-provided workspace selection from the MCP API and make hooks, MCP tools, and workflow state storage all resolve the same workspace from `CLAUDE_PROJECT_DIR`.

## Problem

Observed failure:

- MCP `transition_state` advances the real project state to `exploration`.
- The next `UserPromptSubmit` injection still renders `current_state: intake` and `previous_state: null`.

Root cause:

- `workflow-context.mjs` uses `input.cwd || process.cwd()` as the workspace.
- MCP tools require `args.workspaceRoot`, so the agent may pass a different project path.
- `state.js` derives both DB path and `workspace_id` from the supplied workspace.
- When hook `cwd` and MCP `workspaceRoot` differ, Superharness reads or writes different workflow rows, and may even use different `.superharness/workflow-state.db` files.

This is not just a caller mistake. The public MCP schema currently asks the agent to provide runtime identity on every state operation. That is an invalid contract for a workflow harness.

## Goals

- Make Claude Code workspace identity deterministic.
- Remove `workspaceRoot` from normal MCP tool schemas.
- Ensure `UserPromptSubmit`, `Stop`, `PostToolUse`, MCP state reads, and MCP state writes operate on the same DB and same `workspace_id`.
- Fail clearly when no trusted project root is available.
- Avoid heuristic mixing such as transcript path decoding, recent file guessing, or directory marker scans.

## Non-Goals

- Do not infer the "real" project from additional working directories.
- Do not support multiple active Superharness workspaces in one Claude Code session.
- Do not preserve legacy agent-facing `workspaceRoot` usage.
- Do not use `input.cwd` as a fallback source of truth.
- Do not redesign the workflow state machine.

## Source of Truth

For Claude Code, the authoritative workspace root is:

```text
process.env.CLAUDE_PROJECT_DIR
```

Rules:

- Hooks resolve workspace from `CLAUDE_PROJECT_DIR`.
- MCP server resolves workspace from `CLAUDE_PROJECT_DIR`.
- `cwd` is diagnostic only.
- If `CLAUDE_PROJECT_DIR` is absent or empty, Superharness returns a stop-work or structured error instead of initializing state under `cwd`.

Rationale:

- Claude Code distinguishes stable project root from current working directory.
- Hook input includes `cwd`, but it is not the project identity.
- Claude Code exports `CLAUDE_PROJECT_DIR` to hook subprocesses as the stable project root.
- Claude Code stdio MCP servers can receive environment variables, so plugin MCP config should pass `CLAUDE_PROJECT_DIR` through to the Superharness MCP process.

## API Design

MCP tool schemas should no longer require or expose `workspaceRoot`.

Affected tools:

- `get_state`
- `classify_request`
- `transition_state`
- `list_history`
- `release_stop_block`

Example target schema for `transition_state`:

```json
{
  "type": "object",
  "required": ["from_state", "to_state", "reason"],
  "properties": {
    "from_state": { "type": "string" },
    "to_state": { "type": "string" },
    "previous_state": { "type": "string" },
    "reason": { "type": "string" }
  }
}
```

If a caller still passes `workspaceRoot`, it is ignored or rejected as an unknown implementation detail. User-facing prompts and command docs must stop mentioning it.

## Runtime Design

Add a shared resolver module used by hooks and MCP server code:

```text
workflow-state-server/workspace.js
```

Responsibilities:

- `resolveTrustedWorkspaceRoot(env = process.env)`
  - returns normalized `CLAUDE_PROJECT_DIR`
  - throws if missing or blank
- optionally includes a small diagnostic helper that reports both `CLAUDE_PROJECT_DIR` and observed `cwd` for error messages

Hook behavior:

- `workflow-context.mjs` calls `resolveTrustedWorkspaceRoot(process.env)`.
- `workflow-stop.mjs` calls the same resolver.
- `workflow-post-transition.mjs` should use the same resolver for free-mode and graph loading context.
- Hook input `cwd` remains available only in diagnostics.

MCP behavior:

- `server.js` creates runtime from `resolveTrustedWorkspaceRoot(process.env)`.
- All tool handlers use that runtime workspace.
- Store opening uses the same workspace-derived DB path as state operations.
- Tool handlers do not read workspace identity from user-controlled arguments.

State behavior:

- `resolveWorkflowDbPath({ workspaceRoot })` remains available internally.
- State functions can continue accepting `workspaceRoot` internally for tests and scripts.
- Public MCP handlers provide the trusted workspace root, not agent arguments.

## Claude Plugin Configuration

The plugin MCP config must ensure the stdio MCP server receives `CLAUDE_PROJECT_DIR`.

Target shape:

```json
{
  "mcpServers": {
    "superharness-workflow-state": {
      "command": "node",
      "args": ["workflow-state-server/bootstrap.js"],
      "cwd": ".",
      "env": {
        "CLAUDE_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}"
      }
    }
  }
}
```

If Claude Code already passes the parent environment through, this is still useful as an explicit contract in plugin configuration.

## Error Handling

When `CLAUDE_PROJECT_DIR` is unavailable:

- `UserPromptSubmit` injects a stop-work block:
  - runtime status unavailable
  - reason: `CLAUDE_PROJECT_DIR is required to resolve the Superharness workspace`
  - instruction: start Claude Code from a project directory or ensure the plugin runtime receives `CLAUDE_PROJECT_DIR`
- MCP tools return structured errors with the same reason.
- No DB is created under `cwd`.
- No fallback state initialization occurs.

When `CLAUDE_PROJECT_DIR` points to a missing path:

- Treat it as invalid and stop with a clear error.
- Do not fall back to `cwd`.

## Test Plan

Add focused regression coverage:

- Hook resolver uses `CLAUDE_PROJECT_DIR` even when input `cwd` differs.
- `workflow-context.mjs` injects the state from `<CLAUDE_PROJECT_DIR>/.superharness/workflow-state.db`.
- MCP `transition_state` schema no longer includes `workspaceRoot`.
- MCP `transition_state` writes to the DB for `CLAUDE_PROJECT_DIR`.
- MCP and hook remain synchronized when:
  - hook input `cwd = sessionRoot`
  - `CLAUDE_PROJECT_DIR = projectRoot`
  - MCP transitions `intake -> exploration`
  - next hook injection renders `current_state: exploration`
- Missing `CLAUDE_PROJECT_DIR` produces a structured error and does not create a `.superharness` DB under cwd.

Run:

```bash
cd plugins/superharness/workflow-state-server && npm test
npm run test:installer
```

If hook scenario shell tests are updated:

```bash
bash tests/hooks/scenario-A.test.sh
bash tests/hooks/scenario-B.test.sh
bash tests/hooks/scenario-G.test.sh
```

## Documentation Updates

Update user-facing docs and command instructions:

- README MCP/tool usage examples should not mention `workspaceRoot`.
- `commands/rollback.md` and `commands-codex/rollback.md` should not instruct agents to call `list_history(workspaceRoot=...)`.
- Any skill text that tells agents to pass workspace paths to MCP tools should be updated.

## Open Questions

None for Claude Code.

Codex support may need a separate source-of-truth decision if it does not expose an equivalent project-root environment variable. That should be handled as a separate design rather than weakening the Claude Code contract.
