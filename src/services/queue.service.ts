import { run, get, all } from '../db/connection';
import { getNow, paginate, getChannelDescription } from '../utils/helpers';
import dayjs from 'dayjs';

export async function getQueue(params: any) {
  const { status, channel, taskId, roomNumber, startDate, endDate, page, pageSize } = params;
  const conditions: string[] = [];
  const values: any[] = [];

  if (status) { conditions.push('sq.status = ?'); values.push(status); }
  if (channel) { conditions.push('sq.channel = ?'); values.push(channel); }
  if (taskId) { conditions.push('sq.task_id = ?'); values.push(taskId); }
  if (roomNumber) { conditions.push('sq.room_number LIKE ?'); values.push(`%${roomNumber}%`); }
  if (startDate) { conditions.push('sq.created_at >= ?'); values.push(startDate); }
  if (endDate) { conditions.push('sq.created_at <= ?'); values.push(endDate); }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRow = await get<any>(`SELECT COUNT(*) as total FROM send_queues sq ${whereClause}`, ...values);
  const total = countRow?.total || 0;

  const offset = (page - 1) * pageSize;
  const list = await all(`
    SELECT
      sq.*,
      ct.name as task_name, ct.stage,
      f.unpaid_amount, f.overdue_level, f.overdue_days, f.due_date,
      r.result as receipt_result, r.delivered_at, r.promised_pay_at,
      cr.result as call_result, cr.duration as call_duration, cr.operator as call_operator
    FROM send_queues sq
    LEFT JOIN collection_tasks ct ON sq.task_id = ct.id
    LEFT JOIN fees f ON sq.fee_id = f.id
    LEFT JOIN receipts r ON r.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    ${whereClause}
    ORDER BY sq.priority DESC, sq.created_at ASC
    LIMIT ? OFFSET ?
  `, ...values, pageSize, offset);

  const statusStats = await all(`
    SELECT status, COUNT(*) as count FROM send_queues sq ${whereClause} GROUP BY status
  `, ...values);

  return {
    list: list.map((row: any) => ({ ...row, channel_desc: getChannelDescription(row.channel) })),
    pagination: paginate(total, page, pageSize),
    statusStats,
  };
}

export async function markAsSent(queueId: string, errorMsg?: string) {
  const now = getNow();
  if (errorMsg) {
    await run(`
      UPDATE send_queues SET status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE id = ?
    `, errorMsg, queueId);
  } else {
    await run(`
      UPDATE send_queues SET status = 'sent', sent_at = ?, error_message = NULL WHERE id = ?
    `, now, queueId);
    const q = await get<any>('SELECT task_id FROM send_queues WHERE id = ?', queueId);
    if (q?.task_id) await run(`UPDATE collection_tasks SET sent_count = sent_count + 1 WHERE id = ?`, q.task_id);
  }
  return { queueId, updatedAt: now };
}

export async function markAsDelivered(queueId: string) {
  const now = getNow();
  await run(`UPDATE send_queues SET status = 'delivered', delivered_at = ? WHERE id = ?`, now, queueId);
  const q = await get<any>('SELECT task_id FROM send_queues WHERE id = ?', queueId);
  if (q?.task_id) await run(`UPDATE collection_tasks SET delivered_count = delivered_count + 1 WHERE id = ?`, q.task_id);
  return { queueId, deliveredAt: now };
}

export async function getPromiseDueReminders(daysAhead: number = 7) {
  const from = getNow();
  const to = dayjs().add(daysAhead, 'day').toISOString();
  const list = await all(`
    SELECT
      cr.id as call_record_id,
      cr.room_number, cr.promised_pay_at, cr.operator, cr.note,
      r.owner_name, r.owner_phone, r.building,
      cr.queue_id,
      f.id as fee_id, f.unpaid_amount, f.overdue_days, f.overdue_level,
      (SELECT COUNT(*) FROM payments p WHERE p.room_number = cr.room_number AND p.paid_at >= cr.created_at) as already_paid
    FROM call_records cr
    JOIN rooms r ON r.room_number = cr.room_number
    LEFT JOIN send_queues sq ON cr.queue_id = sq.id
    LEFT JOIN fees f ON sq.fee_id = f.id
    WHERE cr.promised_pay_at IS NOT NULL
      AND cr.promised_pay_at >= ?
      AND cr.promised_pay_at <= ?
      AND (f.status IS NULL OR f.status != 'paid')
    ORDER BY cr.promised_pay_at ASC
  `, from, to);

  const listArr = list as any[];
  const stats = {
    total: listArr.length,
    within_3days: listArr.filter(r => dayjs(r.promised_pay_at).diff(dayjs(), 'day') <= 3).length,
    overdue_promise: listArr.filter(r => dayjs(r.promised_pay_at).isBefore(dayjs())).length,
  };
  return { list, stats };
}

export async function retryFailed(queueIds: string[]) {
  const now = getNow();
  let updated = 0;
  for (const id of queueIds) {
    const res = await run(`
      UPDATE send_queues SET
        status = 'pending',
        error_message = NULL,
        retry_count = retry_count + 1,
        created_at = ?
      WHERE id = ? AND status IN ('failed', 'intercepted')
    `, now, id);
    updated += res.changes || 0;
  }
  return { retried: updated, total: queueIds.length };
}
