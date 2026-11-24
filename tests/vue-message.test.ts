import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, defineComponent, h, nextTick, reactive, ssrContextKey, type Component } from 'vue';
import * as Vue from 'vue';
import { renderToString } from 'vue/server-renderer';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import MessageText from '../src/components/MessageText.vue';
import HistorySfc from '../src/components/HistoryPanel.vue';
import InspectorSfc from '../src/components/CommitInspector.vue';
import FileTreeSfc from '../src/components/FileTree.vue';
import { createHistoryController } from '../src/controllers/history';
import { initI18n } from '../src/lib/i18n';
import { DEFAULT_SETTINGS, type Commit, type GitRef, type Host, type Repository } from '../src/shared/protocol';

// Exercise the actual SFC setup and compiled template with Vue's client renderer.
// Only template compilation differs from Vitest's default node/SSR transform.
function client(component: Component, file: string): Component {
  const filename = fileURLToPath(new URL(file, import.meta.url));
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'message-test', fs: { fileExists: existsSync, readFile: path => readFileSync(path, 'utf8') } });
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: 'message-test', compilerOptions: { bindingMetadata: script.bindings, mode: 'function' } });
  if (result.errors.length) throw new Error(String(result.errors[0]));
  const target = component as { render?: unknown; ssrRender?: unknown };
  const javascript = ts.transpileModule(result.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  target.render = new Function('Vue', javascript)(Vue); delete target.ssrRender; return component;
}
const HistoryPanel = client(HistorySfc, '../src/components/HistoryPanel.vue');
const CommitInspector = client(InspectorSfc, '../src/components/CommitInspector.vue');
client(FileTreeSfc, '../src/components/FileTree.vue');
interface TestNode { type: string; text: string; props: Record<string, unknown>; children: TestNode[]; parent: TestNode | null; value: unknown; selectedIndex: number; options: TestNode[]; addEventListener(name: string, callback: unknown): void }
const node = (type: string, text = ''): TestNode => ({ type, text, props: {}, children: [], parent: null, value: '', selectedIndex: -1,
  get options() { return this.children.filter(child => child.type === 'option'); },
  addEventListener(name, callback) { this.props[`directive:${name}`] = callback; },
});
const renderer = createRenderer<TestNode, TestNode>({
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; }, setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _old, value) => { target.props[key] = value; if (key === 'value') target.value = value; }, parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  insert: (target, parent, anchor = null) => {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    target.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(target); else parent.children.splice(index, 0, target);
  },
  remove: target => { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = null; },
});
const mounted: { unmount(): void }[] = [];
function mount(component: Component, props: Record<string, unknown>) {
  const input = reactive(props), root = node('root'), app = renderer.createApp(defineComponent({ setup: () => () => h(component, input) }));
  app.provide(ssrContextKey, {}); app.mount(root); mounted.push(app); return { root, props: input };
}
const all = (target: TestNode): TestNode[] => [target, ...target.children.flatMap(all)];
const content = (target: TestNode): string => target.text + target.children.filter(child => child.type !== '#comment').map(content).join('');
function find(root: TestNode, predicate: (target: TestNode) => boolean): TestNode {
  const found = all(root).find(predicate); if (!found) throw new Error('Expected rendered node is missing'); return found;
}
function event(extra: Record<string, unknown> = {}) {
  return { defaultPrevented: false, stopped: false, key: '', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0,
    target: { closest: () => null, isContentEditable: false },
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
}
function dispatch(target: TestNode, name: string, value = event()): void {
  for (let current: TestNode | null = target; current && !value.stopped; current = current.parent) {
    const handler = current.props[`on${name}`];
    for (const fn of Array.isArray(handler) ? handler : handler ? [handler] : []) (fn as (value: unknown) => void)(value);
  }
}
const settings = () => ({ ...structuredClone(DEFAULT_SETTINGS), markdown: true, issueUrl: 'https://issues.example/{id}', issueRules: [{ pattern: '\\bTEAM-(\\d+)\\b', url: 'https://team.example/{id}' }] });
const ref: GitRef = { name: 'main', fullName: 'refs/heads/main', oid: 'a'.repeat(40), kind: 'branch', current: true, upstream: null, subject: '' };
const commit = (oid = 'a'.repeat(40)): Commit => ({ oid, parents: [], subject: ':bug: **fix** #7 TEAM-42 https://example.test/docs', author: 'Actual Author', email: 'a@example.test', authoredAt: 1, committedAt: 2, refs: [ref] });
function history(extra: Record<string, unknown> = {}) {
  const compare = vi.fn(), select = vi.fn(), refContext = vi.fn(), openUrl = vi.fn(), context = vi.fn();
  return { ...mount(HistoryPanel, { commits: [commit()], settings: settings(), selected: 'b'.repeat(40), onCompare: compare, onSelect: select, onRefContext: refContext, onOpenUrl: openUrl, onContext: context, ...extra }), compare, select, refContext, openUrl, context };
}
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); initI18n('en', []); vi.unstubAllGlobals(); });

describe('formal Vue MessageText compatibility', () => {
  it('renders recursive formal tokens and escapes untrusted HTML without fetching or navigating', async () => {
    const fetch = vi.fn(() => { throw Error('Message rendering must be local'); }); vi.stubGlobal('fetch', fetch);
    const html = await renderToString(createSSRApp({ render: () => h(MessageText, {
      text: '**bold** *italic* ***both*** `:bug: #7` :bug: #7 TEAM-42 [**docs**](https://example.test/a) <img src=x onerror=alert(1)>', settings: settings(),
    }) }));
    expect(html).toMatch(/<strong[^>]*>bold<\/strong>/); expect(html).toMatch(/<em[^>]*>italic<\/em>/); expect(html).toMatch(/<strong[^>]*><em[^>]*>both<\/em><\/strong>/);
    expect(html).toMatch(/<code[^>]*>:bug: #7<\/code>/); expect(html).toContain('href="https://issues.example/7"'); expect(html).toContain('href="https://team.example/42"');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;'); expect(html).not.toContain('<img'); expect(fetch).not.toHaveBeenCalled();
  });

  it('honors markdown/emoji flags and keeps unsafe URLs and custom emoji HTML literal', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(MessageText, { inline: true,
      text: '**literal** :bug: :custom: [bad](javascript:alert(1)) [file](file:///bad) https://user:password@example.test',
      settings: { ...settings(), markdown: false, emoji: false },
    }) }));
    expect(html.startsWith('<span')).toBe(true); expect(html).toContain('**literal** :bug: :custom:'); expect(html).not.toContain('<a'); expect(html).not.toContain('<strong');
    const custom = await renderToString(createSSRApp({ render: () => h(MessageText, { text: ':custom:', settings: { ...settings(), customEmoji: { custom: '<script>unsafe</script>' } } }) }));
    expect(custom).toContain('&lt;script&gt;unsafe&lt;/script&gt;'); expect(custom).not.toContain('<script>');
  });

  it('emits safe link clicks only, suppresses auxiliary navigation and reacts to settings changes', async () => {
    const openUrl = vi.fn(), instance = mount(MessageText, { text: '**fix** #7 https://example.test', settings: settings(), inline: true, onOpenUrl: openUrl });
    const link = find(instance.root, target => target.props.href === 'https://issues.example/7'), click = event(); dispatch(link, 'Click', click);
    expect(click.defaultPrevented).toBe(true); expect(click.stopped).toBe(true); expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://issues.example/7');
    const auxiliary = event(); dispatch(link, 'Auxclick', auxiliary); expect(auxiliary.defaultPrevented).toBe(true); expect(openUrl).toHaveBeenCalledTimes(1);
    instance.props.settings = { ...settings(), markdown: false, issueUrl: 'https://other.example/{id}' }; await nextTick();
    expect(content(instance.root)).toContain('**fix**'); expect(all(instance.root).some(target => target.props.href === 'https://other.example/7')).toBe(true);
  });

  it('uses message rendering in history and inspector subject/body and forwards openUrl', async () => {
    const instance = history(); expect(all(instance.root).some(target => target.type === 'strong' && content(target) === 'fix')).toBe(true);
    dispatch(find(instance.root, target => target.props.href === 'https://issues.example/7'), 'Click', event({ ctrlKey: true }));
    expect(instance.openUrl).toHaveBeenCalledExactlyOnceWith('https://issues.example/7'); expect(instance.compare).not.toHaveBeenCalled(); expect(instance.select).not.toHaveBeenCalled();
    const repo: Repository = { id: 'fixture', path: '/fixture', name: 'Fixture', gitDir: '', commonDir: '', head: ref.oid, branch: 'main', bare: false, trusted: true };
    const source = { cancel: async () => {}, commitDetail: async () => ({ commit: commit(), body: '**Full body**\n#9 https://example.test/body', base: null, files: [], committer: 'Actual Committer', committerEmail: 'c@example.test', signature: { status: 'N', signer: '', key: '' } }) } as unknown as Host;
    const controller = createHistoryController(source); controller.setRepository(repo, 1); await controller.select(commit());
    const openUrl = vi.fn(), inspector = mount(CommitInspector, { controller, settings: settings(), onOpenUrl: openUrl });
    expect(all(inspector.root).some(target => target.type === 'strong' && content(target) === 'Full body')).toBe(true);
    dispatch(find(inspector.root, target => target.props.href === 'https://issues.example/9'), 'Click'); expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://issues.example/9');
    controller.dispose();
  });
});

describe('formal history reference and comparison interactions', () => {
  it('uses real ref buttons for click, context menu and keyboard without selecting or comparing rows', () => {
    const instance = history(), button = find(instance.root, target => target.type === 'button' && target.props['aria-haspopup'] === 'menu');
    for (const [name, value] of [['Click', event({ ctrlKey: true })], ['Contextmenu', event()], ['Keydown', event({ key: 'F10', shiftKey: true })], ['Keydown', event({ key: 'ContextMenu' })]] as const) dispatch(button, name, value);
    expect(instance.refContext).toHaveBeenCalledTimes(4); expect(instance.refContext.mock.calls[0][0]).toMatchObject({ ref: { fullName: ref.fullName, kind: 'branch' }, commit: { oid: ref.oid } });
    expect(instance.select).not.toHaveBeenCalled(); expect(instance.compare).not.toHaveBeenCalled(); expect(instance.context).not.toHaveBeenCalled();
    dispatch(button, 'Keydown', event({ key: 'Enter', target: { closest: () => button } })); expect(instance.select).not.toHaveBeenCalled();
    dispatch(button, 'Keydown', event({ key: 'ContextMenu', isComposing: true })); expect(instance.refContext).toHaveBeenCalledTimes(4);
  });

  it('compares using Shift, Ctrl or Cmd clicks and retains plain selection behavior', () => {
    const instance = history(), row = find(instance.root, target => target.props.role === 'option');
    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey']) dispatch(row, 'Click', event({ [modifier]: true }));
    expect(instance.compare).toHaveBeenCalledTimes(3); expect(instance.compare).toHaveBeenLastCalledWith({ base: 'b'.repeat(40), target: ref.oid });
    dispatch(row, 'Click'); expect(instance.select).toHaveBeenCalledWith(expect.objectContaining({ oid: ref.oid }), false);
  });

  it('protects history keyboard selection from input, links, ref buttons and IME', () => {
    const instance = history({ selected: ref.oid }), list = find(instance.root, target => target.props.role === 'listbox');
    for (const value of [event({ key: 'ArrowDown', isComposing: true }), event({ key: 'ArrowDown', keyCode: 229 }), event({ key: 'ArrowDown', target: { closest: () => ({}) } }), event({ key: 'Enter', ctrlKey: true })]) dispatch(list, 'Keydown', value);
    expect(instance.select).not.toHaveBeenCalled(); dispatch(list, 'Keydown', event({ key: 'Enter' })); expect(instance.select).toHaveBeenCalledWith(expect.objectContaining({ oid: ref.oid }), true);
  });
});
