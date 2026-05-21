import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderWorkflowContext,
  renderStopWorkContext,
  stripFrontmatter,
  resolveSkillPath,
  renderActiveSkill,
  renderStrictAppendix,
} from '../render-context.js';
import { buildWorkflowGraph } from '../validate-workflow.js';

const installedSkills = new Set([
  'intake',
  'exploration',
  'trivial',
  'brainstorming',
  'planning',
  'serial-execution',
  'parallel-execution',
  'verification',
  'finishing',
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

// v3 has no router state in the default workflow, but renderWorkflowContext
// still supports `type: router` for forward-compatibility / workspace overrides.
// Build a tiny throwaway graph that contains a router node so we can exercise
// the router-guard branch without touching the v3 fixture above.
const routerGraph = buildWorkflowGraph({
  version: 1,
  entryState: 'intake',
  terminalStates: [],
  states: {
    intake: { type: 'interactive', skill: 'intake', next: ['execution_choice'] },
    execution_choice: { type: 'router', next: ['serial_execution', 'parallel_execution', 'systematic_debugging'] },
    serial_execution: { type: 'execution', skill: 'serial-execution', next: ['systematic_debugging'] },
    parallel_execution: { type: 'execution', skill: 'parallel-execution', next: ['systematic_debugging'] },
    systematic_debugging: { type: 'preemptive', skill: 'systematic-debugging', next: ['previous_state'] },
  },
}, { installedSkills });

function createSkillsDir() {
  const skillsDir = mkdtempSync(path.join(tmpdir(), 'superharness-skills-'));
  for (const skill of ['planning', 'serial-execution', 'parallel-execution']) {
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
    expect(resolveSkillPath({ skillsDir, skillName: 'planning' }))
      .toBe(path.join(skillsDir, 'planning', 'SKILL.md'));
  });

  it('rejects invalid skill names', () => {
    const skillsDir = createSkillsDir();
    expect(() => resolveSkillPath({ skillsDir, skillName: '../planning' }))
      .toThrow(/invalid skill name/);
  });
});

describe('renderWorkflowContext', () => {
  it('injects the planning skill in planning state', () => {
    const skillsDir = createSkillsDir();
    const context = renderWorkflowContext({
      stateInfo: { state: 'planning', previous_state: null, active_skill: 'planning' },
      workflowGraph,
      skillsDir,
    });

    expect(context).toContain('<SUPERHARNESS_WORKFLOW_STATE>');
    expect(context).toContain('current_state: planning');
    expect(context).toContain('active_skill: planning');
    expect(context).toContain('allowed_transitions: ["serial_execution","parallel_execution"]');
    expect(context).toContain('Do not edit .superharness/ directly.');
    expect(context).toContain('--- Active skill: planning ---');
    expect(context).toContain('Body for planning.');
    expect(context).not.toContain('description: test skill');
  });

  it('injects serial and parallel execution skills', () => {
    const skillsDir = createSkillsDir();
    const serial = renderWorkflowContext({
      stateInfo: { state: 'serial_execution', previous_state: null, active_skill: 'serial-execution' },
      workflowGraph,
      skillsDir,
    });
    const parallel = renderWorkflowContext({
      stateInfo: { state: 'parallel_execution', previous_state: null, active_skill: 'parallel-execution' },
      workflowGraph,
      skillsDir,
    });

    expect(serial).toContain('Body for serial-execution.');
    expect(parallel).toContain('Body for parallel-execution.');
  });

  it('renders a short router guard for a router state without reading a skill', () => {
    const context = renderWorkflowContext({
      stateInfo: { state: 'execution_choice', previous_state: null, active_skill: null },
      workflowGraph: routerGraph,
      skillsDir: path.join(tmpdir(), 'missing-skills-dir'),
    });

    expect(context).toContain('current_state: execution_choice');
    expect(context).toContain('allowed_transitions: ["serial_execution","parallel_execution","systematic_debugging"]');
    expect(context).toContain('Select serial_execution or parallel_execution');
    expect(context).not.toContain('--- Active skill:');
  });

  it('throws a clear error when the active skill is missing', () => {
    expect(() => renderWorkflowContext({
      stateInfo: { state: 'planning', previous_state: null, active_skill: 'planning' },
      workflowGraph,
      skillsDir: path.join(tmpdir(), 'missing-skills-dir'),
    })).toThrow(/skill not found: planning/);
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

const skillsDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'skills');

describe('renderActiveSkill', () => {
  it('returns SKILL.md body of given state (no SUPERHARNESS_WORKFLOW_STATE wrapper)', () => {
    const out = renderActiveSkill({ stateName: 'intake', skillsDir });
    expect(out).toContain('Active skill: intake');
    expect(out).not.toContain('<SUPERHARNESS_WORKFLOW_STATE>');
  });

  it('throws on unknown state', () => {
    expect(() => renderActiveSkill({ stateName: 'nonexistent', skillsDir })).toThrow();
  });
});

describe('renderStrictAppendix', () => {
  it('returns non-empty append text when silent_stop_allowed=false', () => {
    const out = renderStrictAppendix({ silent_stop_allowed: false });
    expect(out).toContain('本轮');
    expect(out).toContain('transition_state');
  });

  it('returns empty string when silent_stop_allowed=true', () => {
    expect(renderStrictAppendix({ silent_stop_allowed: true })).toBe('');
  });
});
