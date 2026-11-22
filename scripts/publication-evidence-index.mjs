#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { summarizeReport } from './lib/release.mjs';

const root = resolve(process.argv[2] ?? 'artifacts/publication-0.2.2');
const files = {
  frontend: 'final-tests/frontend.json',
  'rust-unit': 'rust-tests/rust-unit.json',
  'rust-integration': 'rust-tests/rust-integration.json',
  desktop: 'desktop-final/test-report.json',
  installer: 'upgrade-final/installer-report.json',
  resources: 'resources-final/test-report.json',
};
const product = JSON.parse(await readFile(join(root, 'final-product/manifest.json'), 'utf8'));
const reports = [];
for (const [kind, path] of Object.entries(files)) {
  const bytes = await readFile(join(root, path));
  const report = JSON.parse(bytes);
  summarizeReport(report, kind);
  if (['desktop', 'installer', 'resources'].includes(kind)) assert.equal(report.binary.sha256, product.files.find(file => file.path === 'qgitgraph.exe').sha256);
  if (kind === 'installer') assert.equal(report.installer.sha256, product.files.find(file => file.path.endsWith('setup.exe')).sha256);
  reports.push({ kind, path, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(root, 'evidence-index.json'), JSON.stringify({ schemaVersion: 1, reports }, null, 2), { flag: 'wx' });
console.log(join(root, 'evidence-index.json'));
