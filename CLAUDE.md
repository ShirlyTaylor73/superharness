# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Superharness is a **plugin/extension** distributed to multiple AI coding agents (Claude Code, Codex, Gemini, etc.). It is *not* an application — it is a runtime that ships into other agents to enforce a programmatic workflow state machine over their normal "skill" behavior. Nothing here is meant to be run standalone except the tests and the MCP server.

The repo root is the marketplace; the actual plugin lives at [plugins/superharness/](plugins/superharness/). Most edits happen there.

## Common commands

Run the workflow-state MCP server's unit tests (Node + Vitest):

```bash
cd plugins/superharness/workflow-state-server
npm.cmd test            # Windows
npm test                # Unix
```

Run a single Vitest file:

```bash
cd plugins/superharness/workflow-state-server
npx vitest run test/state.test.js
```

Run the brainstorm-server tests:

```bash
cd tests/brainstorm-server
npm test
```

Run skill-trigger probes (sends prompts to Claude Code itself and asserts the right skill activates):

```bash
bash tests/skill-triggering/run-all.sh
bash tests/skill-triggering/run-test.sh <skill-name> <prompt-file> <trials>
```

There is no top-level build, lint, or package step — `package.json` is a stub for marketplace metadata.

## Architecture

### Workflow state machine

The center of the system is a **YAML-described state machine** in [plugins/superharness/workflow/default-workflow.yaml](plugins/superharness/workflow/default-workflow.yaml). States map 1:1 to skills. The v3 flow enters at `intake`, which classifies the request and routes to one of three branches: `exploration` (read-only questions), `trivial` (low-risk one-shot changes), or `brainstorming` → `planning` → `serial_execution` / `parallel_execution` → `verification` → `finishing`. All branches loop back to `intake` (there is no terminal `done` state — `entryState: intake`, `terminalStates: []`), and `systematic_debugging` remains a preemptive side branch reachable from execution/gate states. Allowed transitions are explicitly enumerated per state; nothing else is permitted.

State per workspace is persisted in `<workspace>/.superharness/workflow-state.db` (SQLite, schema at [plugins/superharness/workflow-state-server/schema.sql](plugins/superharness/workflow-state-server/schema.sql)). The DB has two tables: current state per workspace + an append-only transition log with `reason` and `source` columns for audit.

### Two integration paths, one engine

The same workflow engine ([plugins/superharness/workflow-state-server/](plugins/superharness/workflow-state-server/)) is consumed two different ways:

1. **MCP server** ([server.js](plugins/superharness/workflow-state-server/server.js)) — exposes `get_state`, `classify_request`, `transition_state`, `list_history`, `reset_state` as MCP tools. This is how agents read/mutate state.
2. **Hook scripts** ([plugins/superharness/hooks/](plugins/superharness/hooks/)) — `workflow-context.mjs` runs on `UserPromptSubmit` and prints rendered workflow context into the agent's context window; `workflow-pre-tool-use.mjs` runs on `PreToolUse` and denies any tool call that would write into `.superharness/` directly. Both are invoked by [run-hook.cmd](plugins/superharness/hooks/run-hook.cmd), a polyglot batch/bash wrapper that finds Git Bash on Windows and execs the extensionless script.

Two configs feed the two clients: [hooks.json](plugins/superharness/hooks/hooks.json) (Claude Code) and [hooks-codex.json](plugins/superharness/hooks/hooks-codex.json) (Codex). They differ mainly in the `matcher` set (Codex has `apply_patch`, Claude has `MultiEdit`).

### Context rendering

[render-context.js](plugins/superharness/workflow-state-server/render-context.js) is what gets injected on every turn. It emits a `<SUPERHARNESS_WORKFLOW_STATE>` block containing: runtime facts (current/previous state, active skill, allowed transitions), rules, and the **full contents of the active skill's SKILL.md** with frontmatter stripped. Router states render a router guard instead of a skill.

If the workflow engine fails to load, `renderStopWorkContext` emits a "stop business work" block — agents are expected to surface the error rather than invent state.

### Skills

State-machine driven active skills live under [plugins/superharness/skills/](plugins/superharness/skills/), each as a directory with a `SKILL.md`. The state machine references them by directory name (e.g. the `planning` state binds to `skills/planning/`, `serial_execution` → `skills/serial-execution/`, `verification` → `skills/verification/`, `finishing` → `skills/finishing/`). The `using-superpowers` skill is intentionally archived at [archived-skills/](plugins/superharness/archived-skills/) — it must NOT be moved back into `skills/`; it would re-establish the old "entry skill" model that the workflow context injection replaced.

When `validate-workflow.js` builds the workflow graph it checks every referenced skill against the set of installed skills under `skills/`. A YAML state that points to a missing skill will fail validation, which then propagates through the hook as the "stop work" context.

### State-edit guard

Agents must never write `.superharness/` directly. [workflow-pre-tool-use.mjs](plugins/superharness/hooks/workflow-pre-tool-use.mjs) checks tool args for `.superharness/` path mentions and (for Bash) for write-like commands (`>`, `rm`, `mv`, `sqlite3`, etc.). All mutations must go through the MCP `transition_state` / `classify_request` / `reset_state` tools, every one of which requires a non-empty `reason` string that lands in the transition log.

## Conventions that aren't obvious

- **`reason` is mandatory and audited.** Every state-mutating MCP tool requires a non-empty `reason`. Don't pass placeholder strings; the transition log is the audit record for why workflow state changed.
- **Hook scripts are extensionless on purpose.** `workflow-context` (no `.sh`) exists because Claude Code's Windows auto-detection prepends `bash` to anything ending in `.sh`. Don't rename them.
- **Two SQLite drivers.** [state.js](plugins/superharness/workflow-state-server/state.js) picks `bun:sqlite` when running under Bun and `better-sqlite3` otherwise. Don't import a driver directly.
- **Workspace-scoped DB path.** `resolveWorkflowDbPath` writes to `<workspaceRoot>/.superharness/workflow-state.db` unless `SUPERHARNESS_WORKFLOW_STATE_DB` overrides it; tests use `SUPERHARNESS_WORKFLOW_STATE_MODE=memory` for `:memory:`.
- **Bash on Windows.** This repo is developed on Windows but expects Git Bash for the `.sh` test scripts. The hook wrapper handles bash discovery automatically; the test runners assume it's on PATH or at `D:\Git\bin\bash.exe`.
- **Project language is Chinese.** The README, `GEMINI.md`, and many skill docs are in Chinese. When editing skills or user-facing docs, match the existing language of that file.
- **Version bumps touch four files.** `package.json`, [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json), [plugins/superharness/.claude-plugin/plugin.json](plugins/superharness/.claude-plugin/plugin.json), and [plugins/superharness/.codex-plugin/plugin.json](plugins/superharness/.codex-plugin/plugin.json) all carry the version string and must move together.
- **MCP server self-heal lives in `bootstrap.js`, not in any hook.** Claude Code spawns the MCP server via `node bootstrap.js` directly, bypassing every UserPromptSubmit / PreToolUse hook. The hook-based dep self-heal in [workflow-context.mjs](plugins/superharness/hooks/workflow-context.mjs) only covers the hook path — the MCP entrypoint needs its own check. [bootstrap.js](plugins/superharness/workflow-state-server/bootstrap.js) does a sync `existsSync` for `node_modules/@modelcontextprotocol/sdk`, runs `npm install --omit=dev` (stderr only — stdout would corrupt MCP stdio) if missing, then dynamic-imports `server.js`. Don't move the import of `@modelcontextprotocol/sdk` out of `server.js`; the wrapper pattern keeps the real server file clean and lets static imports stay at the top.
- **`manifest.hooks` is only for ADDITIONAL hook files.** Claude Code auto-loads `<plugin_root>/hooks/hooks.json` as the standard location; pointing `manifest.hooks` at that same standard file triggers `Duplicate hooks file detected`. Codex DOES need the field set because it doesn't auto-discover (Codex looks for `hooks-codex.json` via the field; absence means no hooks). Hook commands in `hooks-codex.json` must use `${PLUGIN_ROOT}` (Codex official) or `${CLAUDE_PLUGIN_ROOT}` (OOTB compat alias) — Codex sets hook cwd to the session dir, not the plugin root. Additionally, Codex versions before commit `14473c216f` (2026-05-13) require explicit opt-in via `[features].plugin_hooks = true` in user config; current behavior is on by default.
