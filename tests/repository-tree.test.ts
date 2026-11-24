import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryCandidate, RepositoryDiscovery, RepositorySummary } from '../src/shared/protocol';
import type { RepositorySummaryState } from '../src/lib/repository-summaries';
import { initI18n, setLanguage } from '../src/lib/i18n';
import { RepositoryTree, type RepositoryTreeCallbacks, type RepositoryTreeModel } from '../src/ui/repository-tree';

/** Deliberately small native-DOM double: no browser, filesystem, or third-party DOM. */
class TestNode {
  parentElement: TestNode | null = null;
  children: TestNode[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  events = new Map<string, ((event: TestEvent) => void)[]>();
  className = '';
  tagName: string;
  text = '';
  title = '';
  id = '';
  value = '';
  type = '';
  hidden = false;
  disabled = false;
  open = false;
  tabIndex = -1;
  scrollTop = 0;
  style = { setProperty: vi.fn() };
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => names.forEach(name => this.classList.toggle(name, true)),
    remove: (...names: string[]) => names.forEach(name => this.classList.toggle(name, false)),
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean)), enabled = force ?? !names.has(name);
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' '); return enabled;
    },
  };
  constructor(tag = 'div', text = '') { this.tagName = tag === '#text' ? '#text' : tag.toUpperCase(); this.text = text; }
  get parentNode(): TestNode | null { return this.parentElement; }
  get nodeType(): number { return this.tagName === '#text' ? 3 : 1; }
  get nodeName(): string { return this.tagName; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text: string) { this.replaceChildren(); this.text = text; }
  get firstElementChild(): TestNode | null { return this.children.find(child => child.nodeType === 1) ?? null; }
  get nextElementSibling(): TestNode | null {
    const siblings = this.parentElement?.children ?? [], index = siblings.indexOf(this);
    return siblings.slice(index + 1).find(child => child.nodeType === 1) ?? null;
  }
  append(...children: (TestNode | string)[]): void { children.forEach(child => this.appendChild(typeof child === 'string' ? new TestNode('#text', child) : child)); }
  appendChild(child: TestNode): TestNode { return this.insertBefore(child, null); }
  insertBefore(child: TestNode, before: TestNode | null): TestNode {
    if (child === before) return child;
    child.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentElement = this; return child;
  }
  remove(): void { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  replaceChildren(...children: TestNode[]): void { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = ''; this.append(...children); }
  contains(node: TestNode | null): boolean { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  addEventListener(name: string, callback: (event: TestEvent) => void): void { this.events.set(name, [...this.events.get(name) ?? [], callback]); }
  emit(name: string, extra: Partial<TestEvent> = {}): TestEvent {
    const event: TestEvent = { target: this, key: '', button: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    this.events.get(name)?.forEach(callback => callback(event)); return event;
  }
  focus(): void { dom.activeElement = this; this.emit('focus'); }
  getBoundingClientRect() { return { top: 0, bottom: 100, left: 0, right: 240, width: 240, height: 100 }; }
  findAll(predicate: (node: TestNode) => boolean): TestNode[] { return this.children.flatMap(child => [...predicate(child) ? [child] : [], ...child.findAll(predicate)]); }
}
interface TestEvent {
  target: TestNode; key: string; button: number; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean;
  preventDefault: () => void; stopPropagation: () => void;
}
const dom = {
  body: new TestNode('body'), documentElement: new TestNode('html'), activeElement: null as TestNode | null,
  createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('#text', text),
};
const liveTrees: RepositoryTree[] = [];
function candidate(components: string[], path = `/scope/${components.join('/')}`): RepositoryCandidate { return { components, path, marker: 'git-directory' }; }
function discovery(candidates = [candidate([], '/scope'), candidate(['group', 'outer']), candidate(['group', 'outer', 'inner']), candidate(['plain'])], extra: Partial<RepositoryDiscovery> = {}): RepositoryDiscovery {
  return { root: '/scope', repositories: candidates, complete: true, limit: null, warnings: [], directories: 10, entries: 20, ...extra };
}
function setup(result: RepositoryDiscovery | null = discovery()) {
  const callbacks: RepositoryTreeCallbacks = {
    onActivate: vi.fn(), onToggle: vi.fn(), onDepthChange: vi.fn(), onRescan: vi.fn(), onCancel: vi.fn(), onCollapse: vi.fn(), onClose: vi.fn(), onCopyPath: vi.fn(),
    onAction: vi.fn(), onVisibleCandidates: vi.fn(),
  };
  const tree = new RepositoryTree(callbacks); liveTrees.push(tree); dom.body.append(tree.element as unknown as TestNode);
  const model: RepositoryTreeModel = { root: '/scope', rootName: 'scope', depth: 2, discovery: result, loading: false, activePath: null, openingPath: null, collapsedPaths: [] };
  tree.update(model);
  const element = tree.element as unknown as TestNode;
  const rows = () => element.findAll(node => node.getAttribute('role') === 'treeitem');
  const row = (key: string) => rows().find(node => node.dataset.repositoryKey === key)!;
  const action = (name: string) => element.findAll(node => node.dataset.action === name)[0];
  const status = () => element.findAll(node => node.getAttribute('role') === 'status')[0];
  return { tree, model, callbacks, element, rows, row, action, status };
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined); vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('requestAnimationFrame', undefined); vi.stubGlobal('cancelAnimationFrame', undefined);
  dom.body = new TestNode('body'); dom.documentElement = new TestNode('html'); dom.activeElement = null;
  vi.stubGlobal('Node', TestNode); vi.stubGlobal('HTMLElement', TestNode); vi.stubGlobal('Element', TestNode); vi.stubGlobal('document', dom);
  initI18n('en', ['en-US']);
});
afterEach(() => { liveTrees.splice(0).forEach(tree => tree.destroy()); setLanguage('en'); vi.unstubAllGlobals(); });

describe('repository tree navigation', () => {
  it('renders one bounded ARIA tree with a root candidate that also owns nested repositories', () => {
    const { element, rows, row, callbacks } = setup();
    expect(element.findAll(node => node.getAttribute('role') === 'tree')).toHaveLength(1);
    expect(rows()).toHaveLength(5); expect(row('').getAttribute('aria-level')).toBe('1');
    expect(row('').getAttribute('aria-expanded')).toBe('true'); expect(row('group/outer').getAttribute('aria-expanded')).toBe('true');
    expect(row('group').getAttribute('aria-label')).toBe('group, directory');
    expect(row('group/outer/inner').getAttribute('aria-expanded')).toBeNull();
    expect(rows().filter(node => node.tabIndex === 0)).toEqual([row('')]);
    row('').emit('keydown', { key: 'Enter' });
    expect(callbacks.onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/scope', components: [] }));
    row('group/outer').emit('keydown', { key: 'Enter' });
    expect(callbacks.onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/scope/group/outer' }));
    row('group').emit('keydown', { key: 'Enter' });
    expect(callbacks.onActivate).toHaveBeenCalledTimes(2); expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  it('roves keyboard focus, prevents Space scrolling, toggles without activation, and does not steal modifier shortcuts', () => {
    const { row, rows, callbacks } = setup();
    row('').focus(); row('').emit('keydown', { key: 'ArrowDown' }); expect(dom.activeElement).toBe(row('group'));
    row('group').emit('keydown', { key: 'ArrowRight' }); expect(dom.activeElement).toBe(row('group/outer'));
    const outer = row('group/outer'), event = outer.emit('keydown', { key: ' ' });
    expect(event.preventDefault).toHaveBeenCalled(); expect(event.stopPropagation).toHaveBeenCalled();
    expect(callbacks.onToggle).toHaveBeenLastCalledWith('group/outer', true); expect(callbacks.onActivate).not.toHaveBeenCalled();
    expect(rows().some(node => node.dataset.repositoryKey === 'group/outer/inner')).toBe(false);
    expect(outer.getAttribute('aria-expanded')).toBe('false'); expect(dom.activeElement).toBe(outer);
    outer.emit('keydown', { key: 'ArrowRight' }); expect(callbacks.onToggle).toHaveBeenLastCalledWith('group/outer', false);
    expect(row('group/outer')).toBe(outer);
    outer.emit('keydown', { key: 'End' }); expect(dom.activeElement).toBe(row('plain'));
    const plainSpace = row('plain').emit('keydown', { key: ' ' }); expect(plainSpace.preventDefault).toHaveBeenCalled();
    const shiftedSpace = row('plain').emit('keydown', { key: ' ', shiftKey: true }); expect(shiftedSpace.preventDefault).toHaveBeenCalled();
    row('plain').emit('keydown', { key: 'Home' }); expect(dom.activeElement).toBe(row(''));
    const modified = row('').emit('keydown', { key: 'ArrowDown', ctrlKey: true }); expect(modified.preventDefault).not.toHaveBeenCalled();
    expect(rows().filter(node => node.tabIndex === 0)).toHaveLength(1);
  });

  it('separates disclosure hit targets from repository activation and retains keyed rows on collapsing', () => {
    const { row, callbacks } = setup();
    const outer = row('group/outer'), inner = row('group/outer/inner');
    outer.emit('click', { target: outer.children[0] });
    expect(callbacks.onToggle).toHaveBeenCalledWith('group/outer', true); expect(callbacks.onActivate).not.toHaveBeenCalled();
    outer.emit('click', { target: outer.children[2] });
    expect(callbacks.onActivate).toHaveBeenCalledWith(expect.objectContaining({ path: '/scope/group/outer' }));
    outer.emit('click', { target: outer.children[0] });
    expect(row('group/outer/inner')).toBe(inner); expect(row('group/outer')).toBe(outer);
  });

  it('preserves nodes, scroll and focus for active/loading/locale-only changes, and explicitly clears active state', () => {
    const { tree, model, row, element, rows, status } = setup();
    const original = rows(), outer = row('group/outer'); outer.focus();
    const list = element.findAll(node => node.getAttribute('role') === 'tree')[0]; list.scrollTop = 123;
    tree.update({ ...model, activePath: '/scope/group/outer', openingPath: '/scope/plain', loading: true });
    expect(rows()).toEqual(original); expect(dom.activeElement).toBe(outer); expect(list.scrollTop).toBe(123);
    expect(outer.getAttribute('aria-selected')).toBe('true'); expect(outer.getAttribute('aria-current')).toBe('true');
    expect(row('plain').getAttribute('aria-busy')).toBe('true'); expect(status().textContent).toContain('Previous results');
    setLanguage('zh-CN'); tree.updateLocale();
    expect(rows()).toEqual(original); expect(dom.activeElement).toBe(outer); expect(list.scrollTop).toBe(123);
    expect(outer.getAttribute('aria-label')).toBe('outer，当前仓库'); expect(row('plain').getAttribute('aria-label')).toBe('plain，正在打开仓库');
    expect(status().textContent).toContain('上次结果'); expect(element.textContent).toContain('扫描深度');
    tree.update({ ...model, activePath: null, openingPath: null });
    expect(outer.getAttribute('aria-selected')).toBe('false'); expect(outer.getAttribute('aria-current')).toBeNull();
    expect(row('plain').getAttribute('aria-busy')).toBeNull(); expect(rows().some(node => node.classList.contains('is-active'))).toBe(false);
  });

  it('restores focus to the nearest visible ancestor on external disclosure or candidate removal without stealing external focus', () => {
    const { tree, model, row } = setup();
    const outer = row('group/outer'); row('group/outer/inner').focus();
    tree.update({ ...model, collapsedPaths: ['group/outer'] }); expect(dom.activeElement).toBe(outer);
    tree.update({ ...model, discovery: discovery([candidate(['group', 'new'])]) }); expect(dom.activeElement).toBe(row('group'));
    const outside = new TestNode('input'); dom.body.append(outside); outside.focus();
    tree.update({ ...model, collapsedPaths: [''] }); expect(dom.activeElement).toBe(outside); expect(row('').tabIndex).toBe(0);
  });

  it('reconciles new discovery data by key, including transitions between directory and repository-plus-children', () => {
    const { tree, model, row } = setup(discovery([candidate(['same', 'child'])]));
    const group = row('same'), child = row('same/child'); child.focus();
    tree.update({ ...model, discovery: discovery([candidate(['same', 'child']), candidate(['same'])]) });
    expect(row('same')).toBe(group); expect(row('same/child')).toBe(child); expect(dom.activeElement).toBe(child);
    expect(group.classList.contains('is-repository')).toBe(true); expect(group.getAttribute('aria-expanded')).toBe('true');
    tree.update({ ...model, discovery: discovery([candidate(['same'])]) });
    expect(row('same')).toBe(group); expect(dom.activeElement).toBe(group); expect(group.getAttribute('aria-expanded')).toBeNull();
    tree.update({ ...model, discovery: discovery([candidate(['same', 'child'])]) });
    expect(row('same')).toBe(group); expect(group.classList.contains('is-repository')).toBe(false); expect(group.getAttribute('aria-expanded')).toBe('true');
  });

  it('forgets relative row identities when a different native root replaces the scope', () => {
    const { tree, model, row } = setup();
    const previous = row('group/outer'); previous.focus();
    tree.update({ ...model, root: '\\\\server\\share\\scope', discovery: discovery(undefined, { root: '\\\\server\\share\\scope' }) });
    expect(row('group/outer')).not.toBe(previous); expect(dom.activeElement).toBe(row(''));
  });
});

describe('repository scope controls and honest statuses', () => {
  it('delegates path copy, depth, rescan, cancel, rail collapse and close without filesystem access', () => {
    const { tree, model, callbacks, action } = setup();
    action('copy-directory-scope-path').emit('click'); expect(callbacks.onCopyPath).toHaveBeenCalledWith('/scope');
    action('repository-scan-depth').value = '5'; action('repository-scan-depth').emit('change'); expect(callbacks.onDepthChange).toHaveBeenCalledWith(5);
    action('rescan-repositories').emit('click'); expect(callbacks.onRescan).toHaveBeenCalledTimes(1);
    action('collapse-repository-tree').emit('click'); expect(callbacks.onCollapse).toHaveBeenCalledTimes(1);
    action('close-directory-scope').emit('click'); expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    tree.update({ ...model, loading: true });
    expect(action('rescan-repositories').disabled).toBe(true); expect(action('cancel-repository-scan').hidden).toBe(false);
    action('cancel-repository-scan').emit('click'); expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it('has one live status and distinguishes loading, empty complete, partial, warnings, cancellation and failure', () => {
    const { tree, model, status, element } = setup(null);
    expect(status().textContent).toBe('Ready to scan this directory scope.');
    tree.update({ ...model, loading: true }); expect(status().textContent).toBe('Scanning directories…');
    tree.update({ ...model, discovery: discovery([]) }); expect(status().textContent).toBe('No repositories found at this depth.');
    tree.update({ ...model, discovery: discovery([candidate(['only'])]) }); expect(status().textContent).toBe('Scan complete. 1 repository found.');
    tree.update({ ...model, discovery: discovery([candidate(['only'])], { complete: false, limit: 'candidates' }) });
    expect(status().textContent).toContain('Partial scan. 1 repository'); expect(element.textContent).toContain('repository candidate limit');
    expect(element.textContent).not.toContain('Scan complete.');
    tree.update({ ...model, discovery: discovery([], { complete: false, limit: 'time' }) });
    expect(status().textContent).toContain('No repositories found yet'); expect(element.textContent).toContain('scan time limit');
    tree.update({ ...model, discovery: discovery([candidate(['only'])], { warnings: [{ code: 'permission-denied', count: 3 }, { code: 'link-skipped', count: 2 }] }) });
    expect(status().textContent).toContain('warnings'); expect(element.textContent).toContain('Permission denied for 3 entries.');
    expect(element.textContent).toContain('2 links or reparse points were not followed.');
    tree.update({ ...model, cancelled: true }); expect(status().textContent).toContain('Scan cancelled.');
    tree.update({ ...model, discovery: discovery(), cancelled: true }); expect(status().textContent).toContain('Previous results');
    tree.update({ ...model, error: 'Original native error <not markup>' });
    expect(status().textContent).toBe('Scan failed.'); expect(element.textContent).toContain('Original native error <not markup>');
    expect(element.findAll(node => node.getAttribute('role') === 'status')).toHaveLength(1);
  });

  it('never treats a one-result partial discovery as complete or auto-collapses the panel', () => {
    const result = discovery([candidate(['only'])], { complete: false, limit: 'directories' });
    const { tree, model, callbacks, status } = setup(result);
    tree.update({ ...model, activePath: '/scope/only' });
    expect(status().textContent).toContain('Partial scan.'); expect(callbacks.onCollapse).not.toHaveBeenCalled();
    expect(callbacks.onActivate).not.toHaveBeenCalled(); expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  it('opens meaningful warning/error details once, preserving manual details disclosure on locale and active changes', () => {
    const { tree, model, element } = setup(discovery([candidate(['only'])], { complete: false, limit: 'entries' }));
    const details = element.findAll(node => node.tagName === 'DETAILS')[0];
    expect(details.open).toBe(true); details.open = false;
    tree.update({ ...model, activePath: '/scope/only' }); expect(details.open).toBe(false);
    setLanguage('zh-CN'); tree.updateLocale(); expect(details.open).toBe(false);
    tree.update({ ...model, error: 'Native error' }); expect(details.open).toBe(true);
    tree.update({ ...model, discovery: discovery([candidate(['only'])]), error: null }); expect(details.open).toBe(false);
  });

  it('localizes every warning and safety limit while preserving arbitrary native names and original error details', () => {
    const result = discovery([candidate(['__proto__', '<仓库&>'])], {
      complete: false, limit: 'output', warnings: [
        { code: 'permission-denied', count: 1 }, { code: 'io', count: 2 }, { code: 'outside-root', count: 3 },
        { code: 'link-skipped', count: 4 }, { code: 'invalid-path', count: 5 }, { code: 'native-code', count: 6 },
      ],
    });
    const { tree, model, element, row, status } = setup(result);
    setLanguage('zh-CN'); tree.updateLocale();
    expect(row('__proto__/%3C%E4%BB%93%E5%BA%93%26%3E').textContent).toContain('<仓库&>');
    expect(status().textContent).toContain('扫描未完成');
    for (const text of ['结果大小上限', '无访问权限', '文件系统条目', '范围根目录之外', '重解析点', '无法安全表示', 'native-code']) expect(element.textContent).toContain(text);
    tree.update({ ...model, error: 'EACCES: Native message' }); expect(element.textContent).toContain('EACCES: Native message');
    expect(status().textContent).toContain('扫描失败');
  });

  it('reports frontend omission as partial and mounts no more than 1537 directory/repository nodes', () => {
    const candidates = Array.from({ length: 300 }, (_, index) => candidate(Array.from({ length: 6 }, (_entry, depth) => `r${index}-${depth}`)));
    const { rows, status, element } = setup(discovery(candidates));
    expect(rows()).toHaveLength(1537); expect(status().textContent).toContain('Partial scan.'); expect(element.textContent).toContain('44 additional or invalid results');
  });

  it('does not reactivate an opening candidate and destroys locale bindings cleanly', () => {
    const { tree, model, row, callbacks } = setup();
    const outer = row('group/outer');
    tree.update({ ...model, openingPath: '/scope/group/outer' }); outer.emit('keydown', { key: 'Enter' }); expect(callbacks.onActivate).not.toHaveBeenCalled();
    tree.destroy(); outer.emit('keydown', { key: 'Enter' }); tree.updateLocale(); setLanguage('zh-CN');
    expect(callbacks.onActivate).not.toHaveBeenCalled();
  });
});

function summary(path: string, patch: Partial<RepositorySummary> = {}): RepositorySummary {
  return { path, branch: 'main', head: '123456789abcdef', bare: false, trusted: true,
    changes: 0, staged: 0, unstaged: 0, untracked: 0, ahead: null, behind: null, upstream: null, ...patch };
}
function observed(value: RepositorySummary | null, patch: Partial<RepositorySummaryState> = {}): RepositorySummaryState {
  return { summary: value, loading: false, error: null, stale: false, ...patch };
}
function childClass(row: TestNode, name: string): TestNode {
  return row.findAll(node => node.classList.contains(name))[0];
}

describe('repository row summaries and targeted actions', () => {
  it('always mounts branch plus exactly four actions, forwards the live candidate and anchor, and isolates keys/clicks', () => {
    const { row, callbacks } = setup();
    const outer = row('group/outer');
    const controls = outer.findAll(node => node.tagName === 'BUTTON');
    expect(controls.map(control => control.dataset.action)).toEqual(['repository-branch', 'repository-sync', 'repository-commit', 'repository-refresh', 'repository-more']);
    expect(childClass(outer, 'repository-tree-branch-label').textContent).toBe('—');
    expect(childClass(outer, 'repository-tree-row-status').dataset.status).toBe('unknown');
    for (const control of controls) {
      expect(control.tabIndex).toBe(-1);
      expect(control.hidden).toBe(false); expect(control.disabled).toBe(false);
      const click = control.emit('click'); expect(click.stopPropagation).toHaveBeenCalled();
      expect(callbacks.onAction).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/scope/group/outer' }), control, control.dataset.action.replace('repository-', ''));
      const key = control.emit('keydown', { key: 'Enter' });
      expect(key.stopPropagation).toHaveBeenCalled(); expect(key.preventDefault).not.toHaveBeenCalled();
      outer.emit('click', { target: control }); outer.emit('keydown', { key: 'Enter', target: control });
      outer.emit('keydown', { key: ' ', target: control }); outer.emit('keydown', { key: 'ArrowDown', target: control });
    }
    expect(callbacks.onActivate).not.toHaveBeenCalled(); expect(callbacks.onToggle).not.toHaveBeenCalled();
    outer.focus(); expect(controls.every(control => control.tabIndex === 0)).toBe(true);
    row('plain').focus(); expect(controls.every(control => control.tabIndex === -1)).toBe(true);
    expect(row('group').findAll(node => node.tagName === 'BUTTON').every(control => control.disabled && control.tabIndex === -1)).toBe(true);
  });

  it('diffs mutable summary maps without replacing rows/buttons or changing action focus and scroll', () => {
    const { tree, model, row, element } = setup();
    const outer = row('group/outer'), branch = childClass(outer, 'repository-tree-branch');
    const list = element.findAll(node => node.getAttribute('role') === 'tree')[0]; list.scrollTop = 124;
    branch.focus();
    const summaries = new Map<string, RepositorySummaryState>();
    summaries.set('/scope/group/outer', observed(summary('/scope/group/outer', { branch: 'feature/long-branch', changes: 2, staged: 1, unstaged: 2, untracked: 0 })));
    tree.update({ ...model, summaries });
    expect(row('group/outer')).toBe(outer); expect(childClass(outer, 'repository-tree-branch')).toBe(branch);
    expect(dom.activeElement).toBe(branch); expect(list.scrollTop).toBe(124);
    expect(childClass(outer, 'repository-tree-branch-label').textContent).toBe('feature/long-branch');
    const status = childClass(outer, 'repository-tree-row-status');
    expect(status.dataset.status).toBe('changed'); expect(status.title).toContain('2 changed paths');
    summaries.set('/scope/group/outer', observed(summary('/scope/group/outer', { changes: 0 }), { loading: true, stale: true }));
    tree.update({ ...model, summaries }); expect(status.dataset.status).toBe('loading'); expect(status.title).toContain('Previous observation');
    summaries.set('/scope/group/outer', observed(summary('/scope/group/outer'), { error: 'Native <error>', stale: true }));
    tree.update({ ...model, summaries }); expect(status.dataset.status).toBe('error'); expect(status.title).toContain('Native <error>'); expect(status.title).toContain('Previous observation');
    expect(dom.activeElement).toBe(branch); expect(list.scrollTop).toBe(124);
    tree.update({ ...model, discovery: discovery(), summaries });
    expect(dom.activeElement).toBe(branch); expect(childClass(row('group/outer'), 'repository-tree-branch')).toBe(branch);
    setLanguage('zh-CN'); tree.updateLocale(); expect(status.title).toContain('上次观测'); expect(branch.getAttribute('aria-label')).toContain('切换');
    expect(dom.activeElement).toBe(branch);
  });

  it('distinguishes detached, unborn, bare, untrusted, unknown and stale instead of displaying false clean status', () => {
    const { tree, model, row } = setup();
    const outer = row('group/outer'), status = childClass(outer, 'repository-tree-row-status');
    const set = (value: RepositorySummary | null, patch: Partial<RepositorySummaryState> = {}) => tree.update({ ...model, summaries: new Map([['/scope/group/outer', observed(value, patch)]]) });
    set(summary('/scope/group/outer', { branch: null, head: 'abcdef012345' }));
    expect(childClass(outer, 'repository-tree-branch-label').textContent).toBe('Detached abcdef0');
    expect(childClass(outer, 'repository-tree-branch').getAttribute('aria-label')).toContain('Detached abcdef0');
    set(summary('/scope/group/outer', { branch: 'new', head: null })); expect(status.title).toContain('Unborn branch: new');
    set(summary('/scope/group/outer', { bare: true, changes: null })); expect(status.dataset.status).toBe('bare'); expect(status.title).toContain('no working tree');
    set(summary('/scope/group/outer', { trusted: false, changes: null })); expect(status.dataset.status).toBe('untrusted'); expect(status.title).not.toContain('No working tree changes');
    set(summary('/scope/group/outer', { changes: null })); expect(status.dataset.status).toBe('unknown'); expect(status.title).toContain('changes are unknown');
    set(summary('/scope/group/outer'), { stale: true }); expect(status.dataset.status).toBe('stale');
    set(null, { loading: true }); expect(status.dataset.status).toBe('loading'); expect(status.title).not.toContain('No working tree changes');
    set(null, { error: 'no access' }); expect(status.dataset.status).toBe('error'); expect(status.title).toContain('no access');
    set(summary('/different/path')); expect(status.dataset.status).toBe('unknown');
  });

  it('rejects detached stale-row actions and refreshes keyed callback candidate identity after a rescan', () => {
    const { tree, model, row, callbacks } = setup(discovery([candidate(['same'], '/first')]));
    const previous = row('same'), control = childClass(previous, 'repository-tree-branch');
    tree.update({ ...model, discovery: discovery([candidate(['same'], '/replacement')]) });
    expect(row('same')).toBe(previous); control.emit('click');
    expect(callbacks.onAction).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/replacement' }), control, 'branch');
    tree.update({ ...model, root: '/another-scope', discovery: discovery([candidate(['same'], '/new')], { root: '/another-scope' }) });
    control.emit('click'); expect(callbacks.onAction).toHaveBeenCalledTimes(1);
  });
});

describe('local mounting and bounded viewport reporting', () => {
  it('moves the same local list beneath only the active repository and never gives its inputs treeitem keyboard behavior', () => {
    const { tree, model, row, element } = setup();
    const local = new TestNode('section'), input = Object.assign(new TestNode('textarea'), {
      selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward', setSelectionRange: vi.fn(),
    });
    local.append(input); dom.body.append(local); input.focus();
    // Real native DOM moves may blur the focused descendant; emulate that explicitly.
    const remove = local.remove.bind(local);
    local.remove = () => { if (local.contains(dom.activeElement)) dom.activeElement = null; remove(); };
    tree.update({ ...model, activePath: '/scope/group/outer' });
    tree.mountLocal(local as unknown as HTMLElement, '/scope/group/outer');
    expect(dom.activeElement).toBe(input); expect(input.setSelectionRange).toHaveBeenLastCalledWith(2, 5, 'backward');
    const region = element.findAll(node => node.classList.contains('repository-tree-local'))[0];
    expect(row('group/outer').nextElementSibling).toBe(region); expect(region.children).toEqual([local]);
    expect(row('group/outer').contains(local)).toBe(false); expect(region.getAttribute('role')).toBe('region');
    input.focus(); tree.update({ ...model, activePath: '/scope/group/outer', summaries: new Map() });
    expect(dom.activeElement).toBe(input); expect(region.children).toEqual([local]);
    tree.update({ ...model, activePath: '/scope/plain' });
    expect(region.parentElement).toBeNull(); tree.mountLocal(local as unknown as HTMLElement, '/scope/plain');
    expect(row('plain').nextElementSibling).toBe(region); expect(region.children).toEqual([local]);
    tree.update({ ...model, activePath: '/scope/plain', collapsedPaths: [''] }); expect(region.parentElement).toBeNull();
    tree.update({ ...model, activePath: '/scope/plain' }); expect(row('plain').nextElementSibling).toBe(region);
    const workspace = new TestNode('section'); dom.body.append(workspace);
    workspace.append(local); input.value = 'draft that must survive'; input.focus();
    tree.mountLocal(null, null);
    expect(local.parentElement).toBe(workspace); expect(dom.activeElement).toBe(input); expect(input.value).toBe('draft that must survive');
    tree.mountLocal(local as unknown as HTMLElement, '/scope/plain');
    expect(row('plain').nextElementSibling).toBe(region); expect(dom.activeElement).toBe(input); expect(input.value).toBe('draft that must survive');
    workspace.append(local); input.focus(); tree.mountLocal(null, null);
    expect(local.parentElement).toBe(workspace); expect(dom.activeElement).toBe(input); expect(region.parentElement).toBeNull();
    tree.destroy(); expect(local.parentElement).toBe(workspace);
  });

  it('coalesces scroll/update callbacks with RAF and reports only actual viewport candidates', () => {
    const frames = new Map<number, FrameRequestCallback>(); let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    const cancel = vi.fn((frame: number) => frames.delete(frame)); vi.stubGlobal('cancelAnimationFrame', cancel);
    const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(1)); };
    const { tree, model, row, element, callbacks } = setup();
    const viewport = element.findAll(node => node.getAttribute('role') === 'tree')[0];
    const bounds = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 240, width: 240, height: bottom - top });
    viewport.getBoundingClientRect = () => bounds(0, 64);
    row('').getBoundingClientRect = () => bounds(-32, 0);
    row('group/outer').getBoundingClientRect = () => bounds(0, 32);
    row('group/outer/inner').getBoundingClientRect = () => bounds(32, 64);
    row('plain').getBoundingClientRect = () => bounds(64, 96);
    expect(frames.size).toBe(1); flush();
    expect(callbacks.onVisibleCandidates).toHaveBeenLastCalledWith([
      expect.objectContaining({ path: '/scope/group/outer' }), expect.objectContaining({ path: '/scope/group/outer/inner' }),
    ]);
    tree.update({ ...model, summaries: new Map() }); viewport.emit('scroll'); viewport.emit('scroll');
    expect(frames.size).toBe(1); flush(); expect(callbacks.onVisibleCandidates).toHaveBeenCalledTimes(1);
    row('group/outer').getBoundingClientRect = () => bounds(-32, 0);
    row('group/outer/inner').getBoundingClientRect = () => bounds(-32, 0);
    row('plain').getBoundingClientRect = () => bounds(0, 32);
    viewport.emit('scroll'); flush(); expect(callbacks.onVisibleCandidates).toHaveBeenLastCalledWith([expect.objectContaining({ path: '/scope/plain' })]);
    viewport.emit('scroll'); tree.destroy(); expect(cancel).toHaveBeenCalled(); flush(); expect(callbacks.onVisibleCandidates).toHaveBeenCalledTimes(2);
  });

  it('uses a bounded safe fallback without browser observers, skips collapsed candidates, and does not probe a zero-size viewport', () => {
    const result = discovery(Array.from({ length: 100 }, (_, index) => candidate([`r${String(index).padStart(3, '0')}`])));
    const { tree, model, row, element, callbacks } = setup(result);
    expect(callbacks.onVisibleCandidates).toHaveBeenLastCalledWith(expect.any(Array));
    expect(vi.mocked(callbacks.onVisibleCandidates!).mock.calls.at(-1)![0]).toHaveLength(64);
    tree.update({ ...model, collapsedPaths: [''] }); expect(callbacks.onVisibleCandidates).toHaveBeenLastCalledWith([]);
    tree.update(model); expect(row('r000')).toBeDefined();
    const viewport = element.findAll(node => node.getAttribute('role') === 'tree')[0];
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    viewport.emit('scroll'); expect(callbacks.onVisibleCandidates).toHaveBeenLastCalledWith([]);
  });
});
