import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readRepoFile(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

test('npm publish workflow publishes scoped package from matching v tag', async () => {
  const workflow = await readRepoFile('.github/workflows/npm-publish.yml');

  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*-\s*['"]v\*['"]/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*id-token:\s*write/);
  assert.match(workflow, /node-version:\s*['"]24['"]/);
  assert.match(workflow, /registry-url:\s*['"]https:\/\/registry\.npmjs\.org['"]/);
  assert.match(workflow, /package-manager-cache:\s*false/);
  assert.match(workflow, /expectedTag\s*=\s*`v\$\{pkg\.version\}`/);
  assert.match(workflow, /process\.env\.GITHUB_REF_NAME/);
  assert.match(workflow, /npm run test:installer/);
  assert.match(workflow, /npm pack --dry-run/);
  assert.match(workflow, /npm publish --provenance --access public/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test('ci metadata check allows publishable scoped root package', async () => {
  const workflow = await readRepoFile('.github/workflows/ci.yml');

  assert.doesNotMatch(workflow, /package\.json must stay private/);
  assert.doesNotMatch(workflow, /const required = \['name', 'version', 'description', 'license', 'main'\]/);
  assert.match(workflow, /@shirlytaylor73\/superharness/);
  assert.match(workflow, /bin\.superharness/);
  assert.match(workflow, /plugins\/superharness\//);
});
