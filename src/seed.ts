import { initDatabase } from './db/init';
import { run, get, all } from './db/connection';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import { calcOverdueDays, getOverdueLevel, getStageByOverdueLevel } from './utils/helpers';

const BUILDINGS = ['1号楼', '2号楼', '3号楼', '5号楼', '6号楼'];
const OWNER_NAMES = [
  '张伟', '王芳', '李娜', '刘洋', '陈静', '杨帆', '赵敏', '黄强',
  '周杰', '吴敏', '徐丽', '孙涛', '胡斌', '朱琳', '郭鹏', '何雪',
  '高磊', '林梅', '罗勇', '马婷', '蒋文', '谢辉', '韩青', '唐华',
];

function randomPhone() {
  const prefixes = ['138', '139', '186', '187', '158', '159', '135', '189'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  let rest = '';
  for (let i = 0; i < 8; i++) rest += Math.floor(Math.random() * 10);
  return prefix + rest;
}

function randomEmail(name: string) {
  const domains = ['qq.com', '163.com', 'gmail.com', 'sina.com', 'outlook.com'];
  return `${name}@${domains[Math.floor(Math.random() * domains.length)]}`;
}

async function seed() {
  await initDatabase();
  console.log('[Seed] 开始初始化示例数据...');

  for (const b of BUILDINGS) {
    await run('INSERT INTO buildings (id, name, total_rooms, created_at) VALUES (?, ?, ?, ?)',
      uuidv4(), b, 48, dayjs().toISOString());
  }

  let idx = 0;
  for (const building of BUILDINGS) {
    for (let unit = 1; unit <= 2; unit++) {
      for (let floor = 1; floor <= 12; floor++) {
        const roomNumber = `${building}-${unit}单元-${floor.toString().padStart(2, '0')}${unit === 1 ? '01' : '02'}`;
        const roomId = uuidv4();
        const owner = OWNER_NAMES[idx % OWNER_NAMES.length];
        const area = 80 + Math.floor(Math.random() * 80);

        await run(`
          INSERT INTO rooms (id, room_number, building, unit, floor, area,
            owner_name, owner_phone, owner_email, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `, roomId, roomNumber, building, `${unit}单元`, floor, area,
           owner, randomPhone(), randomEmail(owner), dayjs().toISOString());

        const overdueScenario = idx % 6;
        const periods: { period: string; dueDate: string }[] = [];
        const now = dayjs();
        for (let m = 0; m < 6; m++) {
          const pd = now.subtract(m, 'month');
          periods.push({
            period: `${pd.year()}-${(pd.month() + 1).toString().padStart(2, '0')}`,
            dueDate: pd.endOf('month').toISOString(),
          });
        }

        for (const p of periods) {
          const unitPrice = 2.5;
          const base = parseFloat((area * unitPrice).toFixed(2));
          const service = parseFloat((base * 0.01).toFixed(2));
          const original = base + service;

          let paid = 0;
          let reduction = 0;
          const pi = periods.indexOf(p);

          if (overdueScenario === 0 || (overdueScenario < 5 && pi < 2)) {
            paid = original;
          } else if (overdueScenario === 5 && pi >= 3) {
            reduction = parseFloat((original * 0.2).toFixed(2));
            paid = parseFloat(((original - reduction) * 0.3).toFixed(2));
          }

          const payable = parseFloat((original - reduction).toFixed(2));
          const unpaid = parseFloat((payable - paid).toFixed(2));
          const overdueDays = Math.max(0, calcOverdueDays(p.dueDate));
          const overdueLevel = getOverdueLevel(overdueDays);
          const stage = getStageByOverdueLevel(overdueLevel);
          let status = 'unpaid';
          if (unpaid <= 0.01) status = 'paid';
          else if (overdueDays > 0) status = 'overdue';

          await run(`
            INSERT INTO fees (id, room_id, room_number, period, fee_type,
              original_amount, reduction_amount, payable_amount, paid_amount,
              unpaid_amount, due_date, status, overdue_days, overdue_level,
              stage, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'property', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, uuidv4(), roomId, roomNumber, p.period,
             original, reduction, payable, paid, unpaid,
             p.dueDate, status, overdueDays, overdueLevel, stage,
             dayjs().toISOString(), dayjs().toISOString());
        }
        idx++;
      }
    }
  }

  const tplIns = (id: string, name: string, type: string, stage: string, channel: string, content: string, vars: string[]) =>
    run(`INSERT INTO templates (id, name, type, stage, channel, content, variables, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      id, name, type, stage, channel, content, JSON.stringify(vars), dayjs().toISOString());

  await Promise.all([
    tplIns(uuidv4(), '第一阶段-短信温馨提醒', 'reminder', 'stage1', 'sms',
      '【XX物业】尊敬的{{owner_name}}业主您好，您的{{building}}{{room_number}}截至{{date}}共拖欠物业费¥{{unpaid_amount}}，已逾期{{overdue_days}}天。请您尽快缴纳，谢谢配合！退订回T',
      ['owner_name', 'room_number', 'building', 'unpaid_amount', 'overdue_days', 'date']),
    tplIns(uuidv4(), '第二阶段-正式短信通知', 'overdue_notice', 'stage2', 'sms',
      '【XX物业催缴通知】尊敬的{{owner_name}}，您名下{{room_number}}物业费逾期{{overdue_days}}天，累计欠费¥{{unpaid_amount}}。请于3日内缴纳，否则将进入上门催缴阶段。咨询电话：400-XXX-XXXX',
      ['owner_name', 'room_number', 'unpaid_amount', 'overdue_days']),
    tplIns(uuidv4(), '第三阶段-电话催缴话术', 'overdue_notice', 'stage3', 'phone',
      '您好{{owner_name}}业主，我是XX物业客服。您的{{room_number}}物业费已逾期较长时间，累计¥{{unpaid_amount}}，请问您方便什么时候过来缴纳？我们可以为您提供分期方案。',
      ['owner_name', 'room_number', 'unpaid_amount']),
    tplIns(uuidv4(), '第四阶段-律师函', 'lawyer', 'stage4', 'letter',
      '{{owner_name}}：关于您所有的{{building}}{{room_number}}物业服务费拖欠事宜，截至{{date}}已累计欠费¥{{unpaid_amount}}，逾期{{overdue_days}}天。请在收到本函7日内完成缴费，否则本所将依法提起诉讼。',
      ['owner_name', 'room_number', 'building', 'unpaid_amount', 'overdue_days', 'date']),
    tplIns(uuidv4(), '承诺付款到期提醒', 'promise_due', 'stage1', 'sms',
      '【XX物业】尊敬的{{owner_name}}您好，您此前承诺的物业费付款日期已临近，{{building}}{{room_number}}欠费¥{{unpaid_amount}}。请您按时履约，感谢您的支持！',
      ['owner_name', 'room_number', 'building', 'unpaid_amount']),
    tplIns(uuidv4(), '微信提醒模板', 'reminder', 'stage1', 'wechat',
      '物业费缴纳提醒：您的{{room_number}}欠费¥{{unpaid_amount}}，点击下方链接可直接在线支付。如有疑问请联系物业管家。',
      ['room_number', 'unpaid_amount']),
  ]);

  await Promise.all([
    run(`INSERT INTO customer_notes (id, room_number, content, operator, created_at) VALUES (?, ?, ?, ?, ?)`,
      uuidv4(), '1号楼-1单元-0301', '业主在外地，承诺春节前一次结清所有欠费', '李客服', dayjs().subtract(3, 'day').toISOString()),
    run(`INSERT INTO customer_notes (id, room_number, content, operator, created_at) VALUES (?, ?, ?, ?, ?)`,
      uuidv4(), '1号楼-1单元-0301', '已回电确认，业主将于本月20日回来办理', '张主管', dayjs().subtract(1, 'day').toISOString()),
    run(`INSERT INTO customer_notes (id, room_number, content, operator, created_at) VALUES (?, ?, ?, ?, ?)`,
      uuidv4(), '2号楼-2单元-0602', '对物业服务不满，拒绝缴费，需安排主管上门协调', '王客服', dayjs().subtract(5, 'day').toISOString()),
  ]);

  await Promise.all([
    run(`INSERT INTO complaints (id, room_number, content, category, operator, status, resolution, resolved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), '2号楼-2单元-0602', '小区绿化不到位，楼道清扫不及时，要求整改后再缴费',
      '物业服务', '王客服', 'open', null, null, dayjs().subtract(5, 'day').toISOString()),
    run(`INSERT INTO complaints (id, room_number, content, category, operator, status, resolution, resolved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), '3号楼-1单元-0801', '楼上漏水导致房屋受损，物业未妥善处理',
      '设施维修', '赵客服', 'resolved', '已协调施工队完成维修，业主同意缴费',
      dayjs().subtract(1, 'day').toISOString(), dayjs().subtract(10, 'day').toISOString()),
  ]);

  await run(`INSERT INTO blacklists (id, room_number, reason, block_channels, operator, effective_from, effective_to, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    uuidv4(), '5号楼-2单元-1101', '多次辱骂客服人员，态度恶劣',
    'phone,sms', '张主管',
    dayjs().subtract(15, 'day').toISOString(), dayjs().add(15, 'day').toISOString(),
    dayjs().subtract(15, 'day').toISOString());

  const paidFees = await all<any>(`SELECT id, room_number, paid_amount FROM fees WHERE status = 'paid' LIMIT 5`);
  for (let i = 0; i < paidFees.length; i++) {
    const f = paidFees[i];
    await run(`INSERT INTO payments (id, payment_no, fee_ids, room_number, amount, paid_at, method, payer, synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), `PAY${Date.now()}${i.toString().padStart(4, '0')}`, JSON.stringify([f.id]),
      f.room_number, f.paid_amount, dayjs().subtract(i + 1, 'day').toISOString(),
      ['银行转账', '微信支付', '支付宝', '现金', 'POS刷卡'][i], null,
      dayjs().subtract(i, 'hour').toISOString());
  }

  const someFees = await all<any>(`SELECT id, room_number, unpaid_amount FROM fees WHERE status = 'overdue' LIMIT 3`);
  if (someFees.length >= 3) {
    await run(`INSERT INTO reductions (id, fee_id, room_number, reduction_amount, original_unpaid,
              reason, applicant, applicant_note, status, approver, approval_note, approved_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), someFees[0].id, someFees[0].room_number,
      parseFloat((someFees[0].unpaid_amount * 0.3).toFixed(2)), someFees[0].unpaid_amount,
      '疫情期间居家隔离，经济困难', '李客服', '业主提供了社区隔离证明',
      'approved', '张主管', '情况属实，批准减免30%',
      dayjs().subtract(2, 'day').toISOString(), dayjs().subtract(3, 'day').toISOString());

    await run(`INSERT INTO reductions (id, fee_id, room_number, reduction_amount, original_unpaid,
              reason, applicant, applicant_note, status, approver, approval_note, approved_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), someFees[1].id, someFees[1].room_number,
      parseFloat((someFees[1].unpaid_amount * 0.15).toFixed(2)), someFees[1].unpaid_amount,
      '房屋长期空置，申请空置房优惠', '王客服', '业主提供了空置证明',
      'pending', null, null, null, dayjs().subtract(1, 'day').toISOString());

    await run(`INSERT INTO reductions (id, fee_id, room_number, reduction_amount, original_unpaid,
              reason, applicant, applicant_note, status, approver, approval_note, approved_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), someFees[2].id, someFees[2].room_number,
      parseFloat((someFees[2].unpaid_amount * 0.5).toFixed(2)), someFees[2].unpaid_amount,
      '物业服务不达标投诉减免', '赵客服', null,
      'rejected', '张主管', '无有效证据证明服务不达标，驳回',
      dayjs().subtract(5, 'day').toISOString(), dayjs().subtract(7, 'day').toISOString());
  }

  const stats = await get<any>(`
    SELECT
      (SELECT COUNT(*) FROM buildings) as buildings,
      (SELECT COUNT(*) FROM rooms) as rooms,
      (SELECT COUNT(*) FROM fees) as fees,
      (SELECT COUNT(*) FROM fees WHERE status = 'overdue') as overdue_fees,
      (SELECT COUNT(*) FROM fees WHERE status = 'paid') as paid_fees,
      (SELECT COALESCE(SUM(unpaid_amount), 0) FROM fees WHERE status != 'paid') as total_unpaid,
      (SELECT COUNT(*) FROM templates) as templates,
      (SELECT COUNT(*) FROM customer_notes) as notes,
      (SELECT COUNT(*) FROM complaints) as complaints,
      (SELECT COUNT(*) FROM blacklists) as blacklists,
      (SELECT COUNT(*) FROM payments) as payments,
      (SELECT COUNT(*) FROM reductions) as reductions
  `);

  console.log('[Seed] 数据初始化完成！');
  console.log('[Seed] 统计数据：');
  if (stats) {
    console.log('  - 楼栋数:', stats.buildings);
    console.log('  - 房屋数:', stats.rooms);
    console.log('  - 费用记录数:', stats.fees);
    console.log('    - 逾期:', stats.overdue_fees);
    console.log('    - 已缴:', stats.paid_fees);
    console.log('    - 欠费总额:', `¥${parseFloat(stats.total_unpaid || 0).toFixed(2)}`);
    console.log('  - 模板数:', stats.templates);
    console.log('  - 客服备注:', stats.notes);
    console.log('  - 投诉记录:', stats.complaints);
    console.log('  - 黑名单:', stats.blacklists);
    console.log('  - 付款记录:', stats.payments);
    console.log('  - 减免申请:', stats.reductions);
  }
  console.log('\n[Seed] 请运行 npm run dev 启动服务');
}

seed().catch(e => {
  console.error('[Seed] 错误:', e);
  process.exit(1);
});
