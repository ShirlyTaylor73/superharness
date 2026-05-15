# 为 Codex 安装 Superharness

推荐通过 Codex 原生插件市场安装 Superharness。插件会注册 active skills，并通过 hooks 注入当前工作流状态上下文。

## 插件市场安装

```bash
codex plugin marketplace add ShirlyTaylor73/superharness
```

启动 Codex 后输入 `/plugins`，选择 `superharness` 安装。

更新 / 移除：

```bash
codex plugin marketplace upgrade superharness
codex plugin marketplace remove superharness
```

## 符号链接 fallback

如果插件市场不可用，可以手动链接 active skills：

```bash
git clone https://github.com/ShirlyTaylor73/superharness.git ~/.codex/superharness
mkdir -p ~/.agents/skills
ln -s ~/.codex/superharness/plugins/superharness/skills ~/.agents/skills/superharness
```

Windows 使用目录连接：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.agents\skills"
cmd /c mklink /J "$env:USERPROFILE\.agents\skills\superharness" "$env:USERPROFILE\.codex\superharness\plugins\superharness\skills"
```

## 验证

```bash
ls -la ~/.agents/skills/superharness
```

你应该看到一个符号链接（Windows 上为目录连接），指向 Superharness active skills 目录。
