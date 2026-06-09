import express from 'express';
import { initDatabase } from './db/init';
import { operationLogger } from './middleware/logger';
import { errorHandler, notFound } from './middleware/error';
import { normalizeBody } from './middleware/normalize';
import routes from './routes';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(normalizeBody);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

(async () => {
  await initDatabase();
  console.log('[DB] 数据库初始化完成');

  app.use('/api', operationLogger, routes);

  app.get('/', (_req, res) => {
    res.json({
      service: '物业费催缴后端服务',
      version: '1.0.0',
      health: 'http://localhost:' + PORT + '/api/health',
      endpoints: {
        '欠费查询': 'GET /api/fees/search',
        '按房号检索': 'GET /api/fees/by-room?keyword=',
        '费用详情': 'GET /api/fees/:id',
        '费用重算': 'POST /api/fees/recalc',
        '模板选择': 'GET /api/templates',
        '催缴任务创建': 'POST /api/tasks',
        '任务列表': 'GET /api/tasks',
        '任务详情': 'GET /api/tasks/:id',
        '发送队列': 'GET /api/queue',
        '标记已发送': 'POST /api/queue/:id/sent',
        '标记已送达': 'POST /api/queue/:id/delivered',
        '回执登记': 'POST /api/receipts',
        '通话结果登记': 'POST /api/call-results',
        '短信电话合并记录': 'GET /api/records/merged',
        '付款同步': 'POST /api/payments/sync',
        '付款历史': 'GET /api/payments/history',
        '减免申请创建': 'POST /api/reductions',
        '减免审批': 'POST /api/reductions/approve',
        '减免列表': 'GET /api/reductions',
        '客服备注': 'POST /api/notes',
        '投诉标记': 'POST /api/complaints',
        '黑名单管理': 'GET/POST/DELETE /api/blacklists',
        '承诺付款到期提醒': 'GET /api/promise-reminders',
        '效果统计': 'GET /api/stats/overview',
        '楼栋排行': 'GET /api/stats/building-ranking',
        '欠费数据导出': 'GET /api/export/overdue',
        '操作留痕': 'GET /api/audit/operations',
        '调用结果查询': 'GET /api/audit/call-results',
      },
    });
  });

  app.use(errorHandler);
  app.use(notFound);

  app.listen(PORT, () => {
    console.log(`[Server] 物业费催缴后端服务已启动: http://localhost:${PORT}`);
    console.log(`[Server] 健康检查: http://localhost:${PORT}/api/health`);
  });
})();
