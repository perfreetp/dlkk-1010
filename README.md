# 物业费催缴后端服务

供收费系统、短信平台和客服工具调用的物业费催缴管理后端服务。

## 技术栈

- **框架**: Node.js + Express + TypeScript
- **数据库**: SQLite (better-sqlite3)
- **工具库**: dayjs, uuid, zod, csv-writer

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 初始化数据库 + 示例数据
npm run seed

# 3. 启动服务 (开发模式)
npm run dev

# 生产模式
npm run build && npm start
```

服务默认端口: `http://localhost:3000`

## 核心能力（8大类）

| 能力 | 方法 | 路径 |
|------|------|------|
| 住户欠费查询 | GET | `/api/fees/search` |
| 费用重算 | POST | `/api/fees/recalc` |
| 催缴任务创建 | POST | `/api/tasks` |
| 模板选择 | GET | `/api/templates` |
| 发送队列 | GET | `/api/queue` |
| 回执登记 | POST | `/api/receipts` |
| 付款同步 | POST | `/api/payments/sync` |
| 减免申请 | POST | `/api/reductions` |

## 辅助功能

- **按房号检索**: `GET /api/fees/by-room?keyword=`
- **批量生成提醒**: 创建任务时设置 `batchCreate: true` 并指定筛选条件
- **分阶段催缴**: stage1~stage4 (温馨提醒 → 正式通知 → 上门催缴 → 律师函)
- **短信与电话记录合并**: `GET /api/records/merged`
- **逾期等级判断**: normal → warning → mild → moderate → severe → critical
- **承诺付款到期提醒**: `GET /api/promise-reminders?days=7`

## 管理功能

| 功能 | 接口 |
|------|------|
| 客服备注 | `POST/GET /api/notes` |
| 重复催缴拦截 | 任务创建时自动拦截，查看: `GET /api/intercept-logs` |
| 住户投诉标记 | `POST/GET /api/complaints` |
| 黑名单规则 | `GET/POST/DELETE /api/blacklists` |
| 主管审批 | `POST /api/reductions/approve` |
| 催缴效果统计 | `GET /api/stats/overview` |
| 楼栋排行 | `GET /api/stats/building-ranking` |
| 数据导出 | `GET /api/export/overdue?format=csv` |
| 操作留痕 | `GET /api/audit/operations` |
| 调用结果查询 | `GET /api/audit/call-results` |

## 数据模型

- **buildings**: 楼栋表
- **rooms**: 房屋/住户表
- **fees**: 费用明细表
- **templates**: 催缴模板表
- **collection_tasks**: 催缴任务表
- **send_queues**: 发送队列表
- **receipts**: 回执登记表
- **call_records**: 通话记录表
- **payments**: 付款记录表
- **reductions**: 减免申请表
- **customer_notes**: 客服备注表
- **complaints**: 投诉记录表
- **blacklists**: 黑名单表
- **duplicate_intercept_logs**: 重复拦截日志
- **operation_logs**: 操作留痕表
- **api_call_results**: 调用结果记录表

## 请求头

- 可设置 `X-Operator` 标识操作人，用于审计
