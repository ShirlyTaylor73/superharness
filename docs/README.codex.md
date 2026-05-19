# Superharness — Codex CLI 安装指南

在 Codex CLI 中使用 Superharness 的推荐方式是插件市场安装。插件会启用 active skills，并通过 hooks 注入当前工作流状态上下文。

## 插件市场安装

```bash
codex plugin marketplace add ShirlyTaylor73/superharness
```

支持的来源格式：

- GitHub shorthand：`ShirlyTaylor73/superharness`
- 锁定 ref：`ShirlyTaylor73/superharness@v1.1.9` 或 `--ref v1.1.9`
- HTTPS Git URL：`https://github.com/ShirlyTaylor73/superharness.git`
- SSH Git URL：`git@github.com:ShirlyTaylor73/superharness.git`
- 本地路径：`/path/to/superharness`

注册成功后启动 Codex，在交互界面输入：

```text
/plugins
```

在列表中选中 `superharness` 安装。插件市场方式会同时加载 skills 和 hooks。

更新 / 移除：

```bash
codex plugin marketplace upgrade superharness
codex plugin marketplace remove superharness
```

不卸载只禁用：编辑 `~/.codex/config.toml`，将 `superharness` 条目设为 `enabled = false`，重启 Codex。

## 符号链接 fallback

如果插件市场方式不可用，可以走符号链接方案。

```bash
git clone https://github.com/ShirlyTaylor73/superharness.git ~/.codex/superharness
mkdir -p ~/.agents/skills
ln -s ~/.codex/superharness/plugins/superharness/skills ~/.agents/skills/superharness
```

Windows：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.agents\skills"
cmd /c mklink /J "$env:USERPROFILE\.agents\skills\superharness" "$env:USERPROFILE\.codex\superharness\plugins\superharness\skills"
```

## 工作原理

Codex 启动时发现 active skills；插件市场安装还会启用：

- `UserPromptSubmit`：注入当前工作流状态上下文。
- `PreToolUse`：防止直接写入 `.superharness/` 状态目录。

历史文本入口已归档禁用，运行时入口由 workflow context 和 `superharness-workflow-state` 接管。

## 旧版 Codex 启用 hooks

Codex 在 2026-05-13 之后才把 plugin hooks 默认开（commit `14473c216f`）。如果你的 codex-cli 早于这个时间（例如 `0.130.0`），`/plugins` 选中本插件会显示 "No plugin hooks"。手动开启：

```toml
# ~/.codex/config.toml
[features]
plugin_hooks = true
```

加完重启 Codex。新版 Codex（包含 `14473c216f` 之后版本）无需此配置。
