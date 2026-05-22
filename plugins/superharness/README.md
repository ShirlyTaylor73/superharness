# Superharness Plugin

This plugin package contains the Superharness runtime for AI coding agents.

It provides:

- State-machine driven skills for structured software development workflows.
- Claude Code / Codex hooks for workflow context injection and `.superharness/` write protection.
- A programmatic workflow state server backed by SQLite and configured by YAML.

## Layout

| Path | Purpose |
|---|---|
| `.claude-plugin/` | Claude Code plugin metadata |
| `.codex-plugin/` | Codex plugin metadata and interface metadata |
| `skills/` | Active skills discovered by supported agents |
| `workflow/` | Workflow graph configuration |
| `workflow-state-server/` | MCP server, state store, renderer, and tests |
| `hooks/` | Claude Code / Codex hook config and commands |
| `archived-skills/` | Historical disabled skills that must not be registered |

## Runtime Entry

The old text bootstrap entry has been removed from runtime. Superharness starts from workflow context:

- Claude Code / Codex: `UserPromptSubmit -> workflow-context`
- Claude Code / Codex: `PreToolUse -> workflow-pre-tool-use`
- State tools: `superharness-workflow-state`

## v1.4.0: User Control

v1.4.0 ships two slash commands that put rollback and pause decisions back in the user's hands:

- **`/rollback [state]`** — Roll the workflow back to a state that actually appeared in `transition_log`.
  - No argument: pick from a list of the last 5 unique states.
  - With argument (e.g. `/rollback brainstorming`): jump straight to that state.
- **`/free on|off|status`** — Session-level pause / resume of workflow context injection.
  - While free mode is on, hooks stop injecting `SKILL.md` and the mutating MCP tools (`transition_state` / `classify_request` / `reset_state` / `release_stop_block`) are locked.
  - `.superharness/` write protection is always on regardless of free mode.

> **Codex is not supported in v1.4.0** for these two commands. Codex slash commands are a hard-coded enum and plugins cannot contribute new ones today; we will revisit once Codex ships plugin-prompts.

## Development

```bash
cd workflow-state-server
npm.cmd test
```
