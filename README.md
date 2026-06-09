# 物业费催缴后端服务

供收费系统、短信平台和客服工具调用的物业费催缴管理后端服务。

## 技术栈

- **框架**: Node.js + Express + TypeScript
- **数据库**: SQLite (`sql.js` - WASM 版, 无需编译)
- **工具库**: dayjs, uuid, zod, csv-writer

## 快速启动

> ⚠️ **首次启动请按以下 3 步执行**,不需要 Visual Studio 或任何 C++ 编译工具。

```bash
# ================================
# 第1步: 安装依赖 (已预编译, 无需 VS)
# ================================
npm install

# ================================
# 第2步: 初始化数据库+示例数据
#   (选其中一个,小数据推荐 mini-seed)
# ================================
npm run mini-seed     # ✅ 推荐: 2栋×10户×6个月≈60条费用记录(启动快)
# 或
npm run seed          # 完整数据: 5栋×240户×6个月≈1500条费用

# 重置数据库 (删库+重新导入mini种子)
npm run reset

# ================================
# 第3步: 启动服务
# ================================
npm run dev           # 开发模式: http://localhost:3000

# 生产模式
npm run build && npm start

# 运行回归测试 (需要先启动服务)
npm test
```

服务默认端口: `http://localhost:3000`
访问根路径 `http://localhost:3000/` 可查看所有可用端点文档。

---

## 8大类核心能力

| # | 能力 | 方法 | 路径 | 说明 |
|---|------|------|------|------|
| 1 | 住户欠费查询 | GET | `/api/fees/search` | 多维筛选+分页+统计 |
| 2 | 费用重算 | POST | `/api/fees/recalc` | 重算滞纳金/服务费 (欠费永不负数) |
| 3 | 催缴任务创建 | POST | `/api/tasks` | 批量生成,自动黑名单+24h拦截 |
| 4 | 模板选择 | GET | `/api/templates` | 按阶段/渠道筛选 |
| 5 | 发送队列 | GET | `/api/queue` | CRUD+状态流转 |
| 6 | 回执登记 | POST | `/api/receipts` | 短信回执+通话结果 |
| 7 | 付款同步 | POST | `/api/payments/sync` | 按时间顺序自动分摊 |
| 8 | 减免申请 | POST | `/api/reductions` | 申请+主管审批 |

---

## 辅助功能

| 功能 | 接口 | 说明 |
|------|------|------|
| **按房号检索** | `GET /api/fees/by-room?keyword=` | 显示真实最高逾期等级+欠费分布 |
| **批量催缴预演** | `POST /api/tasks/preview` | **预演模式**: 先看命中/拦截数量再确认 |
| **批量生成提醒** | 创建任务时 `batchCreate:true` + 筛选条件 | 按逾期等级/金额批量选择 |
| **分阶段催缴** | 4阶段: stage1温馨→stage2正式→stage3上门→stage4律师函 | 自动匹配逾期等级 |
| **短信+电话合并记录** | `GET /api/records/merged` | 多渠道联系历史 |
| **逾期等级判断** | 6级: normal→warning→mild→moderate→severe→critical | 按天数自动刷新 |
| **承诺付款到期提醒** | `GET /api/promise-reminders?days=7` | 查看近期需跟进户 |

---

## 管理/统计功能

| 功能 | 接口 | 说明 |
|------|------|------|
| 客服备注 | `POST /api/notes`, `GET /api/notes` | 住户沟通记录 |
| 重复催缴拦截 | 任务创建时自动执行 | **24小时最小间隔**+**黑名单渠道**双重拦截 |
| 拦截日志 | `GET /api/intercept-logs` | 查看被拦截历史和原因 |
| 住户投诉标记 | `POST /api/complaints`, `POST :id/resolve` | 投诉分类+解决跟踪 |
| 黑名单规则 | `POST/GET/DELETE /api/blacklists` | 指定渠道屏蔽+有效期 |
| 主管审批 | `POST /api/reductions/approve` | 批准后自动更新费用表 |
| **组合维度效果统计** | `GET /api/stats/combo` | **楼栋×阶段×渠道×时间段**自由组合,查看触达/承诺/回款/回款率 |
| **催缴闭环看板** | `GET /api/stats/closure` | 欠费→已催→送达→承诺→付款→减免 漏斗+按房号/任务追踪 |
| 效果总览 | `GET /api/stats/overview?dimension=` | dimension=stage/channel/call_result |
| 楼栋排行 | `GET /api/stats/building-ranking` | 户均欠费/收缴率/回款率/送达率 |
| 数据导出 | `GET /api/export/overdue?format=csv/json` | 欠费明细导出 |
| 任务数据导出 | `GET /api/export/task/:taskId?format=` | 任务队列导出 |
| 操作留痕 | `GET /api/audit/operations`, `GET /api/audit/operations/:id` | 全量API调用日志 |
| 调用结果查询 | `GET /api/audit/call-results`, `GET :requestId` | 含开始/结束/耗时/错误 |

---

## 组合维度统计使用示例

```bash
# 按楼栋统计触达/承诺/回款
curl "http://localhost:3000/api/stats/combo?group_by=building"

# 按楼栋×阶段×渠道 三维交叉
curl "http://localhost:3000/api/stats/combo?group_by=building_stage&building=1号楼&start_date=2026-01-01&end_date=2026-06-30"

# group_by 可选值:
#   building / stage / channel
#   building_stage / building_channel / stage_channel
#   all (默认,全量汇总)
```

## 催缴闭环看板示例

```bash
# 全量漏斗总览 (含6步转换率+回款率)
curl "http://localhost:3000/api/stats/closure"

# 按房号追踪一户卡在哪一步 (500条明细)
curl "http://localhost:3000/api/stats/closure?room_number=1号楼-1单元-0301"

# 按任务号追踪整批效果
curl "http://localhost:3000/api/stats/closure?task_id=<taskId>"
```

## 批量任务预演模式

```bash
# 步骤1: 预演,不真正建队列,先看命中率
curl -X POST "http://localhost:3000/api/tasks/preview" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "sms",
    "batchCreate": true,
    "overdueLevels": ["mild","moderate","severe","critical"],
    "minAmount": 100
  }'
# 返回: selected总命中 / blacklist_intercepted 黑名单拦截
#       dup_intercepted 重复发送拦截 / to_be_queued 最终入队
# 还包含: 逾期等级分布、拦截样例、预入队列样例

# 步骤2: 确认没问题再真正创建 (复用同一筛选条件)
curl -X POST "http://localhost:3000/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"6月阶段2批量催缴","stage":"stage2",
    "template_id":"<valid-template-id>","templateId":"<valid-template-id>",
    "channel":"sms","priority":2,"operator":"客服小王",
    "batchCreate":true,"overdueLevels":["mild","moderate","severe","critical"],
    "minAmount":100
  }'
```

## 数据模型 (18张表)

| 表名 | 作用 |
|------|------|
| **buildings** | 楼栋 |
| **rooms** | 房屋/住户 (房号、业主、联系方式、面积) |
| **fees** | 费用明细 (周期、应收/减免/已缴/欠费、逾期等级、催缴阶段) |
| **templates** | 催缴模板 (话术、支持{{变量}}替换) |
| **collection_tasks** | 催缴任务 (批次、状态、统计) |
| **send_queues** | 发送队列 (每条催缴记录、状态、模板渲染结果) |
| **receipts** | 回执登记 (送达/未送达、承诺付款日、客服备注) |
| **call_records** | 通话记录 (呼叫结果、时长、客服信息) |
| **payments** | 付款记录 (支付单号、金额、分摊到的费用) |
| **reductions** | 减免申请 (申请人/审批人、金额、理由、状态) |
| **customer_notes** | 客服备注 |
| **complaints** | 投诉记录 (分类、解决状态) |
| **blacklists** | 黑名单 (屏蔽渠道、有效期) |
| **duplicate_intercept_logs** | 拦截日志 (拦截原因、24h/黑名单) |
| **operation_logs** | 操作留痕 (全量API请求响应) |
| **api_call_results** | 调用结果 (统计用、耗时分析) |

---

## 逾期等级与催缴阶段对照

| 逾期天数 | 逾期等级 | 催缴阶段 | 推荐动作 |
|----------|----------|----------|----------|
| 0天 | normal | stage1 | 温馨短信 |
| 1-7天 | warning | stage1 | 提醒短信 |
| 8-30天 | mild | stage2 | 正式通知短信 |
| 31-90天 | moderate | stage3 | 客服电话+上门 |
| 91-180天 | severe | stage3 | 主管介入+上门 |
| >180天 | critical | stage4 | 律师函 |

---

## 项目目录结构

```
src/
├── db/                    # 数据库层
│   ├── connection.ts      # sql.js封装 (run/get/all/exec + 定时落盘)
│   └── init.ts            # 18张表DDL初始化
├── types/
│   ├── enums.ts           # 业务枚举
│   └── schemas.ts         # Zod参数校验schema
├── middleware/
│   ├── logger.ts          # 操作留痕+调用结果自动记录
│   ├── validate.ts        # snake_case→camelCase+Zod校验
│   ├── normalize.ts       # body字段名规范化
│   └── error.ts           # 全局错误处理
├── services/              # 业务服务层 (10+ services)
│   ├── fee.service.ts     # 欠费查询(含真实最高逾期等级)
│   ├── recalc.service.ts  # 费用重算(永不负数)
│   ├── task.service.ts    # 催缴任务+预演模式
│   ├── queue.service.ts   # 发送队列
│   ├── receipt.service.ts # 回执+通话登记+合并
│   ├── payment.service.ts # 付款同步+自动分摊
│   ├── reduction.service.ts # 减免申请+审批
│   ├── customer.service.ts # 备注/投诉/黑名单/拦截
│   ├── stats.service.ts   # 组合统计/闭环看板/楼栋排行/导出
│   └── audit.service.ts   # 操作/调用日志
├── utils/helpers.ts       # 工具函数(逾期等级/模板渲染等)
├── routes/index.ts        # 路由 (~60个端点)
├── server.ts              # Express入口
├── seed.ts                # 完整种子数据(1500+条)
└── mini-seed.ts           # 迷你种子数据(60条,推荐)
```

---

## 小命令提示

| 需求 | 命令 |
|------|------|
| 清空数据库重新来 | `npm run reset` (Windows) / `rm property-fee.db && npm run mini-seed` |
| 改代码后想重启 | 先 Ctrl+C 停止,再 `npm run dev` |
| 只跑部分接口测试 | 修改 `test-api.mjs` 后 `node test-api.mjs` |
| 查看数据库文件 | 当前目录下 `property-fee.db` (sql.js 每5秒自动保存) |
