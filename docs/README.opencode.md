# Superharness — OpenCode 安装指南

在 OpenCode 中使用 Superharness，需要通过 `opencode.json` 加载 Git 插件。OpenCode 不读取本仓库的 Claude/Codex marketplace 配置。

## 安装

在全局或项目级 `opencode.json` 中添加：

```json
{
  "plugin": ["superharness@git+https://github.com/ShirlyTaylor73/superharness.git"]
}
```

重启 OpenCode。插件会自动注册 active skills、`superharness-workflow-state` MCP，并在每轮模型调用前注入 workflow context。

## 使用

列出可用 skills：

```text
use skill tool to list skills
```

加载某个 skill：

```text
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

插件入口由 `package.json.main` 指向 OpenCode 插件文件。

插件做三件事：

1. 通过 `config` hook 把 active skills 目录加入 OpenCode 的 skills 搜索路径。
2. 注册 `superharness-workflow-state` MCP，让 OpenCode 可以读取和切换程序化工作流状态。
3. 通过 `experimental.chat.system.transform` hook，把当前工作流状态上下文注入 system context。

Claude/Codex hooks 不会被 OpenCode 使用。

## 故障排查

如果插件未加载：

1. 检查 `opencode.json` 中的 `plugin` 配置。
2. 运行 `opencode run --print-logs "hello"` 查看加载日志。
3. 确认仓库中的 `package.json.main` 指向存在的 OpenCode 插件入口。

如果 skills 未发现：

1. 使用 OpenCode 的 `skill` 工具列出可用 skills。
2. 确认 active skills 目录位于 OpenCode 的 skills 搜索路径。
3. 确认 `workflow-state-server` 依赖可安装，且 `superharness-workflow-state` MCP 注册成功。


