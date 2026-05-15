import fs from 'node:fs';
import path from 'node:path';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function requireStateNode(workflowGraph, stateName) {
  const node = workflowGraph?.states?.get(stateName);
  if (!node) {
    throw new Error(`workflow state not found: ${stateName}`);
  }
  return node;
}

export function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function resolveSkillPath({ skillsDir, skillName }) {
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    throw new Error(`invalid skill name: ${skillName}`);
  }
  const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`skill not found: ${skillName}`);
  }
  return skillPath;
}

function renderFacts({ stateInfo, node }) {
  return [
    'Runtime facts:',
    `- current_state: ${stateInfo.state}`,
    `- previous_state: ${stateInfo.previous_state ?? 'null'}`,
    `- active_skill: ${stateInfo.active_skill ?? node.skill ?? 'null'}`,
    `- allowed_transitions: ${JSON.stringify(node.next)}`,
    '- state_directory: .superharness/',
  ].join('\n');
}

function renderRules() {
  return [
    'Rules:',
    '- Follow the active skill below for this turn.',
    '- If the state exit condition is met, call transition_state with a non-empty reason.',
    '- Do not edit .superharness/ directly.',
    '- If workflow config or state cannot be loaded, stop business work and report the error.',
  ].join('\n');
}

function renderRouterGuard() {
  return [
    'Router guard:',
    '- Select serial_execution or parallel_execution based on the written plan and platform capability.',
    '- If execution cannot safely proceed, transition to systematic_debugging with a concrete reason.',
  ].join('\n');
}

export function renderWorkflowContext({ stateInfo, workflowGraph, skillsDir }) {
  if (!stateInfo?.state) {
    throw new Error('stateInfo.state is required');
  }

  const node = requireStateNode(workflowGraph, stateInfo.state);
  const parts = [
    '<SUPERHARNESS_WORKFLOW_STATE>',
    renderFacts({ stateInfo, node }),
    '',
    renderRules(),
  ];

  if (node.type === 'router') {
    parts.push('', renderRouterGuard(), '</SUPERHARNESS_WORKFLOW_STATE>');
    return parts.join('\n');
  }

  const skillName = stateInfo.active_skill ?? node.skill;
  if (skillName) {
    const skillPath = resolveSkillPath({ skillsDir, skillName });
    const skillContent = stripFrontmatter(fs.readFileSync(skillPath, 'utf8')).trim();
    parts.push('', `--- Active skill: ${skillName} ---`, skillContent);
  }

  parts.push('</SUPERHARNESS_WORKFLOW_STATE>');
  return parts.join('\n');
}

export function renderStopWorkContext({ reason }) {
  return [
    '<SUPERHARNESS_WORKFLOW_STATE>',
    'Runtime status: unavailable',
    `Reason: ${reason || 'workflow state context could not be loaded'}`,
    '',
    'Rules:',
    '- Stop business work.',
    '- Report the workflow error to the user.',
    '- Do not invent workflow state.',
    '- Do not edit .superharness/ directly.',
    '</SUPERHARNESS_WORKFLOW_STATE>',
  ].join('\n');
}
