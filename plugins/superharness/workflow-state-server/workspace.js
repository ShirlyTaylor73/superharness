import fs from 'node:fs';
import path from 'node:path';

export const WORKSPACE_ENV_ERROR =
  'CLAUDE_PROJECT_DIR is required to resolve the Superharness workspace';

export function resolveTrustedWorkspaceRoot(env = process.env) {
  const raw = env.CLAUDE_PROJECT_DIR;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(WORKSPACE_ENV_ERROR);
  }

  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${WORKSPACE_ENV_ERROR}: path does not exist: ${resolved}`);
  }
  return resolved;
}
