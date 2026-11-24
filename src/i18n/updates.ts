import { defineMessages } from '../lib/i18n';

export const { m, t } = defineMessages('updates', {
  invalid: 'Invalid release information from the update service.',
  check: 'Check for updates', idle: 'Updates are checked only when you choose Check for updates.',
  installed: 'Installed version: {version}', title: 'Updates', checking: 'Checking for the latest stable release…',
  unsupported: 'Update checks are unavailable in this preview. Use the desktop application.',
  noRelease: 'No publicly published stable release was found. You can check again later.',
  available: 'A newer stable release is available.', current: 'Your installed version is at least as recent as the latest stable release.',
  latest: 'Latest stable', published: 'Published', notProvided: 'Not provided', notes: 'Release notes',
  truncated: 'Release notes are truncated. Read the full notes on the release page.', open: 'Open release page',
  checkError: 'Could not check for updates: {detail} Retry using Check for updates.',
  invalidRetry: '{detail} Retry using Check for updates.',
  openError: 'Could not open the release page: {detail} Retry Open release page.',
}, {
  invalid: '更新服务返回的版本信息无效。',
  check: '检查更新', idle: '仅在您选择“检查更新”时才检查更新。',
  installed: '已安装版本：{version}', title: '更新', checking: '正在检查最新稳定版本…',
  unsupported: '此预览环境无法检查更新，请使用桌面应用。',
  noRelease: '未找到公开发布的稳定版本，您可以稍后再试。',
  available: '有新的稳定版本可用。', current: '已安装版本不早于最新稳定版本。',
  latest: '最新稳定版本', published: '发布时间', notProvided: '未提供', notes: '发行说明',
  truncated: '发行说明已截断，请在版本发布页面阅读完整说明。', open: '打开版本发布页面',
  checkError: '无法检查更新：{detail} 请通过“检查更新”重试。',
  invalidRetry: '{detail} 请通过“检查更新”重试。',
  openError: '无法打开版本发布页面：{detail} 请重试“打开版本发布页面”。',
});
