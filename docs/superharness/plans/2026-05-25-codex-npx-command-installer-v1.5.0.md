# Codex npx command installer v1.5.0 实现计划

> **面向 AI 代理的工作者：** 必需子技能：平台支持子代理且计划较大/可安全分 wave 时使用 superpowers:parallel-executing-plans；计划较小、任务强耦合或平台不支持子代理时使用 superpowers:serial-executing-plans。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 发布 `npx superharness@latest` 安装器，把 Superharness Codex 插件运行时和 `free` / `rollback` command markdown 安装到项目级或用户级 Codex 目录。

**架构：** 新增 Node.js CLI 入口，交互式选择项目级/用户级安装，核心安装逻辑放在可测试模块中。安装器复制 `plugins/superharness/` 到目标 `.codex/plugins/superharness`，安装 workflow-state-server 生产依赖，并把 Codex command 模板渲染为包含绝对插件路径的 `.codex/commands/*.md`。版本升级到 `1.5.0`，根 npm 包变为可发布包。

**技术栈：** Node.js >=20 ES modules, Node 标准库 `node:test`, PowerShell/Git Bash 验证, npm package metadata

---

## 文件结构

- `bin/superharness.js`：npx 可执行入口；解析 CLI 参数，调用交互选择和安装核心。
- `bin/lib/codex-installer.js`：安装核心；导出 `parseArgs`、`resolveInstallTarget`、`installCodexSupport`、`renderCommandTemplate`、`backupExistingPath`、`copyPluginRuntime`、`installWorkflowDependencies`。
- `bin/lib/interactive-select.js`：无第三方依赖的方向键选择器；导出 `selectInstallTarget`。
- `plugins/superharness/commands-codex/free.md`：Codex 版 `/free` command 模板，含 `{{SUPERHARNESS_PLUGIN_ROOT}}` 内部安装 token。
- `plugins/superharness/commands-codex/rollback.md`：Codex 版 `/rollback` command 模板，含 `{{SUPERHARNESS_PLUGIN_ROOT}}` 内部安装 token。
- `tests/codex-installer/codex-installer.test.mjs`：installer core 单元测试，使用临时目录和注入的 fake dependency installer。
- `package.json`：发布元数据、`bin`、`files`、测试脚本、版本 `1.5.0`。
- `.claude-plugin/marketplace.json`：版本 `1.5.0`。
- `plugins/superharness/.claude-plugin/plugin.json`：版本 `1.5.0`。
- `plugins/superharness/.codex-plugin/plugin.json`：版本 `1.5.0`。
- `README.md`：新增 Codex npx 快速安装说明。
- `plugins/superharness/README.md`：新增插件内 Codex command 安装说明。

## 任务 1：建立 installer core 的失败测试

**依赖：** 无
**文件集：** `tests/codex-installer/codex-installer.test.mjs`
**导出/变更接口：** 无
**消费接口：** `bin/lib/codex-installer.js::parseArgs`, `bin/lib/codex-installer.js::resolveInstallTarget`, `bin/lib/codex-installer.js::installCodexSupport`, `bin/lib/codex-installer.js::renderCommandTemplate`
**复杂度：** standard

**文件：**
- 创建：`tests/codex-installer/codex-installer.test.mjs`

- [ ] **步骤 1：创建 Node test 文件**

测试使用 `node:test`、`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`。

关键测试用例：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installCodexSupport,
  parseArgs,
  renderCommandTemplate,
  resolveInstallTarget,
} from '../../bin/lib/codex-installer.js';
```

- [ ] **步骤 2：添加参数解析测试**

覆盖：

```js
assert.deepEqual(parseArgs(['--project']), { mode: 'project', force: false, help: false });
assert.deepEqual(parseArgs(['--user', '--force']), { mode: 'user', force: true, help: false });
assert.throws(() => parseArgs(['--project', '--user']), /choose only one/i);
```

- [ ] **步骤 3：添加目标解析测试**

断言：

- `resolveInstallTarget({ mode: 'project', cwd })` 返回 `<cwd>/.codex/plugins/superharness` 和 `<cwd>/.codex/commands`
- `resolveInstallTarget({ mode: 'user', homeDir })` 返回 `<homeDir>/.codex/plugins/superharness` 和 `<homeDir>/.codex/commands`

- [ ] **步骤 4：添加模板渲染测试**

断言 `renderCommandTemplate('node "{{SUPERHARNESS_PLUGIN_ROOT}}/scripts/x.mjs"', 'D:\\Work\\p')` 输出包含真实路径，且不包含 installer token 或旧的 angle-bracket plugin-root placeholder。

- [ ] **步骤 5：添加项目安装测试**

创建临时 package root，最少包含：

```text
plugins/superharness/.codex-plugin/plugin.json
plugins/superharness/.mcp.json
plugins/superharness/hooks/hooks-codex.json
plugins/superharness/scripts/set-free-mode.mjs
plugins/superharness/scripts/rollback.mjs
plugins/superharness/workflow-state-server/package.json
plugins/superharness/commands-codex/free.md
plugins/superharness/commands-codex/rollback.md
```

调用：

```js
const calls = [];
await installCodexSupport({
  mode: 'project',
  cwd,
  homeDir,
  packageRoot,
  now: () => new Date('2026-05-25T07:30:00Z'),
  runCommand: async (command, args, options) => calls.push({ command, args, cwd: options.cwd }),
});
```

断言：

- `<cwd>/.codex/plugins/superharness/scripts/set-free-mode.mjs` 存在
- `<cwd>/.codex/commands/free.md` 存在
- command 文件包含 `<cwd>/.codex/plugins/superharness` 的绝对路径
- command 文件不包含 `{{SUPERHARNESS_PLUGIN_ROOT}}`
- `runCommand` 被调用一次，命令为 `npm`，参数为 `['install', '--omit=dev']`

- [ ] **步骤 6：添加备份覆盖测试**

预先创建 `.codex/commands/free.md` 和 `.codex/plugins/superharness/old.txt`。安装后断言：

- 新文件已覆盖
- 存在 `.bak-20260525-073000` 后缀备份
- 备份里保留旧内容

- [ ] **步骤 7：运行测试确认失败**

运行：

```bash
node --test tests/codex-installer/codex-installer.test.mjs
```

预期：FAIL，报错找不到 `../../bin/lib/codex-installer.js`。

- [ ] **步骤 8：Commit**

```bash
git add tests/codex-installer/codex-installer.test.mjs
git commit -m "test(installer): cover codex install core"
```

## 任务 2：实现 installer core

**依赖：** 任务 1
**文件集：** `bin/lib/codex-installer.js`
**导出/变更接口：** `bin/lib/codex-installer.js::parseArgs`, `bin/lib/codex-installer.js::resolveInstallTarget`, `bin/lib/codex-installer.js::installCodexSupport`, `bin/lib/codex-installer.js::renderCommandTemplate`, `bin/lib/codex-installer.js::backupExistingPath`, `bin/lib/codex-installer.js::copyPluginRuntime`, `bin/lib/codex-installer.js::installWorkflowDependencies`
**消费接口：** 无
**复杂度：** deep

**文件：**
- 创建：`bin/lib/codex-installer.js`

- [ ] **步骤 1：创建模块和常量**

使用 Node 标准库：

```js
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
```

常量：

```js
export const INSTALLER_TOKEN = '{{SUPERHARNESS_PLUGIN_ROOT}}';
export const COMMAND_NAMES = ['free.md', 'rollback.md'];
```

- [ ] **步骤 2：实现 `parseArgs`**

签名：

```js
export function parseArgs(argv)
```

返回：

```js
{ mode: 'project' | 'user' | null, force: boolean, help: boolean }
```

规则：

- `--project` 设置 `mode: 'project'`
- `--user` 和 `--global` 设置 `mode: 'user'`
- `--force` 设置 `force: true`
- `--help` / `-h` 设置 `help: true`
- 同时传 `--project` 和 `--user` 抛错 `choose only one install target`
- 未知参数抛错 `unknown argument: <arg>`

- [ ] **步骤 3：实现 `resolveInstallTarget`**

签名：

```js
export function resolveInstallTarget({ mode, cwd = process.cwd(), homeDir = process.env.USERPROFILE || process.env.HOME })
```

返回：

```js
{
  mode,
  codexRoot,
  pluginRoot,
  commandsRoot,
}
```

规则：

- project: `codexRoot = path.resolve(cwd, '.codex')`
- user: `codexRoot = path.resolve(homeDir, '.codex')`
- `pluginRoot = path.join(codexRoot, 'plugins', 'superharness')`
- `commandsRoot = path.join(codexRoot, 'commands')`

- [ ] **步骤 4：实现备份和复制**

`backupExistingPath(target, timestamp)`：

- 若 target 不存在，返回 `null`
- 若存在，重命名为 `${target}.bak-${timestamp}`
- 若备份名已存在，追加 `-1`、`-2`
- 不删除原路径

`copyPluginRuntime({ packageRoot, pluginRoot, timestamp })`：

- 源：`path.join(packageRoot, 'plugins', 'superharness')`
- 先备份目标
- `fs.cp(source, pluginRoot, { recursive: true })`

- [ ] **步骤 5：实现模板渲染和 command 写入**

`renderCommandTemplate(template, pluginRoot)`：

- 把 `{{SUPERHARNESS_PLUGIN_ROOT}}` 替换为 `pluginRoot`
- 统一把路径中的反斜杠保留给 PowerShell 示例，不强制 POSIX 化
- 渲染后若仍含 `{{SUPERHARNESS_PLUGIN_ROOT}}` 或字符串 `installed-plugin-root`，抛错

在 `installCodexSupport` 中：

- 读取 `plugins/superharness/commands-codex/free.md`
- 读取 `plugins/superharness/commands-codex/rollback.md`
- 分别渲染到 `${commandsRoot}/free.md` 和 `${commandsRoot}/rollback.md`
- 写入前备份已有文件

- [ ] **步骤 6：实现依赖安装**

`installWorkflowDependencies({ pluginRoot, runCommand = spawnCommand })`：

- cwd: `path.join(pluginRoot, 'workflow-state-server')`
- command: `npm`
- args: `['install', '--omit=dev']`
- 失败时抛错 `npm install --omit=dev failed in <cwd>`

`spawnCommand(command, args, options)` 返回 Promise，继承 stdio。

- [ ] **步骤 7：实现 `installCodexSupport`**

签名：

```js
export async function installCodexSupport({
  mode,
  cwd = process.cwd(),
  homeDir = process.env.USERPROFILE || process.env.HOME,
  packageRoot,
  now = () => new Date(),
  runCommand,
} = {})
```

流程：

1. 校验 Node major >= 20
2. 解析 target
3. 生成 timestamp：`YYYYMMDD-HHMMSS`
4. `fs.mkdir(commandsRoot, { recursive: true })`
5. 复制插件 runtime
6. 写 command markdown
7. 安装 workflow-state-server 依赖
8. 返回 `{ mode, pluginRoot, commandsRoot, backups }`

- [ ] **步骤 8：运行 installer core 测试**

运行：

```bash
node --test tests/codex-installer/codex-installer.test.mjs
```

预期：PASS。

- [ ] **步骤 9：Commit**

```bash
git add bin/lib/codex-installer.js tests/codex-installer/codex-installer.test.mjs
git commit -m "feat(installer): add codex install core"
```

## 任务 3：新增 Codex command 模板

**依赖：** 任务 2
**文件集：** `plugins/superharness/commands-codex/free.md`, `plugins/superharness/commands-codex/rollback.md`, `tests/codex-installer/codex-installer.test.mjs`
**导出/变更接口：** 无
**消费接口：** `bin/lib/codex-installer.js::installCodexSupport`, `bin/lib/codex-installer.js::renderCommandTemplate`
**复杂度：** standard

**文件：**
- 创建：`plugins/superharness/commands-codex/free.md`
- 创建：`plugins/superharness/commands-codex/rollback.md`
- 修改：`tests/codex-installer/codex-installer.test.mjs`

- [ ] **步骤 1：创建 `free.md` 模板**

内容必须保留 frontmatter：

````markdown
---
description: 进入或退出 free-mode；暂停 superharness workflow context 注入（Codex）
allowed-tools: shell_command
---

# /free $ARGS

用户输入了 `/free $ARGS`。这是 Codex 兼容 command：不要把下面的命令展示给用户后停止，必须由 agent 调用 shell tool 直接执行。

解析 `$ARGS`：

- 空或 `status`：查询状态
- `on`：进入 free mode
- `off`：退出 free mode
- 其他值：报告用法 `/free [on|off|status]` 并停止

在 PowerShell 中执行：

```powershell
node "{{SUPERHARNESS_PLUGIN_ROOT}}\scripts\set-free-mode.mjs" (Get-Location).Path "$ARGS"
```

在 bash/Git Bash 中执行：

```bash
node "{{SUPERHARNESS_PLUGIN_ROOT}}/scripts/set-free-mode.mjs" "$PWD" "$ARGS"
```

根据 stdout 简短报告结果。不要继续做其他事，不要补 transition_state。
````

- [ ] **步骤 2：创建 `rollback.md` 模板**

内容必须保留 frontmatter，并保留 list_history 流程：

````markdown
---
description: 回退 workflow state 到 transition_log 中走过的某个 state（Codex 用户控制）
allowed-tools: mcp__plugin_superharness_superharness-workflow-state__list_history, shell_command, request_user_input
---

# /rollback $ARGS

用户输入了 `/rollback $ARGS`。这是 Codex 兼容 command：最终 rollback 命令必须由 agent 调用 shell tool 直接执行。

步骤 1：调用 `list_history(workspaceRoot=<当前工作目录>)` 获取历史。

步骤 2：解析参数。

- `$ARGS` 非空：把 `$ARGS` 当目标 state 名。从 transition_log 中过滤 `to_state == $ARGS` 是否存在。不存在就报错，并列出曾走过的 state。
- `$ARGS` 为空：从 transition_log 提取 `to_state`，按时间倒序去重，取最近 5 个独特 state，让用户选择。

步骤 3：执行 rollback。

PowerShell：

```powershell
node "{{SUPERHARNESS_PLUGIN_ROOT}}\scripts\rollback.mjs" (Get-Location).Path "<chosen_state>" "[rollback] 用户 /rollback $ARGS"
```

bash/Git Bash：

```bash
node "{{SUPERHARNESS_PLUGIN_ROOT}}/scripts/rollback.mjs" "$PWD" "<chosen_state>" "[rollback] 用户 /rollback $ARGS"
```

步骤 4：根据 stdout 简短报告“已从 X 回到 Y”。

不要调用 `transition_state`，不要继续之前 state 的任务。下一轮 UserPromptSubmit hook 会注入新 state SKILL.md。
````

- [ ] **步骤 3：扩展测试断言真实模板**

在项目安装测试中使用真实 `packageRoot` 时，断言安装后的 command 文件：

- 包含 `set-free-mode.mjs` 或 `rollback.mjs`
- 包含安装后的绝对 `pluginRoot`
- 不包含 `{{SUPERHARNESS_PLUGIN_ROOT}}`
- 不包含字符串 `installed-plugin-root`

- [ ] **步骤 4：运行测试**

运行：

```bash
node --test tests/codex-installer/codex-installer.test.mjs
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/superharness/commands-codex/free.md plugins/superharness/commands-codex/rollback.md tests/codex-installer/codex-installer.test.mjs
git commit -m "feat(commands): add codex command templates"
```

## 任务 4：实现 CLI 入口和交互选择

**依赖：** 任务 2
**文件集：** `bin/superharness.js`, `bin/lib/interactive-select.js`, `tests/codex-installer/codex-installer.test.mjs`
**导出/变更接口：** `bin/superharness.js::main`, `bin/lib/interactive-select.js::selectInstallTarget`
**消费接口：** `bin/lib/codex-installer.js::parseArgs`, `bin/lib/codex-installer.js::installCodexSupport`
**复杂度：** standard

**文件：**
- 创建：`bin/superharness.js`
- 创建：`bin/lib/interactive-select.js`
- 修改：`tests/codex-installer/codex-installer.test.mjs`

- [ ] **步骤 1：创建交互选择器**

`selectInstallTarget({ cwd = process.cwd(), input = process.stdin, output = process.stdout } = {})`：

- 检测 `cwd/.codex` 是否存在
- 有 `.codex` 时默认 index 为 Project install
- 无 `.codex` 时默认 index 为 User install
- 使用 `readline.emitKeypressEvents(input)` 和 raw mode
- 支持 Up/Down、Enter、Ctrl+C
- 返回 `'project'`、`'user'` 或 `'cancel'`

渲染文本：

```text
Where should Superharness Codex support be installed?

> Project install  Install into this repository's .codex directory
  User install     Install into ~/.codex for all Codex projects
  Cancel
```

- [ ] **步骤 2：创建 CLI 入口**

`bin/superharness.js`：

```js
#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCodexSupport, parseArgs } from './lib/codex-installer.js';
import { selectInstallTarget } from './lib/interactive-select.js';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  let mode = options.mode;
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !env.CI;
  if (!mode) {
    if (!interactive) throw new Error('non-interactive install requires --project or --user');
    mode = await selectInstallTarget();
    if (mode === 'cancel') return 0;
  }
  const result = await installCodexSupport({ mode, packageRoot });
  process.stdout.write(successMessage(result));
  return 0;
}
```

文件尾部捕获异常，写 stderr，`process.exit(1)`。

- [ ] **步骤 3：添加 CLI 测试**

在测试文件里导入 `main` 或只测试 `parseArgs` 已足够；新增一条测试确保 non-interactive 无目标时报错：

```js
assert.rejects(() => main([], { CI: '1' }), /requires --project or --user/i);
```

如果 `main` 难以隔离 process 全局，改为导出 `resolveCliMode({ parsed, interactive, select })` 并测试该纯函数。

- [ ] **步骤 4：运行测试**

运行：

```bash
node --test tests/codex-installer/codex-installer.test.mjs
```

预期：PASS。

- [ ] **步骤 5：手动 smoke CLI help**

运行：

```bash
node bin/superharness.js --help
```

预期：输出包含 `--project`、`--user`、`--force`。

- [ ] **步骤 6：Commit**

```bash
git add bin/superharness.js bin/lib/interactive-select.js tests/codex-installer/codex-installer.test.mjs
git commit -m "feat(installer): add codex install cli"
```

## 任务 5：发布元数据和版本升级

**依赖：** 任务 3, 任务 4
**文件集：** `package.json`, `.claude-plugin/marketplace.json`, `plugins/superharness/.claude-plugin/plugin.json`, `plugins/superharness/.codex-plugin/plugin.json`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`package.json`
- 修改：`.claude-plugin/marketplace.json`
- 修改：`plugins/superharness/.claude-plugin/plugin.json`
- 修改：`plugins/superharness/.codex-plugin/plugin.json`

- [ ] **步骤 1：更新 root `package.json`**

修改：

- `"version": "1.5.0"`
- 移除 `"private": true`
- 添加：

```json
"bin": {
  "superharness": "./bin/superharness.js"
},
"files": [
  "bin/",
  "plugins/superharness/"
],
"scripts": {
  "test:installer": "node --test tests/codex-installer/*.test.mjs"
}
```

如果保留现有字段顺序，优先把 `bin`、`files`、`scripts` 放在 `type` 后或 `engines` 后，保持 JSON 可读。

- [ ] **步骤 2：更新插件版本**

把以下文件中的 `1.4.1` 改为 `1.5.0`：

- `.claude-plugin/marketplace.json`
- `plugins/superharness/.claude-plugin/plugin.json`
- `plugins/superharness/.codex-plugin/plugin.json`

- [ ] **步骤 3：验证 JSON**

运行：

```bash
node -e "for (const f of ['package.json','.claude-plugin/marketplace.json','plugins/superharness/.claude-plugin/plugin.json','plugins/superharness/.codex-plugin/plugin.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('ok')"
```

预期：输出 `ok`。

- [ ] **步骤 4：运行 installer 测试**

运行：

```bash
npm run test:installer
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json plugins/superharness/.codex-plugin/plugin.json
git commit -m "chore(release): prepare v1.5.0 package metadata"
```

## 任务 6：文档更新

**依赖：** 任务 5
**文件集：** `README.md`, `plugins/superharness/README.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** quick

**文件：**
- 修改：`README.md`
- 修改：`plugins/superharness/README.md`

- [ ] **步骤 1：更新根 README Codex 安装说明**

新增或更新 Codex 小节，包含：

````markdown
### Codex 快速安装

```bash
npx superharness@latest
```

安装器会用方向键询问安装到当前项目 `.codex/` 还是用户级 `~/.codex/`。非交互环境使用：

```bash
npx superharness@latest --project
npx superharness@latest --user
```

Codex 版 command 目前支持 `free` 和 `rollback`，安装后写入 `.codex/commands/`。由于 Codex 不支持 Claude Code 的 `!node` 原生 command 执行语法，Codex command 会指示 agent 用 shell tool 执行等价 Node 脚本。
````

- [ ] **步骤 2：更新插件 README**

在 `plugins/superharness/README.md` 加同样的简短说明，并强调：

- `plugins/superharness/commands/` 是 Claude Code 版本
- `plugins/superharness/commands-codex/` 是 Codex 模板，安装时会渲染绝对插件路径

- [ ] **步骤 3：检查 Markdown**

运行：

```bash
Select-String -Path README.md,plugins/superharness/README.md -Pattern 'npx superharness@latest|commands-codex|free|rollback'
```

预期：两份 README 都包含相关说明。

- [ ] **步骤 4：Commit**

```bash
git add README.md plugins/superharness/README.md
git commit -m "docs(codex): document npx command installer"
```

## 任务 7：端到端安装验证

**依赖：** 任务 5, 任务 6
**文件集：** `tests/codex-installer/codex-installer.test.mjs`
**导出/变更接口：** 无
**消费接口：** `bin/lib/codex-installer.js::installCodexSupport`
**复杂度：** standard

**文件：**
- 修改：`tests/codex-installer/codex-installer.test.mjs`

- [ ] **步骤 1：新增真实 package root 的 temp project 安装测试**

测试使用当前仓库作为 `packageRoot`，临时目录作为 `cwd`，注入 fake `runCommand`，调用 `installCodexSupport({ mode: 'project', cwd, packageRoot: repoRoot, runCommand })`。

断言：

- `.codex/plugins/superharness/workflow-state-server/bootstrap.js` 存在
- `.codex/plugins/superharness/.codex-plugin/plugin.json` 存在
- `.codex/commands/free.md` 和 `.codex/commands/rollback.md` 存在
- 两个 command 文件都不包含 `{{SUPERHARNESS_PLUGIN_ROOT}}`
- `runCommand` cwd 以 `.codex/plugins/superharness/workflow-state-server` 结尾

- [ ] **步骤 2：运行完整验证**

运行：

```bash
npm run test:installer
cd plugins/superharness/workflow-state-server && npm test
```

预期：全部 PASS。

- [ ] **步骤 3：运行 npm pack 预检**

运行：

```bash
npm pack --dry-run
```

预期输出包含：

- `bin/superharness.js`
- `bin/lib/codex-installer.js`
- `bin/lib/interactive-select.js`
- `plugins/superharness/commands-codex/free.md`
- `plugins/superharness/commands-codex/rollback.md`
- `plugins/superharness/workflow-state-server/bootstrap.js`

- [ ] **步骤 4：Commit**

```bash
git add tests/codex-installer/codex-installer.test.mjs
git commit -m "test(installer): verify real codex install layout"
```

## 任务 8：最终审查和收口

**依赖：** 任务 7
**文件集：** `bin/superharness.js`, `bin/lib/codex-installer.js`, `bin/lib/interactive-select.js`, `plugins/superharness/commands-codex/free.md`, `plugins/superharness/commands-codex/rollback.md`, `tests/codex-installer/codex-installer.test.mjs`, `package.json`, `.claude-plugin/marketplace.json`, `plugins/superharness/.claude-plugin/plugin.json`, `plugins/superharness/.codex-plugin/plugin.json`, `README.md`, `plugins/superharness/README.md`
**导出/变更接口：** 无
**消费接口：** 无
**复杂度：** standard

**文件：**
- 检查：全部实现文件

- [ ] **步骤 1：检查占位符和版本**

运行：

```bash
rg -n "TO[D]O|TB[D]|待[定]|installed-plugin-root|\\{\\{SUPERHARNESS_PLUGIN_ROOT\\}\\}" bin plugins/superharness/commands-codex tests/codex-installer README.md plugins/superharness/README.md package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json plugins/superharness/.codex-plugin/plugin.json
```

预期：

- `{{SUPERHARNESS_PLUGIN_ROOT}}` 只允许出现在 `plugins/superharness/commands-codex/*.md`
- 不允许出现字符串 `installed-plugin-root`
- 不允许出现占位任务标记

运行：

```bash
rg -n '"version": "1\\.4\\.1"|1\\.4\\.1' package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json plugins/superharness/.codex-plugin/plugin.json
```

预期：无输出。

- [ ] **步骤 2：运行最终验证命令**

运行：

```bash
npm run test:installer
cd plugins/superharness/workflow-state-server && npm test
npm pack --dry-run
```

预期：全部 PASS，pack dry-run 包含安装器和插件文件。

- [ ] **步骤 3：查看 diff 范围**

运行：

```bash
git status --short
git diff --stat HEAD
```

确认只包含本计划文件集内的变更；不要修改 `.mindfs/` 或 `docs/human/`。

- [ ] **步骤 4：最终 commit**

如前面任务已逐步 commit 且无剩余变更，则跳过。若有收口修正：

```bash
git add bin/superharness.js bin/lib/codex-installer.js bin/lib/interactive-select.js plugins/superharness/commands-codex/free.md plugins/superharness/commands-codex/rollback.md tests/codex-installer/codex-installer.test.mjs package.json .claude-plugin/marketplace.json plugins/superharness/.claude-plugin/plugin.json plugins/superharness/.codex-plugin/plugin.json README.md plugins/superharness/README.md
git commit -m "fix(installer): finalize codex npx install flow"
```

## 并行执行图

> 仅 `parallel-executing-plans` 使用；`serial-executing-plans` 忽略本节。

**Critical Path:** 任务 1 → 任务 2 → 任务 3 → 任务 5 → 任务 6 → 任务 7 → 任务 8

- Wave 1（无依赖）：任务 1
- Wave 2（依赖 Wave 1）：任务 2（依赖 1）
- Wave 3（依赖 Wave 2）：任务 3（依赖 2）, 任务 4（依赖 2）
- Wave 4（依赖 Wave 3）：任务 5（依赖 3, 4）
- Wave 5（依赖 Wave 4）：任务 6（依赖 5）
- Wave 6（依赖 Wave 5）：任务 7（依赖 5, 6）
- Wave 7（依赖 Wave 6）：任务 8（依赖 7）
- Wave FINAL（所有任务完成后）：F1 规格合规、F2 代码质量、F3 真实手测、F4 范围保真

## 执行交接

计划完成后，推荐使用串行执行。任务依赖链较长，installer core、CLI、模板、版本和文档之间有明确顺序；并行收益主要在任务 3 和任务 4。

执行方式：

1. 子代理驱动：平台支持子代理时，可在 Wave 3 并行执行 command 模板和 CLI 入口，其余 wave 串行推进。
2. 串行执行：使用 serial-executing-plans 按任务编号执行，最适合当前改动。
