#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function resolvePluginRoot() {
  return path.resolve(
    process.env.CLAUDE_PLUGIN_ROOT
      || process.env.CODEX_PLUGIN_ROOT
      || process.env.PLUGIN_ROOT
      || path.join(__dirname, '..'),
  );
}

function hookOutput(additionalContext) {
  return additionalContext
    ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }
    : {};
}

export async function main() {
  try {
    const input = await readStdinJson();
    const toState = input?.tool_input?.to_state;
    if (!toState) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }
    const pluginRoot = resolvePluginRoot();
    const workflowStateDir = path.join(pluginRoot, 'workflow-state-server');
    const [{ renderActiveSkill }, { loadWorkflowConfig, buildWorkflowGraph }] = await Promise.all([
      import(pathToFileURL(path.join(workflowStateDir, 'render-context.js')).href),
      import(pathToFileURL(path.join(workflowStateDir, 'validate-workflow.js')).href),
    ]);

    const skillsDir = path.join(pluginRoot, 'skills');

    // State 名 (e.g. serial_execution) → skill 目录名 (serial-execution) 由 YAML
    // 的 state.skill 字段映射。从 graph 拿，不要直接用 stateName 当 skill name。
    let skillName = toState;
    try {
      const config = loadWorkflowConfig({ pluginRoot });
      const installedSkills = new Set();
      if (fs.existsSync(skillsDir)) {
        for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))) {
            installedSkills.add(e.name);
          }
        }
      }
      const graph = buildWorkflowGraph(config, { installedSkills });
      skillName = graph.states.get(toState)?.skill ?? toState;
    } catch {
      // graph 加载失败 → 回退用 stateName 当 skill name；renderActiveSkill 再 fail-open
    }

    try {
      const skillContext = renderActiveSkill({ stateName: toState, skillsDir, skillName });
      process.stdout.write(JSON.stringify(hookOutput(skillContext)) + '\n');
    } catch {
      // unknown state 或 SKILL 文件不存在 → fail-open
      process.stdout.write(JSON.stringify({}) + '\n');
    }
  } catch {
    // fail-open: hook 错误绝不阻塞 agent
    process.stdout.write(JSON.stringify({}) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
