import { run, get, all } from '../db/connection';
import { calcOverdueDays, getOverdueLevel, paginate, getStageByOverdueLevel, getOverdueLevelDescription } from '../utils/helpers';
import dayjs from 'dayjs';

export async function refreshFeeStatus(feeId: string) {
  const fee = await get('SELECT * FROM fees WHERE id = ?', feeId) as any;
  if (!fee) return;

  const overdueDays = calcOverdueDays(fee.due_date);
  const overdueLevel = getOverdueLevel(overdueDays);
  const stage = getStageByOverdueLevel(overdueLevel);

  await run(`
    UPDATE fees SET
      overdue_days = ?,
      overdue_level = ?,
      stage = ?,
      status = CASE
        WHEN unpaid_amount <= 0.01 THEN 'paid'
        WHEN ? > 0 THEN 'overdue'
        ELSE 'unpaid'
      END,
      updated_at = ?
    WHERE id = ?
  `, overdueDays, overdueLevel, stage, overdueDays, dayjs().toISOString(), feeId);
}

export async function queryFees(params: any) {
  const {
    roomNumber, building, unit, ownerName, overdueLevel,
    minOverdueDays, maxOverdueDays, minAmount, maxAmount,
    onlyOverdue, page, pageSize, status,
  } = params;

  const conditions: string[] = [];
  const values: any[] = [];

  if (status) {
    if (Array.isArray(status)) {
      conditions.push(`f.status IN (${status.map(() => '?').join(',')})`);
      values.push(...status);
    } else {
      conditions.push('f.status = ?');
      values.push(status);
    }
  }
  // onlyOverdue=true: 只看已逾期(overdue)；false: 全部状态不过滤
  if (onlyOverdue) {
    conditions.push('f.status = ?');
    values.push('overdue');
  }
  if (roomNumber) { conditions.push('f.room_number LIKE ?'); values.push(`%${roomNumber}%`); }
  if (building) { conditions.push('r.building = ?'); values.push(building); }
  if (unit) { conditions.push('r.unit = ?'); values.push(unit); }
  if (ownerName) { conditions.push('r.owner_name LIKE ?'); values.push(`%${ownerName}%`); }
  if (overdueLevel) {
    const levels = Array.isArray(overdueLevel) ? overdueLevel : String(overdueLevel).split(',');
    if (levels.length === 1) {
      conditions.push('f.overdue_level = ?'); values.push(levels[0]);
    } else {
      const ph = levels.map(() => '?').join(',');
      conditions.push(`f.overdue_level IN (${ph})`);
      values.push(...levels);
    }
  }
  if (minOverdueDays !== undefined && minOverdueDays !== null) { conditions.push('f.overdue_days >= ?'); values.push(minOverdueDays); }
  if (maxOverdueDays !== undefined && maxOverdueDays !== null) { conditions.push('f.overdue_days <= ?'); values.push(maxOverdueDays); }
  if (minAmount !== undefined && minAmount !== null) { conditions.push('f.unpaid_amount >= ?'); values.push(minAmount); }
  if (maxAmount !== undefined && maxAmount !== null) { conditions.push('f.unpaid_amount <= ?'); values.push(maxAmount); }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await get<any>(
    `SELECT COUNT(*) as total FROM fees f JOIN rooms r ON f.room_id = r.id ${whereClause}`,
    ...values
  );
  const total = countRow?.total || 0;

  const offset = (page - 1) * pageSize;
  const list = await all(`
    SELECT
      f.id, f.room_id, f.room_number, f.period, f.fee_type,
      f.original_amount, f.reduction_amount, f.payable_amount,
      f.paid_amount, f.unpaid_amount, f.due_date, f.status,
      f.overdue_days, f.overdue_level, f.stage,
      f.created_at, f.updated_at,
      r.building, r.unit, r.floor, r.area,
      r.owner_name, r.owner_phone, r.owner_email,
      (SELECT COUNT(*) FROM customer_notes cn WHERE cn.room_number = f.room_number) as note_count,
      (SELECT COUNT(*) FROM complaints c WHERE c.room_number = f.room_number AND c.status = 'open') as complaint_count,
      (SELECT COUNT(*) FROM blacklists b WHERE b.room_number = f.room_number
        AND (b.effective_to IS NULL OR b.effective_to > datetime('now'))) as blacklisted
    FROM fees f
    JOIN rooms r ON f.room_id = r.id
    ${whereClause}
    ORDER BY f.overdue_days DESC, f.unpaid_amount DESC
    LIMIT ? OFFSET ?
  `, ...values, pageSize, offset);

  const statsRow = await get<any>(`
    SELECT
      COUNT(*) as total_count,
      COALESCE(SUM(f.unpaid_amount), 0) as total_unpaid,
      COALESCE(AVG(f.overdue_days), 0) as avg_overdue_days
    FROM fees f
    JOIN rooms r ON f.room_id = r.id
    ${whereClause}
  `, ...values);

  return {
    list: list.map((row: any) => ({ ...row, overdue_level_desc: getOverdueLevelDescription(row.overdue_level) })),
    pagination: paginate(total, page, pageSize),
    stats: statsRow,
  };
}

export async function getFeeDetail(feeId: string) {
  const fee = await get<any>(`
    SELECT
      f.*,
      r.building, r.unit, r.floor, r.area,
      r.owner_name, r.owner_phone, r.owner_email
    FROM fees f
    JOIN rooms r ON f.room_id = r.id
    WHERE f.id = ?
  `, feeId);
  if (!fee) return null;

  const [notes, complaints, histories, blacklisted, promises] = await Promise.all([
    all(`SELECT * FROM customer_notes WHERE room_number = ? ORDER BY created_at DESC LIMIT 20`, fee.room_number),
    all(`SELECT * FROM complaints WHERE room_number = ? ORDER BY created_at DESC LIMIT 10`, fee.room_number),
    all(`
      SELECT
        sq.id as queue_id, sq.channel, sq.status, sq.sent_at, sq.created_at,
        ct.name as task_name, ct.stage,
        r.result as receipt_result, r.delivered_at, r.promised_pay_at, r.note as receipt_note,
        cr.result as call_result, cr.duration, cr.note as call_note, cr.operator, cr.promised_pay_at as call_promised_at
      FROM send_queues sq
      LEFT JOIN collection_tasks ct ON sq.task_id = ct.id
      LEFT JOIN receipts r ON r.queue_id = sq.id
      LEFT JOIN call_records cr ON cr.queue_id = sq.id
      WHERE sq.fee_id = ?
      ORDER BY sq.created_at DESC
      LIMIT 50
    `, feeId),
    get(`SELECT * FROM blacklists WHERE room_number = ? AND (effective_to IS NULL OR effective_to > datetime('now'))`, fee.room_number),
    all(`SELECT * FROM call_records WHERE room_number = ? AND promised_pay_at IS NOT NULL ORDER BY created_at DESC LIMIT 10`, fee.room_number),
  ]);

  return {
    ...fee,
    overdue_level_desc: getOverdueLevelDescription(fee.overdue_level),
    notes, complaints, histories, blacklisted, promises,
  };
}

export async function searchByRoomNumber(keyword: string, page = 1, pageSize = 50) {
  const values = [`%${keyword}%`];
  const totalRow = await get<any>(
    `SELECT COUNT(DISTINCT r.id) as total FROM rooms r WHERE r.room_number LIKE ?`,
    ...values
  );

  const offset = (page - 1) * pageSize;
  const rooms = await all<any>(`
    SELECT
      r.id, r.room_number, r.building, r.unit, r.floor, r.area,
      r.owner_name, r.owner_phone, r.status
    FROM rooms r
    WHERE r.room_number LIKE ?
    ORDER BY r.room_number
    LIMIT ? OFFSET ?
  `, ...values, pageSize, offset);

  const list: any[] = [];
  for (const r of rooms) {
    const agg = await get<any>(`
      SELECT
        COALESCE(SUM(CASE WHEN f.status != 'paid' THEN f.unpaid_amount END), 0) as total_unpaid,
        COALESCE(MAX(CASE WHEN f.status != 'paid' THEN f.overdue_days END), 0) as max_overdue_days,
        (SELECT COUNT(*) FROM fees f2 WHERE f2.room_id = ? AND f2.status != 'paid') as unpaid_count,
        (SELECT COUNT(*) FROM fees f2 WHERE f2.room_id = ?) as total_count
      FROM fees f WHERE f.room_id = ?
    `, r.id, r.id, r.id);

    const levels = await all<any>(`
      SELECT f.overdue_level, COUNT(*) as cnt, f.overdue_days as od
      FROM fees f WHERE f.room_id = ? AND f.status != 'paid'
      GROUP BY f.overdue_level ORDER BY f.overdue_days DESC
    `, r.id);

    const levelOrder: Record<string, number> = { normal: 0, warning: 1, mild: 2, moderate: 3, severe: 4, critical: 5 };
    let highestLevel = 'normal';
    let maxDays = 0;
    for (const l of levels) {
      if ((levelOrder[l.overdue_level] ?? -1) > (levelOrder[highestLevel] ?? -1)) {
        highestLevel = l.overdue_level;
      }
      if (l.od > maxDays) maxDays = l.od;
    }

    list.push({
      ...r,
      total_unpaid: agg?.total_unpaid || 0,
      max_overdue_days: agg?.max_overdue_days || maxDays,
      highest_level: highestLevel,
      highest_level_desc: getOverdueLevelDescription(highestLevel),
      unpaid_count: agg?.unpaid_count || 0,
      total_fee_count: agg?.total_count || 0,
      overdue_levels_dist: levels.map((l: any) => ({ level: l.overdue_level, count: l.cnt })),
    });
  }

  list.sort((a, b) => b.total_unpaid - a.total_unpaid);

  return {
    list,
    pagination: paginate(totalRow?.total || 0, page, pageSize),
  };
}
