import type {
  ActionResult, ArchiveQuery, ChangedFile, Commit, CommitDetail, ComparisonQuery, ConfigImport, Containment, Diagnostics,
  DiffQuery, DiffResult, ExternalSession, GitAction, GitRef, GithubUpdateInfo, HistoryPage, HistoryQuery, Host,
  PersistedState, Remote, RepoConfig, Repository, RepositorySnapshot, Stash, StashDetail, SubmoduleInfo, TagDetail,
  VerificationResult, VerifyQuery, WorkingState,
} from '../shared/protocol';
import { defaultState } from '../shared/protocol';

const repo: Repository = {
  id: 'demo', path: 'C:\\Projects\\lighthouse', name: 'lighthouse · sample data',
  gitDir: 'C:\\Projects\\lighthouse\\.git', commonDir: 'C:\\Projects\\lighthouse\\.git',
  head: 'a719d8092738156d361eb9b2abe19fdc9ed51631', branch: 'main', trusted: false, bare: false,
};
const subjects = [
  'Merge branch \'feature/command-palette\'', 'Add keyboard navigation to the command palette',
  'Keep search results stable while loading', 'Fix focus restoration after closing a dialog',
  'Merge pull request #48 from fix/cache-invalidation', 'Invalidate cached entries when the source changes',
  'Add tests for concurrent repository updates', 'Release v1.8.0',
  'Prefer system fonts for a smaller distribution', 'Respect reduced motion preferences',
  'Merge branch \'feature/workspace\'', 'Persist workspace layout between sessions',
  'Refine empty state and error messages', 'Simplify the build pipeline',
  'Handle Unicode paths in the file watcher', 'Update contribution guidelines',
  'Expose a read-only diagnostics view', 'Reduce background work while the window is inactive',
  'Add split view for text comparisons', 'Initial project structure',
];
const authors = ['Alex Chen', 'Robin Patel', 'Sam Rivera', 'Morgan Kim'];
function hash(index: number) { return index === 0 ? repo.head! : (0x8af31d7 - index * 365471).toString(16).padStart(8, '0') + 'a' .repeat(32); }
const refs: GitRef[] = [
  { name: 'main', fullName: 'refs/heads/main', oid: hash(0), kind: 'branch', upstream: 'origin/main', current: true, subject: subjects[0] },
  { name: 'origin/main', fullName: 'refs/remotes/origin/main', oid: hash(0), kind: 'remote', upstream: null, current: false, subject: subjects[0] },
  { name: 'feature/command-palette', fullName: 'refs/heads/feature/command-palette', oid: hash(1), kind: 'branch', upstream: null, current: false, subject: subjects[1] },
  { name: 'fix/cache-invalidation', fullName: 'refs/heads/fix/cache-invalidation', oid: hash(5), kind: 'branch', upstream: null, current: false, subject: subjects[5] },
  { name: 'v1.8.0', fullName: 'refs/tags/v1.8.0', oid: hash(7), kind: 'tag', upstream: null, current: false, subject: 'Version 1.8.0' },
];
const commits: Commit[] = subjects.map((subject, index) => {
  let parents = index < subjects.length - 1 ? [hash(index + 1)] : [];
  if (index === 0) parents = [hash(3), hash(1)];
  if (index === 2) parents = [hash(6)];
  if (index === 4) parents = [hash(7), hash(5)];
  if (index === 6) parents = [hash(7)];
  if (index === 10) parents = [hash(13), hash(11)];
  if (index === 12) parents = [hash(14)];
  return { oid: hash(index), parents, author: authors[index % authors.length], email: 'sample@example.invalid',
    authoredAt: 1795169400 - index * 14400, committedAt: 1795169400 - index * 14400,
    subject, refs: refs.filter(ref => ref.oid === hash(index)) };
});
const files: ChangedFile[] = [
  { path: 'src/commands/palette.ts', oldPath: null, status: 'M', additions: 24, deletions: 8, staged: false, unstaged: false },
  { path: 'src/commands/keyboard.ts', oldPath: null, status: 'A', additions: 42, deletions: 0, staged: false, unstaged: false },
  { path: 'src/ui/dialog.css', oldPath: null, status: 'M', additions: 12, deletions: 6, staged: false, unstaged: false },
  { path: 'tests/commands.test.ts', oldPath: null, status: 'M', additions: 36, deletions: 4, staged: false, unstaged: false },
  { path: 'CHANGELOG.md', oldPath: null, status: 'M', additions: 5, deletions: 0, staged: false, unstaged: false },
];
const oldContent = `import { commands } from './registry';\n\nexport function searchCommands(query: string) {\n  const matches = commands.filter(command => {\n    return command.label.includes(query);\n  });\n  return matches;\n}\n`;
const newContent = `import { commands } from './registry';\nimport { rankMatch } from './rank';\n\nexport function searchCommands(query: string) {\n  const normalized = query.trim().toLocaleLowerCase();\n  if (!normalized) return commands;\n\n  return commands\n    .map(command => ({ command, score: rankMatch(command.label, normalized) }))\n    .filter(match => match.score > 0)\n    .sort((left, right) => right.score - left.score)\n    .map(match => match.command);\n}\n`;
const patch = `diff --git a/src/commands/palette.ts b/src/commands/palette.ts\nindex 9dc0a18..a719d80 100644\n--- a/src/commands/palette.ts\n+++ b/src/commands/palette.ts\n@@ -1,8 +1,13 @@\n import { commands } from './registry';\n+import { rankMatch } from './rank';\n \n export function searchCommands(query: string) {\n-  const matches = commands.filter(command => {\n-    return command.label.includes(query);\n-  });\n-  return matches;\n+  const normalized = query.trim().toLocaleLowerCase();\n+  if (!normalized) return commands;\n+\n+  return commands\n+    .map(command => ({ command, score: rankMatch(command.label, normalized) }))\n+    .filter(match => match.score > 0)\n+    .sort((left, right) => right.score - left.score)\n+    .map(match => match.command);\n }\n`;

export class DemoHost implements Host {
  private state = defaultState();
  constructor() {
    this.state.lastRepo = repo.path;
    this.state.recent = [{ path: repo.path, name: repo.name }];
  }
  private readOnly(): never { throw { code: 'DEMO_READ_ONLY', message: 'This is sample data in a browser preview. Git operations are available only in the desktop application.' }; }
  diagnostics(): Promise<Diagnostics> { return Promise.resolve({ appVersion: '0.2.2', gitVersion: 'Sample data — no Git commands are executed', gitPath: null, platform: 'browser preview · sample data' }); }
  checkForUpdates(): Promise<GithubUpdateInfo> { return Promise.resolve({ status: 'unsupported', currentVersion: '0.2.2', latestVersion: null, releaseTag: null, releaseUrl: null, publishedAt: null, releaseNotes: null, notesTruncated: false }); }
  loadState() { return Promise.resolve(structuredClone(this.state)); }
  saveState(value: PersistedState) { this.state = structuredClone(value); return Promise.resolve(); }
  pickRepository() { return Promise.resolve(repo.path); }
  openRepository(_path: string) { return Promise.resolve(structuredClone(repo)); }
  trustRepository(_repoId: string, _trusted: boolean) { return Promise.resolve(); }
  discoverRepositories(_path: string, _depth: number) { return Promise.resolve([repo.path]); }
  refs(_repoId: string, _requestId: string) { return Promise.resolve(structuredClone(refs)); }
  history(query: HistoryQuery): Promise<HistoryPage> {
    let filtered = commits;
    if (query.search) {
      const search = query.search.toLocaleLowerCase();
      filtered = filtered.filter(c => `${c.subject} ${c.author} ${c.oid} ${c.refs.map(r => r.name).join(' ')}`.toLocaleLowerCase().includes(search));
    }
    return Promise.resolve({ commits: structuredClone(filtered.slice(query.offset, query.offset + query.limit)), hasMore: false });
  }
  workingState(_repoId: string, _requestId: string): Promise<WorkingState> {
    return Promise.resolve({ branch: 'main', ahead: 0, behind: 0, operation: null, conflicts: 0,
      files: [{ ...files[0], staged: false, unstaged: true }] });
  }
  commitDetail(_repoId: string, oid: string, _requestId: string, parent?: string): Promise<CommitDetail> {
    const commit = commits.find(c => c.oid === oid) ?? commits[0];
    return Promise.resolve({ commit: structuredClone(commit), body: `${commit.subject}\n\nKeep the command palette fast, predictable, and fully keyboard accessible.\n\nCloses #47`,
      committer: commit.author, committerEmail: commit.email,
      signature: { status: 'N', signer: '', key: '' }, files: structuredClone(files), base: parent ?? commit.parents[0] ?? null });
  }
  compare(_query: ComparisonQuery) { return Promise.resolve(structuredClone(files)); }
  diff(_query: DiffQuery): Promise<DiffResult> { return Promise.resolve({ patch, binary: false, truncated: false, oldContent, newContent }); }
  stashes(_repoId: string, _requestId: string): Promise<Stash[]> { return Promise.resolve([{ selector: 'stash@{0}', oid: 'd'.repeat(40), message: 'WIP on feature/search: refine matching', timestamp: 1795169400 }]); }
  remotes(_repoId: string, _requestId: string): Promise<Remote[]> { return Promise.resolve([{ name: 'origin', fetchUrl: 'https://example.invalid/lighthouse.git', pushUrl: 'https://example.invalid/lighthouse.git' }]); }
  repoConfig(_repoId: string, _requestId: string): Promise<RepoConfig> { return Promise.resolve({ userName: 'Alex Chen', userEmail: 'alex@example.invalid', globalUserName: '', globalUserEmail: '', signingKey: '', signCommits: false }); }
  async action(_action: GitAction): Promise<ActionResult> { return this.readOnly(); }
  cancel(_requestId: string) { return Promise.resolve(); }
  async openTerminal(_repoId: string): Promise<void> { return this.readOnly(); }
  async openEditor(_repoId: string, _path: string): Promise<void> { return this.readOnly(); }
  async externalDiff(_query: DiffQuery): Promise<void> { return this.readOnly(); }
  async openUrl(_url: string): Promise<void> { return this.readOnly(); }
  async copy(text: string) { await navigator.clipboard.writeText(text); }
  async exportConfig(_repoId: string | null): Promise<boolean> { return this.readOnly(); }
  async snapshot(repoId: string, requestId: string): Promise<RepositorySnapshot> {
    return { repository: structuredClone(repo), refs: await this.refs(repoId,requestId), working: await this.workingState(repoId,requestId), stashes: await this.stashes(repoId,requestId), remotes: await this.remotes(repoId,requestId), fingerprint:'demo' };
  }
  async stashDetail(_repoId: string, selector: string, _requestId: string): Promise<StashDetail> { return { selector, oid:'d'.repeat(40), base:hash(0), index:'e'.repeat(40), untracked:null, message:'Sample stash', timestamp:1795169400 }; }
  async tagDetail(_repoId: string, target: string, _requestId: string): Promise<TagDetail> { return { name:target, ref:target, oid:'f'.repeat(40), targetOid:hash(7), targetType:'commit', annotated:true, tagger:'Alex Chen', email:'sample@example.invalid', timestamp:1795169400, message:'Version **1.8.0** :tada:', signature:{status:'N',signer:'',key:''} }; }
  async containment(_repoId: string, oid: string, _requestId: string): Promise<Containment> { return { oid, head:true, refs:structuredClone(refs.filter(ref=>ref.kind==='branch')) }; }
  async submodules(_repoId: string, _requestId: string): Promise<SubmoduleInfo[]> { return []; }
  async verify(_query: VerifyQuery): Promise<VerificationResult> { return this.readOnly(); }
  async archive(_query: ArchiveQuery): Promise<boolean> { return this.readOnly(); }
  async openSnapshot(_query: DiffQuery, _side:'old'|'new'): Promise<void> { return this.readOnly(); }
  async importConfig(): Promise<ConfigImport|null> { return this.readOnly(); }
  onExternalSession(_callback:(session:ExternalSession)=>void) { return Promise.resolve(()=>{}); }
  onRepositoryChanged(_callback: (repoId: string) => void) { return Promise.resolve(() => {}); }
}
