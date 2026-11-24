import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import RepositorySidebar from '../src/components/RepositorySidebar.vue';
import RepositoryMenu from '../src/components/RepositoryMenu.vue';
import BranchPicker from '../src/components/BranchPicker.vue';
import type { ActionKind, GitRef, RepositoryCandidate, Stash, SubmoduleInfo } from '../src/shared/protocol';
import { initI18n, setLanguage } from '../src/lib/i18n';
import {
  branchPickerGroups, buildNavigation, createNavigationSession, createNavigationViewport, localBranchNameProblem, navigationBranch,
  MAX_VISIBLE_NAVIGATION_REPOSITORIES,
  navigationCheckout, navigationCount, navigationCountLabel, navigationExpanded, navigationRepositoryKey,
  navigationScopeName, navigationText, navigationTracking, NAVIGATION_ROOT_KEYS, REPOSITORY_MENU_GROUPS,
  suggestedLocalBranch, type NavigationInput, type NavigationRepository,
} from '../src/lib/vue-navigation';
import { navigationActionDisabled } from '../src/lib/vue-navigation';

function repository(path: string, overrides: Partial<NavigationRepository> = {}): NavigationRepository {
  return { key: path, path, name: path.split('/').at(-1) ?? path, branch: null, head: null, changes: null, ahead: null, behind: null, ...overrides };
}
function candidate(path: string, components: string[]): RepositoryCandidate {
  return { path, components, marker: 'git-directory' };
}
function gitRef(kind: GitRef['kind'], name: string, overrides: Partial<GitRef> = {}): GitRef {
  const prefix = { branch: 'heads', remote: 'remotes', tag: 'tags', stash: 'stash' }[kind];
  return { kind, name, fullName: `refs/${prefix}/${name}`, oid: '1'.repeat(40), upstream: null, current: false, subject: '', ...overrides };
}
const stash: Stash = { selector: 'stash@{0}', oid: '2'.repeat(40), message: 'saved observation', timestamp: 0 };
const submodule: SubmoduleInfo = { path: 'packages/core', name: 'core', url: '', initialized: false, head: null, indexOid: '3'.repeat(40), modified: false, untracked: false };
function input(overrides: Partial<NavigationInput> = {}): NavigationInput {
  return { repositories: [], scopeRoot: '/scope', currentPath: null, refs: [], stashes: [], submodules: [], ...overrides };
}
const allNodes = (value: ReturnType<typeof buildNavigation>) => [...value.byKey.values()];
const sidebarProps = (overrides: Partial<InstanceType<typeof RepositorySidebar>['$props']> = {}) => ({
  repositories: [] as NavigationRepository[], scopeRoot: '/scope', currentPath: null as string | null,
  refs: [] as GitRef[], stashes: [] as Stash[], submodules: [] as SubmoduleInfo[], loading: false,
  generation: 1, busy: false, inlineLocal: false, ...overrides,
});
function renderSidebar(props = sidebarProps(), local?: () => ReturnType<typeof h>) {
  return renderToString(createSSRApp({ render: () => h(RepositorySidebar, props, local ? { local } : undefined) }));
}
afterEach(() => { initI18n('en', []); vi.unstubAllGlobals(); });

// These are assistant automated checks of observations and emitted-intent models, not user-usage evidence.
describe('formal Vue navigation hierarchy', () => {
  it('always has four stable sibling roots, never a branch side tree', () => {
    const a = repository('/scope/a'), b = repository('/scope/b');
    const tree = buildNavigation(input({ repositories: [a, b], currentPath: a.path,
      refs: [gitRef('branch', 'main'), gitRef('remote', 'origin/main'), gitRef('tag', 'v1'), gitRef('stash', 'stash')],
      stashes: [stash], submodules: [submodule],
    }));
    expect(tree.roots.map(root => root.key)).toEqual(NAVIGATION_ROOT_KEYS);
    expect(tree.roots.map(root => root.kind)).toEqual(NAVIGATION_ROOT_KEYS);
    expect(tree.roots.slice(1).map(root => root.contextPath)).toEqual([a.path, a.path, a.path]);
    expect(tree.roots[2].children?.map(node => node.ref?.name)).toEqual(['v1']);
    expect(allNodes(tree).some(node => ['branch', 'remote'].includes(node.ref?.kind ?? ''))).toBe(false);
    const next = buildNavigation(input({ repositories: [a, b], currentPath: b.path }));
    expect(next.roots.map(root => root.key)).toEqual(tree.roots.map(root => root.key));
    expect(next.roots.slice(1).map(root => root.contextPath)).toEqual([b.path, b.path, b.path]);
  });

  it('uses candidate components and not a native path split, including nested repositories', () => {
    const root = repository('\\\\?\\UNC\\server\\share\\Scope', { candidate: candidate('\\\\?\\UNC\\server\\share\\Scope', []) });
    const outer = repository('D:\\opaque\\not-the-hierarchy', { name: 'outer', candidate: candidate('D:\\opaque\\not-the-hierarchy', ['workspace', 'outer']) });
    const inner = repository('/native/also-opaque', { name: 'inner', candidate: candidate('/native/also-opaque', ['workspace', 'outer', 'inner']) });
    const tree = buildNavigation(input({ scopeRoot: root.path, repositories: [inner, root, outer] }));
    const rootNode = tree.roots[0].children![0];
    expect(rootNode.repo).toBe(root);
    expect(rootNode.children![0].label).toBe('workspace');
    expect(rootNode.children![0].repo).toBeUndefined();
    const outerNode = rootNode.children![0].children![0];
    expect(outerNode.repo).toBe(outer);
    expect(outerNode.children![0].repo).toBe(inner);
    expect(tree.repositoryCount).toBe(3);
    expect(tree.byKey.has('D:')).toBe(false);
  });

  it('retains native path case and collision-resistant component identities', () => {
    const values = [
      repository('D:/Repo', { candidate: candidate('D:/Repo', ['a/b']) }),
      repository('d:/repo', { candidate: candidate('d:/repo', ['a', 'b']) }),
      repository('/native/prototype', { candidate: candidate('/native/prototype', ['__proto__']) }),
      repository('/native/colon', { candidate: candidate('/native/colon', ['a:b\\c', 'leaf']) }),
    ];
    const tree = buildNavigation(input({ repositories: values }));
    expect(tree.repositoryCount).toBe(4);
    expect(allNodes(tree).filter(node => node.repo).map(node => node.repo?.path).sort()).toEqual(values.map(repo => repo.path).sort());
    expect(tree.byKey.size).toBe(allNodes(tree).length);
    expect(allNodes(tree).find(node => node.label === 'a:b\\c')?.kind).toBe('directory');
    expect(navigationRepositoryKey(repository('D:/Repo'))).not.toBe(navigationRepositoryKey(repository('d:/repo')));
  });

  it('keeps candidate disclosure keys stable as a folder gains a repository observation', () => {
    const inner = repository('/scope/group/inner', { candidate: candidate('/scope/group/inner', ['group', 'inner']) });
    const before = buildNavigation(input({ repositories: [inner] }));
    const parentKey = allNodes(before).find(node => node.label === 'group')!.key;
    const group = repository('/scope/group', { candidate: candidate('/scope/group', ['group']) });
    const after = buildNavigation(input({ repositories: [group, inner] }));
    expect(after.byKey.get(parentKey)?.repo).toBe(group);
    expect(after.byKey.get(parentKey)?.children?.[0].repo).toBe(inner);
  });

  it('does not mutate observations, does not infer parents from paths, and deduplicates exact repository paths', () => {
    const repos = [repository('/scope/repo'), repository('/scope/repo/child'), repository('/scope/repo')];
    const before = JSON.stringify(repos);
    const tree = buildNavigation(input({ repositories: repos }));
    expect(JSON.stringify(repos)).toBe(before);
    expect(tree.repositoryCount).toBe(2);
    expect(tree.roots[0].children).toHaveLength(2);
    expect(tree.roots[0].children?.every(node => !node.children)).toBe(true);
  });

  it('searches real values, retains ancestors and all four roots, and keeps actions out of the tree', () => {
    const outer = repository('/native/outer', { name: 'outer', candidate: candidate('/native/outer', ['packages', 'outer']) });
    const child = repository('/native/target', { name: 'target', branch: 'feature/search', candidate: candidate('/native/target', ['packages', 'outer', 'target']) });
    const tree = buildNavigation(input({ repositories: [outer, child], currentPath: outer.path, refs: [gitRef('tag', 'release/search')] }), 'search');
    expect(tree.roots).toHaveLength(4);
    expect(tree.roots[0].children?.[0].label).toBe('packages');
    expect(tree.roots[0].children?.[0].children?.[0].repo).toBe(outer);
    expect(tree.roots[0].children?.[0].children?.[0].children?.[0].repo).toBe(child);
    expect(tree.roots[2].children?.[0].ref?.name).toBe('release/search');
    expect(tree.roots[3].children?.[0].message).toBe('noResults');
    expect(tree.roots[0].count).toBe(2);
  });

  it('preserves independent collapse state during search and across repository switches', () => {
    const stored = ['directory-root', 'tags-root'], automatic = [...NAVIGATION_ROOT_KEYS, 'directory:a'];
    expect(navigationExpanded(stored, automatic, '', [])).toEqual(stored);
    expect(navigationExpanded(stored, automatic, 'tag', ['tags-root', 'directory:a'])).toEqual(['directory-root', 'submodules-root', 'stashes-root']);
    expect(navigationExpanded(stored, automatic, '', ['tags-root'])).toEqual(stored);
  });

  it('hides current-owned observations while loading or with no current repository, rather than claiming empty known counts', () => {
    for (const context of [{ currentPath: '/scope/a', loading: true }, { currentPath: null, loading: false }]) {
      const tree = buildNavigation(input({ ...context, refs: [gitRef('tag', 'stale')], stashes: [stash], submodules: [submodule] }));
      expect(tree.roots.slice(1).every(root => root.count === null)).toBe(true);
      expect(allNodes(tree).some(node => node.ref || node.stash || node.submodule)).toBe(false);
    }
    const tree = buildNavigation(input({ currentPath: '/scope/a' }));
    expect(tree.roots.slice(1).map(root => root.count)).toEqual([0, 0, 0]);
  });
});

describe('viewport-only repository summary demand', () => {
  /** Injectable observer delivery only; no browser, network, host, or repository access. */
  function fixture() {
    class Observer {
      static instances: Observer[] = [];
      observed: Element[] = [];
      disconnect = vi.fn();
      observe = vi.fn((element: Element) => { this.observed.push(element); });
      constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) {
        Observer.instances.push(this);
      }
      deliver(entries: { element: Element; visible?: boolean; width?: number; height?: number }[]) {
        this.callback(entries.map(({ element, visible = true, width = 300, height = 50 }) => ({
          target: element, isIntersecting: visible, intersectionRect: { width, height },
        } as IntersectionObserverEntry)), this as unknown as IntersectionObserver);
      }
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const attached = new Set<Element>();
    const root = { contains: (element: Element) => attached.has(element) } as unknown as Element;
    const row = (path: string) => {
      const element = {} as Element;
      attached.add(element);
      return { element, path };
    };
    const publish = vi.fn<(paths: string[]) => void>();
    const viewport = createNavigationViewport(publish);
    return { Observer, attached, root, row, publish, viewport, latest: () => Observer.instances.at(-1)! };
  }

  it('uses the tree viewport as observer root and never assumes all rendered rows are visible', () => {
    const f = fixture(), a = f.row('/scope/a'), b = f.row('/scope/b');
    f.viewport.update(f.root, [a, b], 'scope:1');
    expect(f.latest().options).toEqual({ root: f.root, rootMargin: '0px', threshold: [0, 0.001] });
    expect(f.latest().observed).toEqual([a.element, b.element]);
    expect(f.publish.mock.calls).toEqual([[[]]]);
    f.latest().deliver([{ element: b.element }]);
    expect(f.publish).toHaveBeenLastCalledWith(['/scope/b']);
    f.latest().deliver([{ element: a.element }, { element: b.element, visible: false }]);
    expect(f.publish).toHaveBeenLastCalledWith(['/scope/a']);
    f.latest().deliver([{ element: a.element, visible: false }]);
    expect(f.publish).toHaveBeenLastCalledWith([]);
    f.viewport.dispose();
  });

  it('publishes at most 64 unique native paths in DOM order, not observer callback order', () => {
    const f = fixture(), rows = Array.from({ length: 70 }, (_, index) => f.row(`/scope/${index}`));
    const samePath = f.row(rows[1].path);
    f.viewport.update(f.root, [rows[0], samePath, ...rows.slice(1)], 'scope:1');
    f.latest().deliver([...rows, samePath].reverse().map(row => ({ element: row.element })));
    expect(MAX_VISIBLE_NAVIGATION_REPOSITORIES).toBe(64);
    expect(f.publish).toHaveBeenLastCalledWith(rows.slice(0, 64).map(row => row.path));
    f.latest().deliver(rows.slice(0, 10).map(row => ({ element: row.element, visible: false })));
    f.latest().deliver([{ element: samePath.element, visible: false }]);
    expect(f.publish).toHaveBeenLastCalledWith(rows.slice(10).map(row => row.path));
    f.viewport.dispose();
  });

  it('deduplicates observer batches and identical post-summary updates without a probe/render loop', () => {
    const f = fixture(), a = f.row('/scope/a');
    f.viewport.update(f.root, [a], 'scope:1');
    const observer = f.latest();
    observer.deliver([{ element: a.element }]);
    const calls = f.publish.mock.calls.length;
    observer.deliver([{ element: a.element }]);
    f.viewport.update(f.root, [{ ...a }], 'scope:1');
    expect(f.publish).toHaveBeenCalledTimes(calls);
    expect(f.Observer.instances).toHaveLength(1);
    expect(observer.disconnect).not.toHaveBeenCalled();
    f.viewport.dispose();
  });

  it('updates after search or collapse removes rows, rejects delayed batches and clears a collapsed directory', () => {
    const f = fixture(), a = f.row('/scope/a'), b = f.row('/scope/b');
    f.viewport.update(f.root, [a, b], 'scope:1');
    const previous = f.latest();
    previous.deliver([{ element: a.element }, { element: b.element }]);
    f.attached.delete(a.element);
    f.viewport.update(f.root, [b], 'scope:1');
    expect(previous.disconnect).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenLastCalledWith([]);
    const calls = f.publish.mock.calls.length;
    previous.deliver([{ element: a.element }]);
    expect(f.publish).toHaveBeenCalledTimes(calls);
    f.latest().deliver([{ element: b.element }]);
    expect(f.publish).toHaveBeenLastCalledWith(['/scope/b']);
    const current = f.latest();
    f.viewport.update(f.root, [], 'scope:1');
    expect(f.publish).toHaveBeenLastCalledWith([]);
    current.deliver([{ element: b.element }]);
    expect(f.publish).toHaveBeenLastCalledWith([]);
    f.viewport.dispose();
  });

  it('restarts for generation, scope or candidate identity changes even with unchanged paths and DOM', () => {
    const f = fixture(), a = f.row('D:\\scope\\a');
    f.viewport.update(f.root, [a], 'scope:1:git-directory');
    const first = f.latest();
    first.deliver([{ element: a.element }]);
    for (const context of ['scope:2:git-directory', 'other-scope:2:git-directory', 'scope:1:git-file']) {
      const previous = f.latest();
      f.viewport.update(f.root, [a], context);
      expect(previous.disconnect).toHaveBeenCalledTimes(1);
      expect(f.publish).toHaveBeenLastCalledWith([]);
      f.latest().deliver([{ element: a.element }]);
      expect(f.publish).toHaveBeenLastCalledWith(['D:\\scope\\a']);
    }
    const calls = f.publish.mock.calls.length;
    first.deliver([{ element: a.element, visible: false }]);
    expect(f.publish).toHaveBeenCalledTimes(calls);
    f.viewport.dispose();
  });

  it('ignores foreign, detached and zero-area targets, and retains path case', () => {
    const f = fixture(), upper = f.row('D:/Repo'), lower = f.row('d:/repo'), empty = f.row('');
    const detached = f.row('/removed'), foreign = f.row('/not-a-repository-row');
    f.attached.delete(detached.element);
    f.viewport.update(f.root, [upper, lower, empty, detached], 'scope:1');
    expect(f.latest().observed).toEqual([upper.element, lower.element]);
    f.latest().deliver([{ element: upper.element, height: 0 }, { element: lower.element, width: 0 }, { element: foreign.element }]);
    expect(f.publish).toHaveBeenLastCalledWith([]);
    f.latest().deliver([{ element: lower.element }, { element: upper.element }]);
    expect(f.publish).toHaveBeenLastCalledWith(['D:/Repo', 'd:/repo']);
    f.attached.delete(upper.element);
    f.latest().deliver([{ element: lower.element }]);
    expect(f.publish).toHaveBeenLastCalledWith(['d:/repo']);
    f.viewport.dispose();
  });

  it('re-observes when DOM rows or the scroll viewport are replaced', () => {
    const f = fixture(), before = f.row('/scope/a'), after = f.row('/scope/a');
    f.viewport.update(f.root, [before], 'scope:1');
    const previous = f.latest();
    previous.deliver([{ element: before.element }]);
    f.attached.delete(before.element);
    f.viewport.update(f.root, [after], 'scope:1');
    expect(f.latest().observed).toEqual([after.element]);
    expect(previous.disconnect).toHaveBeenCalledTimes(1);
    f.latest().deliver([{ element: after.element }]);
    const replacement = { contains: (element: Element) => f.attached.has(element) } as unknown as Element;
    f.viewport.update(replacement, [after], 'scope:1');
    expect(f.latest().options.root).toBe(replacement);
    f.latest().deliver([{ element: after.element }]);
    expect(f.publish).toHaveBeenLastCalledWith(['/scope/a']);
    f.viewport.dispose();
  });

  it('disconnects and clears on unmount, and old callbacks cannot publish afterward', () => {
    const f = fixture(), a = f.row('/scope/a');
    f.viewport.update(f.root, [a], 'scope:1');
    const observer = f.latest();
    observer.deliver([{ element: a.element }]);
    f.viewport.dispose();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenLastCalledWith([]);
    const calls = f.publish.mock.calls.length;
    f.viewport.dispose();
    observer.deliver([{ element: a.element }]);
    f.viewport.update(f.root, [a], 'scope:2');
    expect(f.publish).toHaveBeenCalledTimes(calls);
    expect(f.Observer.instances).toHaveLength(1);
  });

  it('is SSR safe and never substitutes all repositories when observation is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const publish = vi.fn<(paths: string[]) => void>(), viewport = createNavigationViewport(publish);
    const element = {} as Element, root = { contains: () => true } as unknown as Element;
    viewport.update(null, [], 'ssr');
    expect(publish).toHaveBeenLastCalledWith([]);
    viewport.update(root, [{ element, path: '/scope/a' }], 'scope:1');
    expect(publish).toHaveBeenLastCalledWith([]);
    viewport.dispose();
  });
});

describe('honest unknown summaries and localization', () => {
  it.each([null, undefined, -1, NaN, Infinity, .5])('shows an em dash for unknown/invalid count %s, including accessible text', value => {
    expect(navigationCount(value)).toBe('—');
    expect(navigationCountLabel(value, 'en')).toBe('— (unknown)');
    expect(navigationCountLabel(value, 'zh-CN')).toBe('— (未知)');
  });
  it('preserves a real zero and raw repository/branch names', () => {
    expect(navigationCount(0)).toBe('0');
    expect(navigationCountLabel(0, 'zh-CN')).toBe('0');
    expect(navigationCount(42)).toBe('42');
    const repo = repository('/scope/raw', { branch: 'feature/Apply 保存', changes: 0, ahead: null, behind: 0 });
    expect(navigationBranch(repo, 'zh-CN')).toBe('feature/Apply 保存');
    expect(navigationTracking(repo, 'en')).toBe('↑— (unknown) ↓0');
    expect(navigationTracking(repo, 'zh-CN')).toBe('↑— (未知) ↓0');
  });
  it('distinguishes unborn, detached, unknown and uninitialized branch observations', () => {
    expect(navigationBranch(repository('/a', { branch: 'main' }), 'en')).toBe('main');
    expect(navigationBranch(repository('/a', { head: 'abcdef1234567' }), 'en')).toBe('Detached abcdef1');
    expect(navigationBranch(repository('/a'), 'en')).toBe('— (HEAD is unknown)');
    expect(navigationBranch(repository('/a', { initialized: false }), 'zh-CN')).toBe('尚未初始化');
  });
  it('localizes UI-owned labels without translating user content', () => {
    expect(navigationText('directory', 'en')).toBe('Directory');
    expect(navigationText('directory', 'zh-CN')).toBe('目录');
    expect(navigationScopeName('D:\\work\\scope\\')).toBe('scope');
    expect(navigationScopeName('/work/literal\\name')).toBe('literal\\name');
    expect(navigationScopeName('/')).toBe('/');
  });
});

describe('targeted menu actions and session lifetime', () => {
  it('contains every formal ActionKind once, plus synchronization, tools and settings', () => {
    const protocol = readFileSync(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8');
    const union = /export type ActionKind\s*=([\s\S]*?);/.exec(protocol)![1];
    const actualKinds = [...union.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
    const entries = REPOSITORY_MENU_GROUPS.flatMap(group => [...group.kinds]);
    expect(entries.filter(kind => !['sync', 'terminal', 'editor', 'settings'].includes(kind)).sort()).toEqual(actualKinds);
    expect(new Set(entries).size).toBe(entries.length);
    expect(REPOSITORY_MENU_GROUPS.find(group => group.key === 'tools')?.kinds).toEqual(['terminal', 'editor']);
    expect(REPOSITORY_MENU_GROUPS.find(group => group.key === 'settings')?.kinds).toEqual(['identity', 'settings']);
  });
  it('only applies known lightweight menu availability; unknown counts leave controller preflight possible', () => {
    const unknown = { busy: false, staged: null, unstaged: null, stashCount: null };
    expect(REPOSITORY_MENU_GROUPS.flatMap(group => [...group.kinds]).every(kind => !navigationActionDisabled(kind, unknown))).toBe(true);
    expect(navigationActionDisabled('commit', { ...unknown, staged: 0 })).toBe(true);
    expect(navigationActionDisabled('stash-save', { ...unknown, staged: 0, unstaged: 0 })).toBe(true);
    expect(navigationActionDisabled('stash-save', { ...unknown, staged: 1, unstaged: 0 })).toBe(false);
    for (const kind of ['stash-apply', 'stash-pop', 'stash-drop', 'stash-branch'] as ActionKind[]) {
      expect(navigationActionDisabled(kind, { ...unknown, stashCount: 0 })).toBe(true);
    }
    expect(REPOSITORY_MENU_GROUPS.flatMap(group => [...group.kinds]).every(kind => navigationActionDisabled(kind, { ...unknown, busy: true }))).toBe(true);
  });
  it('binds a non-current menu target without changing selection or silently retargeting it', () => {
    const sessions = createNavigationSession(), target = sessions.open('/scope/non-current', 3);
    expect(sessions.valid(target, '/scope/non-current', 3)).toBe(true);
    expect(sessions.valid(target, '/scope/current', 3)).toBe(false);
    expect(sessions.valid(target, '/scope/non-current', 4)).toBe(false);
    expect(Object.isFrozen(target)).toBe(true);
  });
  it('rejects old callbacks on A → B → A even if a caller incorrectly reuses generation', () => {
    const sessions = createNavigationSession(), firstA = sessions.open('/a', 2);
    sessions.open('/b', 2);
    const secondA = sessions.open('/a', 2);
    expect(secondA.epoch).toBeGreaterThan(firstA.epoch);
    expect(sessions.valid(firstA, '/a', 2)).toBe(false);
    expect(sessions.valid(secondA, '/a', 2)).toBe(true);
    sessions.close();
    expect(sessions.valid(secondA, '/a', 2)).toBe(false);
    expect(sessions.valid(null, '/a', 2)).toBe(false);
    const reopenedA = sessions.open('/a', 2);
    expect(sessions.valid(secondA, '/a', 2)).toBe(false);
    expect(sessions.valid(reopenedA, '/a', 2)).toBe(true);
  });
});

describe('branch picker intent preparation', () => {
  it('separates local/tag/remote, omits stashes and symbolic remote HEAD, and sorts current first', () => {
    const refs = [gitRef('branch', 'z'), gitRef('tag', 'v1'), gitRef('remote', 'upstream/feature/a'),
      gitRef('remote', 'origin/HEAD'), gitRef('stash', 'stash@{0}'), gitRef('branch', 'main', { current: true })];
    const groups = branchPickerGroups(refs);
    expect(groups.map(group => group.kind)).toEqual(['branch', 'tag', 'remote']);
    expect(groups.map(group => group.refs.map(ref => ref.name))).toEqual([['main', 'z'], ['v1'], ['upstream/feature/a']]);
    expect(branchPickerGroups(refs, 'FEATURE/A').flatMap(group => group.refs.map(ref => ref.name))).toEqual(['upstream/feature/a']);
    expect(suggestedLocalBranch(refs[2])).toBe('feature/a');
  });
  it('hands a local or tag selection straight to root without an extra parameter form', () => {
    const branch = gitRef('branch', 'feature'), tag = gitRef('tag', 'v1');
    const latestBranch = { ...branch, subject: 'new observation' };
    expect(navigationCheckout(branch, [latestBranch, tag])).toEqual({ ref: latestBranch });
    expect(navigationCheckout(tag, [latestBranch, tag])).toEqual({ ref: tag });
    expect(navigationCheckout(branch, [latestBranch], 'ignored')).toEqual({ ref: latestBranch });
  });
  it('requires an explicit valid new local name for remote checkout and does not assume a remote named origin', () => {
    const remote = gitRef('remote', 'team/feature/a');
    expect(suggestedLocalBranch(remote)).toBe('feature/a');
    expect(navigationCheckout(remote, [remote])).toBeNull();
    expect(navigationCheckout(remote, [remote], '')).toBeNull();
    expect(navigationCheckout(remote, [remote], 'review/feature')).toEqual({ ref: remote, localName: 'review/feature' });
    expect(navigationCheckout(remote, [remote, gitRef('branch', 'review/feature')], 'review/feature')).toBeNull();
  });
  it.each(['-option', 'a b', 'a..b', 'a@{b', '.hidden', 'a/.hidden', 'a.lock', 'a/b.lock', 'a/', '/a', 'a//b', 'a\\b', 'a?b', 'a[b', 'a\nb', 'a.', '@', 'HEAD'])('rejects invalid local name %s before requesting checkout', name => {
    expect(localBranchNameProblem(name, [])).toBe('invalidName');
  });
  it('keeps validation localized and allows normal nested branch names', () => {
    expect(localBranchNameProblem('', [])).toBe('requiredName');
    expect(localBranchNameProblem('   ', [])).toBe('requiredName');
    expect(localBranchNameProblem(' feature', [])).toBe('invalidName');
    expect(localBranchNameProblem('feature/仓库', [])).toBeNull();
    expect(localBranchNameProblem('feature', [gitRef('branch', 'feature')])).toBe('existingName');
  });
  it('rejects removed, current, changed-OID or unsupported references against latest observations', () => {
    const branch = gitRef('branch', 'feature'), remoteHead = gitRef('remote', 'origin/HEAD'), stashRef = gitRef('stash', 'saved');
    expect(navigationCheckout(branch, [])).toBeNull();
    expect(navigationCheckout(branch, [{ ...branch, oid: '2'.repeat(40) }])).toBeNull();
    expect(navigationCheckout(branch, [{ ...branch, current: true }])).toBeNull();
    expect(navigationCheckout(remoteHead, [remoteHead], 'main')).toBeNull();
    expect(navigationCheckout(stashRef, [stashRef])).toBeNull();
  });
});

describe('real Vue/Reka component rendering', () => {
  it('renders real Reka tree semantics, stable siblings, and em dashes in visual and accessible observations', async () => {
    initI18n('en', []);
    const repo = repository('/scope/a', { name: 'literal <script> Apply 保存', candidate: candidate('/scope/a', ['a']) });
    const html = await renderSidebar(sidebarProps({ repositories: [repo], currentPath: repo.path, refs: [gitRef('tag', 'v1')], stashes: [stash], submodules: [submodule] }));
    expect(html).toContain('role="tree"');
    for (const kind of NAVIGATION_ROOT_KEYS) {
      expect(html).toMatch(new RegExp(`role="treeitem"[^>]*data-node-kind="${kind}"[^>]*aria-level="1"|data-node-kind="${kind}"[^>]*role="treeitem"[^>]*aria-level="1"`));
    }
    expect(html).toContain('literal &lt;script&gt; Apply 保存');
    expect(html).toContain('Local changes: — (unknown)');
    expect(html).toContain('↑— (unknown) ↓— (unknown)');
    expect(html).toContain('Switch branch in literal');
    expect(html).toContain('Synchronize literal');
    expect(html).toContain('Commit staged changes in literal');
    expect(html).toContain('Refresh literal');
    expect(html).toContain('More actions for literal');
    expect(html).not.toContain('data-node-kind="branch"');
  });
  it('renders the local slot exactly once, at the current repository and only in inline mode', async () => {
    const a = repository('/scope/a'), b = repository('/scope/b');
    const props = sidebarProps({ repositories: [a, b], currentPath: b.path, inlineLocal: true });
    const html = await renderSidebar(props, () => h('div', { 'data-local-panel': 'same-root-owned-panel' }));
    expect(html.match(/data-local-panel=/g)).toHaveLength(1);
    expect(html).toContain('data-local-path="/scope/b"');
    expect(html).not.toContain('data-local-path="/scope/a"');
    const middle = await renderSidebar({ ...props, inlineLocal: false }, () => h('div', { 'data-local-panel': 'must-not-mount' }));
    expect(middle).not.toContain('data-local-panel');
  });
  it('localizes mounted component output in both locales and preserves literal branch/repository strings', async () => {
    const repo = repository('/scope/raw', { name: 'Apply 保存', branch: 'feature/Apply 保存' });
    initI18n('en', []);
    const english = await renderSidebar(sidebarProps({ repositories: [repo], currentPath: repo.path }));
    setLanguage('zh-CN');
    const chinese = await renderSidebar(sidebarProps({ repositories: [repo], currentPath: repo.path }));
    expect(english).toContain('Repository navigation'); expect(english).toContain('Directory and trust');
    expect(chinese).toContain('仓库导航'); expect(chinese).toContain('目录与信任');
    expect(chinese).toContain('当前仓库: Apply 保存'); expect(chinese).toContain('本地修改: — (未知)');
    expect(chinese).toContain('feature/Apply 保存');
  });
  it('renders a real menu trigger for the target without selecting a repository', async () => {
    const props = { repoPath: '/scope/non-current', repoName: 'Target', generation: 2, busy: false, staged: null };
    const html = await renderToString(createSSRApp({ render: () => h(RepositoryMenu, props) }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('More actions for Target');
    expect(html).not.toContain('aria-current');
  });
  it('renders only branch selection controls initially, with a real accessible Reka dialog', async () => {
    const repo = repository('/scope/repo'), context: { teleports?: Record<string, string> } = {};
    await renderToString(createSSRApp({ render: () => h(BranchPicker, {
      open: true, repo, generation: 1, busy: false,
      refs: [gitRef('branch', 'main'), gitRef('remote', 'team/feature'), gitRef('tag', 'v1')],
    }) }), context);
    const html = Object.values(context.teleports ?? {}).join('');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Switch branch');
    expect(html).toContain('Local branches'); expect(html).toContain('Remote branches');
    expect(html).toContain('Tag · detached HEAD');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('name="localName"');
  });
  it('marks only the fixed repository header for viewport observation, never inline local panel content', async () => {
    const a = repository('/scope/a'), b = repository('/scope/b');
    const visible = vi.fn<(paths: string[]) => void>();
    const html = await renderSidebar(sidebarProps({ repositories: [a, b], currentPath: a.path, inlineLocal: true, onVisible: visible }), () => h('div', { 'data-local-panel': 'root-owned' }));
    expect(html.match(/data-viewport-repository-path=/g)).toHaveLength(2);
    expect(html).toContain('data-viewport-repository-path="/scope/a"');
    expect(html).toContain('data-viewport-repository-path="/scope/b"');
    // Mounted visibility is not fabricated by SSR, including when a current row owns a tall local slot.
    expect(visible).not.toHaveBeenCalled();
    const source = readFileSync(new URL('../src/components/RepositorySidebar.vue', import.meta.url), 'utf8');
    expect(source).toContain('<div ref="treeViewport" class="tree-scroll">');
    expect(source).toContain('visible: [paths: string[]]');
    expect(source).toContain("createNavigationViewport(paths => emit('visible', paths))");
    expect(source).toContain('onMounted(updateVisibleRepositories)');
    expect(source).toContain('onUpdated(updateVisibleRepositories)');
    expect(source).toContain('onBeforeUnmount(() => viewport.dispose())');
    expect(source).toContain('.repository-row-header { height: 50px;');
    expect(source).toMatch(/<div class="repository-row-header"[^>]*data-viewport-repository-path/);
    expect(source).not.toMatch(/<div[^>]*data-local-path[^>]*data-viewport-repository-path/);
  });
  it('contains no mock/prototype/controller/host imports in the implementation boundary', () => {
    const paths = ['src/components/RepositorySidebar.vue', 'src/components/RepositoryMenu.vue', 'src/components/BranchPicker.vue', 'src/lib/vue-navigation.ts'];
    for (const path of paths) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from\s+['"][^'"]*(?:designs|lib\/data|lib\/repositories|\/host|\/controllers)[^'"]*['"]/);
      if (path.endsWith('.vue')) {
        expect(source).toContain('<style scoped>');
        expect(source).not.toMatch(/#[\da-fA-F]{3,8}\b/);
      }
    }
    const menu = readFileSync(new URL('../src/components/RepositoryMenu.vue', import.meta.url), 'utf8');
    expect(menu).toContain('resolveText(actionLabel(');
  });
});
