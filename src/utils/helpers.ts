import dayjs from 'dayjs';
import { OVERDUE_LEVELS } from '../types/enums';

export function getNow(): string {
  return dayjs().toISOString();
}

export function calcOverdueDays(dueDate: string): number {
  const due = dayjs(dueDate);
  const now = dayjs();
  const diff = now.diff(due, 'day');
  return Math.max(0, diff);
}

export function getOverdueLevel(days: number): string {
  if (days <= 0) return OVERDUE_LEVELS.NORMAL;
  if (days <= 7) return OVERDUE_LEVELS.WARNING;
  if (days <= 30) return OVERDUE_LEVELS.MILD;
  if (days <= 90) return OVERDUE_LEVELS.MODERATE;
  if (days <= 180) return OVERDUE_LEVELS.SEVERE;
  return OVERDUE_LEVELS.CRITICAL;
}

export function getStageByOverdueLevel(level: string): string {
  switch (level) {
    case OVERDUE_LEVELS.WARNING:
    case OVERDUE_LEVELS.MILD:
      return 'stage1';
    case OVERDUE_LEVELS.MODERATE:
      return 'stage2';
    case OVERDUE_LEVELS.SEVERE:
      return 'stage3';
    case OVERDUE_LEVELS.CRITICAL:
      return 'stage4';
    default:
      return 'stage1';
  }
}

export function paginate(total: number, page: number, pageSize: number) {
  const totalPages = Math.ceil(total / pageSize);
  return {
    total,
    page,
    pageSize,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

export function renderTemplate(content: string, vars: Record<string, any>): string {
  let result = content;
  for (const key of Object.keys(vars)) {
    const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    result = result.replace(pattern, String(vars[key] ?? ''));
  }
  return result;
}

export function getStageDescription(stage: string): string {
  const map: Record<string, string> = {
    stage1: '第一阶段：温馨提醒',
    stage2: '第二阶段：正式通知',
    stage3: '第三阶段：上门催缴',
    stage4: '第四阶段：律师函',
  };
  return map[stage] || stage;
}

export function getChannelDescription(channel: string): string {
  const map: Record<string, string> = {
    sms: '短信',
    phone: '电话',
    email: '邮件',
    wechat: '微信',
    letter: '书面通知',
  };
  return map[channel] || channel;
}

export function getOverdueLevelDescription(level: string): string {
  const map: Record<string, string> = {
    normal: '正常',
    warning: '预警',
    mild: '轻度逾期',
    moderate: '中度逾期',
    severe: '重度逾期',
    critical: '严重逾期',
  };
  return map[level] || level;
}
