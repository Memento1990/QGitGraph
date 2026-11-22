import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPath, auditText } from '../audit-public-source.mjs';

test('public audit retains necessary licenses and covered sources but excludes generated/private output', () => {
  for (const path of ['LICENSE', 'src/ui/updates.ts', 'notices/sources/example-1.0.0.crate', 'src-tauri/permissions/app.toml']) assert.doesNotThrow(() => auditPath(path));
  for (const path of ['artifacts/run/state.json', 'release/old.zip', 'src-tauri/target/release/app.exe', 'src-tauri/gen/schemas.json', 'docs/backup/private.md', 'scripts/tmp/input.json', '.env', 'secrets/id_ed25519', 'certificate.pfx', 'sample-plan.private.json']) assert.throws(() => auditPath(path));
});

test('public audit detects private paths and credentials without reproducing values in reports', () => {
  const privateHome = ['C:', 'Users', 'sensitive-user', 'profile.json'].join('/');
  const wsl = ['\\\\wsl.localhost', 'Ubuntu', 'home', 'sensitive-user', 'repository'].join('\\');
  assert(auditText(privateHome).includes('personal-profile-path'));
  assert(auditText(wsl).includes('private-wsl-home'));
  assert(auditText(['-----BEGIN ', 'PRIVATE KEY-----'].join('')).includes('private-key'));
  assert(auditText(['ghp_', 'x'.repeat(36)].join('')).includes('github-token'));
  assert(auditText(['AKIA', 'X'.repeat(16)].join('')).includes('cloud-access-key'));
  for (const text of ['https://github.com/Memento1990/QGitGraph/releases/latest', 'C:/Users/example/profile.json', '\\\\wsl.localhost\\<distribution>\\home\\<user>\\<repository>', 'MIT License']) assert.deepEqual(auditText(text), []);
});
