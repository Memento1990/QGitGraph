<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useLocale } from '../lib/vue-locale';
import { createUsageController, type UsageHost, type UsageSource, type UsageView } from '../controllers/usage';

const props = defineProps<{ host: UsageHost }>();
const { text } = useLocale();
const controller = createUsageController(props.host);
const view = ref<UsageView>(controller.view);
const source = ref<UsageSource>('userusage');
const consent = ref(false);
const details = ref<HTMLDetailsElement | null>(null);
function close(): void { if (details.value) { details.value.open = false; details.value.querySelector('summary')?.focus(); } }
const unsubscribe = controller.subscribe((value) => {
  view.value = value;
  if (value.status?.source && ['recording', 'paused'].includes(value.status.phase)) source.value = value.status.source;
});
onMounted(() => { if (controller.supported) void controller.refresh(); });
onBeforeUnmount(unsubscribe);
const active = computed(() => ['recording', 'paused'].includes(view.value.status?.phase ?? ''));
const phaseLabel = computed(() => ({ idle: text('未开始', 'Off'), recording: text('正在记录', 'Recording'), paused: text('已暂停', 'Paused'), stopped: text('已结束', 'Stopped'), error: text('记录失败 / 未确认保存', 'Failed / save not confirmed') })[view.value.status?.phase ?? 'idle']);
const sourceLabel = (value: UsageSource | null | undefined) => value ? ({ userusage: text('用户实际使用（声明）', 'User usage (declared)'), assistant: text('助手回归', 'Assistant regression'), 'automated-test': text('自动测试', 'Automated test') })[value] : text('未选择', 'Not selected');
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
async function start(): Promise<void> { if (consent.value && await controller.start(source.value)) consent.value = false; }
</script>

<template>
  <details ref="details" class="usage-recorder" data-testid="native-usage-recorder" @keydown.esc.stop="close">
    <summary>{{ text('使用日志', 'Usage log') }} · {{ controller.supported ? phaseLabel : text('仅正式桌面可用', 'Desktop only') }}</summary>
    <section class="usage-panel" :aria-label="text('本机使用日志', 'Local usage log')" :aria-busy="view.busy">
      <header>
        <strong>{{ text('本机使用日志', 'Local usage log') }}</strong>
        <span class="usage-status" role="status" aria-live="polite">{{ phaseLabel }}{{ view.busy ? text(' · 正在保存…', ' · Saving…') : '' }}</span>
        <button type="button" class="usage-close" :aria-label="text('关闭使用日志面板', 'Close usage log panel')" @click="close">{{ text('关闭', 'Close') }}</button>
      </header>
      <p>{{ text('默认关闭，仅在您显式开始后写入当前 profile 的有界日志。不联网、不上传，也不依赖任务看板运行。', 'Off by default. Only an explicit start writes bounded logs to the current profile. No network, uploads or running taskboard required.') }}</p>
      <p>{{ text('只记录操作与场景编号、会话内匿名仓库、错误类别、数量和白名单状态。不记录路径、代码、Diff、提交说明、输入内容或凭据。选择的来源和当前运行构建在会话内不可更改。', 'Records only action/scenario IDs, session-anonymous repositories, error categories, counts and allowlisted state. No paths, code, diffs, commit messages, typed content or credentials. Source and running build are locked for the session.') }}</p>
      <p v-if="!controller.supported">{{ text('当前浏览器 / 演示 Host 不支持原生日志，不会假装保存。', 'This browser/demo host does not support native logs and will not pretend to save them.') }}</p>
      <template v-else>
        <label class="usage-source">{{ text('来源声明', 'Declared source') }}
          <select v-model="source" :disabled="active || view.busy" :aria-label="text('使用日志来源声明', 'Usage log declared source')">
            <option value="userusage">{{ sourceLabel('userusage') }}</option>
            <option value="assistant">{{ sourceLabel('assistant') }}</option>
            <option value="automated-test">{{ sourceLabel('automated-test') }}</option>
          </select>
        </label>
        <p>{{ text('来源只是类别声明，不是可验证的人类身份。助手回归 / 自动测试不能标作用户使用。', 'Source is a provenance declaration, not verified human identity. Assistant regressions and automated tests must not be labeled user usage.') }}</p>
        <label v-if="!active" class="usage-consent">
          <input v-model="consent" type="checkbox" :disabled="view.busy" />
          {{ text('我了解采集范围，同意为本次会话开启本机日志', 'I understand the capture scope and opt in to local logging for this session') }}
        </label>
        <div class="usage-actions">
          <button type="button" :disabled="active || view.busy || !consent" @click="start">{{ text('开始', 'Start') }}</button>
          <button type="button" :disabled="view.status?.phase !== 'recording' || view.busy" @click="controller.boundary('pause')">{{ text('暂停', 'Pause') }}</button>
          <button type="button" :disabled="view.status?.phase !== 'paused' || view.busy" @click="controller.boundary('resume')">{{ text('继续', 'Resume') }}</button>
          <button type="button" :disabled="!active || view.busy" @click="controller.boundary('stop')">{{ text('结束', 'Stop') }}</button>
          <button type="button" :disabled="view.busy" @click="controller.refresh()">{{ text('刷新状态', 'Refresh status') }}</button>
        </div>
        <p v-if="view.errorCode" class="usage-error" role="alert">{{ text('未确认保存', 'Save not confirmed') }}（{{ view.errorCode }}）。{{ text('请检查本机存储后重新开始；失败期间不会自动补记，容量满时不会删除旧日志。', 'Check local storage before starting again. Failed events are not replayed, and full storage never deletes older logs.') }}</p>
        <dl v-if="view.status">
          <dt>{{ text('会话 / 来源', 'Session / source') }}</dt><dd>{{ view.status.sessionId ?? text('无活动会话', 'No active session') }} / {{ sourceLabel(view.status.source) }}</dd>
          <dt>{{ text('已保存事件', 'Saved events') }}</dt><dd>{{ view.status.eventCount }} · {{ formatBytes(view.status.bytes) }} / {{ formatBytes(view.status.limits.sessionBytes) }}</dd>
          <dt>{{ text('profile 容量', 'Profile capacity') }}</dt><dd>{{ formatBytes(view.status.totalBytes) }} / {{ formatBytes(view.status.limits.globalBytes) }} · {{ view.status.sessionCount }} / {{ view.status.limits.sessionCount }} {{ text('个会话', 'sessions') }}</dd>
          <dt>{{ text('运行版本', 'Running version') }}</dt><dd>{{ view.status.runtime.appVersion }}</dd>
          <dt>{{ text('源码构建', 'Source build') }}</dt><dd>{{ view.status.runtime.sourceBuild }}{{ view.status.runtime.sourceBuildReliable ? '' : text('（开发标识，未绑定可靠源码构建）', ' (development ID; no reliable source-build association)') }}</dd>
          <dt>{{ text('运行 exe SHA-256', 'Running exe SHA-256') }}</dt><dd class="usage-digest">{{ view.status.runtime.exeSha256 }}</dd>
          <dt>{{ text('证据 build', 'Evidence build') }}</dt><dd class="usage-digest">{{ view.status.build }}</dd>
        </dl>
        <p>{{ text('先结束会话，再由本机 CLI 预览 / 导入 profile 下 usage 目录中的完整 JSONL。导入保留原始来源、构建和采集时间，不等于验收完成；重启不会自动恢复记录。', 'Stop the session first, then preview/import the complete JSONL from the profile usage directory using the local CLI. Import preserves original source, build and capture times; it is not acceptance completion. Recording never resumes automatically after restart.') }}</p>
      </template>
    </section>
  </details>
</template>

<style scoped>
.usage-recorder { position: relative; color: var(--text); font-size: 12px; flex: 0 0 auto; }
.usage-recorder > summary { cursor: pointer; padding: 6px 8px; border-radius: 4px; white-space: nowrap; }
.usage-recorder > summary:hover { background: var(--hover); }
.usage-panel { position: absolute; right: 0; top: calc(100% + 8px); z-index: 60; display: grid; gap: 12px; width: min(650px, calc(100vw - 48px)); max-height: 75vh; overflow: auto; padding: 16px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-raised); user-select: text; }
.usage-panel header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.usage-close { color: var(--text); background: var(--panel-muted); border: 1px solid var(--line); border-radius: 4px; min-height: 28px; padding: 3px 8px; cursor: pointer; }
.usage-panel strong { font-size: 14px; }
.usage-panel p { margin: 0; line-height: 1.7; color: var(--muted); }
.usage-status { font-weight: 600; }
.usage-source { display: flex; align-items: center; gap: 12px; }
.usage-source select { flex: 1; min-height: 32px; padding: 4px 8px; color: var(--text); background: var(--panel-muted); border: 1px solid var(--line); border-radius: 4px; }
.usage-consent { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.usage-consent input { width: 16px; height: 16px; accent-color: var(--brand); }
.usage-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.usage-actions button { min-height: 32px; padding: 5px 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel-muted); color: var(--text); cursor: pointer; }
.usage-actions button:hover:not(:disabled) { background: var(--hover); }
.usage-actions button:active:not(:disabled) { border-color: var(--brand); }
.usage-actions button:disabled { cursor: default; opacity: .5; }
.usage-panel :is(button, select, input):focus-visible, .usage-recorder > summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.usage-panel .usage-error { border-left: 3px solid var(--danger); padding-left: 10px; color: var(--text); }
.usage-panel dl { margin: 0; display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 8px 12px; font-variant-numeric: tabular-nums; }
.usage-panel dt { color: var(--muted); }
.usage-panel dd { margin: 0; overflow-wrap: anywhere; }
.usage-digest { font-family: ui-monospace, Consolas, monospace; }
</style>
