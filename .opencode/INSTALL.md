# 为 OpenCode 安装 Superharness

OpenCode 不使用本仓库的 Claude/Codex marketplace 配置。它通过 `opencode.json` 加载 Git 插件，并读取 `package.json.main` 指向的入口。

## 安装

在全局或项目级 `opencode.json` 中添加：

```json
{
  "plugin": ["superharness@git+https://github.com/ShirlyTaylor73/superharness.git"]
}
```

重启 OpenCode 后，插件会自动注册 active skills，并注册 `superharness-workflow-state` MCP。

## 使用

```text
use skill tool to list skills
use skill tool to load superharness/brainstorming
```

## 更新

未锁定版本时，OpenCode 会在启动时按 Git 源更新插件。

锁定特定版本：

```json
{
  "plugin": ["superharness@git+https://github.com/ShirlyTaylor73/superharness.git#v1.1.9"]
}
```

## 工作原理

- `package.json.main` 指向 OpenCode 插件入口。
- `config` hook 注册 active skills 搜索路径。
- `config` hook 注册 `superharness-workflow-state` MCP。
- `experimental.chat.system.transform` hook 注入当前工作流状态上下文。
- `plugins/superharness/hooks/*.json` 只供 Claude/Codex/Cursor 等平台使用，不供 OpenCode 使用。

