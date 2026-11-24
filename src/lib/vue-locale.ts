import { computed, onScopeDispose, ref } from 'vue';
import { getLocale, onLocaleChange, type Locale } from './i18n';

export function useLocale() {
  const locale = ref<Locale>(getLocale());
  const unsubscribe = onLocaleChange(() => { locale.value = getLocale(); });
  onScopeDispose(unsubscribe);
  const chinese = computed(() => locale.value === 'zh-CN');
  function text(zh: string, en: string): string { return chinese.value ? zh : en; }
  return { locale, chinese, text };
}
