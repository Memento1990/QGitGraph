#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'artifacts/performance-0.2.1');
const product = JSON.parse(await readFile(join(directory, 'final-product-02/manifest.json'), 'utf8'));
const executable = product.files.find(file => file.path === 'qgitgraph.exe');
const installer = product.files.find(file => file.path.endsWith('setup.exe'));
assert(executable && installer);
const paths = {
  frontend: 'final-tests/frontend-review-fixed.json',
  'rust-unit': 'final-tests/rust-unit.json',
  'rust-integration': 'final-tests/rust-integration.json',
  desktop: 'desktop-final-02/test-report.json',
};
const reports = [];
for (const [kind, path] of Object.entries(paths)) {
  const bytes = await readFile(join(directory, path));
  const report = JSON.parse(bytes);
  assert(kind === 'frontend' ? report.success === true : report.status === 'passed', `${kind} failed.`);
  if (report.binary) assert.equal(report.binary.sha256, executable.sha256);
  reports.push({ kind, path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(directory, 'pre-upgrade-qualified.json'), JSON.stringify({ schemaVersion: 1, status: 'qualified-for-resource-and-local-upgrade-validation', executable, installer, reports,
  note: 'Not a final release approval. Performance, resource, user-install upgrade and archive checks retain their actual independent status.' }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status: 'qualified-for-resource-and-local-upgrade-validation', checks: reports.length, executableSha256: executable.sha256 }));
