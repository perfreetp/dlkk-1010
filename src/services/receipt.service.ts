import { run, get, all } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import { getNow } from '../utils/helpers';

export async function registerReceipt(data: any) {
  const { queueId, deliveredAt, result, promisedPayAt, note, callDuration } = data;
  const queue = await get<any>('SELECT * FROM send_queues WHERE id = ?', queueId);
  if (!queue) throw new Error('队列记录不存在');

  const now = getNow();
  const receiptId = uuidv4();

  await run(`
    INSERT INTO receipts
      (id, queue_id, delivered_at, result, call_duration, promised_pay_at, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, receiptId, queueId, deliveredAt || now,
     result || (queue.channel === 'sms' ? 'delivered' : null),
     callDuration || null, promisedPayAt || null, note || null, now);

  let newStatus = queue.status;
  if (deliveredAt || result === 'delivered' || result === 'connected') newStatus = 'delivered';
  else if (result && ['no_answer', 'busy', 'rejected'].includes(result)) newStatus = 'failed';

  await run(`
    UPDATE send_queues SET status = ?, delivered_at = COALESCE(?, delivered_at) WHERE id = ?
  `, newStatus, deliveredAt || null, queueId);

  if (queue.task_id && newStatus === 'delivered') {
    await run(`UPDATE collection_tasks SET delivered_count = delivered_count + 1, success_count = success_count + 1 WHERE id = ?`, queue.task_id);
  }

  if (callDuration !== undefined && queue.task_id) {
    await run(`
      INSERT INTO call_records
        (id, queue_id, room_number, result, duration, note, promised_pay_at, operator, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, uuidv4(), queueId, queue.room_number, result || 'connected',
       callDuration, note || null, promisedPayAt || null, 'system', now);
  }

  return { id: receiptId, queueId, status: 'registered', createdAt: now };
}

export async function registerCallResult(data: any) {
  const { callId, queueId, result, duration, note, promisedPayAt, operator } = data;
  const queue = await get<any>('SELECT * FROM send_queues WHERE id = ?', queueId);
  if (!queue) throw new Error('队列记录不存在');
  const now = getNow();

  await run(`
    INSERT INTO call_records
      (id, queue_id, room_number, result, duration, note, promised_pay_at, operator, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, callId, queueId, queue.room_number, result, duration || null,
     note || null, promisedPayAt || null, operator, now);

  await run(`UPDATE send_queues SET status = 'received' WHERE id = ?`, queueId);
  if (queue.task_id) await run(`UPDATE collection_tasks SET success_count = success_count + 1 WHERE id = ?`, queue.task_id);

  if (result === 'complaint') {
    await run(`
      INSERT INTO complaints
        (id, room_number, content, category, operator, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `, uuidv4(), queue.room_number, note || '通话中标记投诉，请跟进', '催缴投诉', operator, now);
  }

  return { callId, queueId, savedAt: now };
}

export async function getMergedRecords(roomNumber?: string, startDate?: string, endDate?: string, page = 1, pageSize = 50) {
  const conditions1: string[] = [];
  const values: any[] = [];
  if (roomNumber) { conditions1.push('room_number = ?'); values.push(roomNumber); }
  if (startDate) { conditions1.push('created_at >= ?'); values.push(startDate); }
  if (endDate) { conditions1.push('created_at <= ?'); values.push(endDate); }
  const whereClause = conditions1.length > 0 ? `WHERE ${conditions1.join(' AND ')}` : '';

  const totalRow = await get<any>(
    `SELECT (SELECT COUNT(*) FROM send_queues sq ${whereClause}) + (SELECT COUNT(*) FROM call_records cr ${whereClause}) as total`,
    ...values, ...values
  );
  const total = totalRow?.total || 0;

  const offset = (page - 1) * pageSize;
  const list = await all(`
    SELECT * FROM (
      SELECT
        'sms' as record_type,
        id, room_number, channel, template_content as content,
        status as sms_status, sent_at as action_at, created_at,
        NULL as call_result, NULL as duration, NULL as operator, NULL as promised_pay_at
      FROM send_queues
      WHERE channel IN ('sms', 'wechat', 'email', 'letter')
        ${whereClause.replace('WHERE', 'AND')}
      UNION ALL
      SELECT
        'call' as record_type,
        id, room_number, 'phone' as channel, note as content,
        NULL as sms_status, created_at as action_at, created_at,
        result as call_result, duration, operator, promised_pay_at
      FROM call_records ${whereClause}
    )
    ORDER BY action_at DESC
    LIMIT ? OFFSET ?
  `, ...values, ...values, pageSize, offset);

  return {
    list,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  };
}
