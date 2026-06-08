# Superharness Plugin

This plugin package contains the Superharness runtime for AI coding agents.

It provides:

- State-machine driven skills for structured software development workflows.
- Claude Code / Codex hooks for workflow context injection and `.superharness/` write protection.
- A programmatic workflow state server backed by SQLite and configured by YAML.
- User-controlled workflow rollback through `/rollback [state]`, limited to states that appear in `transition_log`.
- Session-level workflow context pause and resume through `/free on|off|status`, with mutating state tools locked while free mode is on.

## Layout

| Path | Purpose |
|---|---|
| `.claude-plugin/` | Claude Code plugin metadata |
| `.codex-plugin/` | Codex plugin metadata and interface metadata |
| `skills/` | Active skills discovered by supported agents |
| `workflow/` | Workflow graph configuration |
| `workflow-state-server/` | MCP server, state store, renderer, and tests |
| `hooks/` | Claude Code / Codex hook config and commands |
| `commands/` | Claude Code slash command markdown |
| `commands-codex/` | Codex command templates rendered by the npx installer |
| `archived-skills/` | Historical disabled skills that must not be registered |

## Runtime Entry

The old text bootstrap entry has been removed from runtime. Superharness starts from workflow context:

- Claude Code / Codex: `UserPromptSubmit -> workflow-context`
- Claude Code / Codex: `PreToolUse -> workflow-pre-tool-use`
- State tools: `superharness-workflow-state`

## Codex npx Install

Codex skills and command support are installed through the root package:

```bash
npx @shirlytaylor73/superharness@latest
```

The installer asks whether to install into the current project directories or the user-level directories. Project installs write skills to `.agents/skills/` and commands/runtime to `.codex/`; user installs write skills to `~/.agents/skills/` and commands/runtime to `~/.codex/`. Non-interactive installs can use:

```bash
npx @shirlytaylor73/superharness@latest --project
npx @shirlytaylor73/superharness@latest --user
```

The installer copies active skills from `skills/` into `.agents/skills/`. Codex command markdown currently supports `free` and `rollback`. `commands/` is the Claude Code version; `commands-codex/` is the Codex template source. During install, `commands-codex/` is rendered into `.codex/commands/` with the concrete absolute plugin path because Codex does not support Claude Code's `!node` native command execution syntax.

## Development

```bash
cd workflow-state-server
npm.cmd test
```
