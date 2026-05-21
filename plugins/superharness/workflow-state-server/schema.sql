CREATE TABLE IF NOT EXISTS workflow_state (
  workspace_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  previous_state TEXT,
  active_skill TEXT,
  task_summary TEXT,
  failure_summary TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_transition_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  previous_state TEXT,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('hook','agent-tool','user-reset')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_transition_workspace
  ON workflow_transition_log(workspace_id, id);

CREATE TABLE IF NOT EXISTS workflow_turn (
  workspace_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  block_count INTEGER NOT NULL DEFAULT 0,
  stop_block_released INTEGER NOT NULL DEFAULT 0,
  release_reason TEXT,
  created_at INTEGER NOT NULL
);

-- Note: idx_workflow_transition_turn is created in state.js::ensureTurnIdColumn
-- because the turn_id column is added via ALTER for backwards compatibility
-- with pre-v1.3.0 databases.
