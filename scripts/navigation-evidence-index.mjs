#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fingerprint } from './lib/run.mjs';
import { summarizeReport, validateRustEvidence } from './lib/release.mjs';

const root = resolve(process.argv[2] ?? 'artifacts/navigation-0.3.0');
const product = JSON.parse(await readFile(join(root, 'final-product-02/manifest.json'), 'utf8'));
const executable = product.files.find(file => file.path === 'qgitgraph.exe');
const installer = product.files.find(file => file.path.endsWith('setup.exe'));
assert(executable && installer);
for (const file of product.files) assert.equal((await fingerprint(join(root, 'final-product-02', file.path))).sha256, file.sha256);
const files = {
  frontend: 'frontend-final-03.json',
  'rust-unit': 'rust-tests-release/rust-unit.json',
  'rust-integration': 'rust-tests-release/rust-integration.json',
  desktop: 'desktop-final-02/test-report.json',
  installer: 'upgrade-final/installer-report.json',
  resources: 'resources-final-02/test-report.json',
};
const reports = [];
for (const [kind, path] of Object.entries(files)) {
  const bytes = await readFile(join(root, path));
  const report = JSON.parse(bytes); summarizeReport(report, kind);
  if (['desktop', 'installer', 'resources'].includes(kind)) assert.equal(report.binary.sha256, executable.sha256);
  if (kind === 'installer') assert.equal(report.installer.sha256, installer.sha256);
  if (kind.startsWith('rust-')) {
    const log = await readFile(join(root, path.replace(/[^/]+$/, report.log.path)), 'utf8');
    assert.equal(createHash('sha256').update(log).digest('hex'), report.log.sha256);
    validateRustEvidence(report, log);
  }
  reports.push({ kind, path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const navigation = JSON.parse(await readFile(join(root, 'navigation-final-02/test-report.json'), 'utf8'));
assert.equal(navigation.status, 'passed'); assert.equal(navigation.binary.sha256, executable.sha256);
assert.equal(navigation.repositoryIntegrity.status, 'passed'); assert.equal(navigation.cleanup.remaining.length, 0);
assert(navigation.results.every(result => result.status === 'passed'));
const readonly = JSON.parse(await readFile(join(root, 'wsl-readonly-final-02/test-report.json'), 'utf8'));
assert.equal(readonly.status, 'passed'); assert.equal(readonly.actualBinary.sha256, executable.sha256);
assert.equal(readonly.repoIntegrity.status, 'unchanged-within-stated-coverage'); assert.equal(readonly.cleanup.remaining, 0);
await writeFile(join(root, 'evidence-index.json'), JSON.stringify({ schemaVersion: 1, reports }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status: 'qualified-local-release-evidence', reports: reports.length, navigationChecks: navigation.results.length, readonlyChecks: readonly.checks.length, executableSha256: executable.sha256 }));
