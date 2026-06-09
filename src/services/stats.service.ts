import { get, all } from '../db/connection';
import { createObjectCsvStringifier } from 'csv-writer';
import { getOverdueLevelDescription, getStageDescription, getChannelDescription } from '../utils/helpers';

export async function getCollectionStats(params: any) {
  const { startDate, endDate, building, dimension } = params;

  const dateConditions: string[] = [];
  const dateValues: any[] = [];
  if (startDate) { dateConditions.push('created_at >= ?'); dateValues.push(startDate); }
  if (endDate) { dateConditions.push('created_at <= ?'); dateValues.push(endDate); }
  const dateWhere = dateConditions.length > 0 ? `WHERE ${dateConditions.join(' AND ')}` : '';

  const overview = await get<any>(`
    SELECT
      (SELECT COUNT(*) FROM fees WHERE status = 'overdue') as overdue_count,
      (SELECT COUNT(*) FROM fees WHERE status = 'paid') as paid_count,
      (SELECT COUNT(*) FROM fees) as total_fees,
      (SELECT COALESCE(SUM(unpaid_amount), 0) FROM fees WHERE status != 'paid') as total_unpaid,
      (SELECT COALESCE(SUM(paid_amount), 0) FROM fees) as total_paid,
      (SELECT COALESCE(SUM(original_amount), 0) FROM fees) as total_original,
      (SELECT COUNT(*) FROM collection_tasks ${dateWhere}) as total_tasks,
      (SELECT COUNT(*) FROM send_queues sq ${dateWhere ? `${dateWhere.replace('WHERE', 'WHERE')}` : ''}) as total_sent,
      (SELECT COUNT(*) FROM send_queues WHERE status = 'delivered'
        ${dateWhere ? `AND ${dateWhere.replace('WHERE', '')}` : ''}) as total_delivered,
      (SELECT COUNT(*) FROM complaints WHERE status = 'open') as open_complaints,
      (SELECT COUNT(*) FROM reductions WHERE status = 'pending') as pending_reductions
  `, ...dateValues, ...dateValues, ...dateValues);

  let dimensionData: any = {};
  switch (dimension) {
    case 'stage': dimensionData = await getByStage(); break;
    case 'channel': dimensionData = await getByChannel(dateConditions, dateValues); break;
    case 'call_result': dimensionData = await getByCallResult(dateConditions, dateValues); break;
    default: dimensionData = await getOverallBreakdown();
  }

  const ovr = overview || {} as any;
  return {
    overview: {
      ...ovr,
      overdue_rate: ovr.total_fees > 0 ? parseFloat(((ovr.overdue_count / ovr.total_fees) * 100).toFixed(2)) : 0,
      collection_rate: ovr.total_original > 0 ? parseFloat(((ovr.total_paid / ovr.total_original) * 100).toFixed(2)) : 0,
      delivery_rate: ovr.total_sent > 0 ? parseFloat(((ovr.total_delivered / ovr.total_sent) * 100).toFixed(2)) : 0,
    },
    dimension, dimensionData,
  };
}

async function getOverallBreakdown() {
  const byOverdue = await all(`
    SELECT overdue_level, COUNT(*) as count, COALESCE(SUM(unpaid_amount), 0) as amount
    FROM fees WHERE status != 'paid' GROUP BY overdue_level ORDER BY overdue_level
  `);
  const byStage = await all(`
    SELECT stage, COUNT(*) as count, COALESCE(SUM(unpaid_amount), 0) as amount
    FROM fees WHERE status != 'paid' GROUP BY stage ORDER BY stage
  `);
  return {
    byOverdue: byOverdue.map((r: any) => ({ level: r.overdue_level, level_desc: getOverdueLevelDescription(r.overdue_level), count: r.count, amount: r.amount })),
    byStage: byStage.map((r: any) => ({ stage: r.stage, stage_desc: getStageDescription(r.stage), count: r.count, amount: r.amount })),
  };
}

async function getByStage() {
  const stageStats = await all(`
    SELECT ct.stage,
      COUNT(DISTINCT ct.id) as task_count,
      COUNT(sq.id) as sent_count,
      COUNT(CASE WHEN sq.status = 'delivered' THEN 1 END) as delivered_count,
      COUNT(CASE WHEN cr.id IS NOT NULL THEN 1 END) as call_count,
      COUNT(CASE WHEN cr.result = 'promised' THEN 1 END) as promised_count
    FROM collection_tasks ct
    LEFT JOIN send_queues sq ON sq.task_id = ct.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    GROUP BY ct.stage ORDER BY ct.stage
  `);
  return stageStats.map((r: any) => ({
    ...r, stage_desc: getStageDescription(r.stage),
    delivery_rate: r.sent_count > 0 ? parseFloat(((r.delivered_count / r.sent_count) * 100).toFixed(2)) : 0,
  }));
}

async function getByChannel(dateConditions: string[], values: any[]) {
  const whereClause = dateConditions.length > 0 ? `WHERE ${dateConditions.join(' AND ')}` : '';
  const rows = await all(`
    SELECT channel, COUNT(*) as total_count,
      COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent_count,
      COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_count,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
      COUNT(CASE WHEN status = 'intercepted' THEN 1 END) as intercepted_count
    FROM send_queues ${whereClause} GROUP BY channel ORDER BY total_count DESC
  `, ...values);
  return rows.map((r: any) => ({
    ...r, channel_desc: getChannelDescription(r.channel),
    success_rate: r.total_count > 0 ? parseFloat((((r.sent_count + r.delivered_count) / r.total_count) * 100).toFixed(2)) : 0,
  }));
}

async function getByCallResult(dateConditions: string[], values: any[]) {
  const whereClause = dateConditions.length > 0 ? `WHERE ${dateConditions.join(' AND ')}` : '';
  return all(`
    SELECT result, COUNT(*) as count, COALESCE(AVG(duration), 0) as avg_duration
    FROM call_records ${whereClause} GROUP BY result ORDER BY count DESC
  `, ...values);
}

export async function getBuildingRanking() {
  const buildings = await all(`
    SELECT
      r.building,
      COUNT(DISTINCT r.id) as total_rooms,
      COUNT(DISTINCT f.id) as total_fees,
      COUNT(DISTINCT CASE WHEN f.status = 'overdue' THEN f.id END) as overdue_fees,
      COUNT(DISTINCT CASE WHEN f.status = 'paid' THEN f.id END) as paid_fees,
      COALESCE(SUM(CASE WHEN f.status != 'paid' THEN f.unpaid_amount END), 0) as total_unpaid,
      COALESCE(SUM(f.paid_amount), 0) as total_paid,
      COALESCE(SUM(f.original_amount), 0) as total_original,
      COALESCE(AVG(CASE WHEN f.status = 'overdue' THEN f.overdue_days END), 0) as avg_overdue_days,
      COALESCE(MAX(CASE WHEN f.status = 'overdue' THEN f.overdue_days END), 0) as max_overdue_days
    FROM rooms r
    LEFT JOIN fees f ON f.room_id = r.id
    GROUP BY r.building
    ORDER BY total_unpaid DESC
  `);
  return buildings.map((b: any) => ({
    ...b,
    avg_unpaid: b.total_rooms > 0 ? parseFloat((b.total_unpaid / b.total_rooms).toFixed(2)) : 0,
    overdue_rate: b.total_fees > 0 ? parseFloat(((b.overdue_fees / b.total_fees) * 100).toFixed(2)) : 0,
    collection_rate: b.total_original > 0 ? parseFloat(((b.total_paid / b.total_original) * 100).toFixed(2)) : 0,
  }));
}

export async function exportOverdueData(format: 'csv' | 'json' = 'csv') {
  const data = await all(`
    SELECT
      r.room_number, r.building, r.unit, r.floor, r.area,
      r.owner_name, r.owner_phone, r.owner_email,
      f.period, f.fee_type, f.original_amount, f.reduction_amount,
      f.payable_amount, f.paid_amount, f.unpaid_amount, f.due_date,
      f.overdue_days, f.overdue_level, f.stage
    FROM fees f JOIN rooms r ON f.room_id = r.id
    WHERE f.status != 'paid'
    ORDER BY f.overdue_days DESC, f.unpaid_amount DESC
  `);
  if (format === 'json') return JSON.stringify(data, null, 2);
  const csvStringifier = createObjectCsvStringifier({
    header: [
      { id: 'building', title: '楼栋' }, { id: 'unit', title: '单元' }, { id: 'room_number', title: '房号' },
      { id: 'floor', title: '楼层' }, { id: 'area', title: '面积' }, { id: 'owner_name', title: '业主姓名' },
      { id: 'owner_phone', title: '联系电话' }, { id: 'owner_email', title: '邮箱' },
      { id: 'period', title: '费用周期' }, { id: 'fee_type', title: '费用类型' },
      { id: 'original_amount', title: '应收金额' }, { id: 'reduction_amount', title: '减免金额' },
      { id: 'payable_amount', title: '应缴金额' }, { id: 'paid_amount', title: '已缴金额' },
      { id: 'unpaid_amount', title: '欠费金额' }, { id: 'due_date', title: '到期日' },
      { id: 'overdue_days', title: '逾期天数' }, { id: 'overdue_level', title: '逾期等级' }, { id: 'stage', title: '催缴阶段' },
    ],
  });
  return csvStringifier.getHeaderString() + csvStringifier.stringifyRecords(data as any[]);
}

export async function exportTaskData(taskId: string, format: 'csv' | 'json' = 'csv') {
  const data = await all(`
    SELECT
      sq.room_number, r.owner_name, r.owner_phone, r.building, r.unit,
      sq.channel, sq.status, sq.priority, sq.created_at, sq.sent_at, sq.delivered_at,
      f.period, f.unpaid_amount, f.overdue_days, f.overdue_level,
      rec.result as receipt_result, rec.promised_pay_at,
      cr.result as call_result, cr.duration as call_duration, cr.operator
    FROM send_queues sq
    JOIN rooms r ON sq.room_number = r.room_number
    JOIN fees f ON sq.fee_id = f.id
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    WHERE sq.task_id = ?
    ORDER BY sq.created_at DESC
  `, taskId);
  if (format === 'json') return JSON.stringify(data, null, 2);
  const csvStringifier = createObjectCsvStringifier({
    header: [
      { id: 'building', title: '楼栋' }, { id: 'unit', title: '单元' }, { id: 'room_number', title: '房号' },
      { id: 'owner_name', title: '业主' }, { id: 'owner_phone', title: '电话' },
      { id: 'channel', title: '发送渠道' }, { id: 'status', title: '状态' },
      { id: 'priority', title: '优先级' }, { id: 'period', title: '费用周期' },
      { id: 'unpaid_amount', title: '欠费金额' }, { id: 'overdue_days', title: '逾期天数' },
      { id: 'created_at', title: '创建时间' }, { id: 'sent_at', title: '发送时间' },
      { id: 'delivered_at', title: '送达时间' }, { id: 'receipt_result', title: '回执结果' },
      { id: 'call_result', title: '通话结果' }, { id: 'call_duration', title: '通话时长' },
      { id: 'operator', title: '客服' }, { id: 'promised_pay_at', title: '承诺付款日' },
    ],
  });
  return csvStringifier.getHeaderString() + csvStringifier.stringifyRecords(data as any[]);
}
