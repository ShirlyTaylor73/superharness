# Codex Plugin Fix v1.2.4 — 设计规格

## 背景

v1.2.3 发布后，用户报告 Codex `/plugins` 面板里 superharness 显示：

- ✅ Skills: 22 条加载正常
- ❌ **Hooks: No plugin hooks.**
- ❌ **MCP Servers: No plugin MCP servers.**
- ❌ Apps: No plugin apps.（预期，apps 本来就没配）

根因调研定位到三个独立缺陷，本规格统一在 v1.2.4 patch 中修复。

## 根因

### R1：Codex 的 `Feature::PluginHooks` 在旧版默认关闭

Codex 上游在 2026-05-13 commit `14473c216f` 才把 `plugin_hooks` 标为 `default_enabled: true`（[features/src/lib.rs:970-975](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/features/src/lib.rs#L970-L975)）。用户本机 `codex-cli 0.130.0` 早于此提交，所以本机 `plugin_hooks` 默认 false，[manager.rs:1392-1405](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/core-plugins/src/manager.rs#L1392-L1405) 直接走 `Vec::new()` 分支不加载 hooks。

**性质：** 用户配置问题。仓库侧只能用文档兜底，不能代码自动修复。

### R2：hooks-codex.json 的 command 路径用相对路径

`plugins/superharness/hooks/hooks-codex.json` 当前两条 command 是 `./hooks/run-hook.cmd ...`。但 Codex 的 hook 子进程 cwd 来自 `turn_context.cwd`（用户的 session 目录），不是 plugin root（[hooks/src/engine/command_runner.rs:35](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/hooks/src/engine/command_runner.rs#L35) `.current_dir(cwd)` ← [core/src/hook_runtime.rs:120,155,215,256,284,322](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/core/src/hook_runtime.rs#L120) 全部传 `turn_context.cwd`）。

哪怕 R1 修了，hooks 仍会找不到 `run-hook.cmd`。Codex 官方约定用 env var `PLUGIN_ROOT` 解决路径问题（[developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks)），[discovery.rs:223-225](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/hooks/src/engine/discovery.rs#L223-L225) 同时注入 `PLUGIN_ROOT`（官方名）和 `CLAUDE_PLUGIN_ROOT`（OOTB 兼容别名）。

**性质：** 仓库代码缺陷，必须修。**用 `PLUGIN_ROOT` 不用 `CLAUDE_PLUGIN_ROOT`**——官方名长期支持，别名属于 compat alias，未来去掉的风险高。

### R3：`.codex-plugin/plugin.json` 缺 `mcpServers` 配置

我们的 MCP server 配置只写在 `plugins/superharness/.claude-plugin/plugin.json` 的 inline `mcpServers` 对象里。但 Codex 的 manifest discovery 优先读 `.codex-plugin/plugin.json`（[utils/plugins/src/plugin_namespace.rs:8-16](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/utils/plugins/src/plugin_namespace.rs#L8-L16)），一旦读到就忽略 `.claude-plugin/plugin.json`。而 `.codex-plugin/plugin.json` 没有 `mcpServers` 字段，所以 Codex 看不到任何 MCP server。

另外，Codex 的 manifest `mcpServers` 字段只接受**字符串路径**（指向独立配置文件），不接受 inline 对象（[core-plugins/src/manifest.rs:27-28](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/core-plugins/src/manifest.rs#L27-L28)：`mcp_servers: Option<String>`）。

Codex spawn MCP server 走 [rmcp_client.rs:305-316](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/rmcp-client/src/rmcp_client.rs#L305-L316) 直接进程，**不走 shell**，args 里的 `${PLUGIN_ROOT}` 不会被展开。但 [loader.rs:1073-1080](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/core-plugins/src/loader.rs#L1073-L1080) 会把相对 `cwd` 拼到 plugin_root：

```rust
if let Some(JsonValue::String(cwd)) = object.get("cwd") && !Path::new(cwd).is_absolute() {
    object.insert("cwd".to_string(),
        JsonValue::String(plugin_root.join(cwd).display().to_string()));
}
```

所以正确写法是新建一个独立的 `.mcp.json` 文件，`cwd: "."` + args 用相对路径。

**性质：** 仓库代码缺陷，必须修。

## 修复方案

### 文件清单

| # | 文件 | 操作 |
|---|------|------|
| F1 | `plugins/superharness/hooks/hooks-codex.json` | edit — 2 处 command 改用 `${PLUGIN_ROOT}` |
| F2 | `plugins/superharness/.codex-plugin/plugin.json` | edit — 加 `"mcpServers": "./.mcp.json"` 字段 + version 1.2.3 → 1.2.4 |
| F3 | `plugins/superharness/.mcp.json` | **新建** — Codex 的 MCP server 配置 |
| F4 | `docs/README.codex.md` | edit — 加 plugin_hooks opt-in 说明小节 |
| F5 | `CLAUDE.md` | edit — 修正"`manifest.hooks` is only for ADDITIONAL hook files"那条 |
| F6.a | `package.json` | edit — version 1.2.3 → 1.2.4 |
| F6.b | `.claude-plugin/marketplace.json` | edit — version + plugin description（marketplace.json 也带版本） |
| F6.c | `plugins/superharness/.claude-plugin/plugin.json` | edit — version |
| F6.d | `.cursor-plugin/plugin.json` | edit — version |

合计 **5 类内容改动 + 4 处版本号 bump**（F2 自带版本号 bump，所以 version 文件总共 5 处：F2 + F6.a~d）。

### F1：hooks-codex.json 修复

**当前**：

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{
      "type": "command",
      "command": "./hooks/run-hook.cmd workflow-context",
      "async": false
    }]}],
    "PreToolUse": [{ "matcher": "Bash|apply_patch|Write|Edit", "hooks": [{
      "type": "command",
      "command": "./hooks/run-hook.cmd workflow-pre-tool-use",
      "async": false
    }]}]
  }
}
```

**改后**：command 字段两处分别替换为：

```
"\"${PLUGIN_ROOT}/hooks/run-hook.cmd\" workflow-context"
"\"${PLUGIN_ROOT}/hooks/run-hook.cmd\" workflow-pre-tool-use"
```

引号包裹路径是为了处理路径含空格的边界情况。其它字段保持不变。

### F2：.codex-plugin/plugin.json 加 mcpServers + version bump

在现有 `"hooks": "./hooks/hooks-codex.json"` 后追加 `"mcpServers": "./.mcp.json"`。同步 `version` 字段 1.2.3 → 1.2.4。

### F3：新建 plugins/superharness/.mcp.json

```json
{
  "mcpServers": {
    "superharness-workflow-state": {
      "command": "node",
      "args": ["workflow-state-server/bootstrap.js"],
      "cwd": "."
    }
  }
}
```

- `cwd: "."` 触发 Codex 把相对 cwd 拼成 plugin root（loader.rs:1073-1080）
- `args` 用相对路径，由 node 在 cwd 下解析
- **不**用 `${PLUGIN_ROOT}` —— MCP spawn 不走 shell，env var 不会展开
- `.claude-plugin/plugin.json` 的 inline `mcpServers` **保持原样**（继续用 `${CLAUDE_PLUGIN_ROOT}`，Claude Code 自己展开）

### F4：docs/README.codex.md 加 opt-in 说明

在"工作原理"小节之后新增一个二级小节：

```markdown
## 旧版 Codex 启用 hooks

Codex 在 2026-05-13 之后才把 plugin hooks 默认开（commit `14473c216f`）。如果你的 codex-cli 早于这个时间（例如 `0.130.0`），`/plugins` 选中本插件会显示 "No plugin hooks"。手动开启：

​```toml
# ~/.codex/config.toml
[features]
plugin_hooks = true
​```

加完重启 Codex。新版 Codex（包含 `14473c216f` 之后版本）无需此配置。
```

### F5：CLAUDE.md 修正

把现有最后一条 bullet（关于 `manifest.hooks` 那段）替换为：

```markdown
- **`manifest.hooks` is only for ADDITIONAL hook files.** Claude Code auto-loads `<plugin_root>/hooks/hooks.json` as the standard location; pointing `manifest.hooks` at that same standard file triggers `Duplicate hooks file detected`. Codex and Cursor DO need the field set because they don't auto-discover (Codex looks for `hooks-codex.json` via the field; absence means no hooks). Hook commands in `hooks-codex.json` must use `${PLUGIN_ROOT}` (Codex official) or `${CLAUDE_PLUGIN_ROOT}` (OOTB compat alias) — Codex sets hook cwd to the session dir, not the plugin root. Additionally, Codex versions before commit `14473c216f` (2026-05-13) require explicit opt-in via `[features].plugin_hooks = true` in user config; current behavior is on by default.
```

### F6：版本号同步 bump 到 1.2.4

仓库历史多次因为版本号文件漏改而出问题，本次必须同时改这 5 个文件：

- `package.json`
- `.claude-plugin/marketplace.json`（含 plugin description 和 version 两处可能需要核对）
- `plugins/superharness/.claude-plugin/plugin.json`
- `plugins/superharness/.codex-plugin/plugin.json`（**已并入 F2，不再单独列改动**，但 verification 阶段需一并 grep）
- `.cursor-plugin/plugin.json`

**unique 文件总数：F1 + F2 + F3 + F4 + F5 + F6 的 4 个新文件 = 9 个文件触动**。

## 范围排除（YAGNI）

- ❌ **不加** `.mcp.json` ↔ `.claude-plugin` mcpServers 一致性测试 —— 两套配置服务两个 runtime，命令/参数本身就不同（cwd-relative vs env-var-expansion），强制"一致"反而误导
- ❌ **不改** `hooks/hooks.json`、`hooks/hooks-cursor.json` —— Claude 和 Cursor 行为未受影响
- ❌ **不改** `plugins/superharness/README.md` —— 安装文档主战场是 `docs/README.codex.md`
- ❌ **不改** OpenCode 配置 —— OpenCode 走 `.opencode/plugins/superharness.js` 另一条路径
- ❌ **不**为 Codex 0.130.0 老版本自动写入 config.toml —— 越权且不可逆，文档兜底即可

## 验证

### 静态检查

1. `git diff` 确认仅触动上面 9 个文件
2. `grep -rn "PLUGIN_ROOT\|CLAUDE_PLUGIN_ROOT" plugins/superharness/hooks/` 应只有：
   - `hooks.json` 用 `CLAUDE_PLUGIN_ROOT`（不变）
   - `hooks-codex.json` 用 `PLUGIN_ROOT`（本次改）
   - `hooks-cursor.json` 用 `CLAUDE_PLUGIN_ROOT`（不变）
3. `cat plugins/superharness/.mcp.json | jq` 应能解析，结构包含 `mcpServers.superharness-workflow-state`
4. 5 处版本号文件 `grep -E '"version".*1\.2\.[0-9]+"'` 输出应全是 `"1.2.4"`

### 集成验证（人工，发布后）

1. 用户 `codex plugin marketplace upgrade superharness` 到 1.2.4
2. 用户在 `~/.codex/config.toml` 加 `features.plugin_hooks = true`（如果尚未加）
3. 重启 Codex，`/plugins` 选中 superharness，预期：
   - **Hooks**：不再显示 "No plugin hooks."；具体显示形态以 Codex UI 输出为准（按 [tui/src/chatwidget/plugins.rs:2164-2175](D:/WorkSpace/code/coding-agent-workspace/codex/codex-rs/codex-rs/tui/src/chatwidget/plugins.rs#L2164-L2175) 应列出每个 event 的 handler 个数）
   - **MCP Servers**: 不再显示 "No plugin MCP servers."；应列出 `superharness-workflow-state`
4. 触发一次 PreToolUse 校验（试图直接编辑 `.superharness/`），应被 hook 拦截
5. `mcp__plugin_superharness_superharness-workflow-state__get_state` 应能成功调用

### 回归验证

1. Claude Code 加载本插件，行为零变化（`.claude-plugin/plugin.json` 和 `hooks/hooks.json` 都没改）
2. Cursor 加载本插件，行为零变化（`.cursor-plugin/plugin.json` 仅版本号变）
3. OpenCode 跑 `tests/opencode/run-tests.sh` 全过（OpenCode 配置未触动）
4. workflow-state-server 单测全过（`cd plugins/superharness/workflow-state-server && npm.cmd test`）

## 风险

| 风险 | 缓解 |
|---|---|
| Codex 0.130.0 用户没看文档就升级 | README 提示在显眼位置，CLAUDE.md 加 convention bullet 加强提醒 |
| Codex 后续版本去掉 `CLAUDE_PLUGIN_ROOT` 别名 | 我们用的是 `PLUGIN_ROOT`（官方名），不受影响 |
| Codex 后续版本改 cwd 归一化逻辑 | 影响 F3 `.mcp.json` 的 `cwd: "."` —— 风险低，因为这是 Codex 文档化的行为；若发生，再发 patch |
| 5 处版本号漏改一处 | 实现计划 verification 阶段必须 grep 全部 5 处确认是 1.2.4 |
| Codex 命令解析对 `\"${PLUGIN_ROOT}/...\"` 引号处理意外 | F1 改完先在本机重启 Codex 实测一次再 commit；shell 是 cmd `/C` 或 sh `-lc`，引号都支持 |

## 验收

实现完成的判定：

1. 9 个文件按 F1-F6 描述被修改
2. 上述静态检查 4 项全过
3. 本地 Codex（用户机器）跑 `codex plugin marketplace upgrade superharness`（或开发期 force reinstall）后 `/plugins` 显示 Hooks + MCP Servers 非空
4. commit message 用 `fix(plugin): wire codex hooks/mcp + document plugin_hooks opt-in (v1.2.4)`
5. `git push origin main` 推送到远端
