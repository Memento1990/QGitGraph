import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffDocument, DiffRowLayout, MAX_DIFF_LINES, minimalDiffScrollTop, parsePatch, PatchModelCache, projectDiff, type DiffChangeRange, type DiffViewLine } from '../src/lib/diff';
import { initI18n, setLanguage } from '../src/lib/i18n';
import { DEFAULT_SETTINGS, type AppSettings, type DiffResult } from '../src/shared/protocol';
import { DiffView, type DiffContentAccess, type DiffNavigation, type LoadedContent } from '../src/ui/diff-view';

const multiple = '@@ -1,9 +1,10 @@\n lead\n-old-one\n+new-one\n middle\n-old-two\n+new-two\n+extra\n after\n-old-three\n+new-three\n tail\n';
const result = (patch = multiple, extra: Partial<DiffResult> = {}): DiffResult => ({ patch, binary: false, truncated: false, oldContent: null, newContent: null, ...extra });
const settings = (): AppSettings => structuredClone(DEFAULT_SETTINGS);
const fullOld = 'lead\nold-one\nmiddle\nold-two\nafter\nold-three\ntail\n';
const fullNew = 'lead\nnew-one\nmiddle\nnew-two\nextra\nafter\nnew-three\ntail\n';
const loaded = (content: string | null, extra: Partial<LoadedContent> = {}): LoadedContent => ({ content, binary: false, truncated: false, ...extra });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { for (let index = 0; index < 30; index++) await Promise.resolve(); }

/** Small deterministic DOM: instrument scroll setters, not just resulting scroll positions. */
class TestNode {
  children: TestNode[] = []; parent: TestNode | null = null; className = ''; dataset: Record<string, string | undefined> = {}; attributes = new Map<string, string>();
  style: Record<string, unknown> = { setProperty: (name: string, value: string) => { this.style[name] = value; } };
  id = ''; title = ''; value = ''; type = ''; disabled = false; tabIndex = -1; clientHeight = 240; clientWidth = 1000; isContentEditable = false;
  topWrites: number[] = []; leftWrites: number[] = []; private top = 0; private left = 0; private text = '';
  listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly tag = 'div') {}
  get parentNode() { return this.parent; }
  get nodeName() { return this.tag; }
  get scrollTop() { return this.top; } set scrollTop(value: number) { this.top = value; this.topWrites.push(value); }
  get scrollLeft() { return this.left; } set scrollLeft(value: number) { this.left = value; this.leftWrites.push(value); }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    toggle: (name: string, force?: boolean) => { const add = force ?? !this.classList.contains(name); if (add) this.classList.add(name); else this.classList.remove(name); return add; },
  };
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text: string) { this.text = text; this.children = []; }
  appendChild(child: TestNode) { this.append(child); return child; }
  append(...children: TestNode[]) {
    for (const child of children) {
      if (child.tag === '#fragment') { this.append(...[...child.children]); child.children = []; }
      else { child.remove(); child.parent = this; this.children.push(child); }
    }
  }
  replaceChildren(...children: TestNode[]) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  removeEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== listener)); }
  fire(name: string, extra: Record<string, unknown> = {}) {
    const event = { target: this, key: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[contenteditable]') || selector === '[role="textbox"]') return this.isContentEditable || this.getAttribute('role') === 'textbox';
    return this.tag === selector;
  }
  closest(selector: string): TestNode | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll<T = TestNode>(selector: string): T[] {
    const found: TestNode[] = []; const visit = (node: TestNode) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } }; visit(this); return found as T[];
  }
  querySelector<T = TestNode>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  contains(node: TestNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
}
interface Internals { lines: DiffViewLine[]; changes: DiffChangeRange[]; lineHeight: number; layout: DiffRowLayout | null; models: PatchModelCache; sides: Record<'old' | 'new', { data?: LoadedContent }>; render: () => void; measureRows: (entries: readonly ResizeObserverEntry[]) => void }
const internals = (view: DiffView) => view as unknown as Internals;
const node = (element: HTMLElement) => element as unknown as TestNode;
function query(root: TestNode, selector: string): TestNode { const found = root.querySelector(selector); if (!found) throw new Error(`Missing ${selector}`); return found; }
function action(view: DiffView, name: string): TestNode { const found = node(view.toolbar).querySelectorAll('button').find(button => button.dataset.action === name); if (!found) throw new Error(`Missing ${name}`); return found; }
function mode(view: DiffView, value: string) { const control = query(node(view.toolbar), 'select'); control.value = value; control.fire('change'); }
let frames: Map<number, FrameRequestCallback>, nextFrame: number, live: DiffView[], observers: (() => void)[];
function flushFrames() { const queued = [...frames.values()]; frames.clear(); for (const callback of queued) callback(0); }
function makeView(data = result(), access?: DiffContentAccess, navigation: DiffNavigation | null = {}) {
  const copy = vi.fn(), changeView = vi.fn(), view = new DiffView(changeView, copy); live.push(view);
  const root = new TestNode('section'); root.append(node(view.element)); view.setNavigation(navigation); view.set(data, settings(), true, access);
  return { view, root, viewport: query(node(view.element), '.diff-scroll'), copy, changeView };
}
beforeEach(() => {
  frames = new Map(); nextFrame = 0; live = []; observers = [];
  vi.stubGlobal('Node', TestNode);
  vi.stubGlobal('document', {
    createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
    createTextNode: (text: string) => { const node = new TestNode('#text'); node.textContent = text; return node; }, createDocumentFragment: () => new TestNode('#fragment'),
  });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  initI18n('en');
});
afterEach(() => { for (const view of live) view.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('patch-first semantic change blocks and gaps', () => {
  it('counts three continuous changes inside one hunk, not one change per hunk', () => {
    const cache = new PatchModelCache(), unified = cache.prepare(result(), false), document = unified.document!;
    expect(unified.hunkCount).toBe(1); expect(document.changes).toHaveLength(3);
    expect(document.changes.map(change => [change.oldStart, change.oldCount, change.newStart, change.newCount])).toEqual([[2, 1, 2, 1], [4, 1, 4, 2], [6, 1, 7, 1]]);
    expect(document.sections.map(section => section.kind)).toEqual(['gap', 'change', 'gap', 'change', 'gap', 'change', 'gap']);
    expect(projectDiff(document, false).changes).toHaveLength(3);
  });
  it('preserves IDs across unified/split projection and different context/hunk boundaries', () => {
    const source = result(), cache = new PatchModelCache(), a = cache.prepare(source, false), b = cache.prepare(source, true);
    expect(a.document).toBe(b.document); expect(cache.parsePasses).toBe(1);
    const unified = projectDiff(a.document!, false), split = projectDiff(b.document!, true);
    expect(unified.changes?.map(change => change.id)).toEqual(split.changes?.map(change => change.id));
    expect(unified.changes?.map(change => change.last - change.first)).toEqual([3, 4, 3]);
    expect(split.changes?.map(change => change.last - change.first)).toEqual([2, 3, 2]);
    const noContext = diffDocument(parsePatch('@@ -2 +2 @@\n-old-one\n+new-one\n@@ -4 +4,2 @@\n-old-two\n+new-two\n+extra\n@@ -6 +7 @@\n-old-three\n+new-three\n'));
    expect(noContext.changes.map(change => change.id)).toEqual(a.document!.changes.map(change => change.id));
    expect(new Set(noContext.sections.map(section => section.id)).size).toBe(noContext.sections.length);
  });
  it('merges changes across artificial adjacent hunk boundaries but not omitted context', () => {
    const adjacent = diffDocument(parsePatch('@@ -1 +1 @@\n-a\n+b\n@@ -2 +2 @@\n-c\n+d\n'));
    expect(adjacent.changes).toHaveLength(1); expect(adjacent.changes[0].oldCount).toBe(2);
    const separated = diffDocument(parsePatch('@@ -1 +1 @@\n-a\n+b\n@@ -4 +4 @@\n-c\n+d\n'));
    expect(separated.changes).toHaveLength(2);
    expect(separated.sections.find(section => section.kind === 'gap' && section.oldStart === 2)).toMatchObject({ oldEnd: 4, newEnd: 4 });
  });
  it('uses independent cursors for root additions, empty ranges, deletions and no-newline markers', () => {
    const addition = diffDocument(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n'));
    expect(addition.changes[0]).toMatchObject({ oldStart: 1, newStart: 1, oldCount: 0, newCount: 2 });
    const insertion = diffDocument(parsePatch('@@ -8,0 +9 @@\n+insert\n'));
    expect(insertion.changes[0]).toMatchObject({ oldStart: 9, newStart: 9 });
    const deletion = diffDocument(parsePatch('@@ -3 +2,0 @@\n-remove\n'));
    expect(deletion.changes[0]).toMatchObject({ oldStart: 3, newStart: 3, oldCount: 1, newCount: 0 });
    expect(projectDiff(addition, true).changes).toHaveLength(1);
  });
  it('does not materialize full context until explicitly expanded, then uses verified real content', () => {
    const document = diffDocument(parsePatch('@@ -3 +3 @@\n-old\n+new\n'));
    const old = loaded('one\ntwo\nold\nfour\nfive\n'), next = loaded('one\ntwo\nnew\nfour\nfive\n');
    const collapsed = projectDiff(document, false, { oldContent: old, newContent: next });
    expect(collapsed.lines.filter(line => line.kind === 'context')).toHaveLength(0);
    const expanded = projectDiff(document, false, { oldContent: old, newContent: next, showUnchanged: true });
    expect(expanded.lines.filter(line => line.kind === 'context').map(line => [line.left, line.old, line.next])).toEqual([['one', 1, 1], ['two', 2, 2], ['four', 4, 4], ['five', 5, 5]]);
    expect(expanded.lines.filter(line => line.kind === 'gap').map(line => line.gapCount)).toEqual([2, 2]);
    expect(expanded.lines.some(line => line.kind === 'gap-status')).toBe(false);
  });
  it.each([
    { name: 'missing', old: loaded(null), next: loaded('one\ntwo\nnew\nfour\n') },
    { name: 'binary', old: loaded('one\ntwo\nold\nfour\n', { binary: true }), next: loaded('one\ntwo\nnew\nfour\n') },
    { name: 'truncated', old: loaded('one\ntwo\nold\nfour\n', { truncated: true }), next: loaded('one\ntwo\nnew\nfour\n') },
    { name: 'inconsistent', old: loaded('one\ntwo\nold\nfour\n'), next: loaded('different\ntwo\nnew\nfour\n') },
  ])('never invents omitted lines for $name content', ({ old, next }) => {
    const document = diffDocument(parsePatch('@@ -3 +3 @@\n-old\n+new\n'));
    const rows = projectDiff(document, false, { oldContent: old, newContent: next, showUnchanged: true });
    expect(rows.lines.filter(line => line.old === 1 || line.next === 1)).toHaveLength(0);
    expect(rows.lines.some(line => line.kind === 'gap-status')).toBe(true);
  });
  it('retains only known patch context with a truthful limited marker for truncated output', () => {
    const document = diffDocument(parsePatch('@@ -2,3 +2,3 @@\n known\n-old\n+new\n tail\n')); document.limited = true;
    const rows = projectDiff(document, false, { showUnchanged: true, oldContent: loaded('unknown\nknown\nold\ntail\n'), newContent: loaded('unknown\nknown\nnew\ntail\n') });
    expect(rows.lines.filter(line => line.kind === 'context').map(line => line.left)).toEqual(['known', 'tail']);
    expect(rows.lines.some(line => line.left === 'unknown')).toBe(false); expect(rows.limited).toBe(true);
    expect(rows.lines.filter(line => line.kind === 'gap-status').every(line => line.gapStatus === 'limited')).toBe(true);
  });
});

describe('minimal change reveal and stable semantic anchors', () => {
  it('makes zero scroll writes for fully visible changes including exact viewport edges', () => {
    const { view, viewport } = makeView(), { changes, lineHeight } = internals(view);
    viewport.scrollTop = changes[1].first * lineHeight; viewport.clientHeight = (changes[1].last - changes[1].first) * lineHeight;
    viewport.scrollLeft = 83; viewport.topWrites = []; viewport.leftWrites = [];
    view.navigateChange(1);
    expect(view.activeChange).toBe(1); expect(viewport.topWrites).toEqual([]); expect(viewport.leftWrites).toEqual([]);
    expect(viewport.scrollLeft).toBe(83);
  });
  it('brings an offscreen block only as far as necessary and preserves horizontal position', () => {
    const { view, viewport } = makeView(), { changes, lineHeight } = internals(view);
    viewport.clientHeight = 60; viewport.scrollLeft = 91; viewport.topWrites = []; viewport.leftWrites = [];
    const expected = changes[2].last * lineHeight - viewport.clientHeight;
    view.navigateChange(1, 'last'); expect(viewport.topWrites).toEqual([expected]); expect(viewport.leftWrites).toEqual([]);
    viewport.topWrites = []; view.navigateChange(-1, 'first'); expect(viewport.topWrites).toEqual([changes[0].first * lineHeight]);
  });
  it('reveals an oversized block title and its first few lines without scrolling to its tail', () => {
    const huge = `@@ -30,0 +31,200 @@\n${'+large\n'.repeat(200)}`, { view, viewport } = makeView(result(huge));
    viewport.clientHeight = 80; viewport.scrollTop = 1000; viewport.topWrites = [];
    view.navigateChange(1, 'first'); const { changes, lineHeight } = internals(view);
    expect(viewport.topWrites).toEqual([changes[0].first * lineHeight]); expect(viewport.scrollTop).toBeLessThan(changes[0].last * lineHeight - 80);
    expect(minimalDiffScrollTop(0, 100, 300, 3000, 20)).toBe(280);
    expect(minimalDiffScrollTop(300, 100, 300, 3000, 20)).toBe(300);
  });
  it('keeps semantic old/new coordinates and active ID across split/unified/font/context changes', () => {
    const data = result(), { view, viewport } = makeView(data); view.navigateChange(1);
    const active = view.activeChangeId, lineIndex = internals(view).lines.findIndex(line => line.changeId === active && line.next === 5);
    viewport.scrollTop = lineIndex * internals(view).lineHeight + 3; viewport.scrollLeft = 57;
    view.set(data, { ...settings(), diffView: 'split' }, false);
    const splitAnchor = view.getState().anchor; expect(splitAnchor?.changeId).toBe(active); expect(splitAnchor?.next).toBe(5); expect(splitAnchor?.offset).toBe(3); expect(viewport.scrollLeft).toBe(57);
    view.set(data, { ...settings(), fontSize: 18 }, false);
    expect(view.getState().anchor?.next).toBe(5); expect(view.getState().anchor?.offset).toBe(3); expect(view.activeChangeId).toBe(active);
    const noContext = result('@@ -2 +2 @@\n-old-one\n+new-one\n@@ -4 +4,2 @@\n-old-two\n+new-two\n+extra\n@@ -6 +7 @@\n-old-three\n+new-three\n');
    view.set(noContext, settings(), false); expect(view.activeChangeId).toBe(active); expect(view.getState().anchor?.next).toBe(5); expect(viewport.scrollLeft).toBe(57);
  });
  it('does not overwrite deferred restore while the historical viewport is hidden/zero-size', () => {
    const { view, viewport } = makeView(); viewport.clientHeight = 0; viewport.clientWidth = 0;
    const change = internals(view).changes[1];
    view.restore({ scrollTop: 1234, scrollLeft: 72, activeChange: change.id, anchor: { changeId: change.id, offset: 4 } });
    expect(viewport.scrollTop).toBe(0); expect(view.getState()).toMatchObject({ scrollTop: 1234, scrollLeft: 72, activeChange: change.id });
    view.set(result(), { ...settings(), diffView: 'split' }, false);
    expect(view.getState().scrollTop).toBe(1234); expect(view.getState().scrollLeft).toBe(72);
    viewport.clientHeight = 240; viewport.clientWidth = 1000; observers[0](); flushFrames();
    expect(viewport.scrollTop).toBe(internals(view).changes[1].first * internals(view).lineHeight + 4); expect(viewport.scrollLeft).toBe(72);
    expect(view.activeChangeId).toBe(change.id);
    const saved = view.getState(); viewport.clientHeight = 0; viewport.scrollTop = 0; viewport.scrollLeft = 0; viewport.fire('scroll');
    expect(view.getState().scrollTop).toBe(saved.scrollTop); expect(view.getState().scrollLeft).toBe(72);
  });
  it('keeps the source-line anchor when context opens/closes and side responses arrive later', async () => {
    const old = deferred<LoadedContent>(), next = deferred<LoadedContent>(), ensureContent = vi.fn((side: 'old' | 'new') => side === 'old' ? old.promise : next.promise);
    const { view, viewport } = makeView(result(), { ensureContent, cancelContent: vi.fn() });
    view.navigateChange(1); const active = view.activeChangeId!;
    const index = internals(view).lines.findIndex(line => line.changeId === active && line.next === 5);
    viewport.scrollTop = index * internals(view).lineHeight + 2; viewport.scrollLeft = 63;
    view.setShowUnchanged(true); await tick(); expect(view.getState().anchor?.next).toBe(5);
    old.resolve(loaded(fullOld)); await tick(); expect(ensureContent.mock.calls).toEqual([['old'], ['new']]); expect(view.getState().anchor?.next).toBe(5);
    next.resolve(loaded(fullNew)); await tick(); expect(view.getState().anchor?.next).toBe(5); expect(viewport.scrollLeft).toBe(63);
    view.setShowUnchanged(false); expect(view.getState().anchor?.next).toBe(5); expect(view.activeChangeId).toBe(active);
  });
});

describe('history-only navigation integration and read-only compatibility', () => {
  it('calls cross-file boundaries exactly once and exposes zero-based state', () => {
    const previous = vi.fn(), next = vi.fn(), onChange = vi.fn(), { view } = makeView(result(), undefined, { previousChangeBoundary: previous, nextChangeBoundary: next, onChange });
    expect(view.changeCount).toBe(3); expect(view.activeChange).toBe(0); expect(onChange).toHaveBeenLastCalledWith({ changeCount: 3, activeChange: 0, activeChangeId: view.activeChangeId });
    expect(view.navigateChange(-1)).toBe(true); expect(previous).toHaveBeenCalledOnce(); expect(view.activeChange).toBe(0);
    view.navigateChange(1, 'last'); expect(view.activeChange).toBe(2); expect(next).not.toHaveBeenCalled();
    view.navigateChange(1); expect(next).toHaveBeenCalledOnce(); expect(view.activeChange).toBe(2);
    view.set(result('@@ -1 +1 @@\n-a\n+b\n'), settings()); view.navigateChange(-1, 'last'); expect(view.activeChange).toBe(0); expect(next).toHaveBeenCalledOnce();
  });
  it.each([
    { name: 'empty', data: result(''), message: 'No textual differences' },
    { name: 'binary', data: result('Binary files differ\n', { binary: true }), message: 'Binary file' },
    { name: 'truncated', data: result('', { truncated: true }), message: 'Limited preview' },
    { name: 'header-only', data: result('old mode 100644\nnew mode 100755\n'), message: 'No text hunks' },
  ])('reports no navigable changes for $name without loading any content', async ({ data, message }) => {
    const ensureContent = vi.fn(async () => loaded('must not load')), next = vi.fn();
    const { view } = makeView(data, { ensureContent, cancelContent: vi.fn() }, { nextChangeBoundary: next });
    expect(view.changeCount).toBe(0); expect(view.activeChange).toBe(-1); expect(view.activeChangeId).toBeNull();
    expect(node(view.element).textContent).toContain(message); expect(view.navigateChange(1, 'first')).toBe(false);
    view.setShowUnchanged(true); await tick(); expect(ensureContent).not.toHaveBeenCalled(); view.navigateChange(1); expect(next).toHaveBeenCalledOnce();
  });
  it('binds navigation only to the supplied history root and skips input, IME and non-Alt keys', () => {
    const { view, root } = makeView(), nextFile = vi.fn(), previousFile = vi.fn();
    view.setNavigation({ keyboardRoot: root as unknown as HTMLElement, nextFile, previousFile });
    expect(root.listeners.get('keydown')).toHaveLength(1);
    const ordinary = root.fire('keydown', { key: 'F5' }); expect(ordinary.preventDefault).not.toHaveBeenCalled(); expect(view.activeChange).toBe(0);
    for (const target of [new TestNode('input'), new TestNode('textarea'), new TestNode('select'), Object.assign(new TestNode(), { isContentEditable: true })]) {
      const event = root.fire('keydown', { target, key: 'F5', altKey: true }); expect(event.preventDefault).not.toHaveBeenCalled();
    }
    const composing = root.fire('keydown', { key: 'F5', altKey: true, isComposing: true }); expect(composing.preventDefault).not.toHaveBeenCalled();
    root.fire('keydown', { key: 'F5', altKey: true }); expect(view.activeChange).toBe(1);
    root.fire('keydown', { key: 'F5', altKey: true, shiftKey: true }); expect(view.activeChange).toBe(0);
    root.fire('keydown', { key: 'PageDown', altKey: true }); root.fire('keydown', { key: 'PageUp', altKey: true }); expect(nextFile).toHaveBeenCalledOnce(); expect(previousFile).toHaveBeenCalledOnce();
    view.setNavigation(null); expect(root.listeners.get('keydown')).toHaveLength(0); root.fire('keydown', { key: 'F5', altKey: true }); expect(view.activeChange).toBe(0);
    view.setNavigation({ keyboardRoot: root as unknown as HTMLElement }); view.destroy(); expect(root.listeners.get('keydown')).toHaveLength(0);
  });
  it('keeps an externally mounted toolbar in its slot, localizes without rendering or reparsing', () => {
    const { view } = makeView(), slot = new TestNode('header'); slot.append(node(view.toolbar));
    const data = result(); view.set(data, settings(), false); expect(node(view.toolbar).parent).toBe(slot);
    const control = query(node(view.toolbar), 'select'), render = vi.spyOn(internals(view), 'render'), prepare = vi.spyOn(PatchModelCache.prototype, 'prepare');
    const before = view.getState(); setLanguage('zh-CN'); view.updateLocale(); expect(view.getState()).toEqual(before);
    expect(query(node(view.toolbar), 'select')).toBe(control); expect(action(view, 'next-change').title).toContain('下一处更改'); expect(render).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it('preserves patch copy, lazy old/new read-only views and cached patch identity', async () => {
    const ensureContent = vi.fn(async (side: 'old' | 'new') => loaded(side === 'old' ? 'old-only\n' : 'new-only\n'));
    const { view, viewport, copy } = makeView(result(), { ensureContent, cancelContent: vi.fn() });
    viewport.fire('keydown', { key: 'a', ctrlKey: true }); viewport.fire('keydown', { key: 'c', ctrlKey: true }); expect(copy).toHaveBeenLastCalledWith(multiple);
    mode(view, 'old'); await tick(); expect(ensureContent.mock.calls).toEqual([['old']]); expect(viewport.textContent).toContain('old-only'); expect(node(view.toolbar).textContent).toContain('Read only');
    mode(view, 'new'); await tick(); expect(ensureContent.mock.calls).toEqual([['old'], ['new']]); expect(viewport.textContent).toContain('new-only');
    mode(view, 'diff'); await tick(); mode(view, 'old'); await tick(); expect(ensureContent).toHaveBeenCalledTimes(2); expect(internals(view).models.parsePasses).toBe(1);
    expect(view.changeCount).toBe(3);
  });
  it('bounds DOM and reuses patch/row models for repeated variants and unrelated settings', () => {
    const data = result(`@@ -0,0 +1,${MAX_DIFF_LINES + 30} @@\n${'+long\n'.repeat(MAX_DIFF_LINES + 30)}`), { view, viewport } = makeView(data);
    expect(query(node(view.element), '.diff-rows').children.length).toBeLessThan(40); expect(node(view.toolbar).textContent).toContain('Limited preview');
    const model = internals(view).models, first = internals(view).lines;
    view.set(data, { ...settings(), theme: 'light', fontSize: 14 }, false); expect(internals(view).lines).toBe(first); expect(model.parsePasses).toBe(1); expect(model.rowPasses).toBe(1);
    view.set(data, { ...settings(), diffView: 'split' }, false); expect(model.parsePasses).toBe(1); expect(model.rowPasses).toBe(2);
    view.set(data, settings(), false); expect(model.parsePasses).toBe(1); expect(model.rowPasses).toBe(2);
    viewport.scrollTop = 900_000; viewport.fire('scroll'); flushFrames(); expect(query(node(view.element), '.diff-rows').children.length).toBeLessThan(40);
    expect(view.changeCount).toBe(1);
  });
  it('indexes wrapped split rows by their measured heights and preserves fixed legacy geometry', () => {
    const data = result(`@@ -1 +1 @@\n-${'old'.repeat(500)}\n+${'new'.repeat(600)}\n`), { view, viewport } = makeView(data);
    view.set(data, { ...settings(), diffView: 'split' }, false);
    const state = internals(view), content = query(node(view.element), '.diff-content');
    expect(content.style.width).toBe('100%'); expect(state.layout).not.toBeNull();
    expect(state.layout!.height).toBeGreaterThan(state.lines.length * state.lineHeight);
    expect(content.style.height).toBe(`${state.layout!.height}px`);
    const index = state.lines.findIndex(line => line.kind === 'split-line'), row = query(node(view.element), '.is-wrapped');
    const before = state.layout!.offsetAt(index + 1);
    state.measureRows([{ target: row, borderBoxSize: [{ blockSize: 400 }], contentRect: { height: 400 } }] as unknown as ResizeObserverEntry[]);
    expect(state.layout!.heightAt(index)).toBe(400); expect(state.layout!.offsetAt(index + 1)).not.toBe(before);
    expect(content.style.height).toBe(`${state.layout!.height}px`); flushFrames();
    viewport.scrollTop = 350; viewport.fire('scroll'); flushFrames(); expect(query(node(view.element), '.diff-rows').children.length).toBeLessThan(40);
    const { view: legacy } = makeView(data, undefined, null); legacy.set(data, { ...settings(), diffView: 'split' }, false);
    expect(internals(legacy).layout).toBeNull();
  });
});

describe('measured split row offset index', () => {
  it('maintains exact prefix boundaries after measurements without scanning preceding rows', () => {
    const layout = new DiffRowLayout([20, 60, 20, 100]);
    expect([0, 1, 2, 3, 4].map(index => layout.offsetAt(index))).toEqual([0, 20, 80, 100, 200]);
    expect([0, 19, 20, 79, 80, 199, 200].map(offset => layout.indexAt(offset))).toEqual([0, 0, 1, 1, 2, 3, 4]);
    expect(layout.measure(1, 120)).toBe(true); expect(layout.height).toBe(260); expect(layout.offsetAt(3)).toBe(160);
    expect(layout.measure(1, 120.1)).toBe(false); expect(layout.measure(8, 30)).toBe(false); expect(layout.measure(0, 0)).toBe(false);
    expect(new DiffRowLayout([]).indexAt(20)).toBe(0);
  });
  it('preserves an anchor on width reflow and uses prefixes for visible/offscreen reveals', () => {
    const data = result(`@@ -1,3 +1,3 @@\n-${'x'.repeat(600)}\n+${'y'.repeat(600)}\n middle\n-old\n+new\n`), { view, viewport } = makeView(data);
    view.set(data, { ...settings(), diffView: 'split' }, false); const state = internals(view), active = state.changes[1].id;
    const index = state.lines.findIndex(line => line.changeId === active && line.next === 3);
    viewport.scrollTop = state.layout!.offsetAt(index) + 3; viewport.fire('scroll');
    viewport.clientWidth = 500; observers[0](); flushFrames();
    expect(view.getState().anchor?.next).toBe(3); expect(view.getState().anchor?.offset).toBe(3);
    expect(viewport.scrollTop).toBe(state.layout!.offsetAt(index) + 3);
    const range = state.changes[1]; viewport.scrollTop = state.layout!.offsetAt(range.first); viewport.clientHeight = state.layout!.offsetAt(range.last) - viewport.scrollTop;
    viewport.topWrites = []; view.navigateChange(1, 'last'); expect(viewport.topWrites).toEqual([]);
    viewport.scrollTop = 0; viewport.clientHeight = 70; viewport.topWrites = []; view.navigateChange(1, 'last');
    expect(viewport.topWrites).toEqual([state.layout!.offsetAt(range.last) - 70]);
  });
  it('renders text navigation labels and file count without icon-only widths', () => {
    const { view } = makeView(result(), undefined, { fileIndex: 1, fileCount: 5 });
    expect(action(view, 'previous-file').textContent).toBe('Previous file'); expect(action(view, 'previous-file').classList.contains('icon-button')).toBe(false);
    expect(query(node(view.toolbar), '.diff-file-counter').textContent).toBe('File 2 of 5');
    setLanguage('zh-CN'); expect(action(view, 'next-change').textContent).toBe('下一处'); expect(query(node(view.toolbar), '.diff-file-counter').textContent).toBe('第 2 / 5 个文件');
  });
});

describe('explicit context loading, late completion and cancellation', () => {
  it('loads old then new serially on explicit show, never on patch/mode projection', async () => {
    const old = deferred<LoadedContent>(), next = deferred<LoadedContent>(), ensureContent = vi.fn((side: 'old' | 'new') => side === 'old' ? old.promise : next.promise);
    const data = result(), { view } = makeView(data, { ensureContent, cancelContent: vi.fn() });
    view.set(data, { ...settings(), diffView: 'split' }, false); await tick(); expect(ensureContent).not.toHaveBeenCalled();
    view.setShowUnchanged(true); await tick(); expect(ensureContent.mock.calls).toEqual([['old']]);
    old.resolve(loaded(fullOld)); await tick(); expect(ensureContent.mock.calls).toEqual([['old'], ['new']]);
    next.resolve(loaded(fullNew)); await tick();
    expect(internals(view).lines.filter(line => line.kind === 'split-line' && line.old !== null && line.next !== null).map(line => line.left)).toContain('middle');
    view.setShowUnchanged(false); view.setShowUnchanged(true); await tick(); expect(ensureContent).toHaveBeenCalledTimes(2);
  });
  it('can expand a single stable gap while other gaps stay collapsed', async () => {
    const ensureContent = vi.fn(async (side: 'old' | 'new') => loaded(side === 'old' ? fullOld : fullNew)), { view } = makeView(result(), { ensureContent, cancelContent: vi.fn() });
    const gaps = internals(view).lines.filter(line => line.kind === 'gap'), id = gaps[1].gapId!;
    view.toggleGap(id); await tick(); expect(ensureContent.mock.calls).toEqual([['old'], ['new']]);
    expect(internals(view).lines.filter(line => line.kind === 'context').map(line => line.left)).toEqual(['middle']);
    expect(view.getState()).toMatchObject({ showUnchanged: false, expandedGaps: [id] });
    view.toggleGap(id); expect(internals(view).lines.filter(line => line.kind === 'context')).toHaveLength(0);
    view.restore({ expandedGaps: [id] }); await tick(); expect(internals(view).lines.filter(line => line.kind === 'context').map(line => line.left)).toEqual(['middle']);
  });
  it('cancels queued context before ensureContent starts', async () => {
    const ensureContent = vi.fn(async () => loaded('late')), cancelContent = vi.fn(), { view } = makeView(result(), { ensureContent, cancelContent });
    view.setShowUnchanged(true); view.setShowUnchanged(false); await tick(); expect(ensureContent).not.toHaveBeenCalled(); expect(cancelContent).toHaveBeenCalledOnce();
  });
  it('ignores late old-side completion after another file is installed', async () => {
    const old = deferred<LoadedContent>(), ensureContent = vi.fn(() => old.promise), cancelContent = vi.fn(), { view, viewport } = makeView(result(), { ensureContent, cancelContent });
    view.setShowUnchanged(true); await tick(); expect(ensureContent).toHaveBeenCalledOnce();
    view.set(result('@@ -1 +1 @@\n-before\n+current\n'), settings(), true, { ensureContent: vi.fn(async () => loaded('current')), cancelContent: vi.fn() });
    old.resolve(loaded('stale-secret\n')); await tick(); expect(ensureContent).toHaveBeenCalledOnce(); expect(cancelContent).toHaveBeenCalledOnce();
    expect(viewport.textContent).not.toContain('stale-secret'); expect(view.changeCount).toBe(1); expect(view.getState().showUnchanged).toBe(false);
  });
  it('keeps patch usable on cancellation, retries only the cancelled side and rejects its late result', async () => {
    const old = deferred<LoadedContent>(), ensureContent = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(loaded(fullOld)).mockResolvedValueOnce(loaded(fullNew));
    const cancelContent = vi.fn(), { view, viewport } = makeView(result(), { ensureContent, cancelContent });
    view.setShowUnchanged(true); await tick();
    const cancel = viewport.querySelectorAll('button').find(button => button.title === 'Cancel context loading')!; expect(cancel).toBeTruthy(); cancel.fire('click');
    expect(viewport.textContent).toContain('Context loading cancelled'); expect(view.changeCount).toBe(3); expect(cancelContent).toHaveBeenCalledOnce();
    const retry = viewport.querySelectorAll('button').find(button => button.title === 'Retry context')!; retry.fire('click'); await tick();
    expect(ensureContent.mock.calls).toEqual([['old'], ['old'], ['new']]); expect(viewport.textContent).toContain('middle');
    old.resolve(loaded('stale-cancelled\n')); await tick(); expect(viewport.textContent).not.toContain('stale-cancelled'); expect(internals(view).sides.old.data?.content).toBe(fullOld);
  });
  it('shows failure without losing patch navigation and reuses the completed first side on retry', async () => {
    const ensureContent = vi.fn().mockResolvedValueOnce(loaded(fullOld)).mockRejectedValueOnce(new Error('new failed')).mockResolvedValueOnce(loaded(fullNew));
    const { view, viewport } = makeView(result(), { ensureContent, cancelContent: vi.fn() }); view.setShowUnchanged(true); await tick();
    expect(viewport.textContent).toContain('Unchanged context could not be loaded'); view.navigateChange(1); expect(view.activeChange).toBe(1);
    viewport.querySelectorAll('button').find(button => button.title === 'Retry context')!.fire('click'); await tick();
    expect(ensureContent.mock.calls).toEqual([['old'], ['new'], ['new']]); expect(internals(view).sides.old.data?.content).toBe(fullOld);
  });
  it('remembers unavailable/truncated completion rather than re-fetching or substituting the opposite side', async () => {
    const ensureContent = vi.fn(async (side: 'old' | 'new') => side === 'old' ? loaded(null) : loaded('not-old\n', { truncated: true }));
    const { view, viewport } = makeView(result(), { ensureContent, cancelContent: vi.fn() }); view.setShowUnchanged(true); await tick();
    expect(ensureContent.mock.calls).toEqual([['old'], ['new']]); expect(viewport.textContent).toContain('Missing lines are not reconstructed'); expect(viewport.textContent).not.toContain('not-old');
    view.setShowUnchanged(false); view.setShowUnchanged(true); await tick(); expect(ensureContent).toHaveBeenCalledTimes(2);
    mode(view, 'old'); await tick(); expect(viewport.textContent).toContain('Content unavailable'); expect(viewport.textContent).not.toContain('not-old');
  });
});
