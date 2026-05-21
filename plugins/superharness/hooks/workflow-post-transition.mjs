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

function loadInstalledSkills(pluginRoot) {
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return new Set();
  return new Set(
    fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
      .map((e) => e.name),
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
    const { renderActiveSkill } = await import(
      pathToFileURL(path.join(workflowStateDir, 'render-context.js')).href
    );

    const skillsDir = path.join(pluginRoot, 'skills');
    // Side effect: ensure skill registry is loadable; fail-open if not.
    loadInstalledSkills(pluginRoot);

    // skill name 可能与 state name 略有不同（serial_execution → serial-execution）—
    // render-context.js 应已封装这个转换；先 try state name 原样，如果 throw 再 fail-open
    try {
      const skillContext = renderActiveSkill({ stateName: toState, skillsDir });
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
