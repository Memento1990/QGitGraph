#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SOURCE_ENTRIES, sourceFiles } from './lib/source-archive.mjs';
import { PROJECT, isMain } from './lib/run.mjs';

const privatePatterns = [
  ['personal-profile-path', /[A-Za-z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b)|<|example(?:[\\/]|\b)|test(?:[\\/]|\b))[^\\/\s'"`<>]+[\\/]/i],
  ['private-wsl-home', /(?:wsl\.localhost|wsl\$)[\\/]+[^\\/\s'"<>]+[\\/]+home[\\/]+(?!<|example(?:[\\/]|\b)|user(?:[\\/]|\b)|fixture(?:[\\/]|\b))[^\\/\s'"`<>]+/i],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['cloud-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];
const forbiddenDirectories = new Set(['.git', '.zcode', 'artifacts', 'release', 'node_modules', 'target', 'dist', 'gen', 'backup', 'backups', 'tmp', 'temp', 'logs', 'test-evidence']);
export function auditPath(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  assert(!parts.some(part => forbiddenDirectories.has(part.toLowerCase())), `Excluded output in public source: ${path}`);
  assert(!/(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)|credentials(?:\.[^/]*)?|state\.json|sample-plan\.private\.json)$|\.(?:pfx|p12|pem|key|bak)$/i.test(path), `Private filename in public source: ${path}`);
}
export function auditText(text) {
  const findings = [];
  for (const [code, pattern] of privatePatterns) if (pattern.test(text)) findings.push(code);
  return findings;
}
export async function auditPublicSource({ staged = false, output } = {}) {
  const files = await sourceFiles(PROJECT);
  const names = new Set(files.map(file => file.path));
  if (staged) {
    const paths = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: PROJECT, encoding: 'utf8' }).split('\0').filter(Boolean);
    assert(paths.length, 'No staged source files to audit.');
    assert(paths.every(path => names.has(path)), 'Staged content is outside the reviewed source archive allowlist.');
    for (const file of files) assert(paths.includes(file.path), `Reviewed source is not staged: ${file.path}`);
  }
  const findings = [];
  let totalBytes = 0;
  for (const file of files) {
    auditPath(file.path); totalBytes += file.bytes;
    assert(file.bytes <= 8 * 1024 * 1024, `Unexpectedly large source file: ${file.path}`);
    const bytes = staged ? execFileSync('git', ['show', `:${file.path}`], { cwd: PROJECT, maxBuffer: 16 * 1024 * 1024 }) : await readFile(join(PROJECT, file.path));
    if (staged) assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Staged source differs from reviewed file: ${file.path}`);
    // Archives/images remain hash-inventoried. Only actual text-like sources are scanned as text.
    if (/\.(?:ts|js|mjs|cjs|rs|py|ps1|css|html|md|json|toml|txt|ya?ml)$|(?:^|\/)(?:LICENSE|\.gitignore)$/i.test(file.path)) {
      for (const code of auditText(bytes.toString('utf8'))) findings.push({ path: file.path, code });
    }
  }
  assert(!findings.length, `Public-source audit failed (values omitted): ${JSON.stringify(findings)}`);
  const report = { schemaVersion: 1, kind: 'public-source-audit', status: 'passed', staged, fileCount: files.length, totalBytes, reviewedEntries: SOURCE_ENTRIES,
    files, scope: 'Owned-source allowlist, exact staged bytes where requested, denied output/secret filenames, bounded text secret/private-path patterns. This is not a proof of absence of every possible sensitive datum.' };
  if (output) { const file = resolve(output); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' }); }
  return report;
}
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2); const staged = args.includes('--staged'); const index = args.indexOf('--output');
  const report = await auditPublicSource({ staged, output: index < 0 ? undefined : args[index + 1] });
  console.log(JSON.stringify({ status: report.status, staged: report.staged, files: report.fileCount, bytes: report.totalBytes }));
}
