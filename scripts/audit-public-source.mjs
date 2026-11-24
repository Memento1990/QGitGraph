#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SOURCE_ENTRIES, assertPublicSourcePath, assertSourceOutput, assertSourceOutputParents, materializeSourceCandidate, readSourceSnapshot } from './lib/source-archive.mjs';
import { PROJECT, isMain, parseArgs } from './lib/run.mjs';

const privatePatterns = [
  ['personal-profile-path', /[A-Za-z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b)|<|example(?:[\\/]|\b)|test(?:[\\/]|\b))[^\\/\s'"`<>]+[\\/]/i],
  ['private-wsl-home', /(?:wsl\.localhost|wsl\$)[\\/]+[^\\/\s'"<>]+[\\/]+home[\\/]+(?!<|example(?:[\\/]|\b)|user(?:[\\/]|\b)|fixture(?:[\\/]|\b))[^\\/\s'"`<>]+/i],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['cloud-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];
export const auditPath = assertPublicSourcePath;
export function auditText(text) {
  const findings = [];
  for (const [code, pattern] of privatePatterns) if (pattern.test(text)) findings.push(code);
  return findings;
}
export function parseAuditArgs(argv) {
  const options = parseArgs(argv, { flags: ['staged', 'help'], values: ['root', 'candidate-root', 'reviewed-manifest', 'write-candidate', 'output'] });
  assert(!(options.staged && (options['candidate-root'] || options['reviewed-manifest'])), '--staged cannot use candidate/worktree bytes.');
  assert(!(options['candidate-root'] && options['reviewed-manifest']), 'Choose either --candidate-root or --reviewed-manifest.');
  return options;
}
export async function auditPublicSource({ root = PROJECT, staged, candidateRoot, reviewedManifest, writeCandidate, output } = {}) {
  root = resolve(root);
  const indexMode = !candidateRoot && !reviewedManifest;
  assert(staged !== true || indexMode, '--staged must audit the actual Git index.');
  assert(staged !== false || !indexMode, 'Worktree auditing requires an explicit reviewed manifest or isolated candidate root.');
  if (output) { assertSourceOutput(root, output, candidateRoot); await assertSourceOutputParents(output); }
  if (output && writeCandidate) assertSourceOutput(root, output, writeCandidate);
  const captured = await readSourceSnapshot(root, { candidateRoot, reviewedManifest });
  // Include staged additions/modifications/deletions in the path gate, even when
  // outside source boundaries. Unchanged allowlisted index files are still read.
  for (const path of captured.stagedPaths) auditPath(path);
  const findings = [];
  let totalBytes = 0;
  for (const file of captured.files) {
    auditPath(file.path); totalBytes += file.bytes;
    const bytes = captured.contents.get(file.path);
    // Vue SFC templates/scripts are text sources too. Binary resources remain
    // hash-inventoried; other UTF-8-like files are scanned, not just known suffixes.
    const textLike = /\.(?:vue|ts|js|mjs|cjs|rs|py|ps1|cmd|bat|css|html|md|json|toml|txt|ya?ml)$|(?:^|\/)(?:LICENSE|\.gitignore|\.gitattributes)$/i.test(file.path);
    if (textLike || (!bytes.includes(0) && !/\.(?:crate|zip|png|jpe?g|ico|webp|woff2?)$/i.test(file.path))) {
      for (const code of auditText(bytes.toString('utf8'))) findings.push({ path: file.path, code });
    }
  }
  assert(!findings.length, `Public-source audit failed (values omitted): ${JSON.stringify(findings)}`);
  if (writeCandidate) await materializeSourceCandidate(candidateRoot ?? root, writeCandidate, captured);
  const report = { schemaVersion: 1, kind: 'public-source-audit', status: 'passed', staged: indexMode, source: captured.source,
    fileCount: captured.files.length, totalBytes, reviewedEntries: SOURCE_ENTRIES, files: captured.files,
    scope: 'All allowlisted index blobs plus staged path changes, or explicitly reviewed/isolated candidate bytes. Denied output/secret/log filenames and bounded text secret/private-path patterns remain enforced. This is not a proof of absence of every possible sensitive datum.' };
  if (output) { const file = resolve(output); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' }); }
  return report;
}
if (isMain(import.meta.url)) {
  const options = parseAuditArgs(process.argv.slice(2));
  if (options.help) console.log('node scripts/audit-public-source.mjs [--root <repo>] [--staged] [--output <new-report>] [--write-candidate <new-isolated-directory>]\nDefault: audit every allowlisted file in the actual index, plus staged path changes; never read worktree source bytes or stage files.\nExplicit alternatives: --candidate-root <isolated-source> OR --reviewed-manifest <json> [--root <worktree>].\nManifest: {"schemaVersion":1,"kind":"reviewed-source-manifest","files":[{"path":"src/App.vue","bytes":123,"sha256":"..."}]}. Only exact reviewed files are read. Candidates may be passed to existing archive/stage --source consumers.');
  else {
    const report = await auditPublicSource({ root: options.root, staged: options.staged, output: options.output, candidateRoot: options['candidate-root'], reviewedManifest: options['reviewed-manifest'], writeCandidate: options['write-candidate'] });
    console.log(JSON.stringify({ status: report.status, staged: report.staged, source: report.source, files: report.fileCount, bytes: report.totalBytes }));
  }
}
