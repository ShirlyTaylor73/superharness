import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const SPECIAL_TARGETS = new Set(['previous_state']);

function fail(message) {
  throw new Error(`invalid workflow config: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringList(value, field) {
  if (!Array.isArray(value)) {
    fail(`${field} must be an array`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(`${field} must contain only non-empty strings`);
    }
  }
  return value;
}

function defaultPluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function loadWorkflowConfig({ pluginRoot, workspaceRoot } = {}) {
  const resolvedPluginRoot = pluginRoot ? path.resolve(pluginRoot) : defaultPluginRoot();
  const candidates = [];

  if (workspaceRoot) {
    candidates.push(path.join(path.resolve(workspaceRoot), '.superharness', 'workflow.yaml'));
  }
  candidates.push(path.join(resolvedPluginRoot, 'workflow', 'default-workflow.yaml'));

  const configPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!configPath) {
    fail(`workflow file not found in ${candidates.join(', ')}`);
  }

  const content = fs.readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(content);
  if (!isObject(parsed)) {
    fail(`${configPath} must contain a workflow object`);
  }
  return parsed;
}

export function validateWorkflowConfig(config, { installedSkills } = {}) {
  if (!isObject(config)) {
    fail('root must be an object');
  }
  if (config.version !== 1) {
    fail('version must be 1');
  }
  if (typeof config.entryState !== 'string' || config.entryState.trim() === '') {
    fail('entryState must be a non-empty string');
  }
  if (!isObject(config.states)) {
    fail('states must be an object');
  }
  if (!Object.hasOwn(config.states, config.entryState)) {
    fail(`entryState references missing state ${config.entryState}`);
  }

  // intake hard constraint (v3 state machine requires intake as entryState)
  if (!Object.hasOwn(config.states, 'intake')) {
    fail('intake state must exist (entry state for v3 state machine)');
  }
  if (config.entryState !== 'intake') {
    fail(`entryState must be 'intake', got '${config.entryState}'`);
  }

  const terminalStates = normalizeStringList(config.terminalStates ?? [], 'terminalStates');
  const terminalSet = new Set(terminalStates);

  for (const terminalState of terminalSet) {
    if (!Object.hasOwn(config.states, terminalState)) {
      fail(`terminalStates references missing state ${terminalState}`);
    }
  }

  for (const [stateName, state] of Object.entries(config.states)) {
    if (!isObject(state)) {
      fail(`${stateName} must be an object`);
    }

    const isTerminal = terminalSet.has(stateName) || state.type === 'terminal';
    if (isTerminal) {
      if (state.skill) {
        fail(`${stateName} terminal state must not define skill`);
      }
      if (Array.isArray(state.next) && state.next.length > 0) {
        fail(`${stateName} terminal state must not define next`);
      }
      continue;
    }

    if (!state.type || typeof state.type !== 'string') {
      fail(`${stateName} type must be a non-empty string`);
    }

    const next = normalizeStringList(state.next ?? [], `${stateName}.next`);
    if (next.length === 0) {
      fail(`${stateName} next must contain at least one exit`);
    }

    if (state.skill !== undefined) {
      if (typeof state.skill !== 'string' || state.skill.trim() === '') {
        fail(`${stateName} skill must be a non-empty string`);
      }
      if (installedSkills && !installedSkills.has(state.skill)) {
        fail(`${stateName} skill references missing skill ${state.skill}`);
      }
    }

    for (const target of next) {
      if (SPECIAL_TARGETS.has(target)) continue;
      if (!Object.hasOwn(config.states, target)) {
        fail(`${stateName} next references missing state ${target}`);
      }
    }
  }

  const debugState = config.states.systematic_debugging;
  if (debugState && !terminalSet.has('systematic_debugging')) {
    const exits = Array.isArray(debugState.next) ? debugState.next : [];
    if (!exits.includes('previous_state')) {
      fail('systematic_debugging next must include previous_state');
    }
  }

  return config;
}

export function buildWorkflowGraph(config, { installedSkills } = {}) {
  validateWorkflowConfig(config, { installedSkills });

  const terminalSet = new Set(config.terminalStates ?? []);
  const states = new Map();
  for (const [name, state] of Object.entries(config.states)) {
    const terminal = terminalSet.has(name) || state.type === 'terminal';
    states.set(name, {
      name,
      type: state.type,
      skill: state.skill ?? null,
      next: terminal ? [] : [...state.next],
      terminal,
    });
  }

  return {
    version: config.version,
    entryState: config.entryState,
    terminalStates: terminalSet,
    states,
  };
}
