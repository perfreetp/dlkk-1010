import { z } from 'zod';

export const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(20),
});

export const FeeQuerySchema = z.object({
  roomNumber: z.string().optional(),
  building: z.string().optional(),
  unit: z.string().optional(),
  ownerName: z.string().optional(),
  overdueLevel: z.union([z.string(), z.array(z.string())]).optional(),
  minOverdueDays: z.coerce.number().int().optional(),
  maxOverdueDays: z.coerce.number().int().optional(),
  minAmount: z.coerce.number().optional(),
  maxAmount: z.coerce.number().optional(),
  onlyOverdue: z.coerce.boolean().default(false),
  ...PaginationSchema.shape,
});

export const RecalcSchema = z.object({
  feeIds: z.array(z.string()).min(1),
  reason: z.string().optional(),
});

export const CreateTaskSchema = z.object({
  name: z.string().min(1),
  stage: z.enum(['stage1', 'stage2', 'stage3', 'stage4']),
  templateId: z.string().min(1),
  feeIds: z.array(z.string()).optional().default([]),
  channel: z.enum(['sms', 'phone', 'email', 'wechat', 'letter']),
  priority: z.coerce.number().int().min(1).max(5).default(3),
  scheduledAt: z.string().optional(),
  batchCreate: z.coerce.boolean().default(false),
  overdueLevels: z.array(z.string()).optional(),
  minAmount: z.coerce.number().optional(),
});

export const TemplateSelectSchema = z.object({
  type: z.string().optional(),
  stage: z.string().optional(),
  channel: z.string().optional(),
});

export const QueueQuerySchema = z.object({
  status: z.string().optional(),
  channel: z.string().optional(),
  taskId: z.string().optional(),
  roomNumber: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  ...PaginationSchema.shape,
});

export const ReceiptSchema = z.object({
  queueId: z.string().min(1),
  deliveredAt: z.string().optional(),
  result: z.string().optional(),
  promisedPayAt: z.string().optional(),
  note: z.string().optional(),
  callDuration: z.coerce.number().int().optional(),
});

export const PaymentSyncSchema = z.object({
  paymentNo: z.string().min(1),
  feeIds: z.array(z.string()).optional().default([]),
  roomNumber: z.string().optional(),
  amount: z.coerce.number().positive(),
  paidAt: z.string(),
  method: z.string().min(1),
  payer: z.string().optional(),
}).superRefine((val, ctx) => {
  if ((!val.feeIds || val.feeIds.length === 0) && !val.roomNumber) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'feeIds 和 roomNumber 至少提供一个' });
  }
});

export const ReductionSchema = z.object({
  feeId: z.string().min(1),
  reductionAmount: z.coerce.number().positive(),
  reason: z.string().min(1),
  applicant: z.string().min(1),
  applicantNote: z.string().optional(),
});

export const NoteSchema = z.object({
  roomNumber: z.string().min(1),
  content: z.string().min(1),
  operator: z.string().min(1),
});

export const ComplaintSchema = z.object({
  roomNumber: z.string().min(1),
  content: z.string().min(1),
  operator: z.string().min(1),
  category: z.string().optional(),
});

export const ApprovalSchema = z.object({
  reductionId: z.string().min(1),
  approved: z.boolean(),
  approver: z.string().min(1),
  approvalNote: z.string().optional(),
});

export const StatsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  building: z.string().optional(),
  dimension: z.enum(['overall', 'stage', 'channel', 'call_result']).default('overall'),
});

export const CallResultSchema = z.object({
  callId: z.string().min(1),
  queueId: z.string().min(1),
  result: z.enum(['connected', 'no_answer', 'busy', 'rejected', 'promised', 'complaint']),
  duration: z.coerce.number().int().optional(),
  note: z.string().optional(),
  promisedPayAt: z.string().optional(),
  operator: z.string().min(1),
});
