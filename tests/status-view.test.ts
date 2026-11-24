import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../src/ui/statusbar';
import { setLanguage, localized } from '../src/lib/i18n';
import type { StatusInput } from '../src/lib/status';
import type { ChangedFile, Repository, WorkingState } from '../src/shared/protocol';

interface TestEvent { target: TestNode; key: string; preventDefault: () => void; stopPropagation: () => void }
/** Just enough native DOM to exercise ownership, stable nodes, callbacks, and modal keyboard access. */
class TestNode {
  parentElement: TestNode | null = null;
  children: TestNode[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  events = new Map<string, ((event: TestEvent) => void)[]>();
  className = '';
  id = '';
  hidden = false;
  disabled = false;
  title = '';
  type = '';
  open = false;
  tabIndex = 0;
  writes = 0;
  private text = '';
  readonly tagName: string;
  readonly nodeName: string;
  readonly nodeType: number;
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { names.forEach(name => this.classList.toggle(name, true)); },
    remove: (...names: string[]) => { names.forEach(name => this.classList.toggle(name, false)); },
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean)), enabled = force ?? !names.has(name);
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' '); return enabled;
    },
  };
  constructor(tagName: string, text = '') { this.tagName = tagName === '#text' ? '#text' : tagName.toUpperCase(); this.nodeName = this.tagName; this.nodeType = tagName === '#text' ? 3 : 1; this.text = text; }
  get parentNode(): TestNode | null { return this.parentElement; }
  get firstElementChild(): TestNode | null { return this.children.find(child => child.nodeType === 1) ?? null; }
  get isConnected(): boolean { return this === documentStub.body || Boolean(this.parentElement?.isConnected); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.writes++; this.replaceChildren(); this.text = value; }
  append(...children: (TestNode | string)[]): void { children.forEach(child => this.appendChild(typeof child === 'string' ? new TestNode('#text', child) : child)); }
  appendChild(child: TestNode): TestNode { return this.insertBefore(child, null); }
  insertBefore(child: TestNode, before: TestNode | null): TestNode {
    child.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentElement = this; return child;
  }
  replaceChildren(...children: TestNode[]): void { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = ''; this.append(...children); }
  remove(): void { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  contains(node: TestNode): boolean { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); if (name === 'title') this.title = value; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, [...(this.events.get(name) ?? []), listener]); }
  removeEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, (this.events.get(name) ?? []).filter(value => value !== listener)); }
  emit(name: string, extra: Partial<TestEvent> = {}): void { const event = { target: this, key: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra }; this.events.get(name)?.forEach(listener => listener(event)); }
  click(): void { this.emit('click'); }
  matches(selector: string): boolean { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : selector.toUpperCase() === this.tagName; }
  querySelectorAll(selector: string): TestNode[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string): TestNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { documentStub.activeElement = this; }
  showModal(): void { this.open = true; this.querySelector('button')?.focus(); }
  close(): void { this.open = false; this.emit('close'); }
}
const documentStub = {
  body: new TestNode('body'), documentElement: new TestNode('html'), activeElement: null as TestNode | null,
  createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('#text', text),
};
const repository: Repository = { id: 'repo', name: 'raw project', path: 'D:/very long/原始仓库/path', gitDir: '.git', commonDir: '.git', branch: 'main/raw-branch', head: 'a'.repeat(40), bare: false, trusted: false };
const working = (extra: Partial<WorkingState> = {}): WorkingState => ({ files: [], branch: repository.branch, head: repository.head, ahead: 0, behind: 0, upstream: null, trackingKnown: false, operation: null, conflicts: 0, ...extra });
const input = (extra: Partial<StatusInput> = {}): StatusInput => ({ repository, working: working(), history: { loaded: 300, visible: 26, hasMore: true, loading: false, ready: true }, ...extra });
const bars: StatusBar[] = [];
function mount(callbacks: ConstructorParameters<typeof StatusBar>[0] = {}) {
  const bar = new StatusBar(callbacks), root = bar.element as unknown as TestNode; documentStub.body.append(root); bars.push(bar); return { bar, root };
}
function find(root: TestNode, selector: string): TestNode { const node = root.querySelector(selector); if (!node) throw new Error(`Missing ${selector}`); return node; }
function writes(root: TestNode): number { return root.writes + root.children.reduce((total, child) => total + writes(child), 0); }
function fact(name: string): TestNode {
  const dialog = documentStub.body.querySelector('dialog');
  const row = dialog?.querySelectorAll('.statusbar-fact').find(node => node.dataset.fact === name);
  if (!row) throw new Error(`Missing fact ${name}`);
  return row;
}
beforeEach(() => {
  documentStub.body = new TestNode('body'); documentStub.documentElement = new TestNode('html'); documentStub.activeElement = null;
  vi.stubGlobal('document', documentStub); vi.stubGlobal('Node', TestNode); setLanguage('en');
});
afterEach(() => { bars.splice(0).forEach(bar => bar.destroy()); setLanguage('en'); vi.unstubAllGlobals(); });

describe('compact statusbar view', () => {
  it('reuses only raw snapshot counts while freshness, tracking, history and activity keep updating', () => {
    const { bar, root } = mount();
    const pathRead = vi.fn(() => 'changed.txt');
    const changed: ChangedFile = { get path() { return pathRead(); }, status: '.M', staged: false, unstaged: true, oldPath: null, additions: null, deletions: null };
    const files = [changed];
    const state = input({ working: working({ files }) });
    bar.update(state); const reads = pathRead.mock.calls.length; expect(reads).toBeGreaterThan(0);
    for (let visible = 0; visible < 5; visible++) bar.update({ ...state, history: { ...state.history, visible } });
    setLanguage('zh-CN'); setLanguage('en');
    expect(pathRead).toHaveBeenCalledTimes(reads);
    bar.update({ ...state, working: working({ files, upstream: 'origin/main', trackingKnown: true, ahead: 3, operation: 'merge' }), workingStale: true, lastSuccessfulRefresh: 1_700_000_000_000,
      history: { ...state.history, visible: 2 }, task: { id: 'new-task', label: 'Live task', kind: 'write', cancelScope: 'write' } });
    expect(pathRead).toHaveBeenCalledTimes(reads);
    expect(root.dataset).toMatchObject({ stale: 'true', taskState: 'running', cancelScope: 'write', hasOperation: 'true' });
    expect(find(root, '.statusbar-sync').textContent).toContain('↑3 ↓0'); expect(find(root, '.statusbar-history').textContent).toContain('2 visible');
    expect(find(root, '.statusbar-operation').textContent).toContain('Merge in progress'); expect(find(root, '.task-text').textContent).toBe('Live task');
  });

  it('recounts new same-length arrays and resets its single-entry cache across repositories or missing snapshots', () => {
    const { bar, root } = mount();
    const firstRead = vi.fn(() => 'first'), nextRead = vi.fn(() => 'next');
    const first: ChangedFile = { get path() { return firstRead(); }, status: '.M', staged: false, unstaged: true, oldPath: null, additions: null, deletions: null };
    const next: ChangedFile = { get path() { return nextRead(); }, status: 'AA', staged: true, unstaged: true, oldPath: null, additions: null, deletions: null };
    const firstFiles = [first], nextFiles = [next];
    bar.update(input({ working: working({ files: firstFiles }) })); const firstReads = firstRead.mock.calls.length;
    expect(root.dataset.workingState).toBe('changed');
    bar.update(input({ working: working({ files: nextFiles }) })); const nextReads = nextRead.mock.calls.length;
    expect(nextReads).toBeGreaterThan(0); expect(root.dataset.workingState).toBe('conflict');
    bar.update(input({ working: working({ files: nextFiles }) })); expect(nextRead).toHaveBeenCalledTimes(nextReads);
    bar.update(input({ repository: { ...repository, id: 'other' }, working: working({ files: nextFiles }) })); expect(nextRead).toHaveBeenCalledTimes(nextReads * 2);
    bar.update(input({ working: working({ files: nextFiles }) })); expect(nextRead).toHaveBeenCalledTimes(nextReads * 3);
    bar.update(input({ working: null })); expect(root.dataset.workingState).toBe('unknown');
    bar.update(input({ working: working({ files: nextFiles }) })); expect(nextRead).toHaveBeenCalledTimes(nextReads * 4);
    bar.update(input({ repository: null, working: working({ files: firstFiles }) })); expect(firstRead).toHaveBeenCalledTimes(firstReads);
    bar.update(input({ working: working({ files: firstFiles }) })); expect(firstRead).toHaveBeenCalledTimes(firstReads * 2);
    bar.update(input({ repository: { ...repository, bare: true }, working: working({ files: firstFiles }) })); expect(root.dataset.workingState).toBe('bare'); expect(firstRead).toHaveBeenCalledTimes(firstReads * 2);
    bar.update(input({ working: working({ files: firstFiles }) })); expect(firstRead).toHaveBeenCalledTimes(firstReads * 3);
  });

  it('owns one footer with stable context/working/activity groups and a separate, narrow live region', () => {
    const { bar, root } = mount(); bar.update(input());
    expect(root.tagName).toBe('FOOTER'); expect(root.getAttribute('aria-label')).toBe('Repository status');
    const groups = root.querySelectorAll('.statusbar-group'); expect(groups).toHaveLength(3);
    expect(groups.every(group => group.getAttribute('role') === 'group' && !group.getAttribute('aria-live'))).toBe(true);
    expect(root.getAttribute('aria-live')).toBeNull(); expect(root.getAttribute('role')).toBeNull();
    expect(find(root, '.statusbar-live').getAttribute('aria-live')).toBe('polite');
    const detailButton = find(root, '.statusbar-details'), task = find(root, '.task-text'), summary = find(root, '.status-text');
    detailButton.focus(); bar.update(input({ workingLoading: true }));
    expect(root.querySelectorAll('.statusbar-group')).toEqual(groups); expect(find(root, '.statusbar-details')).toBe(detailButton);
    expect(find(root, '.task-text')).toBe(task); expect(find(root, '.status-text')).toBe(summary); expect(documentStub.activeElement).toBe(detailButton);
    expect(root.dataset).toMatchObject({ workingState: 'clean', stale: 'true', taskState: 'running', cancelScope: 'none' });
  });

  it('keeps unknown/bare/stale observations explicit and never invents upstream 0/0', () => {
    const { bar, root } = mount(); bar.update(input({ working: null }));
    expect(find(root, '.statusbar-summary').textContent).toContain('unknown'); expect(find(root, '.statusbar-sync').textContent).not.toContain('↑0');
    bar.update(input({ repository: { ...repository, bare: true } })); expect(find(root, '.statusbar-summary').textContent).toBe('Bare · no worktree');
    bar.update(input({ working: working({ upstream: 'origin/main', trackingKnown: false }), workingError: 'permission denied' }));
    expect(find(root, '.statusbar-summary').textContent).toBe('Previously clean'); expect(find(root, '.statusbar-sync').textContent).toContain('ahead/behind unknown');
    bar.update(input({ working: working({ upstream: 'origin/main', trackingKnown: true }) })); expect(find(root, '.statusbar-sync').textContent).toBe('↑0 ↓0');
    expect(find(root, '.statusbar-sync').title).toContain('No network check');
  });

  it('deduplicates live task/result announcements across rerenders, filters and language changes', () => {
    const { bar, root } = mount(), announcer = find(root, '.statusbar-live');
    const task = { id: 'write-1', kind: 'write' as const, label: localized(locale => locale === 'en' ? 'Fetching…' : '正在获取…'), cancelScope: 'write' as const };
    bar.update(input({ task })); const firstWrites = writes(announcer); expect(announcer.textContent).toBe('Fetching…');
    for (let count = 0; count < 10; count++) bar.update(input({ task, history: { loaded: 300, visible: count, hasMore: true, ready: true, loading: false } }));
    expect(writes(announcer)).toBe(firstWrites);
    setLanguage('zh-CN'); expect(find(root, '.task-text').textContent).toBe('正在获取…'); expect(writes(announcer)).toBe(firstWrites);
    const result = { id: 'result-1', kind: 'success' as const, message: 'raw fetch output', repoId: repository.id };
    bar.update(input({ result })); expect(announcer.textContent).toBe('已完成：raw fetch output');
    const resultWrites = writes(announcer); bar.update(input({ result })); setLanguage('en'); expect(writes(announcer)).toBe(resultWrites);
    expect(find(root, '.task-text').textContent).toBe('Completed: raw fetch output');
    bar.update(input()); bar.update(input({ result })); expect(writes(announcer)).toBe(resultWrites);
  });

  it('only invokes the current accurate history/write cancellation callback and never cancels external sessions', () => {
    const cancelHistory = vi.fn(), cancelWrite = vi.fn(), { bar, root } = mount({ cancelHistory, cancelWrite });
    const control = find(root, '.statusbar-cancel');
    bar.update(input({ history: { loaded: 2, visible: 2, hasMore: true, loading: true, ready: true } }));
    expect(control.hidden).toBe(false); expect(control.getAttribute('aria-label')).toBe('Cancel history loading'); control.click();
    expect(cancelHistory).toHaveBeenCalledTimes(1); expect(cancelWrite).not.toHaveBeenCalled();
    bar.update(input({ task: { id: 'write', kind: 'write', label: 'Push raw branch', cancelScope: 'write' } }));
    expect(control.getAttribute('aria-label')).toBe('Cancel Git process…'); control.click(); expect(cancelWrite).toHaveBeenCalledTimes(1);
    control.focus(); bar.update(input({ sessions: [{ id: 'external', repoId: repository.id, kind: 'rebase', status: 'running', operation: 'rebase', message: '', exitCode: null }] }));
    expect(control.hidden).toBe(true); expect(root.dataset.cancelScope).toBe('none'); expect(documentStub.activeElement).toBe(find(root, '.statusbar-details'));
    control.click(); expect(cancelWrite).toHaveBeenCalledTimes(1); expect(cancelHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps details keyboard-accessible, shows the full path, and delegates copy, language and trust', () => {
    const copyPath = vi.fn(), changeLanguage = vi.fn(), trust = vi.fn(), openWorking = vi.fn();
    const { bar, root } = mount({ copyPath, changeLanguage, trust, openWorking }); bar.update(input());
    const details = find(root, '.statusbar-details'); expect(details.tagName).toBe('BUTTON'); expect(details.getAttribute('aria-haspopup')).toBe('dialog');
    details.focus(); details.click(); const dialog = find(documentStub.body, 'dialog');
    expect(dialog.open).toBe(true); expect(fact('path').textContent).toContain(repository.path);
    expect(fact('history').textContent).toContain('not the repository total'); expect(fact('counts').textContent).toContain('not additive');
    const copyControl = dialog.querySelectorAll('button').find(node => node.dataset.action === 'status-copy-path')!; copyControl.click(); expect(copyPath).toHaveBeenCalledWith(repository.path);
    dialog.emit('cancel'); expect(dialog.open).toBe(false); expect(documentStub.activeElement).toBe(details);
    find(root, '.statusbar-language').click(); expect(changeLanguage).toHaveBeenCalledTimes(1);
    find(root, '.statusbar-trust').click(); expect(trust).toHaveBeenCalledTimes(1);
    find(root, '.statusbar-summary').click(); expect(openWorking).toHaveBeenCalledTimes(1);
  });

  it('updates open details in place on language switch while preserving raw path, branch, errors and focus', () => {
    const { bar, root } = mount({ copyPath: vi.fn(), changeLanguage: vi.fn() });
    bar.update(input({ workingError: 'fatal: raw Git error', lastSuccessfulRefresh: 1_700_000_000_000 }));
    find(root, '.statusbar-details').click(); const dialog = find(documentStub.body, 'dialog'), path = fact('path'), branch = fact('branch');
    const copyControl = dialog.querySelectorAll('button').find(node => node.dataset.action === 'status-copy-path')!; copyControl.focus();
    setLanguage('zh-CN'); expect(find(documentStub.body, 'dialog')).toBe(dialog); expect(fact('path')).toBe(path); expect(fact('branch')).toBe(branch);
    expect(path.textContent).toContain(repository.path); expect(branch.textContent).toContain(repository.branch);
    expect(fact('workingError').textContent).toContain('fatal: raw Git error'); expect(dialog.textContent).toContain('仓库状态详情');
    expect(documentStub.activeElement).toBe(copyControl); expect(root.getAttribute('aria-label')).toBe('仓库状态');
    bar.destroy(); expect(documentStub.body.querySelector('dialog')).toBeNull();
  });

  it('hides absent callbacks and suppresses non-active repository facts', () => {
    const { bar, root } = mount();
    bar.update(input({ repository: null, sessions: [{ id: 'old', repoId: repository.id, kind: 'rebase', status: 'paused', operation: 'rebase', message: 'old secret', exitCode: null }], result: { id: 'old', repoId: repository.id, kind: 'error', message: 'old result' } }));
    expect(find(root, '.statusbar-summary').hidden).toBe(true); expect(find(root, '.statusbar-language').hidden).toBe(true); expect(find(root, '.statusbar-cancel').hidden).toBe(true);
    find(root, '.statusbar-details').click();
    expect(fact('path').hidden).toBe(true); expect(fact('result').hidden).toBe(true); expect(fact('sessions').hidden).toBe(true);
    expect(find(documentStub.body, 'dialog').textContent).not.toContain('old secret');
  });
});
