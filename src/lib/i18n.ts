/** Small explicit-message localization. Repository/user strings are never translated. */
export type Language = 'system' | 'en' | 'zh-CN';
export type Locale = Exclude<Language, 'system'>;
export type MessageValue = string | number | boolean | null | undefined | LocalizedMessage;
export interface LocalizedMessage {
  readonly kind: 'localized-message';
  readonly resolve: (locale: Locale) => string;
}
export type Localizable = string | LocalizedMessage;

type Alpha = 'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'|'i'|'j'|'k'|'l'|'m'|'n'|'o'|'p'|'q'|'r'|'s'|'t'|'u'|'v'|'w'|'x'|'y'|'z';
type IdentifierChar = Alpha | Uppercase<Alpha> | '_' | '0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9';
type IsIdentifier<S extends string> = S extends '' ? false : S extends `${infer Head}${infer Tail}` ? Head extends Alpha | Uppercase<Alpha> | '_' ? IdentifierTail<Tail> : false : false;
type IdentifierTail<S extends string> = S extends '' ? true : S extends `${infer Head}${infer Tail}` ? Head extends IdentifierChar ? IdentifierTail<Tail> : false : false;
/** Double braces are literals, e.g. {{repo}} in documentation. */
export type MessageParameters<S extends string> = S extends `${string}{${infer Rest}`
  ? Rest extends `{${infer Escaped}` ? Escaped extends `${string}}}${infer Tail}` ? MessageParameters<Tail> : never
    : Rest extends `${infer Name}}${infer Tail}` ? (IsIdentifier<Name> extends true ? Name : never) | MessageParameters<Tail> : never
  : never;
type SameParameters<A extends string, B extends string> = [MessageParameters<A>] extends [MessageParameters<B>] ? [MessageParameters<B>] extends [MessageParameters<A>] ? true : false : false;
type Translation<E extends Record<string, string>, Z extends Record<keyof E, string>> = {
  readonly [K in keyof Z]: K extends keyof E ? SameParameters<E[K], Z[K]> extends true ? Z[K] : never : never;
};
type Args<S extends string> = [MessageParameters<S>] extends [never] ? [] : [args: { readonly [K in MessageParameters<S>]: MessageValue }];
export interface Messages<E extends Record<string, string>> {
  m<K extends keyof E & string>(key: K, ...args: Args<E[K]>): LocalizedMessage;
  t<K extends keyof E & string>(key: K, ...args: Args<E[K]>): string;
}

let preference: Language = 'system';
let locale: Locale = 'en';
let systemLanguages: readonly string[] | undefined;
const listeners = new Set<() => void>();

/** Chinese variants (including regional/Hant tags) use the supported Chinese UI; everything else falls back to English. */
export function resolveLocale(language: Language = 'system', languages: readonly string[] = []): Locale {
  if (language === 'en' || language === 'zh-CN') return language;
  for (const candidate of languages) {
    const tag = candidate.trim().replace(/_/g, '-').toLowerCase();
    if (/^zh(?:-|$)/.test(tag)) return 'zh-CN';
    if (/^en(?:-|$)/.test(tag)) return 'en';
  }
  return 'en';
}
function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}
export function getLocale(): Locale { return locale; }
export function getLanguage(): Language { return preference; }
/** Does not read any browser globals until called, and never performs I/O. */
export function initI18n(language: Language = 'system', languages?: readonly string[]): void {
  systemLanguages = languages;
  setLanguage(language);
}
export function setLanguage(language: Language): void {
  preference = language === 'en' || language === 'zh-CN' ? language : 'system';
  const next = resolveLocale(preference, systemLanguages ?? browserLanguages());
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = next;
  if (locale === next) return;
  locale = next;
  for (const listener of [...listeners]) listener();
}
/** Alias for callers applying persisted global preferences after loading StateStore. */
export const configureLocale = setLanguage;
export function onLocaleChange(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function isLocalizedMessage(value: unknown): value is LocalizedMessage {
  return Boolean(value && typeof value === 'object' && 'kind' in value && value.kind === 'localized-message' && 'resolve' in value && typeof value.resolve === 'function');
}
export function resolveText(value: Localizable, language: Locale = locale): string { return typeof value === 'string' ? value : value.resolve(language); }
/** Explicitly compose a formatted value without registering a catalogue or holding DOM references. */
export function localized(resolve: (locale: Locale) => string): LocalizedMessage { return Object.freeze({ kind: 'localized-message', resolve }); }
/** UI-authored errors retain their descriptor; raw host errors keep their original message/detail. */
export class LocalizedError extends Error {
  constructor(readonly localizedMessage: LocalizedMessage) { super(resolveText(localizedMessage)); this.name = 'LocalizedError'; }
}

function parameterNames(template: string): string[] {
  return [...new Set([...template.replace(/\{\{|\}\}/g, '').matchAll(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g)].map(match => match[1]))].sort();
}
function interpolate(template: string, args: Record<string, MessageValue>, language: Locale): string {
  return template.replace(/\{\{|\}\}|\{([A-Za-z_][A-Za-z_0-9]*)\}/g, (token, key: string | undefined) => {
    if (token === '{{') return '{';
    if (token === '}}') return '}';
    const value = Object.prototype.hasOwnProperty.call(args, key!) ? args[key!] : undefined;
    return isLocalizedMessage(value) ? value.resolve(language) : String(value ?? '');
  });
}
/** Domain-local typed keys: adding a domain requires no central registry or shared-file edits. */
export function defineMessages<const E extends Record<string, string>, const Z extends Record<keyof E, string>>(domain: string, en: E, zh: Z & Translation<E, Z>): Messages<E> {
  const keys = Object.keys(en);
  if (keys.length !== Object.keys(zh).length || keys.some(key => !Object.prototype.hasOwnProperty.call(zh, key))) throw new Error(`Localization key mismatch in ${domain}.`);
  for (const key of keys) {
    if (parameterNames(en[key]).join(',') !== parameterNames(zh[key]).join(',')) throw new Error(`Localization parameter mismatch in ${domain}.${key}.`);
  }
  const message = (key: string, args: Record<string, MessageValue> = {}): LocalizedMessage => localized(language => interpolate((language === 'zh-CN' ? zh : en)[key], args, language));
  return {
    m: (key: keyof E & string, ...args: [Record<string, MessageValue>?]) => message(key, args[0]),
    t: (key: keyof E & string, ...args: [Record<string, MessageValue>?]) => resolveText(message(key, args[0])),
  } as Messages<E>;
}
