import { run, get, all } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import { getNow } from '../utils/helpers';
import { refreshFeeStatus } from './fee.service';

export async function syncPayment(data: any) {
  const { paymentNo, feeIds = [], roomNumber, amount, paidAt, method, payer } = data;
  const existing = await get('SELECT id FROM payments WHERE payment_no = ?', paymentNo);
  if (existing) {
    return { paymentNo, status: 'duplicate', message: '该付款单号已存在，跳过同步' };
  }

  let targetFeeIds = [...feeIds];
  if (targetFeeIds.length === 0 && roomNumber) {
    const autoFees = await all<any>(
      `SELECT id FROM fees WHERE room_number = ? AND status != 'paid' ORDER BY due_date ASC`,
      roomNumber
    );
    targetFeeIds = autoFees.map(f => f.id);
  }
  if (targetFeeIds.length === 0) throw new Error('未找到任何可分摊的欠费记录');

  const feeRows = await all<any>(
    `SELECT * FROM fees WHERE id IN (${targetFeeIds.map(() => '?').join(',')})`,
    ...targetFeeIds
  );
  if (feeRows.length === 0) throw new Error('未找到对应的费用记录');

  const roomNumbers = Array.from(new Set(feeRows.map(r => r.room_number)));
  const totalUnpaid = feeRows.reduce((sum, r) => sum + r.unpaid_amount, 0);
  if (amount > totalUnpaid + 0.01) {
    throw new Error(`付款金额 ${amount} 超过欠费总额 ${totalUnpaid.toFixed(2)}`);
  }

  const paymentId = uuidv4();
  await run(`
    INSERT INTO payments (id, payment_no, fee_ids, room_number, amount, paid_at, method, payer, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, paymentId, paymentNo, JSON.stringify(targetFeeIds), roomNumbers[0], amount, paidAt, method, payer || null, getNow());

  let remainAmount = amount;
  const allocations: any[] = [];
  for (const fee of feeRows) {
    if (remainAmount <= 0) break;
    const toAllocate = Math.min(remainAmount, fee.unpaid_amount);
    if (toAllocate > 0) {
      await run(`
        UPDATE fees SET
          paid_amount = paid_amount + ?,
          unpaid_amount = MAX(0, unpaid_amount - ?),
          status = CASE WHEN MAX(0, unpaid_amount - ?) <= 0.01 THEN 'paid' ELSE status END,
          updated_at = ?
        WHERE id = ?
      `, toAllocate, toAllocate, toAllocate, getNow(), fee.id);
      await refreshFeeStatus(fee.id);
      allocations.push({
        feeId: fee.id, roomNumber: fee.room_number, period: fee.period,
        allocated: toAllocate, oldUnpaid: fee.unpaid_amount,
        newUnpaid: parseFloat((fee.unpaid_amount - toAllocate).toFixed(2)),
      });
      remainAmount = parseFloat((remainAmount - toAllocate).toFixed(2));
    }
  }

  return {
    paymentNo, status: 'success', paymentId, allocations,
    totalAllocated: parseFloat((amount - remainAmount).toFixed(2)),
  };
}

export async function getPaymentHistory(roomNumber?: string, startDate?: string, endDate?: string, page = 1, pageSize = 50, building?: string) {
  const conditions: string[] = [];
  const values: any[] = [];
  if (building) { conditions.push(`room_number IN (SELECT room_number FROM rooms WHERE building = ?)`); values.push(building); }
  if (roomNumber) { conditions.push('room_number LIKE ?'); values.push(`%${roomNumber}%`); }
  if (startDate) { conditions.push('paid_at >= ?'); values.push(startDate); }
  if (endDate) { conditions.push('paid_at <= ?'); values.push(endDate); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await get<any>(`SELECT COUNT(*) as total FROM payments ${whereClause}`, ...values);
  const total = countRow?.total || 0;
  const offset = (page - 1) * pageSize;
  const list = await all(`SELECT * FROM payments ${whereClause} ORDER BY paid_at DESC LIMIT ? OFFSET ?`, ...values, pageSize, offset);
  const stats = await get<any>(`
    SELECT COUNT(*) as total_count, COALESCE(SUM(amount), 0) as total_amount FROM payments ${whereClause}
  `, ...values);

  return {
    list,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    stats,
  };
}

export async function getUnpaidDetailByRoom(roomNumber: string) {
  const [fees, payments] = await Promise.all([
    all(`SELECT * FROM fees WHERE room_number = ? AND status != 'paid' ORDER BY due_date ASC`, roomNumber),
    all(`SELECT * FROM payments WHERE room_number = ? ORDER BY paid_at DESC LIMIT 20`, roomNumber),
  ]);
  const totalUnpaid = (fees as any[]).reduce((sum, f) => sum + f.unpaid_amount, 0);
  const totalPaid = (payments as any[]).reduce((sum, p) => sum + p.amount, 0);
  return {
    roomNumber, fees, payments,
    summary: {
      unpaidCount: fees.length,
      totalUnpaid: parseFloat(totalUnpaid.toFixed(2)),
      totalPaid: parseFloat(totalPaid.toFixed(2)),
      latestPayment: payments[0] || null,
    },
  };
}
