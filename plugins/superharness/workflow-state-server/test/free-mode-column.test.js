import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkflowStateStore, readFreeMode, assertNotFreeMode } from '../state.js';

const WS = '/tmp/ws';
const WS_ID = path.resolve(WS);

describe('free_mode column', () => {
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
  });

  it('readFreeMode returns false when no row exists', () => {
    expect(readFreeMode(store, WS)).toBe(false);
  });

  it('readFreeMode returns true when free_mode = 1', () => {
    store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, free_mode, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(WS_ID, 'intake', 'active', 1, Date.now());
    expect(readFreeMode(store, WS)).toBe(true);
  });

  it('assertNotFreeMode throws when free_mode = 1', () => {
    store.prepare(`INSERT INTO workflow_state (workspace_id, state, status, free_mode, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(WS_ID, 'intake', 'active', 1, Date.now());
    expect(() => assertNotFreeMode(store, WS))
      .toThrow(/free mode/);
  });

  it('ensureFreeModeColumns is idempotent on existing schema', () => {
    const store2 = openWorkflowStateStore({ mode: 'memory' });
    expect(() => store2.close()).not.toThrow();
  });
});
