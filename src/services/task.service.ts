import { run, get, all } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import { getNow, renderTemplate } from '../utils/helpers';

export async function getTemplates(params: any) {
  const { type, stage, channel } = params;
  const conditions: string[] = ['enabled = 1'];
  const values: any[] = [];

  if (type) { conditions.push('type = ?'); values.push(type); }
  if (stage) { conditions.push('stage = ?'); values.push(stage); }
  if (channel) { conditions.push('channel = ?'); values.push(channel); }

  return all(`
    SELECT * FROM templates
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
  `, ...values);
}

export async function createCollectionTask(params: any, operator?: string) {
  const { name, stage, templateId, channel, priority, scheduledAt,
          feeIds, batchCreate, overdueLevels, minAmount } = params;

  const template = await get<any>('SELECT * FROM templates WHERE id = ? AND enabled = 1', templateId);
  if (!template) throw new Error('模板不存在或已禁用');

  let finalFeeIds = [...feeIds];

  if (batchCreate) {
    const conditions: string[] = [];
    const values: any[] = [];
    if (overdueLevels && overdueLevels.length > 0) {
      conditions.push(`overdue_level IN (${overdueLevels.map(() => '?').join(',')})`);
      values.push(...overdueLevels);
    }
    if (minAmount !== undefined) { conditions.push('unpaid_amount >= ?'); values.push(minAmount); }
    conditions.push("status != 'paid'");
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const batchFees = await all<any>(`SELECT id FROM fees ${whereClause}`, ...values);
    finalFeeIds = [...new Set([...finalFeeIds, ...batchFees.map(f => f.id)])];
  }

  if (finalFeeIds.length === 0) throw new Error('未选择任何费用记录');

  const now = getNow();
  const taskId = uuidv4();

  await run(`
    INSERT INTO collection_tasks
      (id, name, stage, template_id, template_content, channel, priority,
       status, scheduled_at, total_count, sent_count, delivered_count, success_count,
       operator, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
  `, taskId, name, stage, templateId, template.content, channel, priority,
     'pending', scheduledAt || now, finalFeeIds.length, operator || null, now);

  const placeholders = finalFeeIds.map(() => '?').join(',');
  const feeRows = await all<any>(`
    SELECT f.id as fee_id, f.room_number, f.unpaid_amount, f.overdue_days,
           r.owner_name, r.owner_phone, r.building, r.owner_email
    FROM fees f
    JOIN rooms r ON f.room_id = r.id
    WHERE f.id IN (${placeholders})
  `, ...finalFeeIds);

  const blacklists = await all<any>(`
    SELECT room_number, block_channels, effective_from, effective_to
    FROM blacklists
    WHERE (effective_to IS NULL OR effective_to > datetime('now'))
  `);
  const blacklistMap = new Map(blacklists.map(b => [b.room_number, b]));

  let createdCount = 0;
  let interceptedCount = 0;

  for (const fee of feeRows) {
    const blacklist = blacklistMap.get(fee.room_number);
    const blockChannels = blacklist ? (blacklist.block_channels || '').split(',') : [];
    const isBlacklisted = blockChannels.includes(channel);

    const lastSent = await get<any>(`
      SELECT MAX(created_at) as last_at
      FROM send_queues
      WHERE fee_id = ? AND channel = ? AND status != 'intercepted'
    `, fee.fee_id);

    const minInterval = 24;
    let shouldIntercept = false;
    if (lastSent?.last_at) {
      const hoursDiff = (Date.now() - new Date(lastSent.last_at).getTime()) / (1000 * 60 * 60);
      if (hoursDiff < minInterval) shouldIntercept = true;
    }

    const content = renderTemplate(template.content, {
      owner_name: fee.owner_name || '业主',
      room_number: fee.room_number,
      building: fee.building,
      unpaid_amount: fee.unpaid_amount.toFixed(2),
      overdue_days: fee.overdue_days,
      date: new Date().toLocaleDateString('zh-CN'),
    });

    let status = 'pending';
    if (isBlacklisted) {
      status = 'intercepted';
      interceptedCount++;
      await run(`
        INSERT INTO duplicate_intercept_logs
          (id, fee_id, room_number, channel, last_sent_at, min_interval_hours, intercepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, uuidv4(), fee.fee_id, fee.room_number, channel, now, minInterval, now);
    } else if (shouldIntercept) {
      status = 'intercepted';
      interceptedCount++;
      await run(`
        INSERT INTO duplicate_intercept_logs
          (id, fee_id, room_number, channel, last_sent_at, min_interval_hours, intercepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, uuidv4(), fee.fee_id, fee.room_number, channel, lastSent.last_at, minInterval, now);
    } else {
      createdCount++;
    }

    await run(`
      INSERT INTO send_queues
        (id, task_id, fee_id, room_number, owner_name, owner_phone,
         channel, template_content, priority, status, retry_count,
         sent_at, delivered_at, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)
    `, uuidv4(), taskId, fee.fee_id, fee.room_number,
       fee.owner_name, fee.owner_phone, channel, content, priority, status, now);
  }

  const task = await get('SELECT * FROM collection_tasks WHERE id = ?', taskId);
  return {
    task,
    summary: { selected: finalFeeIds.length, queued: createdCount, intercepted: interceptedCount },
  };
}

export async function getTasks(page = 1, pageSize = 20) {
  const row = await get<any>('SELECT COUNT(*) as total FROM collection_tasks');
  const total = row?.total || 0;
  const offset = (page - 1) * pageSize;
  const list = await all(`
    SELECT * FROM collection_tasks
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `, pageSize, offset);
  return {
    list,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getTaskDetail(taskId: string) {
  const task = await get('SELECT * FROM collection_tasks WHERE id = ?', taskId);
  if (!task) return null;

  const queues = await all(`
    SELECT sq.*, f.unpaid_amount, f.overdue_level, f.overdue_days
    FROM send_queues sq
    JOIN fees f ON sq.fee_id = f.id
    WHERE sq.task_id = ?
    ORDER BY sq.created_at DESC
  `, taskId);

  const byStatus: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  for (const q of queues as any[]) {
    byStatus[q.status] = (byStatus[q.status] || 0) + 1;
    byChannel[q.channel] = (byChannel[q.channel] || 0) + 1;
  }

  return { task, queues, stats: { total: queues.length, byStatus, byChannel } };
}
