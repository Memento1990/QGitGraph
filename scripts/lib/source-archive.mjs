import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fingerprint, inside, json, readJson, sha256 } from './run.mjs';
import { safeRelative } from './release.mjs';

export const SOURCE_ENTRIES = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'index.html',
  'LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', 'src', 'tests', 'scripts', 'docs', 'notices',
  'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json',
  'src-tauri/src', 'src-tauri/tests', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/permissions',
];
export async function sourceFiles(root) {
  const files = [];
  const visit = async relative => {
    safeRelative(relative);
    const full = join(root, ...relative.split('/'));
    assert(inside(root, full));
    const stat = await lstat(full);
    assert(!stat.isSymbolicLink(), `Source archive refuses links: ${relative}`);
    if (stat.isDirectory()) {
      assert(!['node_modules', 'target', '.git', 'artifacts', 'release', 'dist', '.zcode', '.env', 'gen', 'backup', 'backups', 'tmp', 'temp', 'logs', 'test-evidence'].includes(relative.split('/').at(-1).toLowerCase()), `Excluded source directory encountered: ${relative}`);
      for (const entry of (await readdir(full)).sort()) await visit(`${relative}/${entry}`);
    } else {
      assert(stat.isFile(), `Source archive requires regular files: ${relative}`);
      assert(!/(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pfx|p12|pem|key|bak)|credentials(?:\.[^/]*)?|state(?:-unreadable[^/]*)?\.json|sample-plan\.private\.json)$/i.test(relative), `Private/local file is not allowed in source archive: ${relative}`);
      const bytes = await readFile(full);
      files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    }
  };
  for (const entry of SOURCE_ENTRIES) await visit(entry);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function archiveFileList(root, output) {
  const files = await sourceFiles(root);
  await json(output, { schemaVersion: 1, kind: 'source-archive-list', entries: SOURCE_ENTRIES, files });
  return files;
}
export async function assertZipInventory(archive, report, prefix = '') {
  const actual = await readJson(report);
  const file = await fingerprint(archive);
  assert.equal(actual.sha256, file.sha256, 'Archive inspection hash mismatch.');
  for (const entry of actual.files ?? []) {
    const path = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
    safeRelative(path);
  }
  return actual;
}
