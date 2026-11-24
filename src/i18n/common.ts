import { defineMessages } from '../lib/i18n';

export const { m, t } = defineMessages('common', {
  cancel: 'Cancel', apply: 'Apply', confirm: 'Confirm', close: 'Close', closeDialog: 'Close dialog',
  completed: 'Completed without output.', required: '{label}: a value is required.', number: '{label}: enter a valid whole number.', minimum: '{label}: use a value of at least {value}.', maximum: '{label}: use a value of at most {value}.', resize: 'Resize pane', pixels: '{count} pixels',
  unknown: 'Unknown', unavailable: 'Not available', hostDependent: 'Host dependent',
  operationFailed: 'The operation could not be completed.',
  startupFailed: 'The application could not start.\n{detail}',
}, {
  cancel: '取消', apply: '应用', confirm: '确认', close: '关闭', closeDialog: '关闭对话框',
  completed: '操作已完成，无输出。', required: '{label}：必须填写此项。', number: '{label}：请输入有效整数。', minimum: '{label}：请输入不小于 {value} 的值。', maximum: '{label}：请输入不大于 {value} 的值。', resize: '调整面板大小', pixels: '{count} 像素',
  unknown: '未知', unavailable: '不可用', hostDependent: '由宿主决定',
  operationFailed: '无法完成此操作。',
  startupFailed: '应用无法启动。\n{detail}',
});
