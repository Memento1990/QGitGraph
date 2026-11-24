import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubUpdateInfo, Host, Repository } from '../src/shared/protocol';
import { StateStore } from '../src/lib/state';
import { defineMessages, initI18n, setLanguage } from '../src/lib/i18n';
import { button, closeMenu, contextMenu, disposeBindings, el, field, formDialog, input, loading, resizer, select, setAttribute, setText } from '../src/ui/dom';
import { showSettings } from '../src/ui/settings';
import { UpdateCheck } from '../src/ui/updates';
import { GitActions, type ActionContext } from '../src/ui/actions';
import { DEFAULT_SETTINGS } from '../src/shared/protocol';

type TestEvent = { target: TestNode; key: string; preventDefault(): void; stopPropagation(): void };
/** Dependency-free DOM adapter: tracks identities, writes, focus and caret rather than implementing browser rendering. */
class TestNode {
  parentElement: TestNode | null = null; children: TestNode[] = []; attributes = new Map<string, string>();
  dataset: Record<string, string> = {}; events = new Map<string, ((event: TestEvent) => void)[]>();
  className = ''; id = ''; title = ''; type = ''; name = ''; hidden = false; disabled = false; checked = false; required = false; open = false;
  style: Record<string, string> = {};
  tabIndex = 0; rows = 0; scrollTop = 0; selectionStart = 0; selectionEnd = 0; textWrites = 0; valueWrites = 0;
  private ownText = ''; private ownValue = '';
  classList = { add: (...names: string[]) => { this.className += ` ${names.join(' ')}`; } };
  constructor(readonly tagName: string, text = '') { this.ownText = text; }
  get nodeType(): number { return this.tagName === '#text' ? 3 : 1; }
  get nodeName(): string { return this.tagName; }
  get parentNode(): TestNode | null { return this.parentElement; }
  get firstElementChild(): TestNode | null { return this.children.find(child => child.nodeType === 1) ?? null; }
  get childElementCount(): number { return this.children.filter(child => child.nodeType === 1).length; }
  get isConnected(): boolean { return this === dom.body || Boolean(this.parentElement?.isConnected); }
  get value(): string { return this.ownValue; }
  set value(value: string) { this.ownValue = value; this.valueWrites++; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(text: string) { this.textWrites++; this.replaceChildren(); this.ownText = text; }
  append(...children: (TestNode | string)[]): void { children.forEach(child => this.appendChild(typeof child === 'string' ? new TestNode('#text', child) : child)); }
  appendChild(child: TestNode): TestNode { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  replaceChildren(...children: TestNode[]): void { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.ownText = ''; this.append(...children); }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); if (name === 'title') this.title = value; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, [...(this.events.get(name) ?? []), listener]); }
  emit(name: string, key = ''): void { this.events.get(name)?.forEach(listener => listener({ target: this, key, preventDefault: vi.fn(), stopPropagation: vi.fn() })); }
  querySelectorAll(selector: string): TestNode[] {
    const match = (node: TestNode): boolean => {
      if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
      const attribute = /^(\w+)?\[([^=]+)="([^"]+)"\]$/.exec(selector);
      if (attribute) return (!attribute[1] || node.tagName === attribute[1]) && (attribute[2] in node ? String((node as unknown as Record<string, unknown>)[attribute[2]]) : node.getAttribute(attribute[2])) === attribute[3];
      return node.tagName === selector.replace(':last-of-type', '');
    };
    return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): TestNode | null { const values = this.querySelectorAll(selector); return selector.endsWith(':last-of-type') ? values.at(-1) ?? null : values[0] ?? null; }
  focus(): void { dom.activeElement = this; }
  getBoundingClientRect(): { left: number; bottom: number; width: number; height: number } { return { left: 0, bottom: 0, width: 180, height: 100 }; }
  contains(node: TestNode): boolean { return node === this || this.children.some(child => child.contains(node)); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  reportValidity(): boolean { return true; }
}
const dom = {
  body: new TestNode('body'), documentElement: { lang: 'en' }, activeElement: null as TestNode | null,
  createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('#text', text), querySelector: (selector: string) => dom.body.querySelector(selector),
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
};
const asNode = (node: Node): TestNode => node as unknown as TestNode;
const all = (root: TestNode): TestNode[] => [root, ...root.children.flatMap(all)];
function find(root: TestNode, predicate: (node: TestNode) => boolean): TestNode { const node = all(root).find(predicate); if (!node) throw new Error('Expected node not found'); return node; }
const action = (root: TestNode, name: string) => find(root, node => node.dataset.action === name);
const setting = (root: TestNode, name: string) => find(root, node => node.dataset.setting === name);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const messages = defineMessages('dom-test', { title: 'Title {name}', label: 'Editable value', hint: 'Keep your draft', option: 'First option', invalid: 'Invalid draft', placeholder: 'Type here' }, { title: '标题 {name}', label: '可编辑值', hint: '保留草稿', option: '第一个选项', invalid: '无效草稿', placeholder: '在此输入' });
const available: GithubUpdateInfo = { status: 'available', currentVersion: '0.2.2', latestVersion: '0.3.0', releaseTag: 'v0.3.0', releaseUrl: 'https://github.com/Memento1990/QGitGraph/releases/tag/v0.3.0', publishedAt: null, releaseNotes: 'Release notes: Keep Apply 保存 literal.', notesTruncated: false };
const repo: Repository = { id: 'repo', name: 'Apply 保存', path: 'D:/Apply 保存', gitDir: '.git', commonDir: '.git', head: null, branch: 'main', bare: false, trusted: true };

beforeEach(() => {
  dom.body = new TestNode('body'); dom.documentElement.lang = 'en'; dom.activeElement = null;
  vi.stubGlobal('document', dom); vi.stubGlobal('Node', TestNode); vi.stubGlobal('HTMLInputElement', TestNode);
  vi.stubGlobal('HTMLTextAreaElement', TestNode); vi.stubGlobal('HTMLSelectElement', TestNode);
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 900, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('navigator', { languages: ['fr-FR', 'zh-CN'], language: 'en-US' });
  initI18n('en', []);
});
afterEach(() => { closeMenu(); disposeBindings(dom.body as unknown as Node); initI18n('en', []); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('explicit owned text/attribute bindings', () => {
  it('updates only explicitly localizable label nodes and attributes while preserving controls, focus, caret, scroll and raw user strings', () => {
    const control = input(messages.m('label'), 'Cancel / feature/保存 / {name}');
    const root = el('div', '', field(messages.m('label'), control, messages.m('hint')), button(messages.m('title', { name: 'Apply' }), () => {}, 'open'), el('pre', '', 'Title Apply / Keep your draft / 保存'));
    const chooser = select([{ value: 'fixed', label: messages.m('option') }, { value: 'raw', label: 'First option / user data' }], 'raw', messages.m('label'));
    root.append(chooser); dom.body.append(asNode(root)); setAttribute(control, 'placeholder', messages.m('placeholder'));
    const node = asNode(control), selection = asNode(chooser), beforeNodes = all(asNode(root)), inputWrites = node.valueWrites, selectWrites = selection.valueWrites;
    node.focus(); node.selectionStart = 4; node.selectionEnd = 11; node.scrollTop = 27;
    setLanguage('zh-CN');
    expect(dom.documentElement.lang).toBe('zh-CN'); expect(asNode(root).textContent).toContain('标题 Apply'); expect(asNode(root).textContent).toContain('保留草稿');
    expect(node.getAttribute('aria-label')).toBe('可编辑值'); expect(node.getAttribute('placeholder')).toBe('在此输入');
    expect(node.value).toBe('Cancel / feature/保存 / {name}'); expect(node.valueWrites).toBe(inputWrites); expect(selection.valueWrites).toBe(selectWrites); expect(selection.value).toBe('raw');
    expect(dom.activeElement).toBe(node); expect([node.selectionStart, node.selectionEnd, node.scrollTop]).toEqual([4, 11, 27]);
    expect(all(asNode(root))).toEqual(beforeNodes); expect(asNode(root).textContent).toContain('Title Apply / Keep your draft / 保存'); expect(selection.textContent).toContain('First option / user data');
  });
  it('replaces explicitly owned bindings with raw values, supports text-node targets, and stops updates on disposal', () => {
    const root = el('div'), label = el('span'); root.append(label); dom.body.append(asNode(root));
    setText(label, messages.m('hint')); const text = asNode(label).children[0];
    setLanguage('zh-CN'); expect(text.textContent).toBe('保留草稿'); expect(asNode(label).children[0]).toBe(text);
    setText(label, 'Keep your draft'); setLanguage('en'); setLanguage('zh-CN'); expect(text.textContent).toBe('Keep your draft');
    setText(text as unknown as Node, messages.m('hint')); setAttribute(label, 'title', messages.m('label'));
    disposeBindings(root); setLanguage('en'); expect(text.textContent).toBe('保留草稿'); expect(asNode(label).title).toBe('可编辑值');
    setAttribute(label, 'title', null); expect(asNode(label).getAttribute('title')).toBeNull();
  });
  it('focuses a clicked resizer before pointer capture so Home, End and arrows resize within bounds without replacing a field', () => {
    let width = 240;
    const get = vi.fn(() => width), max = vi.fn(() => 520), set = vi.fn((value: number, _final: boolean) => { width = value; });
    const handleElement = resizer('vertical', get, set, 180, max), handle = asNode(handleElement);
    const control = input(messages.m('label'), 'unchanged draft'), fieldNode = field(messages.m('label'), control), root = el('div', '', fieldNode, handleElement);
    dom.body.append(asNode(root)); const node = asNode(control); node.focus(); node.selectionStart = 3; node.selectionEnd = 8;
    const before = all(asNode(root)), writes = node.valueWrites, getCalls = get.mock.calls.length, maxCalls = max.mock.calls.length;
    const focus = vi.spyOn(handle, 'focus');
    handleElement.setPointerCapture = vi.fn(() => { expect(dom.activeElement).toBe(handle); expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true }); });
    const pointer = { target: handle, key: '', button: 0, pointerId: 7, clientX: 240, clientY: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    for (const listener of handle.events.get('pointerdown') ?? []) listener(pointer);
    expect(pointer.preventDefault).toHaveBeenCalledOnce(); expect(handleElement.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(get).toHaveBeenCalledTimes(getCalls + 1); expect(max).toHaveBeenCalledTimes(maxCalls); expect(set).not.toHaveBeenCalled();
    const press = (key: string, shiftKey = false): void => {
      const event = { target: dom.activeElement!, key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      for (const listener of dom.activeElement?.events.get('keydown') ?? []) listener(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    };
    press('Home'); expect(width).toBe(180); press('ArrowLeft'); expect(width).toBe(180);
    press('ArrowRight'); expect(width).toBe(188); press('ArrowRight', true); expect(width).toBe(228);
    press('End'); expect(width).toBe(520); press('ArrowRight'); expect(width).toBe(520);
    press('ArrowLeft', true); expect(width).toBe(480);
    expect(handle.getAttribute('aria-valuenow')).toBe('480'); expect(set.mock.calls.every(([, final]) => final)).toBe(true);
    setLanguage('zh-CN'); expect(dom.activeElement).toBe(handle); expect(all(asNode(root))).toEqual(before);
    expect(node.value).toBe('unchanged draft'); expect(node.valueWrites).toBe(writes); expect([node.selectionStart, node.selectionEnd]).toEqual([3, 8]);
  });
  it('uses navigator.languages with navigator.language fallback only at initialization and sets document lang to the resolved locale', () => {
    initI18n(); expect(dom.documentElement.lang).toBe('zh-CN');
    vi.stubGlobal('navigator', { languages: [], language: 'en-GB' }); initI18n(); expect(dom.documentElement.lang).toBe('en');
    vi.stubGlobal('navigator', { language: 'zh-HK' }); initI18n(); expect(dom.documentElement.lang).toBe('zh-CN');
  });
});

describe('live forms and action dialogs', () => {
  it('updates an open context menu label/title without changing focus, action IDs or executing actions, and disposes on close', () => {
    const run = vi.fn(), restore = el('button'); dom.body.append(asNode(restore));
    contextMenu([{ label: messages.m('title', { name: 'HEAD' }), action: run, dataAction: 'stable-id' }], { x: 10, y: 10 }, restore);
    const menu = dom.querySelector('.context-menu')!, focused = dom.activeElement, before = all(menu);
    setLanguage('zh-CN'); expect(menu.textContent).toContain('标题 HEAD'); expect(dom.activeElement).toBe(focused); expect(all(menu)).toEqual(before); expect(focused?.dataset.action).toBe('stable-id'); expect(run).not.toHaveBeenCalled();
    closeMenu(); const closed = menu.textContent; setLanguage('en'); expect(menu.textContent).toBe(closed); expect(dom.activeElement).toBe(asNode(restore));
  });
  it('keeps generic required/number validation localized in place instead of browser-language popups', async () => {
    const result = formDialog({ title: messages.m('label'), fields: [{ name: 'required', label: messages.m('label'), value: '', required: true }, { name: 'depth', label: messages.m('hint'), type: 'number', value: '2', min: 0, max: 5 }] });
    const dialog = dom.querySelector('dialog')!, form = dialog.querySelector('form')!, required = dialog.querySelector('[name="required"]')!, depth = dialog.querySelector('[name="depth"]')!;
    form.emit('submit'); expect(dialog.textContent).toContain('a value is required'); setLanguage('zh-CN'); expect(dialog.textContent).toContain('必须填写此项');
    required.value = 'raw'; depth.value = '8'; form.emit('submit'); expect(dialog.textContent).toContain('请输入不大于 5 的值');
    depth.value = '2.5'; form.emit('submit'); expect(dialog.textContent).toContain('请输入有效整数');
    dialog.emit('cancel'); expect(await result).toBeNull();
  });
  it('localizes generic buttons and validation without recreating an input or resetting its invalid value/selection', async () => {
    const result = formDialog({ title: messages.m('title', { name: 'repo' }), fields: [{ name: 'value', label: messages.m('label'), value: 'draft', hint: messages.m('hint'), placeholder: messages.m('placeholder') }], validate: () => messages.m('invalid') });
    const dialog = dom.querySelector('dialog')!, form = dialog.querySelector('form')!, control = dialog.querySelector('input')!;
    control.value = 'broken {json'; control.focus(); control.selectionStart = 3; control.selectionEnd = 7; form.emit('submit');
    const before = all(dialog), writes = control.valueWrites; expect(dialog.textContent).toContain('Invalid draft');
    setLanguage('zh-CN'); expect(dialog.textContent).toContain('无效草稿'); expect(dialog.textContent).toContain('取消'); expect(dialog.textContent).toContain('应用');
    expect(all(dialog)).toEqual(before); expect(control.valueWrites).toBe(writes); expect(control.value).toBe('broken {json'); expect(dom.activeElement).toBe(control); expect([control.selectionStart, control.selectionEnd]).toEqual([3, 7]);
    dialog.emit('cancel'); expect(await result).toBeNull(); const closed = dialog.textContent; setLanguage('en'); expect(dialog.textContent).toBe(closed);
  });
  it('keeps a Git action draft and identity stable without executing or fetching on a language change', async () => {
    const context: ActionContext = { repo, settings: structuredClone(DEFAULT_SETTINGS), refs: [], remotes: [], stashes: [], selected: null, working: { files: [], branch: 'main', ahead: 0, behind: 0, conflicts: 0, operation: null } };
    const execute = vi.fn(async () => null), commitDetail = vi.fn(), callbacks = { context: () => context, execute, error: vi.fn(), changed: vi.fn(), toast: vi.fn() };
    const actions = new GitActions({ commitDetail } as unknown as Host, callbacks); const showing = actions.show('branch-create'); await settle();
    const dialog = dom.querySelector('dialog')!, control = dialog.querySelector('[name="name"]')!; control.value = 'feature/My 原文'; control.focus(); control.selectionStart = 4;
    const before = all(dialog); setLanguage('zh-CN');
    expect(dialog.textContent).toContain('创建分支'); expect(dialog.textContent).toContain('新分支名称'); expect(dialog.textContent).toContain('仓库：Apply 保存');
    expect(control.value).toBe('feature/My 原文'); expect(control.selectionStart).toBe(4); expect(all(dialog)).toEqual(before); expect(execute).not.toHaveBeenCalled(); expect(commitDetail).not.toHaveBeenCalled(); expect(callbacks.changed).not.toHaveBeenCalled();
    dialog.emit('cancel'); await showing; expect(execute).not.toHaveBeenCalled();
  });
  it('localizes loading cancellation without replacing the surrounding state', () => {
    const cancel = vi.fn(), root = loading(messages.m('hint'), cancel); dom.body.append(asNode(root)); const before = all(asNode(root));
    setLanguage('zh-CN'); expect(asNode(root).textContent).toContain('取消'); expect(all(asNode(root))).toEqual(before); expect(cancel).not.toHaveBeenCalled();
  });
});

describe('settings global language and update lifecycle invariants', () => {
  it('offers a shareable repository local-changes position and relabels it without I/O or rebuilding controls', async () => {
    vi.useFakeTimers(); const saveState = vi.fn(async (_state: unknown) => {}), host = { saveState, checkForUpdates: vi.fn(), exportConfig: vi.fn() };
    const changed = vi.fn(), onError = vi.fn(), store = new StateStore(saveState, onError);
    await showSettings(host as unknown as Host, store, repo, null, changed, onError);
    const dialog = dom.querySelector('.settings-dialog')!, position = setting(dialog, 'localChangesPosition');
    expect(position.tagName).toBe('select'); expect(position.disabled).toBe(false); expect(position.value).toBe('middle');
    expect(position.children.map(option => option.value)).toEqual(['middle', 'inline']);
    expect(position.textContent).toContain('Middle pane'); expect(position.textContent).toContain('Inline in history');
    position.value = 'inline'; position.emit('change');
    expect(store.state.repoSettings[repo.id]).toEqual({ localChangesPosition: 'inline' }); expect(store.state.settings.localChangesPosition).toBe('middle');
    expect(changed).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(500);
    const calls = saveState.mock.calls.length, before = all(dialog), writes = position.valueWrites; position.focus();
    setLanguage('zh-CN');
    expect(position.textContent).toContain('中间面板'); expect(position.textContent).toContain('历史内嵌'); expect(dialog.textContent).toContain('本地更改位置');
    expect(position.value).toBe('inline'); expect(position.valueWrites).toBe(writes); expect(dom.activeElement).toBe(position); expect(all(dialog)).toEqual(before);
    await vi.advanceTimersByTimeAsync(500); expect(saveState).toHaveBeenCalledTimes(calls); expect(host.checkForUpdates).not.toHaveBeenCalled(); expect(host.exportConfig).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
  });
  it('persists global language from repository scope without touching invalid raw input, calling changed, or recreating Settings', async () => {
    vi.useFakeTimers(); const saveState = vi.fn(async (_state: unknown) => {}), host = { saveState, checkForUpdates: vi.fn(), exportConfig: vi.fn() };
    const onError = vi.fn(), changed = vi.fn(), languageChanged = vi.fn(), store = new StateStore(saveState, onError);
    await showSettings(host as unknown as Host, store, repo, null, changed, onError, languageChanged);
    const dialog = dom.querySelector('.settings-dialog')!, palette = setting(dialog, 'graphColors'), language = setting(dialog, 'language');
    palette.value = '{invalid draft'; palette.focus(); palette.selectionStart = 2; palette.selectionEnd = 9; palette.emit('input');
    const before = all(dialog), writes = palette.valueWrites, error = find(dialog, node => node.getAttribute('role') === 'alert'); expect(error.textContent).toContain('enter valid JSON');
    language.value = 'zh-CN'; language.emit('change');
    expect(store.state.settings.language).toBe('zh-CN'); expect(store.state.repoSettings[repo.id]).toBeUndefined(); expect(language.disabled).toBe(false);
    expect(error.textContent).toContain('请输入有效的 JSON'); expect(palette.value).toBe('{invalid draft'); expect(palette.valueWrites).toBe(writes); expect(dom.activeElement).toBe(palette); expect([palette.selectionStart, palette.selectionEnd]).toEqual([2, 9]);
    expect(all(dialog)).toEqual(before); expect(changed).not.toHaveBeenCalled(); expect(languageChanged).toHaveBeenCalledOnce(); expect(host.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500); expect(saveState).toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    expect(saveState.mock.calls.at(-1)?.[0]).toMatchObject({ settings: { language: 'zh-CN' }, repoSettings: {} });
  });
  it('preserves the same pending update controller, request generation and controls across language changes and ignores late response after disposal', async () => {
    const request = deferred<GithubUpdateInfo>(), host = { checkForUpdates: vi.fn(() => request.promise), openUrl: vi.fn(async () => {}) };
    const controller = new UpdateCheck(host, '0.2.2'), root = asNode(controller.element); dom.body.append(root); const control = action(root, 'check-for-updates'); control.emit('click');
    const before = all(root), pending = find(root, node => node.dataset.updateStatus === 'checking'); setLanguage('zh-CN');
    expect(all(root)).toEqual(before); expect(control.disabled).toBe(true); expect(pending.textContent).toBe('正在检查最新稳定版本…'); expect(host.checkForUpdates).toHaveBeenCalledOnce(); expect(host.openUrl).not.toHaveBeenCalled();
    controller.dispose(); const closed = root.textContent; setLanguage('en'); expect(root.textContent).toBe(closed); request.resolve(available); await settle(); expect(root.textContent).toBe(closed);
  });
  it('keeps an update error localized without truncating the original diagnostic or retrying requests', async () => {
    const raw = 'native failure ' + '保存 {path} / '.repeat(600), host = { checkForUpdates: vi.fn(async () => { throw { code: 'UPDATE_NETWORK', message: raw, detail: 'original tail detail' }; }), openUrl: vi.fn(async () => {}) };
    const controller = new UpdateCheck(host, '0.2.2'), root = asNode(controller.element); dom.body.append(root); action(root, 'check-for-updates').emit('click'); await settle();
    setLanguage('zh-CN'); expect(root.textContent).toContain('无法检查更新'); expect(root.textContent).toContain(raw); expect(root.textContent).toContain('original tail detail'); expect(host.checkForUpdates).toHaveBeenCalledOnce(); controller.dispose();
  });
  it('localizes the completed release presentation while preserving release notes verbatim and never requesting twice', async () => {
    const host = { checkForUpdates: vi.fn(async () => available), openUrl: vi.fn(async () => {}) }, controller = new UpdateCheck(host, '0.2.2'), root = asNode(controller.element); dom.body.append(root);
    action(root, 'check-for-updates').emit('click'); await settle(); const before = all(root), notes = root.querySelector('pre')!;
    setLanguage('zh-CN'); expect(root.textContent).toContain('有新的稳定版本可用'); expect(root.textContent).toContain('打开版本发布页面'); expect(notes.textContent).toBe(available.releaseNotes); expect(all(root)).toEqual(before);
    expect(host.checkForUpdates).toHaveBeenCalledOnce(); expect(host.openUrl).not.toHaveBeenCalled(); controller.dispose();
  });
});
