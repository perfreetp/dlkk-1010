export const OVERDUE_LEVELS = {
  NORMAL: 'normal',
  WARNING: 'warning',
  MILD: 'mild',
  MODERATE: 'moderate',
  SEVERE: 'severe',
  CRITICAL: 'critical',
} as const;

export type OverdueLevel = typeof OVERDUE_LEVELS[keyof typeof OVERDUE_LEVELS];

export const COLLECTION_STAGES = {
  STAGE1: 'stage1',
  STAGE2: 'stage2',
  STAGE3: 'stage3',
  STAGE4: 'stage4',
} as const;

export type CollectionStage = typeof COLLECTION_STAGES[keyof typeof COLLECTION_STAGES];

export const SEND_CHANNELS = {
  SMS: 'sms',
  PHONE: 'phone',
  EMAIL: 'email',
  WECHAT: 'wechat',
  LETTER: 'letter',
} as const;

export type SendChannel = typeof SEND_CHANNELS[keyof typeof SEND_CHANNELS];

export const QUEUE_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  DELIVERED: 'delivered',
  RECEIVED: 'received',
  INTERCEPTED: 'intercepted',
} as const;

export type QueueStatus = typeof QUEUE_STATUS[keyof typeof QUEUE_STATUS];

export const REDUCTION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

export type ReductionStatus = typeof REDUCTION_STATUS[keyof typeof REDUCTION_STATUS];

export const TEMPLATE_TYPES = {
  OVERDUE_NOTICE: 'overdue_notice',
  REMINDER: 'reminder',
  PROMISE_DUE: 'promise_due',
  LAWYER: 'lawyer',
} as const;

export type TemplateType = typeof TEMPLATE_TYPES[keyof typeof TEMPLATE_TYPES];

export const CALL_RESULTS = {
  CONNECTED: 'connected',
  NO_ANSWER: 'no_answer',
  BUSY: 'busy',
  REJECTED: 'rejected',
  PROMISED: 'promised',
  COMPLAINT: 'complaint',
} as const;

export type CallResult = typeof CALL_RESULTS[keyof typeof CALL_RESULTS];
