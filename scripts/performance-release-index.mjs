#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const output = resolve(process.argv[2] ?? 'artifacts/performance-0.2.1');
const paths = {
  frontend: 'final-tests/frontend-review-fixed.json',
  'rust-unit': 'final-tests/rust-unit.json',
  'rust-integration': 'final-tests/rust-integration.json',
  desktop: 'desktop-final-02/test-report.json',
  installer: 'upgrade-final/installer-report.json',
  resources: 'resources-final/test-report.json',
};
const reports = [];
for (const [kind, path] of Object.entries(paths)) {
  const bytes = await readFile(join(output, path));
  const report = JSON.parse(bytes);
  assert(kind === 'frontend' ? report.success === true : report.status === 'passed', `${kind} has not passed.`);
  reports.push({ kind, path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(output, 'evidence-index.json'), JSON.stringify({ schemaVersion: 1, reports }, null, 2), { flag: 'wx' });
console.log(join(output, 'evidence-index.json'));
