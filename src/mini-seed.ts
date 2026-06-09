import { initDatabase } from './db/init';
import { run, forceSave } from './db/connection';
import { v4 as uuidv4 } from 'uuid';
import dayjs from 'dayjs';
import { calcOverdueDays, getOverdueLevel, getStageByOverdueLevel } from './utils/helpers';

const BUILDINGS = ['1号楼', '2号楼'];
const OWNER_NAMES = ['张伟','王芳','李娜','刘洋','陈静','杨帆','赵敏','黄强','周杰','吴敏'];

function randomPhone() {
  const prefixes = ['138','139','186','187','158'];
  let rest = '';
  for (let i = 0; i < 8; i++) rest += Math.floor(Math.random() * 10);
  return prefixes[Math.floor(Math.random()*prefixes.length)] + rest;
}

async function seed() {
  await initDatabase();
  console.log('[MiniSeed] 开始初始化最小测试数据...');

  for (const b of BUILDINGS) {
    await run('INSERT INTO buildings (id, name, total_rooms, created_at) VALUES (?,?,?,?)',
      uuidv4(), b, 10, dayjs().toISOString());
  }

  let idx = 0;
  const now = dayjs();
  for (const building of BUILDINGS) {
    for (let unit = 1; unit <= 1; unit++) {
      for (let floor = 1; floor <= 5; floor++) {
        const roomNumber = `${building}-${unit}单元-${floor.toString().padStart(2,'0')}01`;
        const roomId = uuidv4();
        const owner = OWNER_NAMES[idx % OWNER_NAMES.length];
        const area = 80 + Math.floor(Math.random()*80);

        await run(`INSERT INTO rooms (id, room_number, building, unit, floor, area,
          owner_name, owner_phone, owner_email, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)`,
          roomId, roomNumber, building, `${unit}单元`, floor, area,
          owner, randomPhone(), `${owner}@qq.com`, dayjs().toISOString());

        for (let m = 0; m < 6; m++) {
          const pd = now.subtract(m, 'month');
          const period = `${pd.year()}-${(pd.month()+1).toString().padStart(2,'0')}`;
          const dueDate = pd.endOf('month').toISOString();
          const overdue = calcOverdueDays(dueDate);
          const level = getOverdueLevel(overdue);
          const stage = getStageByOverdueLevel(level);
          const original = Math.round(area * 2.5);
          let unpaid = original;
          let status = 'unpaid';

          if (m === 0) { unpaid = 0; status = 'paid'; }
          if (m === 1 && idx % 3 === 0) { unpaid = 0; status = 'paid'; }

          await run(`INSERT INTO fees (id, room_id, room_number, period, fee_type,
            original_amount, reduction_amount, payable_amount, paid_amount, unpaid_amount,
            due_date, status, overdue_days, overdue_level, stage, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            uuidv4(), roomId, roomNumber, period, 'property',
            original, 0, original, original-unpaid, unpaid,
            dueDate, status, Math.max(0,overdue), level, stage,
            dayjs().toISOString(), dayjs().toISOString());
        }
        idx++;
      }
    }
  }

  const templates = [
    { name: '阶段一短信-温馨提醒', type: 'reminder', stage: 'stage1', channel: 'sms',
      content: '尊敬的{{owner_name}}业主，您的物业费（{{period}}）￥{{unpaid_amount}}元即将/已逾期，请及时缴纳。' },
    { name: '阶段二短信-正式通知', type: 'reminder', stage: 'stage2', channel: 'sms',
      content: '【正式通知】{{owner_name}}业主：您{{room_number}}物业费已逾期{{overdue_days}}天，累计￥{{unpaid_amount}}元，请3日内缴纳。' },
    { name: '阶段三电话-上门催缴', type: 'call_script', stage: 'stage3', channel: 'phone',
      content: '{{owner_name}}您好，这是物业客服。您家物业费已逾期超过30天，我们将安排专员上门沟通。' },
    { name: '阶段四短信-律师函', type: 'legal', stage: 'stage4', channel: 'sms',
      content: '【律师函告】{{room_number}}业主{{owner_name}}：物业费逾期{{overdue_days}}天，将启动法律程序。' },
  ];
  for (const t of templates) {
    await run(`INSERT INTO templates (id, name, type, stage, channel, content, variables, enabled, created_at)
      VALUES (?,?,?,?,?,?,?,1,?)`,
      uuidv4(), t.name, t.type, t.stage, t.channel, t.content,
      JSON.stringify(['owner_name','room_number','period','unpaid_amount','overdue_days']),
      dayjs().toISOString());
  }

  await run(`INSERT INTO blacklists (id, room_number, reason, block_channels, operator,
    effective_from, created_at) VALUES (?,?,?,?,?,?,?)`,
    uuidv4(), '1号楼-1单元-0501', '多次投诉且态度恶劣', '["sms","phone"]', '主管',
    dayjs().toISOString(), dayjs().toISOString());

  forceSave();
  console.log('[MiniSeed] 完成！10户住户，60条费用记录');
  process.exit(0);
}

seed().catch(e => { console.error('[MiniSeed] 错误:', e); process.exit(1); });
