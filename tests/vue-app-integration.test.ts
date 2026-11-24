import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileScript, compileTemplate, parse, registerTS } from '@vue/compiler-sfc';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey, type Component, type ComponentInternalInstance, type VNode } from 'vue';
import AppSfc from '../src/App.vue';
import RepositoryOpenDialog from '../src/components/RepositoryOpenDialog.vue';
import RepositorySidebar from '../src/components/RepositorySidebar.vue';
import RepositoryMenu from '../src/components/RepositoryMenu.vue';
import HistoryPanel from '../src/components/HistoryPanel.vue';
import HistoryQueryDialog from '../src/components/HistoryQueryDialog.vue';
import LocalChangesPanel from '../src/components/LocalChangesPanel.vue';
import ActionDialog from '../src/components/ActionDialog.vue';
import SettingsDialog from '../src/components/SettingsDialog.vue';
import CommitInspector from '../src/components/CommitInspector.vue';
import DiffPanel from '../src/components/DiffPanel.vue';
import SizeHandle from '../src/components/SizeHandle.vue';
import { defaultState, type ChangedFile, type Commit, type CommitDetail, type DiffResult, type ExternalSession, type Host, type PersistedState, type Repository, type RepositorySnapshot } from '../src/shared/protocol';
import { initI18n } from '../src/lib/i18n';
import type { LocalChangesController } from '../src/controllers/local-changes';
import type { ActionsController } from '../src/controllers/actions';
import type { HistoryController } from '../src/controllers/history';

// Fail at module evaluation if the formal root ever crosses into the old imperative UI/demo.
vi.mock('../src/ui/app', () => { throw new Error('Formal Vue root imported legacy DOM App'); });
vi.mock('../src/ui/dom', () => { throw new Error('Formal Vue root imported legacy DOM business adapter'); });
vi.mock('../src/ui/diff-view', () => { throw new Error('Formal Vue root imported legacy diff renderer'); });
vi.mock('../src/host/demo', () => { throw new Error('Formal Vue root imported demo/mock Host'); });

// Automated, fixtures-only integration: real App/SFC setup, lifecycle, templates and controllers.
// No DesktopHost, native/Git process, browser DOM business adapter, private root state or userusage.
// Only Reka's browser/portal primitives are replaced. They never fabricate business state/results.
vi.mock('reka-ui', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { defineComponent, h, inject, provide } = await import('vue');
  const primitive = (tag: string) => defineComponent({ inheritAttrs: false, setup: (_, { attrs, slots }) => () => h(tag, attrs, slots.default?.()) });
  const portal = defineComponent({ setup: (_, { slots }) => () => slots.default?.() });
  const menuOpen = Symbol('fixture-reka-menu-open');
  return {
    ...actual,
    DialogRoot: defineComponent({ props: { open: Boolean }, setup: (props, { slots }) => () => props.open ? slots.default?.() : null }),
    DialogPortal: portal, DialogContent: primitive('section'), DialogOverlay: primitive('aside'),
    DialogTitle: primitive('h2'), DialogDescription: primitive('p'), DialogClose: primitive('button'),
    DropdownMenuRoot: defineComponent({ props: { open: Boolean }, setup: (props, { slots }) => { provide(menuOpen, () => props.open); return () => slots.default?.(); } }),
    DropdownMenuPortal: portal,
    DropdownMenuContent: defineComponent({ inheritAttrs: false, setup: (_, { attrs, slots }) => { const open = inject<() => boolean>(menuOpen)!; return () => open() ? h('div', attrs, slots.default?.()) : null; } }),
    DropdownMenuSub: portal, DropdownMenuSubContent: primitive('div'), DropdownMenuSubTrigger: primitive('button'),
    DropdownMenuTrigger: primitive('span'), DropdownMenuItem: primitive('button'), DropdownMenuLabel: primitive('div'),
    DropdownMenuSeparator: primitive('hr'), DropdownMenuGroup: primitive('div'),
    TreeRoot: defineComponent({
      props: ['items', 'expanded', 'getKey', 'getChildren'],
      setup: (props, { attrs, slots }) => () => {
        const flattenItems: unknown[] = [];
        const flatten = (items: unknown[], level = 1) => { for (const value of items) {
          const key = props.getKey(value), expanded = props.expanded.includes(key);
          flattenItems.push({ _id: key, value, level, bind: { value, level, expanded } });
          if (expanded) flatten(props.getChildren(value) ?? [], level + 1);
        } };
        flatten(props.items); return h('ul', attrs, slots.default?.({ flattenItems }));
      },
    }),
    TreeItem: defineComponent({ props: ['value', 'level', 'expanded'], setup: (props, { attrs, slots }) => () => h('li', { ...attrs, role: 'treeitem' }, slots.default?.({ isExpanded: props.expanded })) }),
  };
});

// Like vue-settings.test.ts: retain Vite's real SFC script setup and compile client templates
// for the custom renderer (Vitest's node SFC transform otherwise supplies SSR templates).
registerTS(() => ts);
const componentModules = import.meta.glob('../src/components/**/*.vue', { eager: true, import: 'default' });
function clientTemplate(component: Component, relative: string): Component {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  if (!descriptor.template) return component;
  const script = compileScript(descriptor, { id: filename, fs: { fileExists: existsSync, readFile: path => readFileSync(path, 'utf8') } });
  const result = compileTemplate({ source: descriptor.template.content, filename, id: filename, compilerOptions: { bindingMetadata: script.bindings, mode: 'function' } });
  if (result.errors.length) throw new Error(`${relative}: ${String(result.errors[0])}`);
  const target = component as { render?: unknown; ssrRender?: unknown };
  target.render = new Function('Vue', ts.transpileModule(result.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)(Vue);
  delete target.ssrRender; return component;
}
for (const [path, component] of Object.entries(componentModules)) clientTemplate(component as Component, path);
const App = clientTemplate(AppSfc, '../src/App.vue');

// Host-node APIs serve Vue directives, refs and measured UI lifecycle only. Business inputs travel
// through actual component-emitted callbacks or rendered native control handlers, never state edits.
class RenderNode {
  props: Record<string, any> = {};
  children: RenderNode[] = [];
  parent: RenderNode | null = null;
  style: Record<string, any> = {};
  listeners = new Map<string, ((event: any) => void)[]>();
  scrollTop = 0; scrollLeft = 0; clientHeight = 500; clientWidth = 1100;
  value: any = ''; checked = false; selected = false; composing = false;
  selectionStart = 0; selectionEnd = 0; selectionDirection = 'none';
  constructor(readonly type: string, public text = '') {}
  get parentElement() { return this.parent; }
  get tagName() { return this.type.toUpperCase(); }
  get options() { return descendants(this).filter(item => item.type === 'option'); }
  get dataset() { return Object.fromEntries(Object.entries(this.props).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()), value])); }
  get textContent(): string { return this.text + this.children.filter(child => child.type !== '#comment').map(child => child.textContent).join(''); }
  getBoundingClientRect() { return { top: 0, bottom: this.clientHeight, left: 0, right: this.clientWidth, width: this.clientWidth, height: this.clientHeight }; }
  addEventListener(name: string, handler: (event: any) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]); }
  removeEventListener(name: string, handler: (event: any) => void) { this.listeners.set(name, this.listeners.get(name)?.filter(item => item !== handler) ?? []); }
  setAttribute(name: string, value: unknown) { this.props[name] = value; }
  removeAttribute(name: string) { delete this.props[name]; }
  contains(child: RenderNode) { return descendants(this).includes(child); }
  appendChild(child: RenderNode) { insert(child, this); return child; }
  matches(selector: string): boolean { return selector.split(',').some(part => {
    const value = part.trim();
    if (value.startsWith('.')) return String(this.props.class ?? '').split(/\s+/).includes(value.slice(1));
    if (value.startsWith('#')) return this.props.id === value.slice(1);
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(value);
    if (attribute) return attribute[1] in this.props && (attribute[2] === undefined || this.props[attribute[1]] === attribute[2]);
    return this.type === value;
  }); }
  closest(selector: string): RenderNode | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector: string) { return descendants(this).filter(item => item !== this && item.matches(selector)); }
  querySelector<T = RenderNode>(selector: string): T | null { return (this.querySelectorAll(selector)[0] ?? null) as T | null; }
  getRootNode() { return globalThis.document; }
  setSelectionRange(start: number, end: number, direction: string) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  focus() {} select() {}
}
function descendants(root: RenderNode): RenderNode[] { return [root, ...root.children.flatMap(descendants)]; }
function insert(target: RenderNode, parent: RenderNode, anchor: RenderNode | null = null) {
  if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
  target.parent = parent;
  const index = anchor ? parent.children.indexOf(anchor) : -1;
  if (index < 0) parent.children.push(target); else parent.children.splice(index, 0, target);
}
const renderer = createRenderer<RenderNode, RenderNode>({
  createElement: type => new RenderNode(type), createText: text => new RenderNode('#text', text), createComment: text => new RenderNode('#comment', text),
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.children = []; node.text = text; },
  patchProp: (node, key, _, value) => { node.props[key] = value; if (key === 'style') node.style = { ...node.style, ...value }; if (key === 'value') node.value = value; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  insert, remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
});
function find(root: RenderNode, selector: string): RenderNode {
  const found = descendants(root).find(item => item.matches(selector));
  if (!found) throw new Error(`Missing rendered ${selector}`); return found;
}
function withProp(root: RenderNode, key: string, value: unknown): RenderNode { const found = descendants(root).find(item => item.props[key] === value); if (!found) throw new Error(`Missing ${key}=${String(value)}`); return found; }
function fire(target: RenderNode, kind: string, patch: Record<string, unknown> = {}) {
  const event = { target, currentTarget: target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...patch };
  const name = `on${kind[0].toUpperCase()}${kind.slice(1)}`, handlers = target.props[name];
  for (const handler of Array.isArray(handlers) ? handlers : handlers ? [handlers] : []) handler(event);
  for (const handler of target.listeners.get(kind) ?? []) handler(event);
}
async function click(target: RenderNode) { expect(target.props.disabled, 'cannot activate a disabled control').not.toBe(true); fire(target, 'click'); await settle(); }
async function input(target: RenderNode, value: string) { target.value = value; fire(target, 'input'); await settle(); }
async function editSetting(root: RenderNode, key: string, value: string) { const target = withProp(root, 'data-setting', key); target.value = value; fire(target, target.type === 'select' ? 'change' : 'input'); await settle(); }
async function settle() { for (let index = 0; index < 24; index++) { await Promise.resolve(); await nextTick(); } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

const ROOT = 'D:/VueRootFixtures', A = `${ROOT}/alpha`, B = `${ROOT}/beta`;
const oid = (char: string) => char.repeat(40);
function repository(path = A): Repository { return { id: path === A ? 'fixture-alpha' : 'fixture-beta', path, name: path === A ? 'Alpha fixture' : 'Beta fixture', gitDir: `${path}/.git`, commonDir: `${path}/.git`, head: oid(path === A ? 'a' : 'b'), branch: path === A ? 'alpha-main' : 'beta-main', trusted: true, bare: false }; }
function changed(path: string, patch: Partial<ChangedFile> = {}): ChangedFile { return { path, oldPath: null, status: ' M', additions: 1, deletions: 1, staged: false, unstaged: true, ...patch }; }
const files = () => [changed('src/partial.ts', { status: 'MM', staged: true }), changed('new.txt', { status: '??' })];
function snapshot(repo = repository(), list = files()): RepositorySnapshot { return {
  repository: repo, fingerprint: `fixture-snapshot:${repo.id}`, working: { files: list, head: repo.head, branch: repo.branch, ahead: 0, behind: 0, conflicts: 0, operation: null, upstream: 'origin/main', trackingKnown: true },
  refs: [{ name: repo.branch!, fullName: `refs/heads/${repo.branch}`, oid: repo.head!, current: true, kind: 'branch', upstream: 'origin/main', subject: '' }],
  stashes: [], remotes: [{ name: 'origin', fetchUrl: 'https://example.test/fixture.git', pushUrl: 'https://example.test/fixture.git' }],
}; }
function commit(id = oid('a'), subject = 'Literal alpha history'): Commit { return { oid: id, parents: [], author: 'Fixture author', email: 'fixture@example.test', authoredAt: 1, committedAt: 2, subject, refs: [] }; }
function detail(id = oid('a'), subject = 'Literal alpha detail'): CommitDetail { return { commit: commit(id, subject), body: 'Literal fixture detail body', committer: 'Fixture', committerEmail: 'fixture@example.test', signature: { status: '', signer: '', key: '' }, base: null, files: [changed('src/partial.ts')] }; }
const patch: DiffResult = { patch: 'diff --git a/src/partial.ts b/src/partial.ts\n--- a/src/partial.ts\n+++ b/src/partial.ts\n@@ -1 +1 @@\n-fixture before\n+fixture after\n', binary: false, truncated: false, oldContent: null, newContent: null };
function controlledFakeHost(saved = defaultState()) {
  const observations = new Map([[repository(A).id, snapshot(repository(A))], [repository(B).id, snapshot(repository(B), [changed('beta-only.txt')])]]);
  const persisted: PersistedState[] = [];
  let changeListener: ((id: string) => void) | undefined;
  const unlistenRepository = vi.fn(), unlistenExternal = vi.fn();
  const methods = {
    loadState: vi.fn<Host['loadState']>().mockImplementation(async () => structuredClone(saved)),
    diagnostics: vi.fn<Host['diagnostics']>().mockResolvedValue({ appVersion: '0.3.0', gitVersion: 'fixture-only', gitPath: null, platform: 'fixture', hostMode: 'desktop' }),
    saveState: vi.fn<Host['saveState']>().mockImplementation(async state => { persisted.push(structuredClone(state)); }),
    openRepository: vi.fn<Host['openRepository']>().mockImplementation(async path => repository(path)),
    deactivateRepository: vi.fn<NonNullable<Host['deactivateRepository']>>().mockResolvedValue(undefined),
    pickRepository: vi.fn<Host['pickRepository']>().mockResolvedValue(null),
    snapshot: vi.fn<Host['snapshot']>().mockImplementation(async id => structuredClone(observations.get(id)!)),
    history: vi.fn<Host['history']>().mockImplementation(async query => ({ commits: query.repoId === repository(A).id ? [commit(), commit(oid('c'), 'Second loaded fixture')] : [commit(oid('b'), 'Literal beta history')], hasMore: false })),
    commitDetail: vi.fn<Host['commitDetail']>().mockImplementation(async (_, id) => detail(id)),
    compare: vi.fn<Host['compare']>().mockResolvedValue([changed('src/partial.ts')]),
    diff: vi.fn<Host['diff']>().mockResolvedValue(patch),
    submodules: vi.fn<Host['submodules']>().mockResolvedValue([]),
    discoverRepositories: vi.fn<Host['discoverRepositories']>().mockResolvedValue({ root: ROOT, repositories: [A, B].map(path => ({ path, components: [path.split('/').at(-1)!], marker: 'git-directory' })), complete: true, limit: null, warnings: [], directories: 2, entries: 2 }),
    probeRepository: vi.fn<NonNullable<Host['probeRepository']>>().mockImplementation(async item => ({ path: item.path, branch: null, head: null, trusted: false, bare: false, changes: null, staged: null, unstaged: null, untracked: null, ahead: null, behind: null, upstream: null })),
    workingAction: vi.fn<NonNullable<Host['workingAction']>>().mockResolvedValue({ output: 'Literal fixture write result', operation: null }),
    action: vi.fn<Host['action']>().mockResolvedValue({ output: 'Literal fixture action result', operation: null }),
    repoConfig: vi.fn<Host['repoConfig']>().mockResolvedValue({ userName: 'Fixture', userEmail: 'fixture@example.test', globalUserName: '', globalUserEmail: '', signingKey: '', signCommits: false }),
    cancel: vi.fn<Host['cancel']>().mockResolvedValue(undefined),
    openEditor: vi.fn<Host['openEditor']>().mockResolvedValue(undefined), openTerminal: vi.fn<Host['openTerminal']>().mockResolvedValue(undefined),
    checkForUpdates: vi.fn<Host['checkForUpdates']>(), trustRepository: vi.fn<Host['trustRepository']>(),
    onRepositoryChanged: vi.fn<Host['onRepositoryChanged']>().mockImplementation(async callback => { changeListener = callback; return unlistenRepository; }),
    onExternalSession: vi.fn<Host['onExternalSession']>().mockImplementation(async (_callback: (session: ExternalSession) => void) => unlistenExternal),
  };
  // Unsupported capabilities remain absent, not permissive success-returning mocks.
  return { host: methods as unknown as Host, methods, observations, persisted, unlistenRepository, unlistenExternal, emitChange: (id: string) => changeListener?.(id) };
}
function componentNodes(instance: ComponentInternalInstance | null): VNode[] {
  if (!instance) return [];
  const visit = (vnode: VNode): VNode[] => [vnode, ...(vnode.component ? visit(vnode.component.subTree) : Array.isArray(vnode.children) ? vnode.children.filter((child): child is VNode => Boolean(child && typeof child === 'object' && '__v_isVNode' in child)).flatMap(visit) : [])];
  return visit(instance.subTree);
}
const mounted: { unmount(): void }[] = [];
function mount(fake = controlledFakeHost()) {
  const root = new RenderNode('root'), app = renderer.createApp(App, { host: fake.host });
  const warnings: string[] = [];
  app.config.warnHandler = message => warnings.push(message); app.provide(ssrContextKey, {}); app.mount(root);
  const handle = { unmount: () => app.unmount() }; mounted.push(handle);
  const component = (target: Component, choose: (node: VNode) => boolean = () => true): VNode => {
    const found = componentNodes(app._instance).find(vnode => vnode.type === target && choose(vnode));
    if (!found) throw new Error(`Missing mounted component ${(target as { __name?: string }).__name}`); return found;
  };
  const emit = (target: Component, event: string, ...args: unknown[]) => {
    const handler = component(target).props?.[event]; if (typeof handler !== 'function') throw new Error(`Missing emitted callback ${event}`); return handler(...args);
  };
  return { ...fake, root, app, warnings, component, emit, unmount: handle.unmount };
}
type Fixture = ReturnType<typeof mount>;
async function open(fixture: Fixture, path = A) { await fixture.emit(RepositoryOpenDialog, 'onRequest', { mode: 'repository', path, depth: 0 }); await settle(); }
function local(fixture: Fixture): LocalChangesController { return fixture.component(LocalChangesPanel).props!.controller; }
function actions(fixture: Fixture): ActionsController { return fixture.component(ActionDialog).props!.controller; }
function shell(fixture: Fixture) { return find(fixture.root, '.app-shell'); }
function localColumn(fixture: Fixture) { return find(fixture.root, '.local-column'); }
function sidebarWidth(fixture: Fixture): string { return find(fixture.root, '.sidebar-panel').style.width; }
function sidebarState(width = 384, collapsed = false): PersistedState {
  const saved = defaultState(); saved.directoryScope = { root: ROOT, depth: 0, width, collapsed, collapsedPaths: [] }; return saved;
}
function row(fixture: Fixture, group: string, path: string): RenderNode { const found = descendants(fixture.root).find(item => item.type === 'li' && item.props['data-group'] === group && item.props['data-path'] === path); if (!found) throw new Error(`Missing local row ${group}/${path}`); return found; }

function eventTarget() {
  const target = new EventTarget();
  return Object.assign(target, { addEventListener: vi.fn(target.addEventListener.bind(target)), removeEventListener: vi.fn(target.removeEventListener.bind(target)) });
}
function documentPointer(type: 'pointermove' | 'pointerup' | 'pointercancel', pointerId: number, clientX: number) {
  documentEvents.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX }));
}
let windowEvents: ReturnType<typeof eventTarget> & { innerWidth: number };
let documentEvents: ReturnType<typeof eventTarget> & { documentElement: { dataset: Record<string, string>; classList: { toggle: ReturnType<typeof vi.fn> } } };
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  initI18n('en', []); vi.useFakeTimers();
  documentEvents = Object.assign(eventTarget(), { documentElement: { dataset: {}, classList: { toggle: vi.fn() } } });
  media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  windowEvents = Object.assign(eventTarget(), { innerWidth: 1280 });
  vi.stubGlobal('window', windowEvents);
  vi.stubGlobal('document', documentEvents); vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' }); vi.stubGlobal('Element', RenderNode); vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Root fixture must not perform network requests'); }));
});
afterEach(async () => { for (const app of mounted.splice(0)) app.unmount(); await settle(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); initI18n('en', []); });

describe('real Vue App root integration (controlled Host fixtures, not native/userusage)', () => {
  it('runs root setup/mounted/unmount, initializes exactly once and never invents a repository or starts network/usage', async () => {
    const f = mount(); await settle();
    expect(f.methods.loadState).toHaveBeenCalledOnce(); expect(f.methods.diagnostics).toHaveBeenCalledOnce();
    expect(f.methods.onRepositoryChanged).toHaveBeenCalledOnce(); expect(f.methods.onExternalSession).toHaveBeenCalledOnce();
    expect(f.methods.openRepository).not.toHaveBeenCalled(); expect(f.methods.snapshot).not.toHaveBeenCalled();
    expect(shell(f).props['data-repo-id']).toBe(''); expect(shell(f).props['data-task-state']).toBe('idle');
    expect(f.root.textContent).toContain('Open repository / directory'); expect(documentEvents.documentElement.dataset.theme).toBe('dark');
    expect(f.methods.checkForUpdates).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(f.warnings.filter(message => /recursive|undefined|invalid prop/i.test(message))).toEqual([]);
    f.unmount(); await settle();
    expect(documentEvents.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(f.unlistenRepository).toHaveBeenCalledOnce(); expect(f.unlistenExternal).toHaveBeenCalledOnce();
    expect(f.methods.deactivateRepository).toHaveBeenCalledOnce(); mounted.splice(mounted.length - 1, 1);
  });

  it('renders the sidebar as a fixed-pixel aside beside the main remainder and a real SizeHandle (state contract, not geometry)', async () => {
    const f = mount(); await settle();
    expect(find(f.root, '.shell-split').type).toBe('div');
    expect(find(f.root, '.sidebar-panel').type).toBe('aside');
    expect(sidebarWidth(f)).toBe('340px');
    expect(find(f.root, '.main-workspace').type).toBe('section');
    const separator = find(f.root, '.sidebar-separator');
    expect(separator.props).toMatchObject({ role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-valuemin': 300, 'aria-valuemax': 640, 'aria-valuenow': 340 });
    expect(f.component(SizeHandle, node => node.props!.class === 'sidebar-separator').component!.props).toMatchObject({ modelValue: 340, min: 300, max: 640, owner: '' });
    for (const selector of ['.shell-split', '.sidebar-panel', '.main-workspace']) {
      expect(find(f.root, selector).props).not.toHaveProperty('onResize');
      expect(find(f.root, selector).props).not.toHaveProperty('default-size');
      expect(find(f.root, selector).props).not.toHaveProperty('size-unit');
    }
  });

  it('keeps sidebar384 unchanged across 1280→1455→1280 without a window layout listener or resize persistence callback', async () => {
    const f = mount(controlledFakeHost(sidebarState())); await settle(); await vi.advanceTimersByTimeAsync(241); await settle();
    const aside = find(f.root, '.sidebar-panel'), separator = find(f.root, '.sidebar-separator');
    const savedBefore = f.methods.saveState.mock.calls.length;
    expect(sidebarWidth(f)).toBe('384px');
    expect(windowEvents.addEventListener.mock.calls.filter(([name]) => name === 'resize')).toEqual([]);
    for (const width of [1455, 1280]) {
      windowEvents.innerWidth = width; windowEvents.dispatchEvent(new Event('resize')); await settle();
      expect(find(f.root, '.sidebar-panel')).toBe(aside); expect(find(f.root, '.sidebar-separator')).toBe(separator);
      expect(sidebarWidth(f)).toBe('384px'); expect(separator.props['aria-valuenow']).toBe(384);
    }
    await vi.advanceTimersByTimeAsync(241); await settle();
    expect(f.methods.saveState).toHaveBeenCalledTimes(savedBefore);
    expect(f.persisted.every(state => state.directoryScope?.width === 384)).toBe(true);
  });

  it('restores the same aside width after asynchronous state and directory loading without saving a boot340 layout callback', async () => {
    const saved = sidebarState(), fake = controlledFakeHost(saved);
    const loading = deferred<PersistedState>(), scanning = deferred<Awaited<ReturnType<Host['discoverRepositories']>>>();
    fake.methods.loadState.mockReturnValueOnce(loading.promise);
    fake.methods.discoverRepositories.mockReturnValueOnce(scanning.promise);
    const f = mount(fake), aside = find(f.root, '.sidebar-panel'); await settle();
    expect(sidebarWidth(f)).toBe('340px'); expect(f.methods.saveState).not.toHaveBeenCalled();
    loading.resolve(structuredClone(saved)); await settle();
    expect(f.methods.discoverRepositories).toHaveBeenCalledExactlyOnceWith(ROOT, 0, expect.any(String));
    expect(sidebarWidth(f)).toBe('340px'); expect(f.methods.saveState).not.toHaveBeenCalled();
    scanning.resolve({ root: ROOT, repositories: [], complete: true, limit: null, warnings: [], directories: 1, entries: 0 }); await settle();
    expect(find(f.root, '.sidebar-panel')).toBe(aside); expect(sidebarWidth(f)).toBe('384px');
    expect(find(f.root, '.sidebar-separator').props['aria-valuenow']).toBe(384);
    expect(f.methods.saveState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(241); await settle();
    // Directory restoration queues its own persisted scope; no size watcher writes 340 back.
    expect(f.persisted.length).toBeGreaterThan(0);
    expect(f.persisted.every(state => state.directoryScope?.width === 384)).toBe(true);
  });

  it('persists only actual SizeHandle keyboard updates with the real step, shift step and300/640 bounds', async () => {
    const f = mount(controlledFakeHost(sidebarState())); await settle(); await vi.advanceTimersByTimeAsync(241); await settle();
    const separator = find(f.root, '.sidebar-separator'), savedBefore = f.methods.saveState.mock.calls.length;
    fire(separator, 'keydown', { key: 'Escape' }); await settle(); await vi.advanceTimersByTimeAsync(241); await settle();
    expect(sidebarWidth(f)).toBe('384px'); expect(f.methods.saveState).toHaveBeenCalledTimes(savedBefore);
    for (const [key, shiftKey, expected] of [['ArrowRight', false, 392], ['ArrowLeft', true, 352], ['Home', false, 300], ['ArrowLeft', false, 300], ['End', false, 640], ['ArrowRight', false, 640]] as const) {
      fire(separator, 'keydown', { key, shiftKey }); await settle();
      expect(sidebarWidth(f)).toBe(`${expected}px`); expect(separator.props['aria-valuenow']).toBe(expected);
      await vi.advanceTimersByTimeAsync(241); await settle();
      expect(f.persisted.at(-1)!.directoryScope?.width).toBe(expected);
    }
    expect(f.persisted.some(state => state.directoryScope?.width === 340)).toBe(false);
  });

  it('handles real SizeHandle pointer events through document listeners with rounding, clamps and cleanup after release', async () => {
    const f = mount(controlledFakeHost(sidebarState())); await settle(); await vi.advanceTimersByTimeAsync(241); await settle();
    const separator = find(f.root, '.sidebar-separator');
    fire(separator, 'pointerdown', { button: 0, pointerId: 17, clientX: 100 }); await settle();
    const registrations = documentEvents.addEventListener.mock.calls.filter(([name]) => ['pointermove', 'pointerup', 'pointercancel'].includes(name));
    expect(registrations.map(([name]) => name)).toEqual(['pointermove', 'pointerup', 'pointercancel']);
    documentPointer('pointermove', 18, 400); await settle(); expect(sidebarWidth(f)).toBe('384px');
    documentPointer('pointermove', 17, 228.6); await settle(); expect(sidebarWidth(f)).toBe('513px');
    documentPointer('pointermove', 17, 1000); await settle(); expect(sidebarWidth(f)).toBe('640px');
    documentPointer('pointermove', 17, -1000); await settle(); expect(sidebarWidth(f)).toBe('300px');
    documentPointer('pointerup', 17, 228.6); await settle(); expect(sidebarWidth(f)).toBe('513px');
    for (const [name, handler] of registrations) expect(documentEvents.removeEventListener).toHaveBeenCalledWith(name, handler);
    documentPointer('pointermove', 17, 500); await settle(); expect(sidebarWidth(f)).toBe('513px');
    await vi.advanceTimersByTimeAsync(241); await settle();
    expect(f.persisted.at(-1)!.directoryScope?.width).toBe(513);
    expect(f.persisted.some(state => state.directoryScope?.width === 340)).toBe(false);
  });

  it('restarts the same controlled profile at384px without writing the boot340 default to disk', async () => {
    let profile = sidebarState();
    const fake = controlledFakeHost(profile), firstLoad = deferred<PersistedState>(), secondLoad = deferred<PersistedState>();
    fake.methods.loadState.mockReset().mockReturnValueOnce(firstLoad.promise).mockReturnValueOnce(secondLoad.promise);
    fake.methods.saveState.mockImplementation(async state => { profile = structuredClone(state); fake.persisted.push(structuredClone(state)); });
    const first = mount(fake); await settle(); expect(sidebarWidth(first)).toBe('340px');
    firstLoad.resolve(structuredClone(profile)); await settle(); expect(sidebarWidth(first)).toBe('384px');
    await vi.advanceTimersByTimeAsync(241); await settle(); expect(profile.directoryScope?.width).toBe(384);
    first.unmount(); mounted.splice(mounted.length - 1, 1); await settle(); expect(profile.directoryScope?.width).toBe(384);
    const second = mount(fake); await settle(); expect(sidebarWidth(second)).toBe('340px');
    expect(profile.directoryScope?.width).toBe(384);
    secondLoad.resolve(structuredClone(profile)); await settle(); await vi.advanceTimersByTimeAsync(241); await settle();
    expect(fake.methods.loadState).toHaveBeenCalledTimes(2); expect(sidebarWidth(second)).toBe('384px');
    expect(profile.directoryScope?.width).toBe(384); expect(fake.persisted.length).toBeGreaterThan(1);
    expect(fake.persisted.every(state => state.directoryScope?.width === 384)).toBe(true);
  });

  it('keeps the saved width through collapsed startup, reopening and collapse during a live SizeHandle drag', async () => {
    const f = mount(controlledFakeHost(sidebarState(384, true))); await settle(); await vi.advanceTimersByTimeAsync(241); await settle();
    expect(descendants(f.root).some(node => node.matches('.sidebar-panel') || node.matches('.sidebar-separator'))).toBe(false);
    await click(withProp(f.root, 'aria-label', 'Expand repository navigation'));
    expect(sidebarWidth(f)).toBe('384px');
    expect(f.component(SizeHandle, node => node.props!.class === 'sidebar-separator').component!.props.owner).toBe(ROOT);
    const separator = find(f.root, '.sidebar-separator'); fire(separator, 'keydown', { key: 'ArrowRight' }); await settle();
    expect(sidebarWidth(f)).toBe('392px');
    fire(separator, 'pointerdown', { button: 0, pointerId: 23, clientX: 100 }); await settle();
    const registrations = documentEvents.addEventListener.mock.calls.filter(([name]) => ['pointermove', 'pointerup', 'pointercancel'].includes(name));
    await click(withProp(f.root, 'aria-label', 'Collapse repository navigation'));
    for (const [name, handler] of registrations) expect(documentEvents.removeEventListener).toHaveBeenCalledWith(name, handler);
    documentPointer('pointermove', 23, 500); await settle(); await vi.advanceTimersByTimeAsync(241); await settle();
    expect(f.persisted.at(-1)!.directoryScope).toMatchObject({ width: 392, collapsed: true });
    await click(withProp(f.root, 'aria-label', 'Expand repository navigation')); await vi.advanceTimersByTimeAsync(241); await settle();
    expect(sidebarWidth(f)).toBe('392px'); expect(find(f.root, '.sidebar-separator').props['aria-valuenow']).toBe(392);
    expect(f.persisted.at(-1)!.directoryScope).toMatchObject({ width: 392, collapsed: false });
    expect(f.persisted.some(state => state.directoryScope?.width === 340)).toBe(false);
  });

  it('discards a cancelled snapshot even after another activation returns the same repository id', async () => {
    const f = mount(); await settle(); const waiting = deferred<RepositorySnapshot>();
    f.methods.snapshot.mockReturnValueOnce(waiting.promise);
    const obsolete = f.emit(RepositoryOpenDialog, 'onRequest', { mode: 'repository', path: A, depth: 0 }); await settle();
    const generation = shell(f).props['data-open-generation'];
    await f.emit(RepositoryOpenDialog, 'onCancel'); await settle(); await open(f, B); await open(f, A);
    expect(shell(f).props['data-open-generation']).toBeGreaterThan(generation);
    waiting.resolve(snapshot(repository(A), [changed('OBSOLETE-SNAPSHOT.txt')])); await obsolete; await settle();
    expect(local(f).state.groups.flatMap(group => group.entries).map(entry => entry.file.path)).not.toContain('OBSOLETE-SNAPSHOT.txt');
    expect(f.root.textContent).not.toContain('OBSOLETE-SNAPSHOT.txt');
    expect(shell(f).props['data-task-state']).toBe('idle'); expect(f.methods.cancel).toHaveBeenCalled();
  });

  it('does not run a cross-repository tool when its requested open fails or is superseded', async () => {
    const f = mount(); await settle(); await open(f);
    f.methods.openRepository.mockRejectedValueOnce(new Error('Fixture Beta open refused'));
    await f.emit(RepositorySidebar, 'onAction', { kind: 'terminal', repoPath: B }); await settle();
    expect(f.methods.openTerminal).not.toHaveBeenCalled(); expect(f.root.textContent).toContain('Fixture Beta open refused');
    const waiting = deferred<Repository>(); f.methods.openRepository.mockReturnValueOnce(waiting.promise);
    const obsolete = f.emit(RepositorySidebar, 'onAction', { kind: 'terminal', repoPath: B }); await settle();
    await open(f, A); waiting.resolve(repository(B)); await obsolete; await settle();
    expect(shell(f).props['data-repo-id']).toBe(repository(A).id); expect(f.methods.openTerminal).not.toHaveBeenCalled();
  });

  it('waits for the actual snapshot, unwraps nested root refs and expands local changes on the first valid snapshot', async () => {
    const f = mount(), waiting = deferred<RepositorySnapshot>(); await settle();
    f.methods.snapshot.mockReturnValueOnce(waiting.promise);
    const opening = f.emit(RepositoryOpenDialog, 'onRequest', { mode: 'repository', path: A, depth: 0 }); await settle();
    expect(f.methods.history).toHaveBeenCalledOnce(); expect(shell(f).props['data-repo-id']).toBe(repository(A).id);
    expect(shell(f).props['data-task-state']).toBe('running'); expect(local(f).state.snapshot).toBeNull();
    expect(f.root.textContent).toContain('Working state unknown');
    waiting.resolve(snapshot()); await opening; await settle();
    expect(f.component(RepositorySidebar).props!.refs).toEqual(snapshot().refs);
    expect(f.component(HistoryPanel).props!.commits).toHaveLength(2);
    expect(f.component(HistoryPanel).props!.settings).toMatchObject({ theme: 'dark', rowHeight: 28 });
    expect(local(f).state.groups.map(group => [group.id, group.entries.map(entry => entry.file.path)])).toEqual([
      ['staged', ['src/partial.ts']], ['unstaged', ['src/partial.ts']], ['untracked', ['new.txt']],
    ]);
    expect(shell(f).props['data-task-state']).toBe('idle');
    expect(localColumn(f).style.display, 'the initial dirty snapshot must show the real local panel').not.toBe('none');
  });

  it('routes partially staged and untracked rows to actual HEAD→INDEX / INDEX→WORKTREE Host diffs', async () => {
    const f = mount(); await settle(); await open(f);
    await click(find(row(f, 'staged', 'src/partial.ts'), '.ch-file-open'));
    expect(f.methods.diff.mock.calls.at(-1)![0]).toMatchObject({ repoId: repository(A).id, base: repository(A).head, target: 'INDEX', staged: true, path: 'src/partial.ts' });
    expect(f.component(DiffPanel).props!.controller.state.status).toBe('ready');
    expect(f.root.textContent).toContain('fixture after');
    await click(find(row(f, 'unstaged', 'src/partial.ts'), '.ch-file-open'));
    expect(f.methods.diff.mock.calls.at(-1)![0]).toMatchObject({ repoId: repository(A).id, base: 'INDEX', target: 'WORKTREE', staged: false, path: 'src/partial.ts' });
    await click(find(row(f, 'untracked', 'new.txt'), '.ch-file-open'));
    expect(f.methods.diff.mock.calls.at(-1)![0]).toMatchObject({ repoId: repository(A).id, base: 'ROOT', target: 'WORKTREE', path: 'new.txt' });
    expect(f.methods.workingAction).not.toHaveBeenCalled(); expect(f.methods.action).not.toHaveBeenCalled();
  });

  it('toggles the same repository without reopening, preserves the user choice on refresh and restores per-repository drafts', async () => {
    const f = mount(); await settle(); await open(f);
    await click(withProp(f.root, 'aria-label', 'Toggle local changes'));
    const before = localColumn(f).style.display, generation = shell(f).props['data-open-generation'];
    await f.emit(RepositorySidebar, 'onSelect', A); await settle();
    expect(localColumn(f).style.display === 'none').toBe(before !== 'none');
    expect(shell(f).props['data-open-generation']).toBe(generation); expect(f.methods.openRepository).toHaveBeenCalledOnce();
    await input(find(f.root, '.ch-message'), 'Alpha unsaved fixture draft');
    const choice = localColumn(f).style.display;
    await click(withProp(f.root, 'aria-label', 'Refresh current repository'));
    expect(localColumn(f).style.display).toBe(choice);
    await f.emit(RepositorySidebar, 'onSelect', B); await settle();
    expect(find(f.root, '.ch-message').props.value).toBe('');
    await input(find(f.root, '.ch-message'), 'Beta unsaved fixture draft');
    await f.emit(RepositorySidebar, 'onSelect', A); await settle();
    expect(find(f.root, '.ch-message').props.value).toBe('Alpha unsaved fixture draft');
    expect(local(f).state.selected).toBeNull();
  });

  it('invalidates late detail and diff results across A→B→A even though A has the same repository id', async () => {
    const f = mount(); await settle(); await open(f);
    const oldGeneration = shell(f).props['data-open-generation'], lateDetail = deferred<CommitDetail>();
    f.methods.commitDetail.mockReturnValueOnce(lateDetail.promise);
    f.emit(HistoryPanel, 'onSelect', commit(), true); await settle();
    await f.emit(RepositorySidebar, 'onSelect', B); await settle(); await f.emit(RepositorySidebar, 'onSelect', A); await settle();
    expect(shell(f).props['data-open-generation']).toBeGreaterThan(oldGeneration);
    lateDetail.resolve(detail(oid('a'), 'OBSOLETE DETAIL MUST NOT RENDER')); await settle();
    expect(f.root.textContent).not.toContain('OBSOLETE DETAIL MUST NOT RENDER');
    const lateDiff = deferred<DiffResult>(); f.methods.diff.mockReturnValueOnce(lateDiff.promise);
    await click(find(row(f, 'unstaged', 'src/partial.ts'), '.ch-file-open'));
    await f.emit(RepositorySidebar, 'onSelect', B); await settle(); await f.emit(RepositorySidebar, 'onSelect', A); await settle();
    lateDiff.resolve({ ...patch, patch: patch.patch.replace('fixture after', 'OBSOLETE DIFF MUST NOT RENDER') }); await settle();
    expect(f.root.textContent).not.toContain('OBSOLETE DIFF MUST NOT RENDER'); expect(local(f).state.selected).toBeNull();
    expect(f.methods.cancel).toHaveBeenCalled();
  });

  it('keeps write busy through the real result and post-write snapshot and blocks navigation until both settle', async () => {
    const f = mount(); await settle(); await open(f);
    const writing = deferred<Awaited<ReturnType<NonNullable<Host['workingAction']>>>>(), refreshing = deferred<RepositorySnapshot>();
    f.methods.workingAction.mockReturnValueOnce(writing.promise);
    await click(withProp(row(f, 'unstaged', 'src/partial.ts'), 'data-action', 'stage-file'));
    expect(f.methods.workingAction).toHaveBeenCalledOnce(); expect(shell(f).props['data-action-busy']).toBe(true);
    expect(withProp(f.root, 'aria-label', 'Refresh current repository').props.disabled).toBe(true);
    expect(f.root.textContent).not.toContain('Literal fixture write result');
    await f.emit(RepositorySidebar, 'onSelect', B); await f.emit(RepositorySidebar, 'onAction', { kind: 'terminal', repoPath: B }); await settle();
    expect(f.methods.openRepository).toHaveBeenCalledOnce(); expect(f.methods.openTerminal).not.toHaveBeenCalled();
    f.methods.snapshot.mockReturnValueOnce(refreshing.promise); writing.resolve({ output: 'Literal fixture write result', operation: null }); await settle();
    expect(shell(f).props['data-action-busy']).toBe(true); expect(f.root.textContent).not.toContain('Literal fixture write result');
    refreshing.resolve(snapshot()); await settle();
    expect(shell(f).props['data-action-busy']).toBe(false); expect(f.root.textContent).toContain('Literal fixture write result');
    await f.emit(RepositorySidebar, 'onSelect', B); await settle(); expect(shell(f).props['data-repo-id']).toBe(repository(B).id);
  });

  it('binds repository menu/toolbar actions to their actual target and routes missing upstream to setup, never a fabricated sync', async () => {
    const f = mount(); await settle(); await open(f);
    f.observations.get(repository(B).id)!.working.upstream = null;
    await f.emit(RepositorySidebar, 'onAction', { kind: 'settings', repoPath: B }); await settle();
    expect(shell(f).props['data-repo-id']).toBe(repository(B).id);
    expect(f.component(SettingsDialog).props).toMatchObject({ open: true, scope: 'repository', repo: { id: repository(B).id } });
    f.emit(SettingsDialog, 'onUpdate:open', false); await settle();
    const menu = f.component(RepositoryMenu, vnode => vnode.component!.props.repoPath === B);
    await menu.props!.onAction({ kind: 'terminal', repoPath: B }); await settle();
    expect(f.methods.openTerminal).toHaveBeenCalledExactlyOnceWith(repository(B).id);
    const sync = descendants(find(f.root, '.repository-commandbar')).find(node => node.type === 'button' && node.textContent.startsWith('Sync changes'))!;
    expect(sync).toBeDefined(); await click(sync);
    expect(actions(f).state.kind).toBe('set-upstream'); expect(actions(f).state.binding?.repoId).toBe(repository(B).id);
    expect(f.methods.workingAction).not.toHaveBeenCalled(); expect(f.methods.action).not.toHaveBeenCalled();
    expect(f.root.textContent).not.toContain('Operation completed and refreshed.');
  });

  it('saves global and replacement repo preferences through real dialog controls and retains a retryable failed draft', async () => {
    const saved = defaultState(); saved.repoSettings[repository(A).id] = { rowHeight: 31 };
    const f = mount(controlledFakeHost(saved)); await settle(); await open(f);
    await click(withProp(f.root, 'aria-label', 'Open global settings'));
    await editSetting(f.root, 'theme', 'light');
    f.methods.saveState.mockRejectedValueOnce(new Error('Fixture persistence unavailable'));
    await click(withProp(f.root, 'data-action', 'save-settings'));
    expect(f.root.textContent).toContain('Fixture persistence unavailable');
    expect(withProp(f.root, 'data-setting', 'theme').props.value).toBe('light');
    expect(withProp(f.root, 'data-action', 'save-settings').props.disabled).toBe(false);
    expect(documentEvents.documentElement.dataset.theme).toBe('light');
    await click(withProp(f.root, 'data-action', 'save-settings'));
    expect(f.component(SettingsDialog).component!.props.saveError).toBe(''); expect(f.persisted.at(-1)!.settings.theme).toBe('light');
    f.emit(SettingsDialog, 'onUpdate:open', false); await settle();
    await f.emit(RepositorySidebar, 'onAction', { kind: 'settings', repoPath: A }); await settle();
    expect(f.component(SettingsDialog).props!.scope).toBe('repository');
    const inherit = withProp(f.root, 'data-inherit-setting', 'rowHeight'); await click(inherit);
    await editSetting(f.root, 'theme', 'dark');
    f.methods.saveState.mockRejectedValueOnce(new Error('Fixture repository save refused'));
    await click(withProp(f.root, 'data-action', 'save-settings'));
    expect(f.component(SettingsDialog).component!.props.saveError).toBe('Fixture repository save refused');
    expect(withProp(f.root, 'data-setting', 'theme').props.value).toBe('dark');
    expect(withProp(f.root, 'data-action', 'save-settings').props.disabled).toBe(false);
    await click(withProp(f.root, 'data-action', 'save-settings'));
    expect(f.component(SettingsDialog).component!.props.saveError).toBe('');
    expect(f.persisted.at(-1)!.repoSettings[repository(A).id]).toEqual({ theme: 'dark' });
    expect(f.persisted.at(-1)!.settings.theme).toBe('light'); expect(documentEvents.documentElement.dataset.theme).toBe('dark');
    expect(f.methods.history).toHaveBeenCalledOnce(); expect(f.methods.snapshot).toHaveBeenCalledOnce();
  });

  it('distinguishes loaded filter from native full-history search and binds selection to the real inspector', async () => {
    const f = mount(); await settle(); await open(f);
    f.emit(HistoryPanel, 'onSelect', commit(), true); await settle();
    expect(f.component(CommitInspector).props!.controller.state.selected).toBe(oid('a'));
    const history = f.component(CommitInspector).props!.controller as HistoryController;
    expect(history.state.detail?.body).toBe('Literal fixture detail body');
    const reads = f.methods.history.mock.calls.length;
    f.emit(HistoryQueryDialog, 'onApply', { scope: { kind: 'all' }, search: 'Second loaded', searchMode: 'message', queryMode: 'filter', filter: {} }); await settle();
    expect(f.methods.history).toHaveBeenCalledTimes(reads);
    expect(f.component(HistoryPanel).props!.commits.map((item: Commit) => item.oid)).toEqual([oid('c')]);
    f.emit(HistoryQueryDialog, 'onApply', { scope: { kind: 'all' }, search: 'Full fixture search', searchMode: 'author', queryMode: 'search', filter: {} }); await settle();
    expect(f.methods.history.mock.calls.at(-1)![0]).toMatchObject({ search: 'Full fixture search', searchMode: 'author', offset: 0 });
    expect(f.component(HistoryPanel).props!.query.queryMode).toBe('search');
    expect(f.component(HistoryPanel).props!.commits).toHaveLength(2);
  });
});
