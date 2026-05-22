import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Sync-ish check of free_mode flag without depending on state.js statically.
 * Opens DB, reads free_mode, returns false on any error (fail-open).
 */
export async function isFreeMode({ pluginRoot, workspaceRoot }) {
  const dbPath = process.env.SUPERHARNESS_WORKFLOW_STATE_DB
    || path.join(path.resolve(workspaceRoot), '.superharness', 'workflow-state.db');
  if (!fs.existsSync(dbPath)) return false;

  try {
    const { openWorkflowStateStore, readFreeMode } = await import(
      pathToFileURL(path.join(pluginRoot, 'workflow-state-server', 'state.js')).href
    );
    const store = openWorkflowStateStore({ dbPath });
    try {
      return readFreeMode(store, workspaceRoot);
    } finally {
      store.close?.();
    }
  } catch {
    return false;
  }
}
