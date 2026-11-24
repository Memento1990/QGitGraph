import { isLocalizedMessage, onLocaleChange, resolveText, type Localizable, type LocalizedMessage } from '../lib/i18n';
import { m } from '../i18n/common';
import { icon, type IconName } from './icons';

export type { Localizable } from '../lib/i18n';

type Binding = { target: WeakRef<Node>; value: LocalizedMessage; attribute?: string; reference: WeakRef<Binding> };
const bindings = new Set<WeakRef<Binding>>();
const nodeBindings = new WeakMap<Node, Map<string, Binding>>();
const textSlots = new WeakMap<Node, Node>();
const collected = typeof FinalizationRegistry === 'undefined' ? undefined : new FinalizationRegistry<WeakRef<Binding>>(reference => bindings.delete(reference));
function unbind(node: Node, key: string): void {
  const old = nodeBindings.get(node)?.get(key);
  if (old) { bindings.delete(old.reference); collected?.unregister(old); nodeBindings.get(node)!.delete(key); }
}
function bind(node: Node, value: Localizable, attribute?: string): void {
  const key = attribute ?? '#text'; unbind(node, key);
  if (!isLocalizedMessage(value)) return;
  const binding = { target: new WeakRef(node), value, attribute } as Binding; binding.reference = new WeakRef(binding);
  let owned = nodeBindings.get(node); if (!owned) { owned = new Map(); nodeBindings.set(node, owned); }
  owned.set(key, binding); bindings.add(binding.reference); collected?.register(node, binding.reference, binding);
}
/** Own one label's text slot. Subsequent locale changes mutate only that Text node, never the element/inputs around it. */
export function setText(node: Node, value: Localizable): void {
  let text = textSlots.get(node);
  if (text && text !== node && (text.parentNode ?? (text as HTMLElement).parentElement) !== node) { unbind(text, '#text'); text = undefined; }
  if (!text) {
    const isText = node.nodeType === 3 || node.nodeName === '#text' || (node as HTMLElement).tagName === '#text';
    if (isText) text = node;
    else { text = document.createTextNode(''); node.textContent = ''; node.appendChild(text); }
    textSlots.set(node, text);
  }
  text.textContent = resolveText(value); bind(text, value);
}
function writeAttribute(node: Element, name: string, value: string): void {
  node.setAttribute(name, value);
  // Native DOM reflects these automatically; keeping the property in sync also supports small host DOM adapters.
  if (name === 'title' && typeof (node as HTMLElement).title === 'string') (node as HTMLElement).title = value;
}
/** Only explicitly owned presentation attributes are rebound; values and checked/selection state are never touched. */
export function setAttribute(node: Element, name: string, value: Localizable | null): void {
  unbind(node, name);
  if (value === null) { node.removeAttribute(name); return; }
  writeAttribute(node, name, resolveText(value)); bind(node, value, name);
}
/** Dispose only registered bindings inside a component, not arbitrary DOM text. Weak references also cover forgotten detached nodes. */
export function disposeBindings(root: Node): void {
  for (const reference of [...bindings]) {
    const binding = reference.deref(); const target = binding?.target.deref();
    if (!binding || !target) { bindings.delete(reference); continue; }
    let ancestor: Node | null = target;
    while (ancestor && ancestor !== root) ancestor = ancestor.parentNode ?? (ancestor as HTMLElement).parentElement;
    if (ancestor === root) unbind(target, binding.attribute ?? '#text');
  }
}
onLocaleChange(() => {
  for (const reference of [...bindings]) {
    const binding = reference.deref(); const target = binding?.target.deref();
    if (!binding || !target) { bindings.delete(reference); continue; }
    if (binding.attribute) writeAttribute(target as Element, binding.attribute, resolveText(binding.value));
    else target.textContent = resolveText(binding.value);
  }
});

export type Child = Node | Localizable | number | null | undefined | false;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  append(node, ...children);
  return node;
}
export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) parent.appendChild(child);
    else { const text = document.createTextNode(isLocalizedMessage(child) ? resolveText(child) : String(child)); if (isLocalizedMessage(child)) bind(text, child); parent.appendChild(text); }
  }
}
export function button(label: Localizable, action: () => void, glyph?: IconName, className = '', iconOnly = false): HTMLButtonElement {
  const node = el('button', `button ${className}`);
  node.type = 'button';
  setAttribute(node, 'title', label);
  if (glyph) node.append(icon(glyph));
  if (!iconOnly) node.append(el('span', '', label));
  else { node.classList.add('icon-button'); setAttribute(node, 'aria-label', label); }
  node.addEventListener('click', action);
  return node;
}
export function select(options: { value: string; label: Localizable }[], value: string, label: Localizable, onChange?: (value: string) => void): HTMLSelectElement {
  const node = el('select');
  setAttribute(node, 'aria-label', label); setAttribute(node, 'title', label);
  for (const option of options) { const item = el('option', '', option.label); item.value = option.value; node.append(item); }
  node.value = value;
  if (onChange) node.addEventListener('change', () => onChange(node.value));
  return node;
}
export function input(label: Localizable, value = '', type = 'text'): HTMLInputElement {
  const node = el('input'); node.type = type; node.value = value;
  setAttribute(node, 'aria-label', label); return node;
}
export function checkbox(label: Localizable, checked: boolean, onChange?: (checked: boolean) => void): HTMLLabelElement {
  const control = input(label, '', 'checkbox'); control.checked = checked;
  if (onChange) control.addEventListener('change', () => onChange(control.checked));
  return el('label', 'checkbox', control, el('span', '', label));
}
export function field(label: Localizable, control: HTMLElement, hint?: Localizable): HTMLLabelElement {
  return el('label', 'field', el('span', 'field-label', label), control, hint ? el('small', 'muted', hint) : null);
}
export function empty(title: Localizable, detail?: Localizable): HTMLElement {
  return el('div', 'empty-state', el('strong', '', title), detail ? el('p', 'muted', detail) : null);
}
export function loading(label: Localizable, cancel?: () => void): HTMLElement {
  const node = el('div', 'loading-state', el('span', 'spinner'), el('span', '', label));
  node.setAttribute('role', 'status');
  if (cancel) node.append(button(m('cancel'), cancel));
  return node;
}
export function badge(label: Localizable, className = '', title?: Localizable): HTMLElement {
  const node = el('span', `badge ${className}`, label); if (title) setAttribute(node, 'title', title); return node;
}

export interface MenuItem { label: Localizable; action: () => void; icon?: IconName; disabled?: boolean; danger?: boolean; shortcut?: string; dataAction?: string; checked?: boolean }
let activeMenu: (() => void) | undefined;
export function closeMenu(): boolean { if (!activeMenu) return false; activeMenu(); return true; }
export function contextMenu(items: (MenuItem | null)[], position: { x: number; y: number }, restore?: HTMLElement): void {
  activeMenu?.();
  const menu = el('div', 'context-menu'); menu.setAttribute('role', 'menu');
  const controls: HTMLButtonElement[] = [];
  for (const item of items) {
    if (!item) { const separator = el('div', 'menu-separator'); separator.setAttribute('role', 'separator'); menu.append(separator); continue; }
    const control = button(item.label, () => { close(); item.action(); }, item.icon, item.danger ? 'danger-text' : '');
    control.setAttribute('role', item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'); control.disabled = Boolean(item.disabled); control.tabIndex = -1;
    if (item.checked !== undefined) control.setAttribute('aria-checked', String(item.checked));
    if (item.dataAction) control.dataset.action = item.dataAction;
    if (item.shortcut) control.append(el('kbd', '', item.shortcut));
    menu.append(control); if (!control.disabled) controls.push(control);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(position.y, window.innerHeight - rect.height - 4))}px`;
  let closed = false;
  function close(): void { if (closed) return; closed = true; document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', close); disposeBindings(menu); menu.remove(); activeMenu = undefined; if (restore?.isConnected) restore.focus({ preventScroll: true }); }
  function outside(event: PointerEvent): void { if (!menu.contains(event.target as Node)) close(); }
  document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', close);
  let typeahead = ''; let typedAt = 0;
  menu.addEventListener('keydown', event => {
    event.stopPropagation();
    const index = controls.indexOf(document.activeElement as HTMLButtonElement);
    let target = index;
    if (event.key === 'ArrowDown') target = (index + 1) % controls.length;
    else if (event.key === 'ArrowUp') target = (index - 1 + controls.length) % controls.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = controls.length - 1;
    else if (event.key === 'Escape' || event.key === 'Tab' || event.key === 'ArrowLeft') { event.preventDefault(); close(); return; }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now(); typeahead = now - typedAt < 800 ? typeahead + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase(); typedAt = now;
      const ordered = [...controls.slice(index + 1), ...controls.slice(0, index + 1)];
      const match = ordered.find(control => control.title.toLocaleLowerCase().startsWith(typeahead)); if (match) { event.preventDefault(); match.focus(); } return;
    } else return;
    event.preventDefault(); controls[target]?.focus();
  });
  activeMenu = close; if (controls.length) controls[0].focus(); else { menu.tabIndex = -1; menu.focus(); }
}
export function menuAtButton(control: HTMLElement, items: (MenuItem | null)[]): void {
  const rect = control.getBoundingClientRect(); contextMenu(items, { x: rect.left, y: rect.bottom + 2 }, control);
}

export interface FormField {
  name: string; label: Localizable; type?: 'text' | 'textarea' | 'select' | 'checkbox' | 'number';
  value?: string | boolean; options?: { value: string; label: Localizable }[]; required?: boolean;
  hint?: Localizable; placeholder?: Localizable; min?: number; max?: number;
}
export interface FormOptions {
  title: Localizable; description?: Localizable; fields?: FormField[]; confirm?: Localizable; danger?: boolean; body?: Node;
  dataAction?: string;
  validate?: (values: FormValues) => Localizable | null;
}
export type FormValues = Record<string, string | boolean>;
export async function formDialog(options: FormOptions): Promise<FormValues | null> {
  closeMenu();
  const dialog = el('dialog', `dialog ${options.danger ? 'danger-dialog' : ''}`);
  const titleId = `dialog-${Math.random().toString(36).slice(2)}`;
  dialog.setAttribute('aria-labelledby', titleId);
  const title = el('h2', '', options.title); title.id = titleId;
  const form = el('form', 'dialog-form'); form.noValidate = true;
  const header = el('header', 'dialog-header', title, button(m('closeDialog'), () => finish(null), 'close', '', true));
  const body = el('div', 'dialog-body');
  if (options.description) body.append(el('p', 'dialog-description', options.description));
  if (options.body) body.append(options.body);
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  for (const item of options.fields ?? []) {
    let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (item.type === 'select') control = select(item.options ?? [], String(item.value ?? ''), item.label);
    else if (item.type === 'textarea') { control = el('textarea'); control.value = String(item.value ?? ''); control.rows = 4; }
    else if (item.type === 'checkbox') { control = input(item.label, '', 'checkbox'); control.checked = Boolean(item.value); }
    else { control = input(item.label, String(item.value ?? ''), item.type === 'number' ? 'number' : 'text'); }
    control.name = item.name; control.required = Boolean(item.required); setAttribute(control, 'aria-label', item.label);
    if ('placeholder' in control && item.placeholder) setAttribute(control, 'placeholder', item.placeholder);
    if (control instanceof HTMLInputElement) { if (item.min !== undefined) control.min = String(item.min); if (item.max !== undefined) control.max = String(item.max); }
    controls.set(item.name, control);
    body.append(item.type === 'checkbox'
      ? el('div', 'field', el('label', 'checkbox', control, el('span', '', item.label)), item.hint ? el('small', 'muted', item.hint) : null)
      : field(item.label, control, item.hint));
  }
  const error = el('p', 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true; body.append(error);
  const submit = el('button', `button ${options.danger ? 'danger' : 'primary'}`, options.confirm ?? m('apply')); submit.type = 'submit'; if (options.dataAction) submit.dataset.action = options.dataAction;
  const footer = el('footer', 'dialog-footer', button(m('cancel'), () => finish(null)), submit);
  form.append(header, body, footer); dialog.append(form); document.body.append(dialog);
  const previous = document.activeElement as HTMLElement | null;
  let resolve: (value: FormValues | null) => void;
  const result = new Promise<FormValues | null>(done => { resolve = done; });
  let closed = false;
  function finish(value: FormValues | null): void { if (closed) return; closed = true; disposeBindings(dialog); dialog.close(); dialog.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); resolve(value); }
  form.addEventListener('submit', event => {
    event.preventDefault();
    let basicError: Localizable | null = null;
    for (const item of options.fields ?? []) {
      const control = controls.get(item.name)!; const value = control.value.trim();
      if (item.required && (item.type === 'checkbox' ? !(control as HTMLInputElement).checked : !value)) basicError = m('required', { label: item.label });
      else if (item.type === 'number' && value) {
        const number = Number(value);
        if (!Number.isFinite(number) || !Number.isInteger(number)) basicError = m('number', { label: item.label });
        else if (item.min !== undefined && number < item.min) basicError = m('minimum', { label: item.label, value: item.min });
        else if (item.max !== undefined && number > item.max) basicError = m('maximum', { label: item.label, value: item.max });
      }
      if (basicError) { setText(error, basicError); error.hidden = false; control.setAttribute('aria-invalid', 'true'); control.focus(); return; }
      control.removeAttribute?.('aria-invalid');
    }
    const values: FormValues = {};
    controls.forEach((control, name) => { values[name] = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value.trim(); });
    const message = options.validate?.(values);
    if (message) { setText(error, message); error.hidden = false; return; }
    finish(values);
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
  dialog.showModal();
  queueMicrotask(() => (controls.values().next().value ?? submit).focus());
  return result;
}
export async function confirmDialog(title: Localizable, description: Localizable, confirm: Localizable = m('confirm'), danger = false): Promise<boolean> {
  return (await formDialog({ title, description, confirm, danger })) !== null;
}
export async function textDialog(title: Localizable, text: Localizable): Promise<void> {
  const output = el('pre', 'output-text', text || m('completed')); output.tabIndex = 0;
  await formDialog({ title, body: output, confirm: m('close') });
}

/** Pointer and keyboard resizing share the same bounded numeric model. */
export function resizer(orientation: 'vertical' | 'horizontal', get: () => number, set: (value: number, final: boolean) => void, min: number, max: () => number, invert = false, label: Localizable = m('resize')): HTMLElement {
  const handle = el('div', `resize-handle ${orientation}`); handle.tabIndex = 0;
  handle.setAttribute('role', 'separator'); setAttribute(handle, 'aria-label', label); handle.setAttribute('aria-orientation', orientation);
  const apply = (value: number, final: boolean): void => {
    const upper = Math.max(min, max()); const next = Math.max(min, Math.min(upper, value)); set(next, final);
    handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(Math.round(upper))); handle.setAttribute('aria-valuenow', String(Math.round(next))); setAttribute(handle, 'aria-valuetext', m('pixels', { count: Math.round(next) }));
  };
  handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(Math.round(Math.max(min, max())))); handle.setAttribute('aria-valuenow', String(Math.round(get()))); setAttribute(handle, 'aria-valuetext', m('pixels', { count: Math.round(get()) }));
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.focus({ preventScroll: true }); handle.setPointerCapture(event.pointerId);
    const start = orientation === 'vertical' ? event.clientX : event.clientY;
    const value = get(); document.body.classList.add('resizing');
    const move = (next: PointerEvent): void => apply(value + ((orientation === 'vertical' ? next.clientX : next.clientY) - start) * (invert ? -1 : 1), false);
    const finish = (): void => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); document.body.classList.remove('resizing'); apply(get(), true); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  });
  handle.addEventListener('keydown', event => {
    const negative = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const positive = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); event.stopPropagation(); apply(event.key === 'Home' ? min : max(), true); return; }
    if (event.key !== negative && event.key !== positive) return;
    event.preventDefault(); event.stopPropagation(); apply(get() + (event.key === positive ? 1 : -1) * (invert ? -1 : 1) * (event.shiftKey ? 40 : 8), true);
  });
  return handle;
}
