import { describe, it, expect, beforeEach } from 'vitest';
import { openWorkflowStateStore, createTurn, getTurn } from '../state.js';
import { handleReleaseStopBlock } from '../server.js';

describe('release_stop_block MCP tool', () => {
  let store;
  beforeEach(() => {
    store = openWorkflowStateStore({ mode: 'memory' });
    createTurn(store, { workspaceRoot: '/ws', turnId: 'uuid-1' });
  });

  it('sets stop_block_released=1 and release_reason', async () => {
    const res = await handleReleaseStopBlock({
      store,
      workspaceRoot: '/ws',
      args: { reason: '环境错误，用户授权终止' },
    });
    expect(res.ok).toBe(true);
    const row = getTurn(store, { workspaceRoot: '/ws' });
    expect(row.stop_block_released).toBe(1);
    expect(row.release_reason).toBe('环境错误，用户授权终止');
  });

  it('writes audit row with [escape] prefix', async () => {
    await handleReleaseStopBlock({
      store,
      workspaceRoot: '/ws',
      args: { reason: '磁盘满' },
    });
    const auditRows = store.db.prepare("SELECT * FROM workflow_transition_log WHERE reason LIKE '[escape]%'").all();
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].reason).toContain('磁盘满');
  });

  it('rejects empty reason', async () => {
    await expect(handleReleaseStopBlock({
      store,
      workspaceRoot: '/ws',
      args: { reason: '' },
    })).rejects.toThrow(/reason/);
  });

  it('rejects placeholder reason (ok / start)', async () => {
    await expect(handleReleaseStopBlock({
      store,
      workspaceRoot: '/ws',
      args: { reason: 'ok' },
    })).rejects.toThrow();
  });
});
