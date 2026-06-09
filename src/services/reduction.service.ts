import { run, get, all } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import { getNow } from '../utils/helpers';
import { refreshFeeStatus } from './fee.service';

export async function createReduction(data: any) {
  const { feeId, reductionAmount, reason, applicant, applicantNote } = data;
  const fee = await get<any>('SELECT * FROM fees WHERE id = ?', feeId);
  if (!fee) throw new Error('费用记录不存在');
  if (reductionAmount > fee.unpaid_amount + 0.01) {
    throw new Error(`减免金额 ${reductionAmount} 超过欠费金额 ${fee.unpaid_amount.toFixed(2)}`);
  }
  const existing = await get(`SELECT * FROM reductions WHERE fee_id = ? AND status = 'pending'`, feeId);
  if (existing) throw new Error('该费用已有待审批的减免申请');

  const id = uuidv4();
  await run(`
    INSERT INTO reductions
      (id, fee_id, room_number, reduction_amount, original_unpaid, reason,
       applicant, applicant_note, status, approver, approval_note, approved_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)
  `, id, feeId, fee.room_number, reductionAmount, fee.unpaid_amount,
     reason, applicant, applicantNote || null, getNow());

  return { id, feeId, roomNumber: fee.room_number, reductionAmount, status: 'pending', message: '减免申请已提交，等待主管审批' };
}

export async function approveReduction(data: any) {
  const { reductionId, approved, approver, approvalNote } = data;
  const reduction = await get<any>('SELECT * FROM reductions WHERE id = ?', reductionId);
  if (!reduction) throw new Error('减免申请不存在');
  if (reduction.status !== 'pending') {
    throw new Error(`该申请已${reduction.status === 'approved' ? '通过' : '拒绝'}，不可重复审批`);
  }
  const now = getNow();

  if (approved) {
    await run(`
      UPDATE reductions SET status = 'approved', approver = ?, approval_note = ?, approved_at = ? WHERE id = ?
    `, approver, approvalNote || null, now, reductionId);
    await run(`
      UPDATE fees SET
        reduction_amount = reduction_amount + ?,
        payable_amount = payable_amount - ?,
        unpaid_amount = MAX(0, unpaid_amount - ?),
        status = CASE WHEN MAX(0, unpaid_amount - ?) <= 0.01 THEN 'paid' ELSE status END,
        updated_at = ?
      WHERE id = ?
    `, reduction.reduction_amount, reduction.reduction_amount,
       reduction.reduction_amount, reduction.reduction_amount, now, reduction.fee_id);
    await refreshFeeStatus(reduction.fee_id);
  } else {
    await run(`
      UPDATE reductions SET status = 'rejected', approver = ?, approval_note = ?, approved_at = ? WHERE id = ?
    `, approver, approvalNote || null, now, reductionId);
  }
  return { id: reductionId, status: approved ? 'approved' : 'rejected', approvedAt: now };
}

export async function getReductions(status?: string, roomNumber?: string, page = 1, pageSize = 50) {
  const conditions: string[] = [];
  const values: any[] = [];
  if (status) { conditions.push('r.status = ?'); values.push(status); }
  if (roomNumber) { conditions.push('r.room_number LIKE ?'); values.push(`%${roomNumber}%`); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await get<any>(`SELECT COUNT(*) as total FROM reductions r ${whereClause}`, ...values);
  const total = countRow?.total || 0;
  const offset = (page - 1) * pageSize;
  const list = await all(`
    SELECT r.*, f.unpaid_amount as current_unpaid, f.period, f.due_date,
           ro.owner_name, ro.building, ro.unit
    FROM reductions r
    JOIN fees f ON r.fee_id = f.id
    JOIN rooms ro ON f.room_id = ro.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `, ...values, pageSize, offset);
  const stats = await all(`
    SELECT status, COUNT(*) as count, COALESCE(SUM(reduction_amount), 0) as total_amount
    FROM reductions GROUP BY status
  `);

  return {
    list,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    stats,
  };
}

export async function getReductionDetail(id: string) {
  const reduction = await get<any>(`
    SELECT r.*, f.unpaid_amount as current_unpaid, f.period, f.due_date,
           ro.owner_name, ro.owner_phone, ro.building, ro.unit, ro.area
    FROM reductions r
    JOIN fees f ON r.fee_id = f.id
    JOIN rooms ro ON f.room_id = ro.id
    WHERE r.id = ?
  `, id);
  if (!reduction) return null;
  const histories = await all(`
    SELECT * FROM reductions WHERE fee_id = (SELECT fee_id FROM reductions WHERE id = ?) ORDER BY created_at DESC LIMIT 20
  `, id);
  return { reduction, histories };
}
