import { onScopeDispose, shallowRef, type Ref } from 'vue';
import type { ActionKind, GitRef, Repository, RepositoryCandidate, Stash, SubmoduleInfo } from '@/shared/protocol';
import { defineMessages, getLocale, onLocaleChange, resolveText, type Locale } from '@/lib/i18n';
import { m as repositoryMessages } from '@/i18n/repository-actions';

/** Observations only. A missing summary is not a clean working tree. Native paths remain opaque identities. */
export interface NavigationRepository {
  key: string;
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  changes: number | null;
  ahead: number | null;
  behind: number | null;
  repository?: Repository;
  candidate?: RepositoryCandidate;
  parentPath?: string;
  initialized?: boolean;
}

export type NavigationActionKind = ActionKind | 'sync' | 'terminal' | 'editor' | 'settings';
export interface NavigationAction { kind: NavigationActionKind; repoPath: string }
export interface NavigationCheckout { ref: GitRef; localName?: string }

export const navigationMessages = defineMessages('vue-navigation', {
  navigation: 'Repository navigation', workspace: 'Workspace', directory: 'Directory', submodules: 'Submodules',
  tags: 'Tags', stashes: 'Stashes', open: 'Open repository or directory', search: 'Find repositories, tags or stashes',
  refreshDirectory: 'Refresh directory scope', current: 'Current repository', changes: 'Local changes',
  expand: 'Expand', collapse: 'Collapse', emptyDirectory: 'No repositories found.', emptySubmodules: 'No submodules.',
  emptyTags: 'No tags.', emptyStashes: 'No stashes.', noCurrent: 'Select a repository.', noResults: 'No matches.',
  loading: 'Loading…', trust: 'Directory and trust', parent: 'Return to parent repository',
  initialized: 'Initialized', uninitialized: 'Not initialized', branches: 'Branches', history: 'History',
  remotes: 'Remotes', repository: 'Repository', tools: 'Tools', settings: 'Settings', terminal: 'Open terminal',
  editor: 'Open in editor', sync: 'Synchronize', commit: 'Commit', more: 'More actions', staged: 'Staged',
  unstaged: 'Unstaged', untrusted: 'Not trusted — the main controller will request authorization before execution.',
  branchPicker: 'Switch branch', branchHint: 'Choose a local branch or tag. Remote branches require a new local name.',
  searchRefs: 'Find a branch or tag', localBranches: 'Local branches', remoteBranches: 'Remote branches',
  noRefs: 'No matching references.', close: 'Close', back: 'Back', currentBranch: 'Current branch',
  detachedTag: 'Tag · detached HEAD', remoteName: 'New local branch name',
  remoteHint: 'The new local branch tracks this exact remote branch. Review and confirmation are handled by the main controller.',
  reviewRemote: 'Review tracking branch', requiredName: 'Enter a local branch name.', invalidName: 'Enter a valid Git branch name.',
  existingName: 'That local branch already exists. Choose another name or select the existing local branch.',
}, {
  navigation: '仓库导航', workspace: '工作空间', directory: '目录', submodules: '子模块', tags: '标签', stashes: '储藏',
  open: '打开仓库或目录', search: '查找仓库、标签或储藏', refreshDirectory: '刷新目录范围', current: '当前仓库',
  changes: '本地修改', expand: '展开', collapse: '收起', emptyDirectory: '未找到仓库。', emptySubmodules: '没有子模块。',
  emptyTags: '没有标签。', emptyStashes: '没有储藏。', noCurrent: '请选择仓库。', noResults: '没有匹配项。',
  loading: '正在加载…', trust: '目录与信任', parent: '返回父仓库', initialized: '已初始化', uninitialized: '尚未初始化',
  branches: '分支', history: '历史', remotes: '远程仓库', repository: '仓库', tools: '工具', settings: '设置',
  terminal: '打开终端', editor: '在编辑器中打开', sync: '同步', commit: '提交', more: '更多操作', staged: '已暂存',
  unstaged: '未暂存', untrusted: '尚未信任 — 执行前由主控制器请求授权。', branchPicker: '切换分支',
  branchHint: '选择本地分支或标签。检出远程分支需要指定新本地分支名。', searchRefs: '查找分支或标签',
  localBranches: '本地分支', remoteBranches: '远程分支', noRefs: '没有匹配的引用。', close: '关闭', back: '返回',
  currentBranch: '当前分支', detachedTag: '标签 · 分离 HEAD', remoteName: '新本地分支名称',
  remoteHint: '新本地分支跟踪此确切的远程分支。检查与确认由主控制器承接。', reviewRemote: '检查跟踪分支',
  requiredName: '请输入本地分支名称。', invalidName: '请输入有效的 Git 分支名称。',
  existingName: '该本地分支已存在，请换一个名称或直接选择已有本地分支。',
});
export type NavigationMessageKey = Parameters<typeof navigationMessages.m>[0];
export function useNavigationLocale(): Readonly<Ref<Locale>> {
  const locale = shallowRef(getLocale());
  onScopeDispose(onLocaleChange(() => { locale.value = getLocale(); }));
  return locale;
}
export function navigationText(key: NavigationMessageKey, locale: Locale): string {
  return resolveText(navigationMessages.m(key), locale);
}
export function navigationCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
}
/** Include the dash in accessible names and titles too; never silently announce unknown as zero. */
export function navigationCountLabel(value: number | null | undefined, locale: Locale): string {
  const count = navigationCount(value);
  return count === '—' ? `— (${resolveText(repositoryMessages('countUnknown'), locale)})` : count;
}
export function navigationBranch(repo: NavigationRepository, locale: Locale): string {
  if (repo.initialized === false) return navigationText('uninitialized', locale);
  if (repo.branch) return repo.branch;
  if (repo.head) return resolveText(repositoryMessages('detached', { head: repo.head.slice(0, 7) }), locale);
  return `— (${resolveText(repositoryMessages('headUnknown'), locale)})`;
}
export function navigationTracking(repo: NavigationRepository, locale: Locale): string {
  return `↑${navigationCountLabel(repo.ahead, locale)} ↓${navigationCountLabel(repo.behind, locale)}`;
}

export const NAVIGATION_ROOT_KEYS = ['directory-root', 'submodules-root', 'tags-root', 'stashes-root'] as const;
export type NavigationRootKind = typeof NAVIGATION_ROOT_KEYS[number];
export interface NavigationNode {
  key: string;
  kind: NavigationRootKind | 'directory' | 'repository' | 'submodule' | 'tag' | 'stash' | 'empty';
  label: string;
  message?: NavigationMessageKey;
  contextPath?: string;
  contextName?: string;
  count?: number | null;
  repo?: NavigationRepository;
  ref?: GitRef;
  stash?: Stash;
  submodule?: SubmoduleInfo;
  children?: NavigationNode[];
}
export interface NavigationInput {
  repositories: readonly NavigationRepository[];
  scopeRoot: string | null;
  currentPath: string | null;
  refs: readonly GitRef[];
  stashes: readonly Stash[];
  submodules: readonly SubmoduleInfo[];
  loading?: boolean;
}
export interface NavigationTree {
  roots: NavigationNode[];
  byKey: Map<string, NavigationNode>;
  autoExpanded: string[];
  repositoryCount: number;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const identity = (prefix: string, parts: readonly unknown[]): string => `${prefix}:${JSON.stringify(parts)}`;
export function navigationRepositoryKey(repo: NavigationRepository): string {
  return identity('repository', [repo.path, repo.key]);
}
/** Display only. Hierarchy is exclusively RepositoryCandidate.components, never a split native path. */
export function navigationScopeName(path: string): string {
  const separator = /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? /[\\/]/ : /\//;
  return path.split(separator).filter(Boolean).at(-1) ?? path;
}
function empty(key: string, message: NavigationMessageKey): NavigationNode {
  return { key: `${key}:empty`, kind: 'empty', label: '', message };
}
function searchable(node: NavigationNode): string {
  return [node.label, node.repo?.path, node.repo?.name, node.repo?.branch, node.repo?.head,
    node.ref?.fullName, node.stash?.selector, node.stash?.message, node.submodule?.path].filter(Boolean).join('\n').toLowerCase();
}
function filterNodes(nodes: NavigationNode[], query: string): NavigationNode[] {
  return nodes.flatMap(node => {
    if (node.kind !== 'empty' && searchable(node).includes(query)) return [node];
    const children = node.children && filterNodes(node.children, query);
    return children?.length ? [{ ...node, children }] : [];
  });
}

export function buildNavigation(input: NavigationInput, search = ''): NavigationTree {
  const repositories = [...new Map(input.repositories.map(repo => [repo.path, repo])).values()];
  const current = repositories.find(repo => repo.path === input.currentPath);
  const scopeNode: NavigationNode = {
    key: identity('directory', [input.scopeRoot, []]), kind: 'directory',
    label: input.scopeRoot ? navigationScopeName(input.scopeRoot) : '', children: [],
  };
  const directories = new Map<string, NavigationNode>([['[]', scopeNode]]);
  const flat: NavigationNode[] = [];
  for (const repo of repositories.sort((a, b) => compare(a.path, b.path))) {
    const components = repo.candidate?.components;
    if (!input.scopeRoot || !components || components.some(part => !part || part === '.' || part === '..')) {
      flat.push({ key: navigationRepositoryKey(repo), kind: 'repository', label: repo.name, repo });
      continue;
    }
    let node = scopeNode;
    for (let index = 0; index < components.length; index++) {
      const parts = components.slice(0, index + 1), key = JSON.stringify(parts);
      let child = directories.get(key);
      if (!child) {
        child = { key: identity('directory', [input.scopeRoot, parts]), kind: 'directory', label: parts.at(-1)!, children: [] };
        directories.set(key, child);
        node.children!.push(child);
      }
      node = child;
    }
    // A directory may itself be a repository and still own independent nested candidates.
    if (!node.repo) { node.repo = repo; node.kind = 'repository'; node.label = repo.name; }
    else flat.push({ key: navigationRepositoryKey(repo), kind: 'repository', label: repo.name, repo });
  }
  const directoryChildren = [...(scopeNode.repo ? [scopeNode] : scopeNode.children!), ...flat];
  const sortChildren = (nodes: NavigationNode[]): void => {
    nodes.sort((a, b) => compare(a.label, b.label) || compare(a.key, b.key));
    for (const node of nodes) if (node.children) {
      sortChildren(node.children);
      if (!node.children.length) delete node.children;
    }
  };
  sortChildren(directoryChildren);
  const available = Boolean(input.currentPath) && !input.loading;
  const context = { contextPath: input.currentPath ?? undefined, contextName: current?.name ?? (input.currentPath ? navigationScopeName(input.currentPath) : undefined) };
  const submodules: NavigationNode[] = available ? input.submodules.map(info => ({
    key: identity('submodule', [input.currentPath, info.path]), kind: 'submodule', label: info.name || info.path,
    submodule: info, contextPath: input.currentPath!,
  })) : [];
  const tags: NavigationNode[] = available ? input.refs.filter(ref => ref.kind === 'tag').map(ref => ({
    key: identity('tag', [input.currentPath, ref.fullName]), kind: 'tag', label: ref.name, ref, contextPath: input.currentPath!,
  })) : [];
  const stashes: NavigationNode[] = available ? input.stashes.map(stash => ({
    key: identity('stash', [input.currentPath, stash.selector, stash.oid]), kind: 'stash',
    label: `${stash.selector} · ${stash.message}`, stash, contextPath: input.currentPath!,
  })) : [];
  const noContext: NavigationMessageKey = input.loading ? 'loading' : 'noCurrent';
  let roots: NavigationNode[] = [
    { key: 'directory-root', kind: 'directory-root', label: '', message: 'directory', contextPath: input.scopeRoot ?? undefined,
      contextName: input.scopeRoot ? navigationScopeName(input.scopeRoot) : undefined, count: input.loading ? null : repositories.length,
      children: directoryChildren.length ? directoryChildren : [empty('directory-root', input.loading ? 'loading' : 'emptyDirectory')] },
    { key: 'submodules-root', kind: 'submodules-root', label: '', message: 'submodules', ...context,
      count: available ? submodules.length : null, children: submodules.length ? submodules : [empty('submodules-root', available ? 'emptySubmodules' : noContext)] },
    { key: 'tags-root', kind: 'tags-root', label: '', message: 'tags', ...context,
      count: available ? tags.length : null, children: tags.length ? tags : [empty('tags-root', available ? 'emptyTags' : noContext)] },
    { key: 'stashes-root', kind: 'stashes-root', label: '', message: 'stashes', ...context,
      count: available ? stashes.length : null, children: stashes.length ? stashes : [empty('stashes-root', available ? 'emptyStashes' : noContext)] },
  ];
  const query = search.trim().toLowerCase();
  if (query) roots = roots.map(root => {
    const children = filterNodes(root.children!, query);
    return { ...root, children: children.length ? children : [empty(root.key, 'noResults')] };
  });
  const byKey = new Map<string, NavigationNode>(), autoExpanded: string[] = [];
  const visit = (nodes: NavigationNode[]): void => {
    for (const node of nodes) { byKey.set(node.key, node); if (node.children) { autoExpanded.push(node.key); visit(node.children); } }
  };
  visit(roots);
  return { roots, byKey, autoExpanded, repositoryCount: repositories.length };
}

export function navigationExpanded(stored: readonly string[], automatic: readonly string[], search: string, searchClosed: readonly string[]): string[] {
  return search.trim() ? [...new Set([...stored, ...automatic])].filter(key => !searchClosed.includes(key)) : [...stored];
}

/** Match the summary scheduler's visible batch bound without importing repository/controller code. */
export const MAX_VISIBLE_NAVIGATION_REPOSITORIES = 64;
export interface NavigationViewportRow { element: Element; path: string }

/**
 * Observe rendered row headers, not a repository's potentially tall inline local panel.
 * DOM order, rather than observer delivery order, determines the bounded visible snapshot.
 * This only publishes paths; the root resolves them against its current discovery candidates.
 */
export function createNavigationViewport(publish: (paths: string[]) => void) {
  let observer: IntersectionObserver | null = null;
  let root: Element | null = null;
  let rows: NavigationViewportRow[] = [];
  let context = '';
  let epoch = 0;
  let disposed = false;
  let signature: string | null = null;
  const intersecting = new Set<Element>();
  const notify = () => {
    const paths = new Set<string>();
    for (const row of rows) {
      if (intersecting.has(row.element) && root?.contains(row.element)) paths.add(row.path);
      if (paths.size >= MAX_VISIBLE_NAVIGATION_REPOSITORIES) break;
    }
    const next = JSON.stringify([context, [...paths]]);
    if (next === signature) return;
    signature = next;
    publish([...paths]);
  };
  return {
    /** Call after the tree's DOM update. Identical elements/paths do not restart on summary updates. */
    update(nextRoot: Element | null, nextRows: readonly NavigationViewportRow[], nextContext: string): void {
      if (disposed) return;
      const rendered = nextRows.filter(row => row.path && nextRoot?.contains(row.element));
      if (root === nextRoot && context === nextContext && signature !== null && rows.length === rendered.length
        && rows.every((row, index) => row.element === rendered[index].element && row.path === rendered[index].path)) return;
      const currentEpoch = ++epoch;
      observer?.disconnect(); observer = null;
      root = nextRoot; rows = rendered; context = nextContext; intersecting.clear();
      // Clear removed/collapsed/previous-scope targets immediately; do not wait on a late observer batch.
      notify();
      if (!root || !rows.length || typeof IntersectionObserver !== 'function') return;
      const observed = new Set(rows.map(row => row.element));
      observer = new IntersectionObserver(entries => {
        if (disposed || epoch !== currentEpoch) return;
        for (const entry of entries) {
          if (!observed.has(entry.target)) continue;
          const area = entry.intersectionRect;
          if (entry.isIntersecting && area.width > 0 && area.height > 0 && root?.contains(entry.target)) intersecting.add(entry.target);
          else intersecting.delete(entry.target);
        }
        notify();
      // The tiny positive threshold follows an edge-touch (zero-area) entry once real pixels enter.
      }, { root, rootMargin: '0px', threshold: [0, 0.001] });
      observed.forEach(element => observer!.observe(element));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; epoch++;
      observer?.disconnect(); observer = null;
      rows = []; root = null; intersecting.clear();
      notify();
    },
  };
}

export interface NavigationSession { readonly repoPath: string; readonly generation: number; readonly epoch: number }
/** Session object identity rejects late callbacks, including close/reopen and A → B → A at the same generation. */
export function createNavigationSession() {
  let epoch = 0;
  let active: NavigationSession | null = null;
  return {
    open(repoPath: string, generation: number): NavigationSession {
      active = Object.freeze({ repoPath, generation, epoch: ++epoch });
      return active;
    },
    close(): void { active = null; epoch++; },
    valid(target: NavigationSession | null, repoPath: string | null | undefined, generation: number): target is NavigationSession {
      return target !== null && target === active && target.repoPath === repoPath && target.generation === generation && target.epoch === epoch;
    },
  };
}

export type RepositoryMenuGroupKey = 'repository' | 'branches' | 'history' | 'tags' | 'stashes' | 'remotes' | 'tools' | 'settings';
/** Exhaustive against the real protocol, not a prototype subset. Entry order is also menu order. */
const actionGroups = {
  commit: 'repository', clean: 'repository', continue: 'repository', abort: 'repository',
  checkout: 'branches', 'checkout-remote': 'branches', 'branch-create': 'branches', 'branch-rename': 'branches',
  'branch-delete': 'branches', 'set-upstream': 'branches',
  merge: 'history', rebase: 'history', 'cherry-pick': 'history', revert: 'history', drop: 'history', reset: 'history',
  'tag-create': 'tags', 'tag-delete': 'tags', 'tag-push': 'tags',
  'stash-save': 'stashes', 'stash-apply': 'stashes', 'stash-pop': 'stashes', 'stash-drop': 'stashes', 'stash-branch': 'stashes',
  fetch: 'remotes', pull: 'remotes', push: 'remotes', 'fetch-into': 'remotes', 'remote-branch-delete': 'remotes',
  'remote-add': 'remotes', 'remote-edit': 'remotes', 'remote-remove': 'remotes', prune: 'remotes', identity: 'settings',
} satisfies Record<ActionKind, RepositoryMenuGroupKey>;
export const REPOSITORY_MENU_GROUPS: readonly { key: RepositoryMenuGroupKey; kinds: readonly NavigationActionKind[] }[] =
  (['repository', 'branches', 'history', 'tags', 'stashes', 'remotes', 'tools', 'settings'] as const).map(key => ({
    key, kinds: [
      ...(key === 'repository' ? ['sync' as const] : []),
      ...(Object.entries(actionGroups).filter(([, group]) => group === key).map(([kind]) => kind as ActionKind)),
      ...(key === 'tools' ? ['terminal' as const, 'editor' as const] : []),
      ...(key === 'settings' ? ['settings' as const] : []),
    ],
  }));
export interface NavigationActionState { busy: boolean; staged: number | null; unstaged?: number | null; stashCount?: number | null }
export function navigationActionDisabled(kind: NavigationActionKind, state: NavigationActionState): boolean {
  if (state.busy) return true;
  if (kind === 'commit' && state.staged === 0) return true;
  if (kind === 'stash-save' && state.staged === 0 && state.unstaged === 0) return true;
  return ['stash-apply', 'stash-pop', 'stash-drop', 'stash-branch'].includes(kind) && state.stashCount === 0;
}

export function branchPickerGroups(refs: readonly GitRef[], search = ''): { kind: 'branch' | 'tag' | 'remote'; refs: GitRef[] }[] {
  const query = search.trim().toLowerCase();
  return (['branch', 'tag', 'remote'] as const).map(kind => ({
    kind, refs: refs.filter(ref => ref.kind === kind && !(kind === 'remote' && /\/HEAD$/.test(ref.fullName))
      && (!query || `${ref.name}\n${ref.fullName}`.toLowerCase().includes(query)))
      .sort((a, b) => Number(b.current) - Number(a.current) || compare(a.name, b.name)),
  }));
}
export function suggestedLocalBranch(ref: GitRef): string {
  const fullName = ref.fullName.replace(/^refs\/remotes\//, '');
  const slash = fullName.indexOf('/');
  return slash < 0 ? '' : fullName.slice(slash + 1);
}
export function localBranchNameProblem(name: string, refs: readonly GitRef[]): 'requiredName' | 'invalidName' | 'existingName' | null {
  if (!name.trim()) return 'requiredName';
  if (name !== name.trim() || name === '@' || name === 'HEAD' || name.startsWith('-') || name.endsWith('.')
    || /[\s\u0000-\u001f\u007f~^:?*\[\\]/.test(name) || name.includes('..') || name.includes('@{')
    || name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) return 'invalidName';
  if (refs.some(ref => ref.kind === 'branch' && (ref.name === name || ref.fullName === `refs/heads/${name}`))) return 'existingName';
  return null;
}
/** Resolve against the latest props; an old ref name alone cannot authorize a changed target OID. */
export function navigationCheckout(ref: GitRef, refs: readonly GitRef[], localName?: string): NavigationCheckout | null {
  const actual = refs.find(item => item.kind === ref.kind && item.fullName === ref.fullName && item.oid === ref.oid);
  if (!actual || actual.kind === 'stash' || actual.current) return null;
  if (actual.kind === 'remote') {
    if (/\/HEAD$/.test(actual.fullName) || localName === undefined || localBranchNameProblem(localName, refs)) return null;
    return { ref: actual, localName };
  }
  return { ref: actual };
}
