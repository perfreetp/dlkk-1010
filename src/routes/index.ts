import { Router, Request, Response, NextFunction } from 'express';
import * as FeeService from '../services/fee.service';
import * as RecalcService from '../services/recalc.service';
import * as TaskService from '../services/task.service';
import * as QueueService from '../services/queue.service';
import * as ReceiptService from '../services/receipt.service';
import * as PaymentService from '../services/payment.service';
import * as ReductionService from '../services/reduction.service';
import * as CustomerService from '../services/customer.service';
import * as StatsService from '../services/stats.service';
import * as AuditService from '../services/audit.service';
import { validateBody, validateQuery } from '../middleware/validate';
import {
  FeeQuerySchema, RecalcSchema, CreateTaskSchema, TemplateSelectSchema,
  QueueQuerySchema, ReceiptSchema, PaymentSyncSchema, ReductionSchema,
  NoteSchema, ComplaintSchema, ApprovalSchema, StatsQuerySchema, CallResultSchema,
  PaginationSchema, ComboStatsSchema, ClosureBoardSchema, PreviewTaskSchema,
  RiskAnalysisSchema,
} from '../types/schemas';

const router = Router();

function wrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.get('/health', (_req, res) => {
  res.json({ code: 200, message: 'ok', data: { timestamp: new Date().toISOString() } });
});

router.get('/fees/search', validateQuery(FeeQuerySchema), wrap(async (req, res) => {
  const result = await FeeService.queryFees((req as any).validatedQuery);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/fees/by-room', wrap(async (req, res) => {
  const { keyword, page = 1, pageSize = 50 } = req.query as any;
  if (!keyword) return res.status(400).json({ code: 400, message: 'keyword 参数必填' });
  const result = await FeeService.searchByRoomNumber(keyword as string, +page, +pageSize);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/fees/:id', wrap(async (req, res) => {
  const detail = await FeeService.getFeeDetail(req.params.id);
  if (!detail) return res.status(404).json({ code: 404, message: '费用记录不存在' });
  res.json({ code: 200, message: 'success', data: detail });
}));

router.post('/fees/recalc', validateBody(RecalcSchema), wrap(async (req, res) => {
  const result = await RecalcService.recalculateFees(req.body.feeIds, req.body.reason);
  res.json({ code: 200, message: '重算完成', data: result });
}));

router.get('/fees/:id/recalc-history', wrap(async (req, res) => {
  const history = await RecalcService.getRecalcHistory(req.params.id);
  res.json({ code: 200, message: 'success', data: history });
}));

router.get('/templates', validateQuery(TemplateSelectSchema), wrap(async (req, res) => {
  const templates = await TaskService.getTemplates((req as any).validatedQuery);
  res.json({ code: 200, message: 'success', data: templates });
}));

router.post('/tasks', validateBody(CreateTaskSchema), wrap(async (req, res) => {
  try {
    const result = await TaskService.createCollectionTask(req.body, req.headers['x-operator'] as string);
    res.json({ code: 200, message: '任务创建成功', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.post('/tasks/preview', validateBody(PreviewTaskSchema), wrap(async (req, res) => {
  try {
    const result = await TaskService.previewCollectionTask((req as any).validatedBody || req.body);
    res.json({ code: 200, message: '预演成功', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.get('/tasks', validateQuery(PaginationSchema), wrap(async (req, res) => {
  const { page, pageSize } = (req as any).validatedQuery;
  const result = await TaskService.getTasks(page, pageSize);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/tasks/:id', wrap(async (req, res) => {
  const detail = await TaskService.getTaskDetail(req.params.id);
  if (!detail) return res.status(404).json({ code: 404, message: '任务不存在' });
  res.json({ code: 200, message: 'success', data: detail });
}));

router.get('/queue', validateQuery(QueueQuerySchema), wrap(async (req, res) => {
  const result = await QueueService.getQueue((req as any).validatedQuery);
  res.json({ code: 200, message: 'success', data: result });
}));

router.post('/queue/:id/sent', wrap(async (req, res) => {
  const { error } = req.body || {};
  const result = await QueueService.markAsSent(req.params.id, error);
  res.json({ code: 200, message: '已更新发送状态', data: result });
}));

router.post('/queue/:id/delivered', wrap(async (req, res) => {
  const result = await QueueService.markAsDelivered(req.params.id);
  res.json({ code: 200, message: '已更新送达状态', data: result });
}));

router.post('/queue/retry', wrap(async (req, res) => {
  const { queueIds } = req.body;
  if (!Array.isArray(queueIds) || queueIds.length === 0) {
    return res.status(400).json({ code: 400, message: 'queueIds 必填且为非空数组' });
  }
  const result = await QueueService.retryFailed(queueIds);
  res.json({ code: 200, message: '重试已提交', data: result });
}));

router.get('/promise-reminders', wrap(async (req, res) => {
  const { days = 7 } = req.query as any;
  const result = await QueueService.getPromiseDueReminders(+days);
  res.json({ code: 200, message: 'success', data: result });
}));

router.post('/receipts', validateBody(ReceiptSchema), wrap(async (req, res) => {
  try {
    const result = await ReceiptService.registerReceipt(req.body);
    res.json({ code: 200, message: '回执登记成功', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.post('/call-results', validateBody(CallResultSchema), wrap(async (req, res) => {
  try {
    const result = await ReceiptService.registerCallResult(req.body);
    res.json({ code: 200, message: '通话结果已记录', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.get('/records/merged', wrap(async (req, res) => {
  const { roomNumber, startDate, endDate, page = 1, pageSize = 50 } = req.query as any;
  const result = await ReceiptService.getMergedRecords(
    roomNumber as string, startDate as string, endDate as string, +page, +pageSize
  );
  res.json({ code: 200, message: 'success', data: result });
}));

router.post('/payments/sync', validateBody(PaymentSyncSchema), wrap(async (req, res) => {
  try {
    const result = await PaymentService.syncPayment(req.body);
    res.json({ code: 200, message: '付款同步完成', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.get('/payments/history', wrap(async (req, res) => {
  const { roomNumber, building, startDate, endDate, page = 1, pageSize = 50 } = req.query as any;
  const result = await PaymentService.getPaymentHistory(
    roomNumber as string, startDate as string, endDate as string, +page, +pageSize, building as string
  );
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/payments/by-room/:roomNumber', wrap(async (req, res) => {
  const result = await PaymentService.getUnpaidDetailByRoom(req.params.roomNumber);
  res.json({ code: 200, message: 'success', data: result });
}));

router.post('/reductions', validateBody(ReductionSchema), wrap(async (req, res) => {
  try {
    const result = await ReductionService.createReduction(req.body);
    res.json({ code: 200, message: '减免申请已提交', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.post('/reductions/approve', validateBody(ApprovalSchema), wrap(async (req, res) => {
  try {
    const result = await ReductionService.approveReduction(req.body);
    res.json({
      code: 200,
      message: result.status === 'approved' ? '已批准减免' : '已拒绝减免',
      data: result,
    });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.get('/reductions', wrap(async (req, res) => {
  const { status, roomNumber, page = 1, pageSize = 50 } = req.query as any;
  const result = await ReductionService.getReductions(
    status as string, roomNumber as string, +page, +pageSize
  );
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/reductions/:id', wrap(async (req, res) => {
  const detail = await ReductionService.getReductionDetail(req.params.id);
  if (!detail) return res.status(404).json({ code: 404, message: '减免申请不存在' });
  res.json({ code: 200, message: 'success', data: detail });
}));

router.post('/notes', validateBody(NoteSchema), wrap(async (req, res) => {
  try {
    const result = await CustomerService.addCustomerNote(req.body);
    res.json({ code: 200, message: '备注已添加', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.get('/notes', wrap(async (req, res) => {
  const { roomNumber, page = 1, pageSize = 50 } = req.query as any;
  const result = await CustomerService.getCustomerNotes(roomNumber as string, +page, +pageSize);
  res.json({ code: 200, message: 'success', data: result });
}));

router.post('/complaints', validateBody(ComplaintSchema), wrap(async (req, res) => {
  try {
    const result = await CustomerService.markComplaint(req.body);
    res.json({ code: 200, message: '投诉已登记', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.post('/complaints/:id/resolve', wrap(async (req, res) => {
  const { resolution } = req.body;
  if (!resolution) return res.status(400).json({ code: 400, message: 'resolution 必填' });
  const result = await CustomerService.resolveComplaint(req.params.id, resolution);
  res.json({ code: 200, message: '投诉已解决', data: result });
}));

router.get('/complaints', wrap(async (req, res) => {
  const { status, roomNumber, page = 1, pageSize = 50 } = req.query as any;
  const result = await CustomerService.getComplaints(
    status as string, roomNumber as string, +page, +pageSize
  );
  res.json({ code: 200, message: 'success', data: result });
}));

router.post('/blacklists', wrap(async (req, res) => {
  try {
    const result = await CustomerService.addBlacklist(req.body);
    res.json({ code: 200, message: '已加入黑名单', data: result });
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message });
  }
}));

router.delete('/blacklists/:id', wrap(async (req, res) => {
  const result = await CustomerService.removeBlacklist(req.params.id);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/blacklists', wrap(async (req, res) => {
  const { page = 1, pageSize = 50 } = req.query as any;
  const result = await CustomerService.getBlacklists(+page, +pageSize);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/intercept-logs', wrap(async (req, res) => {
  const { page = 1, pageSize = 50 } = req.query as any;
  const result = await CustomerService.getInterceptLogs(+page, +pageSize);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/stats/overview', validateQuery(StatsQuerySchema), wrap(async (req, res) => {
  const result = await StatsService.getCollectionStats((req as any).validatedQuery);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/stats/building-ranking', wrap(async (_req, res) => {
  const result = await StatsService.getBuildingRanking();
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/stats/combo', validateQuery(ComboStatsSchema), wrap(async (req, res) => {
  const result = await StatsService.getComboStats((req as any).validatedQuery || req.query);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/stats/closure', validateQuery(ClosureBoardSchema), wrap(async (req, res) => {
  const result = await StatsService.getClosureBoard((req as any).validatedQuery || req.query);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/stats/risk-analysis', validateQuery(RiskAnalysisSchema), wrap(async (req, res) => {
  const result = await StatsService.getRiskAnalysis((req as any).validatedQuery || req.query);
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/export/overdue', wrap(async (req, res) => {
  const { format = 'csv' } = req.query as any;
  const content = await StatsService.exportOverdueData(format as 'csv' | 'json');
  const ext = format === 'json' ? 'json' : 'csv';
  const contentType = format === 'json' ? 'application/json' : 'text/csv; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="overdue-fees.${ext}"`);
  res.send(content);
}));

router.get('/export/task/:taskId', wrap(async (req, res) => {
  const { format = 'csv' } = req.query as any;
  const content = await StatsService.exportTaskData(req.params.taskId, format as 'csv' | 'json');
  const ext = format === 'json' ? 'json' : 'csv';
  const contentType = format === 'json' ? 'application/json' : 'text/csv; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="task-${req.params.taskId}.${ext}"`);
  res.send(content);
}));

router.get('/audit/operations', wrap(async (req, res) => {
  const { apiPath, startDate, endDate, operator, page = 1, pageSize = 50 } = req.query as any;
  const result = await AuditService.getOperationLogs({
    apiPath, startDate, endDate, operator, page: +page, pageSize: +pageSize,
  });
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/audit/operations/:id', wrap(async (req, res) => {
  const detail = await AuditService.getOperationLogDetail(req.params.id);
  if (!detail) return res.status(404).json({ code: 404, message: '日志不存在' });
  res.json({ code: 200, message: 'success', data: detail });
}));

router.get('/audit/call-results', wrap(async (req, res) => {
  const { requestId, apiName, status, startDate, endDate, page = 1, pageSize = 50 } = req.query as any;
  const result = await AuditService.getCallResults({
    requestId, apiName, status, startDate, endDate, page: +page, pageSize: +pageSize,
  });
  res.json({ code: 200, message: 'success', data: result });
}));

router.get('/audit/call-results/:requestId', wrap(async (req, res) => {
  const detail = await AuditService.getCallResultDetail(req.params.requestId);
  if (!detail) return res.status(404).json({ code: 404, message: '调用记录不存在' });
  res.json({ code: 200, message: 'success', data: detail });
}));

export default router;
