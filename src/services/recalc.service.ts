import { run, get, all } from '../db/connection';
import { getNow } from '../utils/helpers';
import { refreshFeeStatus } from './fee.service';

export async function recalculateFees(feeIds: string[], reason?: string) {
  const results = [];
  const now = getNow();

  for (const feeId of feeIds) {
    const fee = await get<any>('SELECT * FROM fees WHERE id = ?', feeId);
    if (!fee) {
      results.push({ feeId, success: false, error: '费用记录不存在' });
      continue;
    }
    const room = await get<any>('SELECT area FROM rooms WHERE id = ?', fee.room_id);
    if (!room) {
      results.push({ feeId, success: false, error: '房屋信息不存在' });
      continue;
    }

    const unitPrice = fee.fee_type === 'property' ? 2.5 : 5.0;
    const baseAmount = parseFloat((room.area * unitPrice).toFixed(2));
    const periodMonth = parseInt(fee.period.split('-')[1] || '1');
    let serviceCharge = 0;
    let lateFee = 0;

    if (fee.status === 'overdue') {
      const overdueDays = Math.max(0, fee.overdue_days);
      lateFee = parseFloat((baseAmount * 0.0005 * overdueDays).toFixed(2));
      serviceCharge = parseFloat((baseAmount * 0.02).toFixed(2));
    } else if (periodMonth % 3 === 0) {
      serviceCharge = parseFloat((baseAmount * 0.01).toFixed(2));
    }

    const newOriginal = parseFloat((baseAmount + serviceCharge + lateFee).toFixed(2));
    const newPayable = parseFloat((newOriginal - fee.reduction_amount).toFixed(2));
    const newUnpaid = parseFloat((newPayable - fee.paid_amount).toFixed(2));

    const oldData = {
      original_amount: fee.original_amount,
      payable_amount: fee.payable_amount,
      unpaid_amount: fee.unpaid_amount,
    };

    await run(`
      UPDATE fees SET
        original_amount = ?,
        payable_amount = ?,
        unpaid_amount = ?,
        last_recalc_at = ?,
        recalc_note = ?,
        updated_at = ?
      WHERE id = ?
    `, newOriginal, newPayable, newUnpaid, now, reason || '系统重算', now, feeId);

    await refreshFeeStatus(feeId);

    results.push({
      feeId,
      success: true,
      roomNumber: fee.room_number,
      old: oldData,
      new: { original_amount: newOriginal, payable_amount: newPayable, unpaid_amount: newUnpaid },
      changes: {
        original_delta: parseFloat((newOriginal - oldData.original_amount).toFixed(2)),
        payable_delta: parseFloat((newPayable - oldData.payable_amount).toFixed(2)),
        unpaid_delta: parseFloat((newUnpaid - oldData.unpaid_amount).toFixed(2)),
      },
    });
  }

  const totalRecalc = results.filter(r => r.success).length;
  const totalDelta = results.filter(r => r.success)
    .reduce((sum, r: any) => sum + (r.changes?.unpaid_delta || 0), 0);

  return {
    results,
    summary: {
      total: feeIds.length,
      recalculated: totalRecalc,
      failed: feeIds.length - totalRecalc,
      total_unpaid_delta: parseFloat(totalDelta.toFixed(2)),
    },
  };
}

export async function getRecalcHistory(feeId: string) {
  const rows = await all(`
    SELECT id, api_path, request_body, created_at
    FROM operation_logs
    WHERE api_path = '/api/fees/recalc'
      AND request_body LIKE ?
    ORDER BY created_at DESC
    LIMIT 50
  `, `%"${feeId}"%`);
  return rows.map((row: any) => {
    try {
      const body = JSON.parse(row.request_body);
      return { id: row.id, at: row.created_at, reason: body.reason || '' };
    } catch {
      return { id: row.id, at: row.created_at, reason: '' };
    }
  });
}
