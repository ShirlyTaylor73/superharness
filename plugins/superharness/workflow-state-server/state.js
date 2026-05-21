import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_BUN = typeof process !== 'undefined' && !!process.versions?.bun;
const Database = IS_BUN
  ? (await import('bun:sqlite')).Database
  : (await import('better-sqlite3')).default;

const VALID_SOURCES = new Set(['hook', 'agent-tool', 'user-reset']);

function now() {
  return Date.now();
}

function requireReason(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('reason must be a non-empty string');
  }
  return reason.trim();
}

function requireWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new Error('workspaceRoot must be a non-empty string');
  }
  return path.resolve(workspaceRoot);
}

function requireWorkflowGraph(workflowGraph) {
  if (!workflowGraph?.states || !workflowGraph?.entryState) {
    throw new Error('workflowGraph is required');
  }
  return workflowGraph;
}

function activeSkillFor(workflowGraph, stateName) {
  return workflowGraph.states.get(stateName)?.skill ?? null;
}

function statusFor(workflowGraph, stateName) {
  return workflowGraph.states.get(stateName)?.terminal ? 'completed' : 'active';
}

function normalizeSource(source = 'agent-tool') {
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`invalid source: ${source}`);
  }
  return source;
}

function readSchema() {
  return fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'),
    'utf8',
  );
}

export function ensureTurnIdColumn(db) {
  const columns = db.prepare("PRAGMA table_info(workflow_transition_log)").all();
  const hasTurnId = columns.some((c) => c.name === 'turn_id');
  if (!hasTurnId) {
    db.exec("ALTER TABLE workflow_transition_log ADD COLUMN turn_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_transition_turn ON workflow_transition_log(turn_id)");
}

export function createTurn(store, { workspaceRoot, turnId }) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  store.db.prepare(`
    INSERT OR REPLACE INTO workflow_turn
    (workspace_id, turn_id, block_count, stop_block_released, release_reason, created_at)
    VALUES (?, ?, 0, 0, NULL, ?)
  `).run(workspaceId, turnId, now());
}

export function getTurn(store, { workspaceRoot }) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  return store.db.prepare('SELECT * FROM workflow_turn WHERE workspace_id = ?').get(workspaceId) ?? null;
}

export function incrementBlockCount(store, { workspaceRoot }) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  store.db.prepare('UPDATE workflow_turn SET block_count = block_count + 1 WHERE workspace_id = ?').run(workspaceId);
}

export function releaseTurnBlock(store, { workspaceRoot, reason }) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  store.db.prepare('UPDATE workflow_turn SET stop_block_released = 1, release_reason = ? WHERE workspace_id = ?').run(reason, workspaceId);
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    workspace_id: row.workspace_id,
    state: row.state,
    status: row.status,
    previous_state: row.previous_state ?? null,
    active_skill: row.active_skill ?? null,
    task_summary: row.task_summary ?? null,
    failure_summary: row.failure_summary ?? null,
    updated_at: row.updated_at,
  };
}

function getRow(store, workspaceId) {
  return normalizeRow(
    store.prepare('SELECT * FROM workflow_state WHERE workspace_id = ?').get(workspaceId),
  );
}

function insertLog(store, {
  workspaceId,
  fromState,
  toState,
  previousState,
  reason,
  source,
  createdAt = now(),
}) {
  const turnRow = store.prepare('SELECT turn_id FROM workflow_turn WHERE workspace_id = ?').get(workspaceId);
  const turnId = turnRow?.turn_id ?? null;
  store.prepare(`
    INSERT INTO workflow_transition_log (
      workspace_id, from_state, to_state, previous_state, reason, source, turn_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, fromState ?? null, toState, previousState ?? null, reason, source, turnId, createdAt);
}

function upsertState(store, {
  workspaceId,
  workflowGraph,
  state,
  previousState = null,
  taskSummary = null,
  failureSummary = null,
  updatedAt = now(),
}) {
  store.prepare(`
    INSERT INTO workflow_state (
      workspace_id, state, status, previous_state, active_skill,
      task_summary, failure_summary, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      state = excluded.state,
      status = excluded.status,
      previous_state = excluded.previous_state,
      active_skill = excluded.active_skill,
      task_summary = excluded.task_summary,
      failure_summary = excluded.failure_summary,
      updated_at = excluded.updated_at
  `).run(
    workspaceId,
    state,
    statusFor(workflowGraph, state),
    previousState,
    activeSkillFor(workflowGraph, state),
    taskSummary,
    failureSummary,
    updatedAt,
  );
  return getRow(store, workspaceId);
}

function assertTransitionAllowed(workflowGraph, fromState, toState) {
  const fromNode = workflowGraph.states.get(fromState);
  if (!fromNode) {
    throw new Error(`unknown from_state: ${fromState}`);
  }
  if (!fromNode.next.includes(toState)) {
    throw new Error(`transition ${fromState} -> ${toState} is not allowed`);
  }
}

const LEGACY_STATE_MAP = {
  done: 'intake',
  execution_choice: 'planning',
};

function migrateLegacyState(store, workspaceId, current) {
  if (!current) return current;
  const target = LEGACY_STATE_MAP[current.state];
  if (!target) return current;

  const updatedAt = now();
  store.prepare(`
    UPDATE workflow_state
       SET state = ?,
           status = 'active',
           previous_state = NULL,
           active_skill = NULL,
           updated_at = ?
     WHERE workspace_id = ?
  `).run(target, updatedAt, workspaceId);

  insertLog(store, {
    workspaceId,
    fromState: current.state,
    toState: target,
    previousState: null,
    reason: `legacy migration: ${current.state} -> ${target} (state removed in v3 state machine)`,
    source: 'user-reset',
    createdAt: updatedAt,
  });

  return getRow(store, workspaceId);
}

export { migrateLegacyState };

export function resolveWorkflowDbPath({ workspaceRoot } = {}) {
  if (process.env.SUPERHARNESS_WORKFLOW_STATE_DB) {
    return process.env.SUPERHARNESS_WORKFLOW_STATE_DB;
  }
  return path.join(requireWorkspaceRoot(workspaceRoot ?? process.cwd()), '.superharness', 'workflow-state.db');
}

export function openWorkflowStateStore({ dbPath, mode } = {}) {
  const resolvedDbPath = mode === 'memory' ? ':memory:' : path.resolve(dbPath ?? resolveWorkflowDbPath());
  if (resolvedDbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
  }

  const db = new Database(resolvedDbPath);
  const store = {
    db,
    path: resolvedDbPath,
    exec(sql) {
      return db.exec(sql);
    },
    prepare(sql) {
      return typeof db.prepare === 'function' ? db.prepare(sql) : db.query(sql);
    },
    close() {
      return db.close();
    },
  };

  if (resolvedDbPath !== ':memory:') {
    store.exec('PRAGMA journal_mode = WAL');
  }
  store.exec('PRAGMA foreign_keys = ON');
  store.exec(readSchema());
  ensureTurnIdColumn(store);

  return store;
}

export function initializeWorkflowState(store, {
  workspaceRoot,
  workflowGraph,
  reason = 'initialize workflow state',
} = {}) {
  const graph = requireWorkflowGraph(workflowGraph);
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  const existing = getRow(store, workspaceId);
  if (existing) {
    return migrateLegacyState(store, workspaceId, existing) ?? existing;
  }

  const trimmedReason = requireReason(reason);
  const state = upsertState(store, {
    workspaceId,
    workflowGraph: graph,
    state: graph.entryState,
  });
  insertLog(store, {
    workspaceId,
    fromState: null,
    toState: graph.entryState,
    previousState: null,
    reason: trimmedReason,
    source: 'hook',
  });
  return state;
}

export function getWorkflowState(store, { workspaceRoot, workflowGraph } = {}) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  const existing = getRow(store, workspaceId);
  if (existing) {
    return migrateLegacyState(store, workspaceId, existing) ?? existing;
  }
  if (!workflowGraph) {
    return null;
  }
  return initializeWorkflowState(store, {
    workspaceRoot,
    workflowGraph,
    reason: 'initialize workflow state',
  });
}

export function classifyRequest(store, {
  workspaceRoot,
  workflowGraph,
  task_summary = null,
  failure_summary = null,
  reason,
} = {}) {
  const graph = requireWorkflowGraph(workflowGraph);
  const trimmedReason = requireReason(reason);
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  const current = getWorkflowState(store, { workspaceRoot, workflowGraph: graph });

  const updated = upsertState(store, {
    workspaceId,
    workflowGraph: graph,
    state: current.state,
    previousState: current.previous_state,
    taskSummary: task_summary,
    failureSummary: failure_summary,
  });
  insertLog(store, {
    workspaceId,
    fromState: current.state,
    toState: current.state,
    previousState: current.previous_state,
    reason: trimmedReason,
    source: 'agent-tool',
  });
  return updated;
}

export function transitionWorkflowState(store, {
  workspaceRoot,
  workflowGraph,
  from_state,
  to_state,
  previous_state = null,
  reason,
  source = 'agent-tool',
} = {}) {
  const graph = requireWorkflowGraph(workflowGraph);
  const trimmedReason = requireReason(reason);
  const normalizedSource = normalizeSource(source);
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  const current = getWorkflowState(store, { workspaceRoot, workflowGraph: graph });

  if (from_state !== current.state) {
    throw new Error(`from_state ${from_state} does not match current state ${current.state}`);
  }

  let target = to_state;
  if (target === 'previous_state') {
    if (current.state !== 'systematic_debugging') {
      throw new Error('previous_state transition is only valid from systematic_debugging');
    }
    assertTransitionAllowed(graph, current.state, 'previous_state');
    if (!current.previous_state) {
      throw new Error('previous_state transition has no recorded previous_state');
    }
    target = current.previous_state;
  } else {
    assertTransitionAllowed(graph, current.state, target);
  }

  if (!graph.states.has(target)) {
    throw new Error(`unknown to_state: ${target}`);
  }

  const nextPreviousState = target === 'systematic_debugging'
    ? (previous_state || current.state)
    : null;

  const updated = upsertState(store, {
    workspaceId,
    workflowGraph: graph,
    state: target,
    previousState: nextPreviousState,
    taskSummary: current.task_summary,
    failureSummary: current.failure_summary,
  });
  insertLog(store, {
    workspaceId,
    fromState: current.state,
    toState: target,
    previousState: nextPreviousState,
    reason: trimmedReason,
    source: normalizedSource,
  });
  return updated;
}

export function listWorkflowHistory(store, { workspaceRoot } = {}) {
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  return store.prepare(`
    SELECT id, workspace_id, from_state, to_state, previous_state, reason, source, created_at
    FROM workflow_transition_log
    WHERE workspace_id = ?
    ORDER BY id ASC
  `).all(workspaceId);
}

export function resetWorkflowState(store, {
  workspaceRoot,
  workflowGraph,
  reason,
} = {}) {
  const graph = requireWorkflowGraph(workflowGraph);
  const trimmedReason = requireReason(reason);
  const workspaceId = requireWorkspaceRoot(workspaceRoot);
  const current = getWorkflowState(store, { workspaceRoot, workflowGraph: graph });
  const reset = upsertState(store, {
    workspaceId,
    workflowGraph: graph,
    state: graph.entryState,
  });
  insertLog(store, {
    workspaceId,
    fromState: current.state,
    toState: graph.entryState,
    previousState: null,
    reason: trimmedReason,
    source: 'user-reset',
  });
  return reset;
}
