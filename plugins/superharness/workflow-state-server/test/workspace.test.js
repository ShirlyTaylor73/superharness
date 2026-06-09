import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveTrustedWorkspaceRoot } from '../workspace.js';

describe('resolveTrustedWorkspaceRoot', () => {
  it('uses CLAUDE_PROJECT_DIR as the trusted workspace', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'superharness-project-'));
    expect(resolveTrustedWorkspaceRoot({ CLAUDE_PROJECT_DIR: project })).toBe(project);
  });

  it('rejects missing CLAUDE_PROJECT_DIR', () => {
    expect(() => resolveTrustedWorkspaceRoot({})).toThrow(/CLAUDE_PROJECT_DIR is required/);
  });

  it('rejects blank CLAUDE_PROJECT_DIR', () => {
    expect(() => resolveTrustedWorkspaceRoot({ CLAUDE_PROJECT_DIR: '   ' })).toThrow(/CLAUDE_PROJECT_DIR is required/);
  });
});
