# Codex Plugin Fix v1.2.4 实现计划

> **面向 AI 代理的工作者：** 必需子技能：平台支持子代理且计划较大/可安全分 wave 时使用 superharness:parallel-execution；计划较小、任务强耦合或平台不支持子代理时使用 superharness:serial-execution。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Codex `/plugins` 选中 superharness 时不再显示 "No plugin hooks" 和 "No plugin MCP servers"，发布 v1.2.4 patch。

**架构：** 修 3 处仓库代码缺陷（hooks command 路径用 `${PLUGIN_ROOT}`、`.codex-plugin/plugin.json` 加 `mcpServers` 字段、新建 `.mcp.json` 用 cwd-relative 解决 MCP 不展开 env var）+ 2 处文档（README.codex.md 加旧版 Codex opt-in 说明、CLAUDE.md 修正 manifest.hooks 约定）+ 5 处版本号 bump 到 1.2.4。

**技术栈：** JSON（plugin manifests / hook config / MCP config）、Markdown（文档）。无新依赖、无代码逻辑、无测试代码改动。

**规格参考：** `docs/superharness/specs/2026-05-20-codex-plugin-fix-v1.2.4-design.md`

---

## 文件结构

| 路径 | 职责 | 触动方式 |
|---|---|---|
| `plugins/superharness/hooks/hooks-codex.json` | Codex hook 配置 | edit（2 处 command） |
| `plugins/superharness/.codex-plugin/plugin.json` | Codex 插件清单 | edit（加 mcpServers + version） |
| `plugins/superharness/.mcp.json` | Codex MCP server 配置（独立文件） | **新建** |
| `docs/README.codex.md` | Codex 安装文档 | edit（加 opt-in 小节） |
| `CLAUDE.md` | 项目约定文档 | edit（修正 1 条 bullet） |
| `package.json` | 仓库 npm 元数据 | edit（version） |
| `.claude-plugin/marketplace.json` | Marketplace 元数据 | edit（version） |
| `plugins/superharness/.claude-plugin/plugin.json` | Claude 插件清单 | edit（version） |
| `.cursor-plugin/plugin.json` | Cursor 插件清单 | edit（version） |

合计 9 个文件。每个任务负责互不重叠的子集，可全部并行。

---

## 任务

### 任务 1：修 hooks-codex.json 命令路径

**依赖：** 无
**文件集：** `plugins/superharness/hooks/hooks-codex.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`plugins/superharness/hooks/hooks-codex.json`

- [ ] **步骤 1：替换两处 command 字段**

把文件内 `UserPromptSubmit` 下的：

```
"command": "./hooks/run-hook.cmd workflow-context"
```

改为：

```
"command": "\"${PLUGIN_ROOT}/hooks/run-hook.cmd\" workflow-context"
```

把 `PreToolUse` 下的：

```
"command": "./hooks/run-hook.cmd workflow-pre-tool-use"
```

改为：

```
"command": "\"${PLUGIN_ROOT}/hooks/run-hook.cmd\" workflow-pre-tool-use"
```

其余字段（`type`、`async`、`matcher`）保持不变。

- [ ] **步骤 2：验证 JSON 仍合法**

运行：
```bash
node -e "JSON.parse(require('fs').readFileSync('plugins/superharness/hooks/hooks-codex.json','utf8'))"
```
预期：无输出（解析成功）。

- [ ] **步骤 3：grep 确认没有遗留相对路径**

运行：
```bash
grep -n "\./hooks/run-hook" plugins/superharness/hooks/hooks-codex.json
```
预期：无输出（全部已替换）。

- [ ] **步骤 4：Commit**

```bash
git add plugins/superharness/hooks/hooks-codex.json
git commit -m "fix(hooks): use \${PLUGIN_ROOT} in codex hook command paths

Codex sets hook cwd to the user session dir, not the plugin root.
Relative './hooks/run-hook.cmd' fails to resolve. Use Codex's official
PLUGIN_ROOT env var (injected by hooks engine) for absolute paths.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 2：.codex-plugin/plugin.json 加 mcpServers + version bump

**依赖：** 无
**文件集：** `plugins/superharness/.codex-plugin/plugin.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`plugins/superharness/.codex-plugin/plugin.json`

- [ ] **步骤 1：加 mcpServers 字段**

在现有 `"hooks": "./hooks/hooks-codex.json",` 行之后插入一行：

```json
  "mcpServers": "./.mcp.json",
```

注意结尾英文逗号——后面还有 `interface` 字段。

- [ ] **步骤 2：bump version 1.2.3 → 1.2.4**

替换 `"version": "1.2.3"` 为 `"version": "1.2.4"`。

- [ ] **步骤 3：验证 JSON 仍合法**

```bash
node -e "JSON.parse(require('fs').readFileSync('plugins/superharness/.codex-plugin/plugin.json','utf8'))"
```
预期：无输出。

- [ ] **步骤 4：Commit**

```bash
git add plugins/superharness/.codex-plugin/plugin.json
git commit -m "fix(plugin): wire mcpServers in codex manifest + bump 1.2.4

Codex prefers .codex-plugin/plugin.json over .claude-plugin/plugin.json
and ignores the latter once the former exists. Without an mcpServers
field, Codex sees no MCP servers from this plugin.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 3：新建 .mcp.json

**依赖：** 无
**文件集：** `plugins/superharness/.mcp.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 创建：`plugins/superharness/.mcp.json`

- [ ] **步骤 1：写入文件**

完整文件内容：

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

设计要点：
- Codex spawn MCP server 走 stdio 直进程，**不走 shell**，args 里的 `${PLUGIN_ROOT}` 不会展开
- Codex 的 plugin loader 会把相对 cwd 归一化为 `plugin_root.join(cwd)`，所以 `cwd: "."` 自动指向 plugin root
- node 在 cwd 下解析相对路径的 script，所以 args 用相对路径就行

- [ ] **步骤 2：验证 JSON 合法 + bootstrap.js 存在**

```bash
node -e "JSON.parse(require('fs').readFileSync('plugins/superharness/.mcp.json','utf8'))"
test -f plugins/superharness/workflow-state-server/bootstrap.js && echo "bootstrap.js OK"
```
预期：无 JSON 错 + 输出 `bootstrap.js OK`。

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/.mcp.json
git commit -m "feat(plugin): add codex .mcp.json with cwd-relative args

Codex doesn't expand env vars in MCP server args (direct process spawn,
no shell). Use cwd: '.' which Codex normalizes to plugin_root, then node
resolves relative arg paths from there.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 4：docs/README.codex.md 加 opt-in 小节

**依赖：** 无
**文件集：** `docs/README.codex.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`docs/README.codex.md`

- [ ] **步骤 1：在"工作原理"小节之后插入新小节**

定位现有内容：

```
历史文本入口已归档禁用，运行时入口由 workflow context 和 `superharness-workflow-state` 接管。
```

在这一行之后追加（保留 1 空行）：

```markdown

## 旧版 Codex 启用 hooks

Codex 在 2026-05-13 之后才把 plugin hooks 默认开（commit `14473c216f`）。如果你的 codex-cli 早于这个时间（例如 `0.130.0`），`/plugins` 选中本插件会显示 "No plugin hooks"。手动开启：

```toml
# ~/.codex/config.toml
[features]
plugin_hooks = true
```

加完重启 Codex。新版 Codex（包含 `14473c216f` 之后版本）无需此配置。
```

注意：嵌入的 ` ```toml ... ``` ` 内部代码块用 3 反引号即可，外层 markdown 不需要 escape。

- [ ] **步骤 2：grep 确认插入正确**

```bash
grep -n "plugin_hooks = true" docs/README.codex.md
```
预期：输出包含 `plugin_hooks = true` 的行号（1 次匹配）。

- [ ] **步骤 3：Commit**

```bash
git add docs/README.codex.md
git commit -m "docs(codex): document plugin_hooks opt-in for older codex-cli

codex-cli before commit 14473c216f (2026-05-13) ships with plugin_hooks
default-off. Users on 0.130.0 hit 'No plugin hooks' until they add the
flag manually.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 5：CLAUDE.md 修正 manifest.hooks 约定

**依赖：** 无
**文件集：** `CLAUDE.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`CLAUDE.md`

- [ ] **步骤 1：找到要替换的 bullet**

定位现有 bullet（在"Conventions that aren't obvious"小节最后一条）：

```
- **`manifest.hooks` is only for ADDITIONAL hook files.** Claude Code auto-loads `<plugin_root>/hooks/hooks.json` as the standard location. Pointing `manifest.hooks` at that same standard file triggers `Duplicate hooks file detected` in `/doctor` and breaks plugin load. Leave the field unset unless you have hook files outside the standard path (Cursor and Codex have their own non-standard `hooks-cursor.json` / `hooks-codex.json` and DO need the field set; Claude's plugin.json does not).
```

- [ ] **步骤 2：替换为新版本**

整条替换为：

```
- **`manifest.hooks` is only for ADDITIONAL hook files.** Claude Code auto-loads `<plugin_root>/hooks/hooks.json` as the standard location; pointing `manifest.hooks` at that same standard file triggers `Duplicate hooks file detected`. Codex and Cursor DO need the field set because they don't auto-discover (Codex looks for `hooks-codex.json` via the field; absence means no hooks). Hook commands in `hooks-codex.json` must use `${PLUGIN_ROOT}` (Codex official) or `${CLAUDE_PLUGIN_ROOT}` (OOTB compat alias) — Codex sets hook cwd to the session dir, not the plugin root. Additionally, Codex versions before commit `14473c216f` (2026-05-13) require explicit opt-in via `[features].plugin_hooks = true` in user config; current behavior is on by default.
```

- [ ] **步骤 3：grep 确认替换**

```bash
grep -n "PLUGIN_ROOT" CLAUDE.md
```
预期：至少 1 次匹配（新文案里有 `${PLUGIN_ROOT}`）。

```bash
grep -n "Leave the field unset unless" CLAUDE.md
```
预期：无输出（旧文案已被删除）。

- [ ] **步骤 4：Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): correct codex manifest.hooks convention

Codex DOES need the hooks field set (we mistakenly said otherwise).
Document the \${PLUGIN_ROOT} requirement and plugin_hooks opt-in for
older Codex versions.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### 任务 6：4 处剩余版本号 bump 到 1.2.4

**依赖：** 无
**文件集：** `package.json`, `.claude-plugin/marketplace.json`, `plugins/superharness/.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`package.json`（顶层 `"version"` 字段）
- 修改：`.claude-plugin/marketplace.json`（`plugins[0].version` 字段）
- 修改：`plugins/superharness/.claude-plugin/plugin.json`（顶层 `"version"` 字段）
- 修改：`.cursor-plugin/plugin.json`（顶层 `"version"` 字段）

注：`.codex-plugin/plugin.json` 的版本号由任务 2 同步处理，**本任务不动**。

- [ ] **步骤 1：4 处 `"1.2.3"` → `"1.2.4"`**

逐文件替换。每个文件只有一处版本号字段，定位明确。

- [ ] **步骤 2：验证 4 个 JSON 仍合法**

```bash
for f in package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json .cursor-plugin/plugin.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f OK"
done
```
预期：4 个 `OK` 输出。

- [ ] **步骤 3：grep 全仓库版本号一致性**

```bash
grep -rn '"version".*"1\.2\.[0-9]\+"' package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json plugins/superharness/.codex-plugin/plugin.json .cursor-plugin/plugin.json
```
预期：所有匹配都是 `"1.2.4"`（共 5 处：本任务的 4 处 + 任务 2 改的 1 处）。

> 此步在 wave 内不一定通过（任务 2 可能尚未完成）。允许暂时显示 `1.2.3` 残留，由 Wave FINAL 的 F3（真实手测）再次验证。

- [ ] **步骤 4：Commit**

```bash
git add package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json .cursor-plugin/plugin.json
git commit -m "chore(release): bump 4 manifest version files to 1.2.4

Cross-runtime version sync (excluding .codex-plugin which is bumped
alongside the mcpServers wiring in a separate commit).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## 集成验证（在 Wave FINAL 之前由 reviewer 跑）

以下命令汇总 6 个任务完成后的最终静态检查。在主任务循环完成后、Wave FINAL 触发前由执行环境跑一次：

```bash
# 1. 5 处版本号一致
grep -rn '"version".*"1\.2\.4"' package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json plugins/superharness/.codex-plugin/plugin.json .cursor-plugin/plugin.json | wc -l
# 预期：5

# 2. hooks-codex.json 全部用 PLUGIN_ROOT
grep -c "PLUGIN_ROOT" plugins/superharness/hooks/hooks-codex.json
# 预期：2

# 3. 没有遗留相对路径
grep -c '"\./hooks/run-hook' plugins/superharness/hooks/hooks-codex.json
# 预期：0

# 4. .mcp.json 存在且解析
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('plugins/superharness/.mcp.json','utf8')).mcpServers))"
# 预期：[ 'superharness-workflow-state' ]

# 5. .codex-plugin manifest 含 mcpServers 字段
node -e "console.log(JSON.parse(require('fs').readFileSync('plugins/superharness/.codex-plugin/plugin.json','utf8')).mcpServers)"
# 预期：./.mcp.json

# 6. README.codex.md 包含 opt-in 块
grep -c "plugin_hooks = true" docs/README.codex.md
# 预期：>= 1

# 7. CLAUDE.md 提到 PLUGIN_ROOT
grep -c "PLUGIN_ROOT" CLAUDE.md
# 预期：>= 1

# 8. 回归：workflow-state-server 单测
( cd plugins/superharness/workflow-state-server && npm.cmd test 2>&1 | tail -5 )
# 预期：所有测试 PASS

# 9. 回归：OpenCode 契约测试（可选，依赖 Git Bash）
# "D:\Git\bin\bash.exe" tests/opencode/run-tests.sh 2>&1 | tail -10
# 预期：全过
```

## 发布交接（人工，所有任务 + Wave FINAL 完成后）

集成验证全过后，由人或 finishing skill 决定：

```bash
git push origin main
```

推送后：
1. 在用户机器上 `codex plugin marketplace upgrade superharness` 或重启 Codex 触发自动 refresh
2. 用户机器 `~/.codex/config.toml` 确认含 `[features].plugin_hooks = true`（旧版 Codex 必需）
3. `/plugins` 选中 superharness 应显示 Hooks（非空）+ MCP Servers（含 `superharness-workflow-state`）

---

## 并行执行图

> 仅 `parallel-execution` 使用；`serial-execution` 忽略本节。

**Critical Path:** 任务 1 → Wave FINAL（无任务间依赖，瓶颈在 wave 收口审查）

- Wave 1（无依赖，全部并行）：任务 1, 任务 2, 任务 3, 任务 4, 任务 5, 任务 6
- Wave FINAL（所有任务完成后）：F1 规格合规、F2 代码质量、F3 真实手测、F4 范围保真

**Wave 1 安全性自检（4 条规则全过）：**

| 文件集相交 | 任意两两 `A.文件集 ∩ B.文件集` 都是 `∅`：T1 单独触动 hooks-codex.json、T2 单独触动 .codex-plugin/plugin.json、T3 单独触动 .mcp.json、T4 单独触动 README.codex.md、T5 单独触动 CLAUDE.md、T6 触动 4 个其余 manifest（不含 .codex-plugin）→ 全部不交 |
| 导出符号相交 | 全部任务 `导出/变更接口` 都是 `无` → 无冲突 |
| 导出 ∩ 消费 | 全部任务 `消费接口` 都是 `无` → 无冲突 |
| 同读上游 | 无任务消费同一上游符号 → 不构成冲突 |

**Wave 1 任务数 = 6**，落在 5-8 推荐区间内。
