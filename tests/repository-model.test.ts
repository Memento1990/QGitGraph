import { describe, expect, it } from 'vitest';
import type { RepositoryCandidate } from '../src/shared/protocol';
import {
  buildRepositoryTree, clampRepositoryDepth, MAX_REPOSITORY_CANDIDATES, MAX_REPOSITORY_TREE_NODES,
  repositoryNodeKey, repositoryScopeName, repositoryTreeFocusKey, repositoryTreeKeyAction, visibleRepositoryRows,
} from '../src/lib/repositories';

function candidate(components: string[], path = `/scope/${components.join('/')}`, marker: RepositoryCandidate['marker'] = 'git-directory'): RepositoryCandidate {
  return { components, path, marker };
}

const example = () => buildRepositoryTree('/scope', [
  candidate([], '/scope'), candidate(['workspace', 'outer']), candidate(['workspace', 'outer', 'inner']), candidate(['other']),
]);

describe('native component repository tree', () => {
  it('keeps the root, ancestor groups, repositories, and nested repositories independently', () => {
    const tree = example();
    expect(tree.root.key).toBe(''); expect(tree.root.candidate?.path).toBe('/scope');
    expect(tree.root.parentKey).toBeNull(); expect(tree.root.children.map(node => node.name)).toEqual(['other', 'workspace']);
    const group = tree.nodes.get('workspace')!, outer = tree.nodes.get('workspace/outer')!;
    expect(group.candidate).toBeNull(); expect(group.components).toEqual(['workspace']);
    expect(outer.candidate?.path).toBe('/scope/workspace/outer');
    expect(outer.children[0].candidate?.path).toBe('/scope/workspace/outer/inner');
    expect(tree.candidateCount).toBe(4); expect(tree.nodes.size).toBe(5); expect(tree.omittedCount).toBe(0);
    expect(visibleRepositoryRows(tree, new Set()).map(row => [row.node.key, row.level, row.position, row.setSize])).toEqual([
      ['', 1, 1, 1], ['other', 2, 1, 2], ['workspace', 2, 2, 2], ['workspace/outer', 3, 1, 1], ['workspace/outer/inner', 4, 1, 1],
    ]);
  });

  it('never derives relative hierarchy from native paths or case-folds path identity', () => {
    const root = '\\\\?\\UNC\\Server\\Share\\Root';
    const input = [candidate(['a:b\\c'], `${root}\\native-name`, 'git-file'), candidate(['Repo'], 'D:\\Root\\Repo'), candidate(['repo'], 'd:\\root\\repo')];
    const before = JSON.stringify(input), tree = buildRepositoryTree(root, input);
    expect(tree.rootPath).toBe(root); expect(tree.root.name).toBe(root);
    expect(tree.nodes.get('a%3Ab%5Cc')?.name).toBe('a:b\\c');
    expect(tree.nodes.get('a%3Ab%5Cc')?.candidate?.path).toBe(`${root}\\native-name`);
    expect(tree.nodes.get('Repo')?.candidate?.path).toBe('D:\\Root\\Repo');
    expect(tree.nodes.get('repo')?.candidate?.path).toBe('d:\\root\\repo');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('uses reversible canonical collision-resistant disclosure keys, including prototype-like names', () => {
    const components = ['a/b', 'colon:name', 'back\\slash', '%2F', '仓库', '__proto__', 'constructor'];
    const key = repositoryNodeKey(components);
    expect(key.split('/').map(decodeURIComponent)).toEqual(components);
    expect(key.split('/').every(segment => encodeURIComponent(decodeURIComponent(segment)) === segment)).toBe(true);
    expect(key).not.toMatch(/[:\\\u0000-\u001f]/); expect(repositoryNodeKey([])).toBe('');
    expect(repositoryNodeKey(['a/b'])).not.toBe(repositoryNodeKey(['a', 'b']));
    expect(repositoryNodeKey(['a%2Fb'])).not.toBe(repositoryNodeKey(['a/b']));
    expect(repositoryNodeKey(['x', 'y%2Fz'])).not.toBe(repositoryNodeKey(['x/y', 'z']));
    const tree = buildRepositoryTree('/scope', [candidate(['__proto__']), candidate(['constructor']), candidate(['toString'])]);
    expect(tree.candidateCount).toBe(3); expect(tree.nodes.get('__proto__')?.candidate).not.toBeNull();
  });

  it('is deterministic across input order, locale changes, and duplicate records', () => {
    const input = [candidate(['z']), candidate(['A']), candidate(['a']), candidate(['仓库']), candidate(['a', 'child'])];
    const first = buildRepositoryTree('/scope', input), second = buildRepositoryTree('/scope', [...input].reverse());
    const keys = (tree: ReturnType<typeof buildRepositoryTree>) => visibleRepositoryRows(tree, new Set()).map(row => row.node.key);
    expect(keys(first)).toEqual(keys(second));
    expect(first.root.children.map(node => node.name)).toEqual(['A', 'a', 'z', '仓库']);
    const duplicate = buildRepositoryTree('/scope', [candidate(['a'], '/z'), candidate(['a'], '/a'), candidate(['a'], '/a')]);
    expect(duplicate.candidateCount).toBe(1); expect(duplicate.nodes.get('a')?.candidate?.path).toBe('/a'); expect(duplicate.omittedCount).toBe(1);
  });

  it('bounds candidates, directory nodes, depth, key length, and malformed records honestly', () => {
    const input = Array.from({ length: MAX_REPOSITORY_CANDIDATES + 10 }, (_, index) => candidate(Array.from({ length: 6 }, (_entry, depth) => `repo${index}-${depth}`)));
    const tree = buildRepositoryTree('/scope', input);
    expect(tree.candidateCount).toBe(MAX_REPOSITORY_CANDIDATES); expect(tree.nodes.size).toBe(MAX_REPOSITORY_TREE_NODES);
    expect(visibleRepositoryRows(tree, new Set())).toHaveLength(MAX_REPOSITORY_TREE_NODES); expect(tree.omittedCount).toBe(10);
    const malformed = [candidate(['.']), candidate(['..']), candidate(['']), candidate(['a\0b']), candidate(['\ud800']), candidate(['仓'.repeat(4_000)]), candidate(Array(7).fill('deep')), candidate(['valid'])];
    const invalid = buildRepositoryTree('/scope', malformed);
    expect(invalid.candidateCount).toBe(1); expect(invalid.omittedCount).toBe(7); expect(invalid.nodes.size).toBe(2);
    expect(buildRepositoryTree('/scope', []).root.children).toEqual([]);
  });

  it('takes only a display basename without treating POSIX backslashes as hierarchy or touching native identity', () => {
    expect(repositoryScopeName('D:\\work\\scope\\')).toBe('scope');
    expect(repositoryScopeName('D:/work/scope/')).toBe('scope');
    expect(repositoryScopeName('\\\\?\\UNC\\Server\\Share\\Scope')).toBe('Scope');
    expect(repositoryScopeName('/mnt/work/scope\\literal')).toBe('scope\\literal');
    expect(repositoryScopeName('/mnt/work/仓库/')).toBe('仓库');
    expect(repositoryScopeName('/')).toBe('/'); expect(repositoryScopeName('C:\\')).toBe('C:');
  });

  it('clamps only the requested scan depth without reinterpreting native candidates', () => {
    expect([-2, 0, 1.9, 5, 99, NaN, Infinity].map(clampRepositoryDepth)).toEqual([0, 0, 1, 5, 5, 0, 0]);
    expect(buildRepositoryTree('/scope', [candidate(Array(6).fill('native'))]).candidateCount).toBe(1);
  });
});

describe('repository disclosure and keyboard model', () => {
  it('collapses directories without losing candidates or their independent descendants', () => {
    const tree = example(), collapsed = new Set(['workspace/outer']);
    expect(visibleRepositoryRows(tree, collapsed).map(row => row.node.key)).toEqual(['', 'other', 'workspace', 'workspace/outer']);
    expect(tree.nodes.get('workspace/outer')?.candidate).not.toBeNull();
    expect(tree.nodes.get('workspace/outer')?.children).toHaveLength(1);
    expect(visibleRepositoryRows(tree, new Set([''])).map(row => row.node.key)).toEqual(['']);
  });

  it('implements roving arrows and home/end, with repository-only Enter and disclosure-only Space', () => {
    const tree = example(), collapsed = new Set<string>(), rows = visibleRepositoryRows(tree, collapsed);
    const action = (focused: string, key: string) => repositoryTreeKeyAction(rows, focused, collapsed, key);
    expect(action('', 'ArrowUp')).toEqual({ type: 'focus', key: '' });
    expect(action('', 'ArrowDown')).toEqual({ type: 'focus', key: 'other' });
    expect(action('workspace/outer', 'Home')).toEqual({ type: 'focus', key: '' });
    expect(action('', 'End')).toEqual({ type: 'focus', key: 'workspace/outer/inner' });
    expect(action('', 'ArrowRight')).toEqual({ type: 'focus', key: 'other' });
    expect(action('workspace', 'ArrowLeft')).toEqual({ type: 'toggle', key: 'workspace', collapsed: true });
    expect(action('other', 'ArrowLeft')).toEqual({ type: 'focus', key: '' });
    expect(action('other', 'ArrowRight')).toEqual({ type: 'none' });
    expect(action('workspace', 'Enter')).toEqual({ type: 'none' });
    expect(action('', 'Enter')).toEqual({ type: 'activate', key: '' });
    expect(action('workspace/outer', 'Enter')).toEqual({ type: 'activate', key: 'workspace/outer' });
    expect(action('workspace/outer', ' ')).toEqual({ type: 'toggle', key: 'workspace/outer', collapsed: true });
    expect(action('other', ' ')).toEqual({ type: 'none' });
    expect(action('other', 'Tab')).toBeNull(); expect(action('missing', 'Enter')).toBeNull();
    const folded = new Set(['workspace']), visible = visibleRepositoryRows(tree, folded);
    expect(repositoryTreeKeyAction(visible, 'workspace', folded, 'ArrowRight')).toEqual({ type: 'toggle', key: 'workspace', collapsed: false });
    expect(repositoryTreeKeyAction(visible, 'workspace', folded, 'ArrowLeft')).toEqual({ type: 'focus', key: '' });
    expect(repositoryTreeKeyAction(visible, 'workspace', folded, 'Spacebar')).toEqual({ type: 'toggle', key: 'workspace', collapsed: false });
  });

  it('restores removed or hidden focus to the closest visible ancestor, including the root', () => {
    const tree = example();
    expect(repositoryTreeFocusKey(visibleRepositoryRows(tree, new Set(['workspace/outer'])), ['workspace', 'outer', 'inner'])).toBe('workspace/outer');
    expect(repositoryTreeFocusKey(visibleRepositoryRows(tree, new Set()), ['workspace', 'removed', 'inner'])).toBe('workspace');
    expect(repositoryTreeFocusKey(visibleRepositoryRows(tree, new Set([''])), ['workspace', 'outer'])).toBe('');
    expect(repositoryTreeFocusKey([], ['workspace'])).toBeNull();
  });
});
