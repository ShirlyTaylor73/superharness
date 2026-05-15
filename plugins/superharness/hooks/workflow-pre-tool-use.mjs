import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function normalizePathText(value) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function pathTouchesWorkflowState(value) {
  const normalized = normalizePathText(value);
  return normalized.includes('/.superharness/')
    || normalized.startsWith('.superharness/')
    || normalized.includes('.superharness/');
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function isWriteCommand(command) {
  return />>?|(^|\s)(rm|del|move|mv|copy|cp|set-content|add-content|out-file|sqlite3)(\s|$)/i
    .test(command);
}

function shouldDeny(input) {
  const toolName = input.tool_name || input.toolName || '';
  const toolInput = input.tool_input || input.toolInput || {};
  const strings = collectStrings(toolInput);

  if (/^bash$/i.test(toolName)) {
    const command = typeof toolInput.command === 'string' ? toolInput.command : strings.join('\n');
    return pathTouchesWorkflowState(command) && isWriteCommand(command);
  }

  return strings.some(pathTouchesWorkflowState);
}

function denyOutput() {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Workflow state is managed by superharness workflow tools; do not edit .superharness/ directly.',
    },
  };
}

export async function main() {
  const input = await readStdinJson();
  if (shouldDeny(input)) {
    process.stdout.write(`${JSON.stringify(denyOutput())}\n`);
    return;
  }
  process.stdout.write('{}\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
