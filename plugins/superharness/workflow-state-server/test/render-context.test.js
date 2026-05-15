import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  renderWorkflowContext,
  renderStopWorkContext,
  stripFrontmatter,
  resolveSkillPath,
} from '../render-context.js';
import { buildWorkflowGraph } from '../validate-workflow.js';

const installedSkills = new Set([
  'brainstorming',
  'writing-plans',
  'serial-executing-plans',
  'parallel-executing-plans',
  'verification-before-completion',
  'finishing-a-development-branch',
  'systematic-debugging',
]);

const workflowGraph = buildWorkflowGraph({
  version: 1,
  entryState: 'brainstorming',
  terminalStates: ['done'],
  states: {
    brainstorming: { type: 'interactive', skill: 'brainstorming', next: ['planning', 'systematic_debugging'] },
    planning: { type: 'interactive', skill: 'writing-plans', next: ['execution_choice', 'systematic_debugging'] },
    execution_choice: { type: 'router', next: ['serial_execution', 'parallel_execution', 'systematic_debugging'] },
    serial_execution: { type: 'execution', skill: 'serial-executing-plans', next: ['verification', 'systematic_debugging'] },
    parallel_execution: { type: 'execution', skill: 'parallel-executing-plans', next: ['verification', 'systematic_debugging'] },
    verification: { type: 'gate', skill: 'verification-before-completion', next: ['finishing', 'systematic_debugging'] },
    finishing: { type: 'gate', skill: 'finishing-a-development-branch', next: ['done', 'systematic_debugging'] },
    systematic_debugging: { type: 'preemptive', skill: 'systematic-debugging', next: ['previous_state', 'serial_execution', 'planning'] },
    done: { type: 'terminal' },
  },
}, { installedSkills });

function createSkillsDir() {
  const skillsDir = mkdtempSync(path.join(tmpdir(), 'superharness-skills-'));
  for (const skill of ['writing-plans', 'serial-executing-plans', 'parallel-executing-plans']) {
    mkdirSync(path.join(skillsDir, skill), { recursive: true });
    writeFileSync(
      path.join(skillsDir, skill, 'SKILL.md'),
      [
        '---',
        `name: ${skill}`,
        'description: test skill',
        '---',
        '',
        `# ${skill}`,
        '',
        `Body for ${skill}.`,
      ].join('\n'),
    );
  }
  return skillsDir;
}

describe('stripFrontmatter', () => {
  it('removes leading frontmatter', () => {
    expect(stripFrontmatter('---\nname: x\n---\n# Body')).toBe('# Body');
  });

  it('leaves regular markdown unchanged', () => {
    expect(stripFrontmatter('# Body')).toBe('# Body');
  });
});

describe('resolveSkillPath', () => {
  it('resolves a valid skill path', () => {
    const skillsDir = createSkillsDir();
    expect(resolveSkillPath({ skillsDir, skillName: 'writing-plans' }))
      .toBe(path.join(skillsDir, 'writing-plans', 'SKILL.md'));
  });

  it('rejects invalid skill names', () => {
    const skillsDir = createSkillsDir();
    expect(() => resolveSkillPath({ skillsDir, skillName: '../writing-plans' }))
      .toThrow(/invalid skill name/);
  });
});

describe('renderWorkflowContext', () => {
  it('injects the writing-plans skill in planning state', () => {
    const skillsDir = createSkillsDir();
    const context = renderWorkflowContext({
      stateInfo: { state: 'planning', previous_state: null, active_skill: 'writing-plans' },
      workflowGraph,
      skillsDir,
    });

    expect(context).toContain('<SUPERHARNESS_WORKFLOW_STATE>');
    expect(context).toContain('current_state: planning');
    expect(context).toContain('active_skill: writing-plans');
    expect(context).toContain('allowed_transitions: ["execution_choice","systematic_debugging"]');
    expect(context).toContain('Do not edit .superharness/ directly.');
    expect(context).toContain('--- Active skill: writing-plans ---');
    expect(context).toContain('Body for writing-plans.');
    expect(context).not.toContain('description: test skill');
  });

  it('injects serial and parallel execution skills', () => {
    const skillsDir = createSkillsDir();
    const serial = renderWorkflowContext({
      stateInfo: { state: 'serial_execution', previous_state: null, active_skill: 'serial-executing-plans' },
      workflowGraph,
      skillsDir,
    });
    const parallel = renderWorkflowContext({
      stateInfo: { state: 'parallel_execution', previous_state: null, active_skill: 'parallel-executing-plans' },
      workflowGraph,
      skillsDir,
    });

    expect(serial).toContain('Body for serial-executing-plans.');
    expect(parallel).toContain('Body for parallel-executing-plans.');
  });

  it('renders a short router guard for execution_choice without reading a skill', () => {
    const context = renderWorkflowContext({
      stateInfo: { state: 'execution_choice', previous_state: null, active_skill: null },
      workflowGraph,
      skillsDir: path.join(tmpdir(), 'missing-skills-dir'),
    });

    expect(context).toContain('current_state: execution_choice');
    expect(context).toContain('allowed_transitions: ["serial_execution","parallel_execution","systematic_debugging"]');
    expect(context).toContain('Select serial_execution or parallel_execution');
    expect(context).not.toContain('--- Active skill:');
  });

  it('throws a clear error when the active skill is missing', () => {
    expect(() => renderWorkflowContext({
      stateInfo: { state: 'planning', previous_state: null, active_skill: 'writing-plans' },
      workflowGraph,
      skillsDir: path.join(tmpdir(), 'missing-skills-dir'),
    })).toThrow(/skill not found: writing-plans/);
  });
});

describe('renderStopWorkContext', () => {
  it('renders a stop-work instruction block', () => {
    const context = renderStopWorkContext({ reason: 'config failed' });
    expect(context).toContain('<SUPERHARNESS_WORKFLOW_STATE>');
    expect(context).toContain('config failed');
    expect(context).toContain('Stop business work');
    expect(context).toContain('Do not edit .superharness/ directly.');
  });
});
