import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkflowStateStore, createTurn, getTurn, incrementBlockCount, releaseTurnBlock } from '../state.js';

describe('workflow_turn CRUD', () => {
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
  });

  it('createTurn inserts new turn_id and resets block_count + release fields', () => {
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-1' });
    const row = getTurn(store, { workspaceRoot: '/ws/a' });
    expect(row.turn_id).toBe('uuid-1');
    expect(row.block_count).toBe(0);
    expect(row.stop_block_released).toBe(0);
    expect(row.release_reason).toBeNull();
  });

  it('createTurn overwrites previous turn for same workspace', () => {
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-1' });
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-2' });
    expect(getTurn(store, { workspaceRoot: '/ws/a' }).turn_id).toBe('uuid-2');
  });

  it('incrementBlockCount increases by 1', () => {
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-1' });
    incrementBlockCount(store, { workspaceRoot: '/ws/a' });
    incrementBlockCount(store, { workspaceRoot: '/ws/a' });
    expect(getTurn(store, { workspaceRoot: '/ws/a' }).block_count).toBe(2);
  });

  it('releaseTurnBlock sets stop_block_released=1 and release_reason', () => {
    createTurn(store, { workspaceRoot: '/ws/a', turnId: 'uuid-1' });
    releaseTurnBlock(store, { workspaceRoot: '/ws/a', reason: 'user authorized escape' });
    const row = getTurn(store, { workspaceRoot: '/ws/a' });
    expect(row.stop_block_released).toBe(1);
    expect(row.release_reason).toBe('user authorized escape');
  });
});
