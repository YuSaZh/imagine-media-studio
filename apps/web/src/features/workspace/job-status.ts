import { t } from '../../i18n/index';

export const ACTIVE_JOB_STATUSES = new Set(['queued', 'submitting', 'remote_pending', 'remote_running', 'downloading', 'processing']);
export const RETRYABLE_JOB_STATUSES = new Set(['failed', 'rejected', 'expired', 'cancelled']);
export const JOB_LABELS: Record<string, string> = {
  get queued() { return t("等待生成"); }, get submitting() { return t("正在提交"); }, get remote_pending() { return t("等待服务响应"); }, get remote_running() { return t("正在生成"); },
  get downloading() { return t("正在下载"); }, get processing() { return t("正在处理"); }, get completed() { return t("已完成"); }, get failed() { return t("生成失败"); }, get cancelled() { return t("已取消"); }, get rejected() { return t("请求被拒绝"); }, get expired() { return t("结果已过期"); },
};
