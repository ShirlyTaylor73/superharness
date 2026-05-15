import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadWorkflowConfig,
  validateWorkflowConfig,
  buildWorkflowGraph,
} from '../validate-workflow.js';

const installedSkills = new Set([
  'brainstorming',
  'writing-plans',
  'serial-executing-plans',
  'parallel-executing-plans',
  'verification-before-completion',
  'finishing-a-development-branch',
  'systematic-debugging',
]);

const validConfig = () => ({
  version: 1,
  entryState: 'brainstorming',
  terminalStates: ['done'],
  states: {
    brainstorming: {
      type: 'interactive',
      skill: 'brainstorming',
      next: ['planning', 'systematic_debugging'],
    },
    planning: {
      type: 'interactive',
      skill: 'writing-plans',
      next: ['execution_choice', 'systematic_debugging'],
    },
    execution_choice: {
      type: 'router',
      next: ['serial_execution', 'parallel_execution', 'systematic_debugging'],
    },
    serial_execution: {
      type: 'execution',
      skill: 'serial-executing-plans',
      next: ['verification', 'systematic_debugging'],
    },
    parallel_execution: {
      type: 'execution',
      skill: 'parallel-executing-plans',
      next: ['verification', 'systematic_debugging'],
    },
    verification: {
      type: 'gate',
      skill: 'verification-before-completion',
      next: ['finishing', 'systematic_debugging'],
    },
    finishing: {
      type: 'gate',
      skill: 'finishing-a-development-branch',
      next: ['done', 'systematic_debugging'],
    },
    systematic_debugging: {
      type: 'preemptive',
      skill: 'systematic-debugging',
      next: ['previous_state', 'serial_execution', 'planning'],
    },
    done: {
      type: 'terminal',
    },
  },
});

describe('validateWorkflowConfig', () => {
  it('accepts the default workflow shape', () => {
    const graph = buildWorkflowGraph(validConfig(), { installedSkills });
    expect(graph.entryState).toBe('brainstorming');
    expect(graph.states.get('planning').skill).toBe('writing-plans');
    expect(graph.states.get('done').terminal).toBe(true);
  });

  it('rejects a missing entryState', () => {
    expect(() => validateWorkflowConfig({ version: 1, states: {} }, { installedSkills }))
      .toThrow(/entryState/);
  });

  it('rejects a next target that does not exist', () => {
    const config = validConfig();
    config.states.brainstorming.next = ['missing_state'];
    expect(() => validateWorkflowConfig(config, { installedSkills }))
      .toThrow(/brainstorming.*next.*missing_state/);
  });

  it('rejects a state that references a missing skill', () => {
    const config = validConfig();
    config.states.planning.skill = 'missing-skill';
    expect(() => validateWorkflowConfig(config, { installedSkills }))
      .toThrow(/planning.*skill.*missing-skill/);
  });

  it('rejects a terminal state with a skill', () => {
    const config = validConfig();
    config.states.done.skill = 'brainstorming';
    expect(() => validateWorkflowConfig(config, { installedSkills }))
      .toThrow(/done.*terminal.*skill/);
  });

  it('rejects a non-terminal state without exits', () => {
    const config = validConfig();
    config.states.planning.next = [];
    expect(() => validateWorkflowConfig(config, { installedSkills }))
      .toThrow(/planning.*next/);
  });

  it('rejects systematic_debugging without previous_state exit', () => {
    const config = validConfig();
    config.states.systematic_debugging.next = ['planning'];
    expect(() => validateWorkflowConfig(config, { installedSkills }))
      .toThrow(/systematic_debugging.*previous_state/);
  });
});

describe('loadWorkflowConfig', () => {
  it('prefers workspace workflow over plugin default', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'superharness-workflow-'));
    const workspaceRoot = path.join(root, 'workspace');
    const pluginRoot = path.join(root, 'plugin');
    mkdirSync(path.join(workspaceRoot, '.superharness'), { recursive: true });
    mkdirSync(path.join(pluginRoot, 'workflow'), { recursive: true });
    copyFileSync(
      path.resolve('..', 'workflow', 'default-workflow.yaml'),
      path.join(pluginRoot, 'workflow', 'default-workflow.yaml'),
    );

    writeFileSync(
      path.join(workspaceRoot, '.superharness', 'workflow.yaml'),
      [
        'version: 1',
        'entryState: done',
        'terminalStates:',
        '  - done',
        'states:',
        '  done:',
        '    type: terminal',
      ].join('\n'),
    );

    const loaded = loadWorkflowConfig({ pluginRoot, workspaceRoot });
    expect(loaded.entryState).toBe('done');
  });
});
