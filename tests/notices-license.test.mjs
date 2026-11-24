import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(path.join(root, ...relative.split('/')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(read('notices/manifest.json'));
const lock = JSON.parse(read('package-lock.json'));
const packageJson = JSON.parse(read('package.json'));
const index = read('THIRD_PARTY_NOTICES.md').toString('utf8');
const npm = manifest.packages.filter(item => item.ecosystem === 'npm');
const npmPackage = name => {
  const item = npm.find(item => item.name === name);
  assert(item, `Missing npm notice: ${name}`);
  return item;
};

test('notice ownership and every recorded source input match current bytes without granting legal clearance', () => {
  assert.equal(manifest.legalClearance, false);
  for (const [file, expected] of Object.entries(manifest.ownedFiles)) {
    assert(file === 'THIRD_PARTY_NOTICES.md' || file.startsWith('notices/'));
    assert.equal(hash(read(file)), expected, file);
  }
  for (const [file, expected] of Object.entries(manifest.inputs)) assert.equal(hash(read(file)), expected, file);
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
    'src/components/SHADCN_LICENSE.txt', 'src/styles/workbench.css']) assert(manifest.inputs[file], file);
  assert.deepEqual(manifest.findings.filter(item => /^(UNKNOWN|MISSING|UNSCANNED)/.test(item.code)), []);
  assert.match(index, /NOT release clearance/);
});

test('Vue production closure preserves original npm legal files and heterogeneous license declarations', () => {
  assert.equal(packageJson.license, 'MIT');
  for (const name of Object.keys(packageJson.dependencies)) npmPackage(name);
  for (const name of ['@vue/runtime-dom', '@vue/runtime-core', '@vue/reactivity', '@vue/shared', '@vue/compiler-sfc', '@vue/server-renderer']) npmPackage(name);
  for (const item of npm) {
    assert.equal(item.version, lock.packages[item.identity].version, item.name);
    for (const file of item.legalFiles) {
      assert.deepEqual(read(file.output), read(`${item.identity}/${file.source}`), `${item.name}: ${file.source}`);
      assert.equal(manifest.ownedFiles[file.output], file.sha256, file.output);
    }
  }
  assert.equal(npmPackage('class-variance-authority').declaredLicense, 'Apache-2.0');
  assert.equal(npmPackage('@internationalized/date').declaredLicense, 'Apache-2.0');
  assert.equal(npmPackage('@swc/helpers').declaredLicense, 'Apache-2.0');
  assert.equal(npmPackage('@tauri-apps/api').declaredLicense, 'Apache-2.0 OR MIT');
  assert.equal(npmPackage('entities').declaredLicense, 'BSD-2-Clause');
  assert.equal(npmPackage('tslib').declaredLicense, '0BSD');
});

test('imported Tailwind stylesheet is included despite devDependency and tool roots are not mislabeled runtime', () => {
  assert.match(read('src/styles/workbench.css').toString('utf8'), /@import\s+["']tailwindcss["']/);
  const tailwind = npmPackage('tailwindcss');
  assert.equal(lock.packages[tailwind.identity].dev, true);
  assert.match(tailwind.relationship, /distributed CSS/);
  for (const name of ['@tailwindcss/vite', '@tailwindcss/oxide', '@vitejs/plugin-vue', 'vue-tsc', 'vite', 'vitest', '@tauri-apps/cli']) {
    assert(!npm.some(item => item.name === name), `Unexpected dev-only tool root: ${name}`);
  }
  assert.match(index, /NOT an exact shipped runtime inventory/);
  assert.match(index, /installed optional TypeScript peers/);
});

test('local editable shadcn source retains its original unovue MIT text in the index and ownership hashes', () => {
  const item = manifest.packages.find(item => item.ecosystem === 'local' && item.identity === 'src/components/ui');
  assert(item);
  assert.equal(item.version, 'unversioned');
  assert.equal(item.vcs, null);
  assert.equal(item.declaredLicense, 'MIT');
  const file = item.legalFiles.find(file => file.source === 'src/components/SHADCN_LICENSE.txt');
  assert(file);
  assert.deepEqual(read(file.output), read(file.source));
  assert.equal(file.sha256, manifest.inputs[file.source]);
  assert.equal(file.sha256, manifest.ownedFiles[file.output]);
  assert.match(read(file.output).toString('utf8'), /Copyright \(c\) 2023 unovue/);
  assert(index.includes(item.notice));
  assert(manifest.findings.some(finding => finding.code === 'VENDORED_SOURCE_PROVENANCE_REVIEW' && finding.package === 'local:shadcn-vue'));
});

test('pinned Lucide keeps both its ISC grant and the entire original Feather MIT terms', () => {
  const item = npmPackage('lucide-vue-next');
  assert.equal(item.version, '1.0.0');
  assert.equal(item.declaredLicense, 'ISC');
  const file = item.legalFiles.find(file => file.source === 'LICENSE');
  const original = read('node_modules/lucide-vue-next/LICENSE');
  assert.deepEqual(read(file.output), original);
  const text = original.toString('utf8');
  assert.match(text, /ISC License[\s\S]*Permission to use, copy, modify, and\/or distribute/);
  assert.match(text, /The MIT License \(MIT\) \(for portions derived from Feather\)[\s\S]*Cole Bemis[\s\S]*Permission is hereby granted[\s\S]*The above copyright notice[\s\S]*SOFTWARE\./);
  assert(item.embeddedComponents.some(component => component.output === file.output && /Feather/.test(component.name)));
});

test('all existing MPL source archives and pinned official upstream license texts remain checksum-covered', () => {
  const cargo = manifest.packages.filter(item => item.ecosystem === 'cargo');
  const cargoLock = read('src-tauri/Cargo.lock').toString('utf8');
  const checksumByPackage = new Map(cargoLock.split(/^\[\[package\]\]\s*$/m).slice(1).map(block => [
    `${/^name\s*=\s*"([^"\r\n]+)"/m.exec(block)?.[1]}@${/^version\s*=\s*"([^"\r\n]+)"/m.exec(block)?.[1]}`,
    /^checksum\s*=\s*"([a-f0-9]{64})"/m.exec(block)?.[1],
  ]));
  const mpl = cargo.filter(item => /\bMPL-2\.0\b/.test(item.declaredLicense ?? ''));
  assert.deepEqual(mpl.map(item => item.name).sort(), ['cssparser', 'cssparser-macros', 'dtoa-short', 'option-ext', 'selectors']);
  for (const item of mpl) {
    const archive = item.sourceArchive;
    assert(archive, item.name);
    assert.equal(hash(read(archive.output)), checksumByPackage.get(`${item.name}@${item.version}`));
    assert.equal(archive.sha256, manifest.ownedFiles[archive.output]);
  }
  assert(manifest.ownedFiles['notices/source-availability.md']);
  const upstream = cargo.flatMap(item => item.upstreamLegalFiles);
  assert.equal(upstream.length, 8);
  for (const file of upstream) {
    assert.equal(hash(read(file.output)), file.sha256, file.output);
    assert.equal(manifest.ownedFiles[file.output], file.sha256, file.output);
    assert.match(file.sourceURL, /^https:\/\//);
  }
});
