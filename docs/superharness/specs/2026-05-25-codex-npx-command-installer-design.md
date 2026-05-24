# Codex npx command installer design

Date: 2026-05-25

## Background

Superharness currently supports Codex through the Codex plugin manifest at
`plugins/superharness/.codex-plugin/plugin.json`, which exposes skills, hooks,
and the workflow-state MCP server. This does not cover Claude Code-style plugin
commands. Codex CLI slash commands are built-in, enum-dispatched commands, and
Codex plugin marketplace installation does not install custom command markdown.

Superharness v1.4.0 added Claude Code slash commands:

- `/free`
- `/rollback`

Those commands are implemented as Claude command markdown under
`plugins/superharness/commands/`. They rely on Claude Code's native command
execution syntax, for example `!node ...`, which executes during command
rendering instead of being presented to the agent as normal instructions.

Codex does not support that native command execution behavior in custom command
markdown. For Codex compatibility, Superharness needs a separate npx-based
installer that copies both the plugin runtime and Codex-compatible command
markdown into Codex-visible locations.

## Goals

1. Provide a one-command installer similar in spirit to
   `npx superpowers-zh@latest`.
2. Install Superharness Codex assets without relying on Codex plugin marketplace
   support for custom commands.
3. Install only the supported Codex commands for this feature:
   `free` and `rollback`.
4. Convert Claude Code command markdown into Codex-compatible prompt
   instructions, where the Codex agent directly executes the equivalent shell
   command through its shell tool.
5. Keep dependency installation in the installer, not inside command markdown.
6. Preserve the current Superharness safety model as much as possible while
   accepting that Codex command execution is agent-mediated rather than
   render-time native execution.

## Non-goals

- Do not add native slash command support to Codex itself.
- Do not implement a generic Claude command migration engine.
- Do not expose rollback or free-mode as new mutating MCP tools.
- Do not place dependency self-healing logic inside `free.md` or `rollback.md`.
- Do not broaden Codex command support beyond `free` and `rollback` in this
  change.

## User experience

Running the installer with no explicit target starts an interactive TTY flow:

```bash
npx superharness@latest
```

The installer shows a direction-key selection menu:

```text
Where should Superharness Codex support be installed?

> Project install  Install into this repository's .codex directory
  User install     Install into ~/.codex for all Codex projects
  Cancel
```

The default highlighted option is `Project install` when a project `.codex`
directory is detected. Otherwise, the default highlighted option is
`User install`.

The installer also supports non-interactive flags:

```bash
npx superharness@latest --project
npx superharness@latest --user
npx superharness@latest --force
```

When stdin/stdout is not a TTY, or when `CI` is set, the installer must not
prompt. If neither `--project` nor `--user` is provided, it exits with a clear
usage error.

## Install layout

### Project install

Project install writes:

```text
<repo>/.codex/plugins/superharness/
<repo>/.codex/commands/free.md
<repo>/.codex/commands/rollback.md
```

The copied plugin directory is a self-contained copy of
`plugins/superharness/`, including:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `hooks/`
- `scripts/`
- `skills/`
- `workflow/`
- `workflow-state-server/`

### User install

User install writes:

```text
~/.codex/plugins/superharness/
~/.codex/commands/free.md
~/.codex/commands/rollback.md
```

On Windows, `~` resolves through the user's home directory. For the common local
environment this is `C:\Users\<User>\.codex`.

## Overwrite policy

Existing installed assets are backed up before overwrite. Backup names include a
timestamp:

```text
.codex/commands/free.md.bak-20260525-153000
.codex/commands/rollback.md.bak-20260525-153000
.codex/plugins/superharness.bak-20260525-153000
```

The default behavior is backup-then-overwrite. `--force` keeps the same
overwrite behavior but may suppress confirmation prompts if any are added later.

The installer must never delete unrelated files under `.codex/` or `~/.codex/`.

## Dependency handling

The installer is responsible for preparing the copied plugin runtime.

After copying `plugins/superharness/`, the installer runs dependency
installation for:

```text
<installed-plugin-root>/workflow-state-server/
```

The install command is:

```bash
npm install --omit=dev
```

This keeps `free.md` and `rollback.md` focused on workflow control rather than
dependency repair. The existing MCP `bootstrap.js` self-heal remains useful for
MCP startup, but command markdown must not duplicate that behavior.

## Codex command markdown

Codex command markdown is generated from the two Claude Code commands, but it
uses Codex-compatible prompt instructions.

Files:

```text
plugins/superharness/commands-codex/free.md
plugins/superharness/commands-codex/rollback.md
```

Installed target:

```text
.codex/commands/free.md
.codex/commands/rollback.md
```

The files retain compatible frontmatter:

```yaml
---
description: ...
allowed-tools: ...
---
```

Codex is not assumed to parse `allowed-tools`; the field is retained as
human-readable compatibility metadata.

### `free.md`

The Codex version supports the same user-facing actions as the Claude Code
version:

- `on`
- `off`
- `status`

The command body instructs the agent to execute the equivalent Node script with
the installed plugin root:

```powershell
node "<installed-plugin-root>/scripts/set-free-mode.mjs" "<workspaceRoot>" "<on|off|status>"
```

For Git Bash or other POSIX shells, the same command can be represented as:

```bash
node "<installed-plugin-root>/scripts/set-free-mode.mjs" "<workspaceRoot>" "<on|off|status>"
```

The agent must report the script stdout briefly and stop. It must not perform
additional workflow transitions after running the command.

### `rollback.md`

The Codex version preserves the Claude Code workflow:

1. Use the workflow-state MCP `list_history` tool for the current workspace.
2. If the user supplied an argument, treat it as the target state and verify
   that it appears in transition history as a `to_state`.
3. If the user supplied no argument, present the most recent distinct historical
   states and ask the user which state to target.
4. Execute the rollback script:

```powershell
node "<installed-plugin-root>/scripts/rollback.mjs" "<workspaceRoot>" "<chosen_state>" "[rollback] 用户 /rollback <args>"
```

For Git Bash or other POSIX shells:

```bash
node "<installed-plugin-root>/scripts/rollback.mjs" "<workspaceRoot>" "<chosen_state>" "[rollback] 用户 /rollback <args>"
```

The command must preserve the current restriction that rollback to
`systematic_debugging` is refused by the script. The command markdown should not
try to bypass that guard.

After rollback, the agent reports the script stdout briefly and stops. It must
not call `transition_state`, and it must not continue work under the previous
state.

## Installed plugin root resolution

The installer writes the Codex command markdown with the concrete installed
plugin root baked into the command text.

For project install:

```text
<repo>/.codex/plugins/superharness
```

For user install:

```text
~/.codex/plugins/superharness
```

This avoids relying on `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, npx cache paths, or
Codex marketplace cache paths inside command markdown.

## CLI architecture

Add a Node.js CLI entrypoint under `bin/` and expose it through `package.json`.

Expected package shape:

```json
{
  "bin": {
    "superharness": "./bin/superharness.js"
  }
}
```

The root package must no longer be `private: true` when published.

The CLI responsibilities are:

1. Parse `--project`, `--user`, `--force`, and help flags.
2. If no target flag is provided and the process is interactive, show the
   direction-key selection menu.
3. Resolve install roots.
4. Backup existing targets.
5. Copy plugin runtime files.
6. Install `workflow-state-server` production dependencies.
7. Render and write Codex command markdown with the installed plugin root.
8. Print a concise success summary and next-step note.

The CLI should use only Node.js standard library unless a dependency is clearly
worth the package overhead. Direction-key selection can be implemented with
`readline.emitKeypressEvents` and raw-mode stdin.

## Error handling

- Missing Node.js `<20`: exit with an actionable error.
- Non-interactive run without `--project` or `--user`: exit with usage.
- Failed dependency install: fail the installation and report the failing path
  and command.
- Failed backup or copy: fail without deleting the original target.
- Unsupported command arguments in generated command markdown: the agent-facing
  instructions should show usage and stop.

## Tests

Add focused tests for the installer logic:

- Project install creates `.codex/plugins/superharness` and both command files.
- User install writes under a supplied fake home directory.
- Existing command files and plugin directory are backed up before overwrite.
- Generated command markdown contains the concrete installed plugin root.
- Non-interactive execution without target flags fails.
- `--project` and `--user` bypass interactive selection.

Existing workflow-state tests remain relevant:

```bash
cd plugins/superharness/workflow-state-server && npm test
```

The installer should also have a lightweight dry-run or temp-directory test that
does not mutate the developer's real `.codex` directory.

## Implementation notes

No open product decisions remain for this design. Implementation may still
choose exact helper function boundaries and test harness details.
