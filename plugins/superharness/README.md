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

## Development

```bash
cd workflow-state-server
npm.cmd test
```
