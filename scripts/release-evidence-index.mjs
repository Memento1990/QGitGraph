#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fingerprint, isMain, parseArgs, regularFile, sha256, slash } from './lib/run.mjs';
import { requiredReleaseKinds, validateReleaseEvidenceIndex } from './lib/release.mjs';

const legacyPaths = Object.freeze({ frontend: 'final-tests/frontend.json', 'rust-unit': 'final-tests-host-tests-02/rust-unit.json', 'rust-integration': 'final-tests-host-tests-02/rust-integration.json', desktop: 'release-payload-final/test-report.json', installer: 'install-final-03/test-report.json', resources: 'resources-payload-final/test-report.json' });
const reportFlags = ['frontend', 'rust-unit', 'rust-integration', 'desktop-report', 'installer-report', 'resources'];
export function parseEvidenceIndexArgs(argv) {
  const args = [...argv]; const positionalRoot = args[0] && !args[0].startsWith('--') ? args.shift() : undefined;
  const options = parseArgs(args, { values: ['root', 'output', 'desktop-kind', 'binary', 'installer', ...reportFlags], flags: ['help'] });
  assert(!(positionalRoot && options.root), 'Evidence root may only be specified once.');
  if (positionalRoot) options.root = positionalRoot;
  options['desktop-kind'] ??= 'desktop'; requiredReleaseKinds(options['desktop-kind']);
  return options;
}
export async function createReleaseEvidenceIndex({ root = 'artifacts/v0.2', output, desktopKind = 'desktop', binary, installer, reports = {} } = {}) {
  const kinds = requiredReleaseKinds(desktopKind); root = resolve(root); output = resolve(output ?? join(root, 'evidence-index.json'));
  if (desktopKind === 'vue-desktop') {
    assert(binary && installer, 'Vue release evidence indexing requires the actual --binary and --installer.');
    for (const kind of kinds) assert(reports[kind], `Vue release evidence indexing requires an explicit report path: ${kind}`);
  }
  for (const kind of Object.keys(reports)) assert(kinds.includes(kind), `Unknown or unselected evidence kind: ${kind}`);
  const inputs = [];
  for (const kind of kinds) {
    const path = resolve(root, reports[kind] ?? legacyPaths[kind]); await regularFile(path);
    inputs.push({ kind, file: path, bytes: await readFile(path) });
  }
  // Legacy callers keep the existing default paths. Their binding still comes
  // from actual artifact bytes, never from a report's asserted SHA alone.
  if (!binary || !installer) {
    const report = JSON.parse(inputs.find(entry => entry.kind === 'installer').bytes.toString('utf8'));
    binary ??= report.binary?.path; installer ??= report.installer?.path;
    assert(typeof binary === 'string' && isAbsolute(binary) && typeof installer === 'string' && isAbsolute(installer), 'Actual --binary and --installer paths are required when reports do not record absolute artifact paths.');
  }
  const binaryPath = resolve(binary), installerPath = resolve(installer);
  const binaryInfo = await fingerprint(binaryPath), installerInfo = await fingerprint(installerPath);
  assert(![binaryPath, installerPath, ...inputs.map(entry => entry.file)].some(path => path.toLowerCase() === output.toLowerCase()), 'Evidence index output must not overwrite an input.');
  const index = { schemaVersion: 1, reports: inputs.map(({ kind, file, bytes }) => ({ kind, path: slash(relative(dirname(output), file)), sha256: sha256(bytes) })) };
  await validateReleaseEvidenceIndex(index, { reportsRoot: dirname(output), binary: binaryInfo, installer: installerInfo, binaryModifiedAt: (await lstat(binaryPath)).mtimeMs, desktopKind });
  await writeFile(output, JSON.stringify(index, null, 2), { flag: 'wx' });
  return index;
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseEvidenceIndexArgs(argv);
  if (options.help) {
    console.log('node scripts/release-evidence-index.mjs [<evidence-root>] [--root <evidence-root>] [--output <new-index.json>] [--desktop-kind desktop|vue-desktop] [--binary <exe>] [--installer <setup.exe>]\nReports: --frontend <json> --rust-unit <json> --rust-integration <json> --desktop-report <json> --installer-report <json> --resources <json>\nDefault desktop retains legacy report paths and parity validation. Vue selection requires all six report paths and actual binary/installer explicitly, with full automated coverage and same-binary hash/time/integrity. No report kind or contents are rewritten.');
    return;
  }
  const desktopKind = options['desktop-kind']; const reports = {};
  for (const [flag, kind] of [['frontend', 'frontend'], ['rust-unit', 'rust-unit'], ['rust-integration', 'rust-integration'], ['desktop-report', desktopKind], ['installer-report', 'installer'], ['resources', 'resources']]) if (options[flag]) reports[kind] = options[flag];
  const root = resolve(options.root ?? 'artifacts/v0.2'); const output = resolve(options.output ?? join(root, 'evidence-index.json'));
  const index = await createReleaseEvidenceIndex({ root, output, desktopKind, binary: options.binary, installer: options.installer, reports });
  console.log(JSON.stringify({ status: 'qualified-local-release-evidence', reports: index.reports.length, desktopKind, output }));
}
if (isMain(import.meta.url)) await main();
