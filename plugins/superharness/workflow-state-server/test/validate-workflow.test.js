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

const validConfig = () => ({
  version: 1,
  entryState: 'intake',
  terminalStates: [],
  states: {
    intake: {
      type: 'interactive',
      skill: 'intake',
      next: ['exploration', 'trivial', 'brainstorming'],
    },
    exploration: {
      type: 'interactive',
      skill: 'exploration',
      next: ['intake'],
    },
    trivial: {
      type: 'execution',
      skill: 'trivial',
      next: ['intake', 'systematic_debugging'],
    },
    brainstorming: {
      type: 'interactive',
      skill: 'brainstorming',
      next: ['planning'],
    },
    planning: {
      type: 'interactive',
      skill: 'planning',
      next: ['serial_execution', 'parallel_execution'],
    },
    serial_execution: {
      type: 'execution',
      skill: 'serial-execution',
      next: ['verification', 'systematic_debugging'],
    },
    parallel_execution: {
      type: 'execution',
      skill: 'parallel-execution',
      next: ['verification', 'systematic_debugging'],
    },
    verification: {
      type: 'gate',
      skill: 'verification',
      next: ['finishing', 'systematic_debugging'],
    },
    finishing: {
      type: 'gate',
      skill: 'finishing',
      next: ['intake', 'systematic_debugging'],
    },
    systematic_debugging: {
      type: 'preemptive',
      skill: 'systematic-debugging',
      next: ['previous_state', 'serial_execution', 'planning'],
    },
  },
});

describe('validateWorkflowConfig', () => {
  it('accepts the default workflow shape', () => {
    const graph = buildWorkflowGraph(validConfig(), { installedSkills });
    expect(graph.entryState).toBe('intake');
    expect(graph.states.get('planning').skill).toBe('planning');
    expect(graph.states.get('intake').skill).toBe('intake');
    expect(graph.terminalStates.size).toBe(0);
  });

  it('rejects a missing entryState', () => {
    expect(() => validateWorkflowConfig({ version: 1, states: {} }, { installedSkills }))
      .toThrow(/entryState/);
  });

  it('rejects a next target that does not exist', () => {
    const config = validConfig();
    config.states.intake.next = ['missing_state'];
    expect(() => validateWorkflowConfig(config, { installedSkills }))
      .toThrow(/intake.*next.*missing_state/);
  });

  it('rejects a state that references a missing skill', () => {
    const config = validConfig();
    config.states.planning.skill = 'missing-skill';
    expect(() => validateWorkflowConfig(config, { installedSkills }))
      .toThrow(/planning.*skill.*missing-skill/);
  });

  it('rejects a terminal state with a skill', () => {
    // v3 has no built-in terminal states. Synthesise one for this check.
    const config = validConfig();
    config.terminalStates = ['parked'];
    config.states.parked = { type: 'terminal', skill: 'intake' };
    expect(() => validateWorkflowConfig(config, { installedSkills }))
      .toThrow(/parked.*terminal.*skill/);
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
