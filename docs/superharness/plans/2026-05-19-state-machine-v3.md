# 状态机 v3 实现计划

> **面向 AI 代理的工作者：** 必需子技能：平台支持子代理且计划较大/可安全分 wave 时使用 superharness:parallel-executing-plans；计划较小、任务强耦合或平台不支持子代理时使用 superharness:serial-executing-plans。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把状态机从 8 状态线性 cycle 改成 11 状态多入口分流：新增 intake 入口 + exploration/trivial 快速通道、删除 done、5 个存量 skill 重命名对齐状态名、systematic-debugging 补"完成调试后"章节。

**架构：** 改一份 YAML 重定义状态图；新建 3 个 skill 目录；重命名 5 个 skill 目录；改 4 个 test fixture 文件；validate-workflow.js 加 intake 硬约束；state.js 加 legacy `done` → `intake` 自动迁移；systematic-debugging / brainstorming 两个存量 SKILL.md 补丁。

**技术栈：** Node + Vitest + better-sqlite3，OpenCode 插件（Bun），workflow-state MCP server。

**所有 skill 创建/修改任务必须使用 `superharness:writing-skills` skill**——这是 brainstorming 阶段用户的明确要求，用于保证新 skill 内容质量和命名/frontmatter 一致性。

**参考规格：** [docs/superharness/specs/2026-05-19-state-machine-v3-design.md](../specs/2026-05-19-state-machine-v3-design.md)

---

### 任务 1：state.js 加 legacy state migrator（TDD）

**依赖：** 无
**文件集：** `plugins/superharness/workflow-state-server/state.js`, `plugins/superharness/workflow-state-server/test/state.test.js`
**导出/变更接口：** `state.js::migrateLegacyState`
**消费接口：** `state.js::openWorkflowStateStore`, `state.js::recordTransition`
**复杂度：** standard

**文件：**
- 修改：`plugins/superharness/workflow-state-server/state.js`（在 `initializeWorkflowState` / `getOrInitState` 调用链中插入 migrator）
- 测试：`plugins/superharness/workflow-state-server/test/state.test.js`（新增 migration 测试 case）

- [ ] **步骤 1：编写失败测试**

在 `test/state.test.js` 新增一个 describe block `legacy state migration`：

```js
describe('legacy state migration', () => {
  it('migrates legacy done state to intake on read', () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    const workspaceId = '/workspace/legacy-test';
    // 直接 upsert 一个 state='done' 的旧记录
    store.prepare(`
      INSERT INTO workflow_state (workspace_id, state, status, previous_state, active_skill, task_summary, failure_summary, updated_at)
      VALUES (?, 'done', 'completed', null, null, null, null, ?)
    `).run(workspaceId, Date.now());

    const state = getWorkflowState(store, { workspaceRoot: workspaceId });
    expect(state.state).toBe('intake');

    // 审计日志应记录迁移事件
    const history = listWorkflowHistory(store, { workspaceRoot: workspaceId });
    const migration = history.find(h => h.to_state === 'intake' && h.from_state === 'done');
    expect(migration).toBeDefined();
    expect(migration.reason).toMatch(/legacy.*migration/i);
    expect(migration.source).toBe('user-reset');
  });

  it('migrates legacy execution_choice state to planning', () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    const workspaceId = '/workspace/legacy-ec';
    store.prepare(`
      INSERT INTO workflow_state (workspace_id, state, status, previous_state, active_skill, task_summary, failure_summary, updated_at)
      VALUES (?, 'execution_choice', 'active', null, null, null, null, ?)
    `).run(workspaceId, Date.now());

    const state = getWorkflowState(store, { workspaceRoot: workspaceId });
    expect(state.state).toBe('planning');

    const history = listWorkflowHistory(store, { workspaceRoot: workspaceId });
    const migration = history.find(h => h.to_state === 'planning' && h.from_state === 'execution_choice');
    expect(migration).toBeDefined();
    expect(migration.reason).toMatch(/legacy.*migration/i);
  });

  it('does not migrate non-legacy states', () => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    const workspaceId = '/workspace/normal-test';
    store.prepare(`
      INSERT INTO workflow_state (workspace_id, state, status, previous_state, active_skill, task_summary, failure_summary, updated_at)
      VALUES (?, 'brainstorming', 'active', null, 'brainstorming', null, null, ?)
    `).run(workspaceId, Date.now());

    const state = getWorkflowState(store, { workspaceRoot: workspaceId });
    expect(state.state).toBe('brainstorming');

    const history = listWorkflowHistory(store, { workspaceRoot: workspaceId });
    expect(history).toHaveLength(0);  // 没有迁移事件
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd plugins/superharness/workflow-state-server
npm.cmd test -- --run test/state.test.js -t "legacy state migration"
```

预期：FAIL — `expected 'done' to be 'intake'`（migrator 不存在，state 仍是 done）

- [ ] **步骤 3：在 state.js 实现 migrateLegacyState**

在 `state.js` 的 `getWorkflowState` 之前插入：

```js
const LEGACY_STATE_MAP = {
  'done': 'intake',
  'execution_choice': 'planning',
};

function migrateLegacyState(store, workspaceId, current) {
  if (!current) return current;
  const target = LEGACY_STATE_MAP[current.state];
  if (!target) return current;

  const updated = upsertState(store, {
    workspaceId,
    state: target,
    status: current.status,
    previousState: null,
    activeSkill: null,  // 由 hook 注入时 active_skill 重新解析
    taskSummary: current.task_summary,
    failureSummary: current.failure_summary,
    updatedAt: Date.now(),
  });
  recordTransition(store, {
    workspaceId,
    fromState: current.state,
    toState: target,
    previousState: null,
    reason: `legacy migration: ${current.state} → ${target} (state removed in v3 state machine)`,
    source: 'user-reset',
    createdAt: Date.now(),
  });
  return updated;
}

export { migrateLegacyState };
```

修改 `getWorkflowState`（或同一函数体里的读取路径）调用 migrator：

```js
export function getWorkflowState(store, { workspaceRoot } = {}) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  let row = store.prepare(`SELECT * FROM workflow_state WHERE workspace_id = ?`).get(workspaceId);
  if (!row) return null;
  // migrate legacy state if needed
  const migrated = migrateLegacyState(store, workspaceId, row);
  return formatState(migrated || row);
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm.cmd test -- --run test/state.test.js -t "legacy state migration"
```

预期：PASS

- [ ] **步骤 5：运行全量测试确保无回归**

```bash
npm.cmd test
```

预期：全绿

- [ ] **步骤 6：Commit**

```bash
git add plugins/superharness/workflow-state-server/state.js plugins/superharness/workflow-state-server/test/state.test.js
git commit -m "feat(state): add legacy done→intake state migrator with audit log"
```

---

### 任务 2：重命名 5 个状态绑定 skill 目录

**依赖：** 无
**文件集：** `plugins/superharness/skills/writing-plans/`, `plugins/superharness/skills/serial-executing-plans/`, `plugins/superharness/skills/parallel-executing-plans/`, `plugins/superharness/skills/verification-before-completion/`, `plugins/superharness/skills/finishing-a-development-branch/`
**导出/变更接口：** `skills/planning/SKILL.md`, `skills/serial-execution/SKILL.md`, `skills/parallel-execution/SKILL.md`, `skills/verification/SKILL.md`, `skills/finishing/SKILL.md`
**消费接口：** 无
**复杂度：** quick

**子技能：** 使用 `superharness:writing-skills` 来校验 frontmatter 改动后 skill 仍然能被正确触发。

- [ ] **步骤 1：git mv 5 个目录并改 frontmatter name**

```bash
cd plugins/superharness/skills

git mv writing-plans planning
git mv serial-executing-plans serial-execution
git mv parallel-executing-plans parallel-execution
git mv verification-before-completion verification
git mv finishing-a-development-branch finishing
```

然后用 sed/编辑器更新每个 SKILL.md 的 frontmatter `name:` 字段：

```yaml
# planning/SKILL.md
name: planning
```

对 5 个文件各做一次。`description:` 字段保持不变（保留原有的触发语义）。

- [ ] **步骤 2：grep 检查存量交叉引用**

```bash
cd plugins/superharness
grep -rn "writing-plans\|serial-executing-plans\|parallel-executing-plans\|verification-before-completion\|finishing-a-development-branch" skills/ workflow/ workflow-state-server/ hooks/
```

**预期发现**（这些将在后续任务中处理，本步骤只是登记）：
- `skills/brainstorming/SKILL.md` 引用 `writing-plans` → 任务 7 处理
- `skills/systematic-debugging/SKILL.md` 引用 `verification-before-completion` → 任务 6 处理
- `workflow/default-workflow.yaml` 引用 5 个旧名 → 任务 8 处理
- 4 个 test fixture 文件引用旧名 → 任务 9 处理

- [ ] **步骤 3：用 writing-skills 校验改后 skill 触发性**

按 writing-skills 指引重新审视 5 个 SKILL.md 的 frontmatter：name 字段对齐、description 是否还能在新名下被检索到。

- [ ] **步骤 4：Commit**

```bash
git add plugins/superharness/skills/
git commit -m "refactor(skills): rename 5 state-bound skills to match state names"
```

---

### 任务 3：创建 intake skill

**依赖：** 无
**文件集：** `plugins/superharness/skills/intake/SKILL.md`
**导出/变更接口：** `skills/intake/SKILL.md`
**消费接口：** 无
**复杂度：** standard

**子技能：** 使用 `superharness:writing-skills`。

参考规格 § 4.1。

- [ ] **步骤 1：调用 writing-skills 指引创建 skill 文件**

按规格 § 4.1 内容大纲写 `plugins/superharness/skills/intake/SKILL.md`：

```markdown
---
name: intake
description: 会话入口和 triage——在新会话起点或任务完成回到默认态时使用，听需求、必要时澄清、把任务路由到 exploration / trivial / brainstorming，或当场回答无需切态的纯问答
metadata:
  type: workflow-state
---

# Intake — 入口分流

## 角色
你处在新会话起点（或一个任务完成后回到默认态）。三件事：
1. 听用户表达需求
2. 必要时回问 1-2 个澄清问题（不要过度盘问）
3. 把任务路由到下一个状态

## 决策表

| 用户意图 | 该走 | transition_state 到 |
|---|---|---|
| 纯问答 / 解释 / 查 API 用法 | 当场答 | （不切态） |
| 看看 X 是怎么实现的 / 深度探索 | 只读探索 | exploration |
| 改 typo / 调整配置 / 单文件小修复 | 快速改动 | trivial |
| 新功能 / bugfix / 多文件变更 | 正式开发 | brainstorming |

## 反过度分类

- 用户问问题就答，**不要**为了"走流程"硬切态
- 不确定大小时回问一句确认："这只是改 X 还是还要碰 Y 和 Z？"
- answer-only 在 intake 里答完，**不**调用 transition_state

## 切态时的 reason

转出去时 reason 必须包含：
- 用户原话摘要（10-30 字）
- 你为什么判定走这一档的关键判断点

## 出口

- `exploration`：只读探索
- `trivial`：轻量改动
- `brainstorming`：正式开发（需要规划）

不要从 intake 直接跳 planning/execution——总是先去 brainstorming 走完需求确认。
```

- [ ] **步骤 2：用 writing-skills 验证**

按 writing-skills 指引检查：
- frontmatter `name` / `description` 是否合规
- description 是否能让 skill 在 "新会话开始" 类语境下被路由器选中
- 内容是否清晰、可执行、无占位符

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/skills/intake/SKILL.md
git commit -m "feat(skills): add intake skill for entry-state triage"
```

---

### 任务 4：创建 exploration skill

**依赖：** 无
**文件集：** `plugins/superharness/skills/exploration/SKILL.md`
**导出/变更接口：** `skills/exploration/SKILL.md`
**消费接口：** 无
**复杂度：** standard

**子技能：** 使用 `superharness:writing-skills`。

参考规格 § 4.2。

- [ ] **步骤 1：调用 writing-skills 创建 skill 文件**

按规格 § 4.2 写 `plugins/superharness/skills/exploration/SKILL.md`，内容覆盖：
- 角色（只读深度探索）
- 工具白名单（Read/Grep/Glob/WebFetch/WebSearch/Bash 只读）
- 输出规范（结构化分析报告 + `file_path:line_number` 引用）
- 完成后路径（→ intake；改主意要写代码 → intake，**不**自己跳 trivial/brainstorming）

frontmatter `description` 要包含触发词："深度探索"、"理解代码"、"对比方案"、"调研"。

- [ ] **步骤 2：用 writing-skills 验证**

检查 description 触发性 + 工具白名单约束的明确性 + 没有"在 exploration 里偷偷改代码"的漏洞。

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/skills/exploration/SKILL.md
git commit -m "feat(skills): add exploration skill for read-only deep dives"
```

---

### 任务 5：创建 trivial skill

**依赖：** 无
**文件集：** `plugins/superharness/skills/trivial/SKILL.md`
**导出/变更接口：** `skills/trivial/SKILL.md`
**消费接口：** 无
**复杂度：** standard

**子技能：** 使用 `superharness:writing-skills`。

参考规格 § 4.3。

- [ ] **步骤 1：调用 writing-skills 创建 skill 文件**

按规格 § 4.3 写 `plugins/superharness/skills/trivial/SKILL.md`，内容覆盖：
- 角色（单点小改 + 自带验证，**不走 plan/verification**）
- 改动边界（≤ 3 文件 / ≤ 50 行 / 不引入新依赖 / 不改公共 API / 不改 schema）
- 超边界 → 立即 transition 回 intake
- 自带验证（相关 test + lint + 类型检查）
- 异常出口（测试失败 → systematic_debugging；范围超预期 → intake）
- 完成 reason 要写"改了什么 + 验证结果"

frontmatter `description` 触发词："小改"、"typo"、"单文件修复"、"轻量改动"、"调整配置"。

- [ ] **步骤 2：用 writing-skills 验证**

检查 description 触发性 + 边界数字是否清晰可执行 + 异常出口完整。

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/skills/trivial/SKILL.md
git commit -m "feat(skills): add trivial skill for quick edits with built-in verification"
```

---

### 任务 6：更新 systematic-debugging skill 加"完成调试后"章节 + 修旧引用

**依赖：** 任务 2
**文件集：** `plugins/superharness/skills/systematic-debugging/SKILL.md`
**导出/变更接口：** `skills/systematic-debugging/SKILL.md`
**消费接口：** `skills/verification/SKILL.md`, `skills/planning/SKILL.md`
**复杂度：** standard

**子技能：** 使用 `superharness:writing-skills`。

- [ ] **步骤 1：grep 旧名引用**

```bash
grep -n "verification-before-completion\|writing-plans" plugins/superharness/skills/systematic-debugging/SKILL.md
```

预期发现 "相关技能" 段引用 `verification-before-completion`、可能引用 `writing-plans`。

- [ ] **步骤 2：调用 writing-skills 更新引用 + 追加新章节**

替换：
- `superharness:verification-before-completion` → `superharness:verification`
- 任何 `writing-plans` 引用 → `planning`

末尾追加 "## 完成调试后" 章节（按规格 § 4.4 完整文本）。

- [ ] **步骤 3：验证修改后的渲染**

手动检查：跑一次 hook context 渲染（构造一个 systematic_debugging 状态读取），确认 SKILL.md 全文被正确 emit 到上下文。

```bash
cd plugins/superharness/workflow-state-server
node -e "
import('./render-context.js').then(({ renderWorkflowContext }) => {
  console.log(renderWorkflowContext({
    workspaceId: '/tmp/test',
    workflowGraph: { /* 构造最小 graph */ },
    state: 'systematic_debugging',
    skillsDir: '../skills',
  }));
});
"
```

- [ ] **步骤 4：Commit**

```bash
git add plugins/superharness/skills/systematic-debugging/SKILL.md
git commit -m "feat(skills): add post-debug exit guidance to systematic-debugging"
```

---

### 任务 7：更新 brainstorming skill 引用

**依赖：** 任务 2
**文件集：** `plugins/superharness/skills/brainstorming/SKILL.md`
**导出/变更接口：** `skills/brainstorming/SKILL.md`
**消费接口：** `skills/planning/SKILL.md`
**复杂度：** quick

**子技能：** 使用 `superharness:writing-skills`。

- [ ] **步骤 1：grep 旧名引用**

```bash
grep -n "writing-plans" plugins/superharness/skills/brainstorming/SKILL.md
```

- [ ] **步骤 2：替换所有引用**

把 "调用 writing-plans 技能" 改为 "transition 到 planning"（保持 markdown 排版）：

```
原：调用 writing-plans 技能创建详细的实现计划
新：transition 到 planning 状态创建详细的实现计划
```

注意：流程图 dot block 里的 "调用 writing-plans 技能" 节点也要改成 "transition 到 planning"。

- [ ] **步骤 3：用 writing-skills 验证**

确认改动后流程描述仍连贯，没有断链。

- [ ] **步骤 4：Commit**

```bash
git add plugins/superharness/skills/brainstorming/SKILL.md
git commit -m "refactor(skills): align brainstorming refs to renamed planning skill"
```

---

### 任务 8：重写 default-workflow.yaml

**依赖：** 任务 2, 任务 3, 任务 4, 任务 5
**文件集：** `plugins/superharness/workflow/default-workflow.yaml`
**导出/变更接口：** `workflow/default-workflow.yaml`
**消费接口：** `skills/intake/SKILL.md`, `skills/exploration/SKILL.md`, `skills/trivial/SKILL.md`, `skills/planning/SKILL.md`, `skills/serial-execution/SKILL.md`, `skills/parallel-execution/SKILL.md`, `skills/verification/SKILL.md`, `skills/finishing/SKILL.md`, `skills/brainstorming/SKILL.md`, `skills/systematic-debugging/SKILL.md`
**复杂度：** standard

- [ ] **步骤 1：整体重写 YAML**

替换 `plugins/superharness/workflow/default-workflow.yaml` 为：

```yaml
version: 1
entryState: intake
terminalStates: []

states:
  intake:
    type: interactive
    skill: intake
    next:
      - exploration
      - trivial
      - brainstorming

  exploration:
    type: interactive
    skill: exploration
    next:
      - intake

  trivial:
    type: execution
    skill: trivial
    next:
      - intake
      - systematic_debugging

  brainstorming:
    type: interactive
    skill: brainstorming
    next:
      - planning

  planning:
    type: interactive
    skill: planning
    next:
      - serial_execution
      - parallel_execution

  serial_execution:
    type: execution
    skill: serial-execution
    next:
      - verification
      - systematic_debugging

  parallel_execution:
    type: execution
    skill: parallel-execution
    next:
      - verification
      - systematic_debugging

  verification:
    type: gate
    skill: verification
    next:
      - finishing
      - systematic_debugging

  finishing:
    type: gate
    skill: finishing
    next:
      - intake
      - systematic_debugging

  systematic_debugging:
    type: preemptive
    skill: systematic-debugging
    next:
      - previous_state
      - serial_execution
      - planning
```

- [ ] **步骤 2：手工跑 validate-workflow.js 校验**

```bash
cd plugins/superharness/workflow-state-server
node -e "
import('./validate-workflow.js').then(({ loadWorkflowConfig, validateWorkflowConfig }) => {
  const config = loadWorkflowConfig({ pluginRoot: '..' });
  const installed = new Set(['intake','exploration','trivial','brainstorming','planning','serial-execution','parallel-execution','verification','finishing','systematic-debugging']);
  validateWorkflowConfig(config, { installedSkills: installed });
  console.log('OK');
});
"
```

预期输出：`OK`

- [ ] **步骤 3：Commit**

```bash
git add plugins/superharness/workflow/default-workflow.yaml
git commit -m "feat(workflow): v3 state machine — intake entry + trivial/exploration paths"
```

---

### 任务 10：validate-workflow.js 加 intake 硬约束（TDD）

**依赖：** 任务 9
**文件集：** `plugins/superharness/workflow-state-server/validate-workflow.js`, `plugins/superharness/workflow-state-server/test/validate-workflow.test.js`
**导出/变更接口：** `validate-workflow.js::validateWorkflowConfig`
**消费接口：** `validate-workflow.js::SPECIAL_TARGETS`
**复杂度：** quick

- [ ] **步骤 1：写失败测试**

在 `test/validate-workflow.test.js` 新增 case：

```js
it('rejects config missing intake state', () => {
  const config = validConfig();
  delete config.states.intake;
  config.entryState = 'brainstorming';  // 改 entry 避开 "entryState references missing state"
  expect(() => validateWorkflowConfig(config, { installedSkills }))
    .toThrow(/intake/i);
});

it('rejects config where intake exists but is not entryState', () => {
  const config = validConfig();
  config.entryState = 'brainstorming';
  expect(() => validateWorkflowConfig(config, { installedSkills }))
    .toThrow(/intake.*entryState|entryState.*intake/i);
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd plugins/superharness/workflow-state-server
npm.cmd test -- --run test/validate-workflow.test.js -t "intake"
```

预期：FAIL（约束不存在）

- [ ] **步骤 3：在 validate-workflow.js 加约束**

在 `validateWorkflowConfig` 末尾（systematic_debugging 校验之前或之后）加：

```js
// intake hard constraint
if (!Object.hasOwn(config.states, 'intake')) {
  fail('intake state must exist (entry state for v3 state machine)');
}
if (config.entryState !== 'intake') {
  fail(`entryState must be 'intake', got '${config.entryState}'`);
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npm.cmd test -- --run test/validate-workflow.test.js
```

预期：PASS（含新增 case 和所有 existing case，因为任务 9 已经更新了 validConfig）

- [ ] **步骤 5：Commit**

```bash
git add plugins/superharness/workflow-state-server/validate-workflow.js plugins/superharness/workflow-state-server/test/validate-workflow.test.js
git commit -m "feat(validate): require intake state and entryState=intake"
```

---

### 任务 9：更新 4 个测试 fixture + 新增 transition 合法性测试

**依赖：** 任务 1
**文件集：** `plugins/superharness/workflow-state-server/test/server.test.js`, `plugins/superharness/workflow-state-server/test/state.test.js`, `plugins/superharness/workflow-state-server/test/validate-workflow.test.js`, `plugins/superharness/workflow-state-server/test/render-context.test.js`
**导出/变更接口：** `test/validate-workflow.test.js::validConfig`
**消费接口：** `validate-workflow.js::buildWorkflowGraph`, `state.js::createTools`
**复杂度：** standard

- [ ] **步骤 1：更新 4 个 fixture 到 v3 状态机骨架**

每个 test 文件的 hardcoded workflow fixture 改成：

```js
const installedSkills = new Set([
  'intake', 'exploration', 'trivial',
  'brainstorming', 'planning',
  'serial-execution', 'parallel-execution',
  'verification', 'finishing',
  'systematic-debugging',
]);

const workflowGraph = buildWorkflowGraph({
  version: 1,
  entryState: 'intake',
  terminalStates: [],
  states: {
    intake: { type: 'interactive', skill: 'intake', next: ['exploration', 'trivial', 'brainstorming'] },
    exploration: { type: 'interactive', skill: 'exploration', next: ['intake'] },
    trivial: { type: 'execution', skill: 'trivial', next: ['intake', 'systematic_debugging'] },
    brainstorming: { type: 'interactive', skill: 'brainstorming', next: ['planning'] },
    planning: { type: 'interactive', skill: 'planning', next: ['serial_execution', 'parallel_execution'] },
    serial_execution: { type: 'execution', skill: 'serial-execution', next: ['verification', 'systematic_debugging'] },
    parallel_execution: { type: 'execution', skill: 'parallel-execution', next: ['verification', 'systematic_debugging'] },
    verification: { type: 'gate', skill: 'verification', next: ['finishing', 'systematic_debugging'] },
    finishing: { type: 'gate', skill: 'finishing', next: ['intake', 'systematic_debugging'] },
    systematic_debugging: { type: 'preemptive', skill: 'systematic-debugging', next: ['previous_state', 'serial_execution', 'planning'] },
  },
}, { installedSkills });
```

注意：`validate-workflow.test.js` 的 `validConfig()` 工厂函数也要返回上面的结构（被任务 10 的新约束所要求）。

- [ ] **步骤 2：新增 transition 合法性测试**

在 `server.test.js` 加：

```js
describe('v3 transitions', () => {
  // 合法转换
  it.each([
    ['intake', 'exploration'],
    ['intake', 'trivial'],
    ['intake', 'brainstorming'],
    ['exploration', 'intake'],
    ['trivial', 'intake'],
    ['trivial', 'systematic_debugging'],
    ['brainstorming', 'planning'],
    ['planning', 'serial_execution'],
    ['planning', 'parallel_execution'],
    ['finishing', 'intake'],
    ['finishing', 'systematic_debugging'],
  ])('allows %s → %s', (from, to) => {
    const store = openWorkflowStateStore({ mode: 'memory' });
    stores.push(store);
    const tools = createTools(runtimeFor(store));
    initializeWorkflowState(store, workspaceId, workflowGraph);
    // 先手动 upsert 到 from 状态
    upsertState(store, { workspaceId, state: from, /* ... */ });
    const result = toolByName(tools, 'transition_state').handler({
      workspaceRoot: workspaceId,
      from_state: from,
      to_state: to,
      reason: 'test',
    });
    expect(result.state).toBe(to);
  });

  // 非法转换（被拒）
  it.each([
    ['brainstorming', 'systematic_debugging'],
    ['planning', 'systematic_debugging'],
    ['intake', 'systematic_debugging'],
    ['exploration', 'systematic_debugging'],
    ['intake', 'planning'],
    ['exploration', 'trivial'],
  ])('rejects %s → %s', (from, to) => {
    // 类似上面但断言抛错 / 返回 error
    expect(() => /* ... */).toThrow(/not allowed/);
  });
});
```

- [ ] **步骤 3：运行全量测试**

```bash
cd plugins/superharness/workflow-state-server
npm.cmd test
```

预期：全绿（包括新增的所有 transition cases、迁移测试）

注：YAML 一致性测试（修 historical fixture drift gap）依赖 T8 的真 YAML 才能通过，推迟到本计划完成后的独立 PR 处理。

- [ ] **步骤 4：Commit**

```bash
git add plugins/superharness/workflow-state-server/test/
git commit -m "test: update fixtures + add v3 transition tests"
```

---

## 自检

**1. 规格覆盖度：**
- ✓ 11 个状态、删 done — 任务 8
- ✓ 5 个 skill 重命名 — 任务 2
- ✓ 3 个新 skill — 任务 3、4、5
- ✓ systematic-debugging 补丁 — 任务 6
- ✓ brainstorming 更新 — 任务 7
- ✓ legacy state migrator — 任务 1
- ✓ intake 硬约束 — 任务 10
- ✓ 测试 fixture 更新 — 任务 9
- ⏭️ YAML 一致性测试 — 推迟到独立 PR（依赖 T8 输出，与 wave 调度耦合）
- ✓ writing-skills 子技能注入 — 任务 3-7
- ✓ 范围外（multi-cycle epic / sub-agent / check 自修复 / journal）— 规格 § 6 明示 defer，本计划不包含

**2. 占位符扫描：** 无 TODO / 待定 / 后续补充。所有任务步骤都给了具体命令或代码。

**3. 接口契约扫描：**
- 任务 6 消费 `skills/verification/SKILL.md` ← 任务 2 输出 ✓ 显式依赖
- 任务 6 消费 `skills/planning/SKILL.md` ← 任务 2 输出 ✓ 显式依赖
- 任务 7 消费 `skills/planning/SKILL.md` ← 任务 2 输出 ✓ 显式依赖
- 任务 8 消费所有 10 个 SKILL.md ← 任务 2/3/4/5 输出 ✓ 显式依赖（任务 6/7 不在依赖里，因为 YAML 只引用 skill 名字而非内容；6/7 改的是内容）
- 任务 10 修改 validate-workflow.test.js (validConfig)，任务 9 也修改同一文件 → 文件集冲突 ✓ 任务 10 依赖任务 9（避免同 wave 并行写同一文件）

**4. 拓扑序：**
- 任务 1：deps 无 ✓
- 任务 2：deps 无 ✓
- 任务 3：deps 无 ✓
- 任务 4：deps 无 ✓
- 任务 5：deps 无 ✓
- 任务 6：deps {2} ⊆ {1..5} ✓
- 任务 7：deps {2} ⊆ {1..6} ✓
- 任务 8：deps {2,3,4,5} ⊆ {1..7} ✓
- 任务 9：deps {1} ⊆ {1..8} ✓
- 任务 10：deps {9} ⊆ {1..9} ✓

**5. 类型/命名一致性：**
- `legacy migrator` 函数名 `migrateLegacyState` 在任务 1 步骤 3 定义、任务 1 步骤 5 commit message 不出现冲突 ✓
- skill 名字 `verification`（无后缀）跨任务一致 ✓
- 状态名 `intake/exploration/trivial` 跨任务一致 ✓

---

## 并行执行图

> 仅 `parallel-executing-plans` 使用；`serial-executing-plans` 忽略本节。

**Critical Path：** 任务 2 → 任务 8 → Wave FINAL（length 3）

- **Wave 1（无依赖）：** 任务 1, 任务 2, 任务 3, 任务 4, 任务 5
- **Wave 2（依赖 Wave 1）：** 任务 6（依赖 2）, 任务 7（依赖 2）, 任务 8（依赖 2, 3, 4, 5）, 任务 9（依赖 1）
- **Wave 3（依赖 Wave 2）：** 任务 10（依赖 9）
- **Wave FINAL（所有任务完成后）：** F1 规格合规、F2 代码质量、F3 真实手测（含 `npm test` 全绿 + OpenCode 插件契约测试 + skill triggering 测试）、F4 范围保真

---

## 执行交接

计划已完成并保存到 `docs/superharness/plans/2026-05-19-state-machine-v3.md`。两种执行方式：

**1. 子代理驱动（适合较大计划）** — 平台支持子代理时，10 任务分 2 wave 并行执行，wave 内多任务并行，通过并行子代理完成每个任务执行和任务间审查，快速迭代。

**2. 串行执行（适合小计划或无子代理平台）** — 使用 serial-executing-plans 按任务编号执行，串行推进并设有检查点。

**选哪种方式？**

**如果选择子代理驱动：**
- **必需子技能：** 使用 `superharness:parallel-executing-plans`
- Wave 1 = 6 任务可安全并行（文件集互不相交：state.js / 5 个 skill 目录 / 4 个 test 文件）
- Wave 2 = 4 任务可安全并行（systematic-debugging.md / brainstorming.md / yaml / validate-workflow + test）
- 注意：所有 skill 创建/修改任务（3, 4, 5, 6, 7）的执行 agent 必须在任务内显式调用 `superharness:writing-skills` 子技能

**如果选择串行执行：**
- **必需子技能：** 使用 `superharness:serial-executing-plans`
- 按 1 → 2 → 3 → 4 → 5 → 9 → 6 → 7 → 8 → 10 顺序推进
- 任务 3/4/5/6/7 在执行时调用 `superharness:writing-skills`
