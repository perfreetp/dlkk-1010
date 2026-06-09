import { get, all } from '../db/connection';
import { createObjectCsvStringifier } from 'csv-writer';
import { getOverdueLevelDescription, getStageDescription, getChannelDescription } from '../utils/helpers';

interface ComboParams {
  startDate?: string;
  endDate?: string;
  building?: string;
  stage?: string | string[];
  channel?: string | string[];
  // 组合维度: building / stage / channel / building_stage / building_channel / stage_channel / all
  groupBy?: 'building' | 'stage' | 'channel' | 'building_stage' | 'building_channel' | 'stage_channel' | 'all';
}

export async function getComboStats(p: ComboParams = {}) {
  const { startDate, endDate, building, groupBy = 'all' } = p;
  let { stage, channel } = p;
  if (typeof stage === 'string') stage = stage.split(',').filter(Boolean);
  if (typeof channel === 'string') channel = channel.split(',').filter(Boolean);

  const feeCond: string[] = [];
  const feeValues: any[] = [];
  if (building) { feeCond.push('r.building = ?'); feeValues.push(building); }
  if (stage && stage.length > 0) {
    feeCond.push(`f.stage IN (${stage.map(() => '?').join(',')})`);
    feeValues.push(...stage);
  }
  const feeWhere = feeCond.length ? `WHERE ${feeCond.join(' AND ')}` : '';

  const queueCond: string[] = [];
  const queueValues: any[] = [];
  if (startDate) { queueCond.push('sq.created_at >= ?'); queueValues.push(startDate); }
  if (endDate) { queueCond.push('sq.created_at <= ?'); queueValues.push(endDate); }
  if (building) { queueCond.push('r2.building = ?'); queueValues.push(building); }
  if (stage && stage.length > 0) {
    queueCond.push(`ct.stage IN (${stage.map(() => '?').join(',')})`);
    queueValues.push(...stage);
  }
  if (channel && channel.length > 0) {
    queueCond.push(`sq.channel IN (${channel.map(() => '?').join(',')})`);
    queueValues.push(...channel);
  }
  const queueWhere = queueCond.length ? `WHERE ${queueCond.join(' AND ')}` : '';

  const payCond: string[] = [];
  const payValues: any[] = [];
  if (startDate) { payCond.push('py.paid_at >= ?'); payValues.push(startDate); }
  if (endDate) { payCond.push('py.paid_at <= ?'); payValues.push(endDate); }
  if (building) { payCond.push('r3.building = ?'); payValues.push(building); }
  if (stage && stage.length > 0) {
    payCond.push(`f3.stage IN (${stage.map(() => '?').join(',')})`);
    payValues.push(...stage);
  }
  const payWhere = payCond.length ? `WHERE ${payCond.join(' AND ')}` : '';

  let groupFields: string[] = [];
  let groupLabels: string[] = [];
  let groupSelect: string[] = [];
  let groupOrder: string[] = [];

  switch (groupBy) {
    case 'building':
      groupFields = ['building'];
      groupLabels = ['楼栋'];
      groupSelect = [
        `r.building as building`,
        `r2.building as building`,
        `r3.building as building`,
      ];
      groupOrder = ['building'];
      break;
    case 'stage':
      groupFields = ['stage'];
      groupLabels = ['阶段'];
      groupSelect = [
        `f.stage as stage`,
        `ct.stage as stage`,
        `f3.stage as stage`,
      ];
      groupOrder = ['stage'];
      break;
    case 'channel':
      groupFields = ['channel'];
      groupLabels = ['渠道'];
      groupSelect = [`null`, `sq.channel as channel`, `null`];
      groupOrder = ['channel'];
      break;
    case 'building_stage':
      groupFields = ['building', 'stage'];
      groupLabels = ['楼栋', '阶段'];
      groupSelect = [
        `r.building as building, f.stage as stage`,
        `r2.building as building, ct.stage as stage`,
        `r3.building as building, f3.stage as stage`,
      ];
      groupOrder = ['building', 'stage'];
      break;
    case 'building_channel':
      groupFields = ['building', 'channel'];
      groupLabels = ['楼栋', '渠道'];
      groupSelect = [
        `r.building as building, null as channel`,
        `r2.building as building, sq.channel as channel`,
        `r3.building as building, null as channel`,
      ];
      groupOrder = ['building', 'channel'];
      break;
    case 'stage_channel':
      groupFields = ['stage', 'channel'];
      groupLabels = ['阶段', '渠道'];
      groupSelect = [
        `f.stage as stage, null as channel`,
        `ct.stage as stage, sq.channel as channel`,
        `f3.stage as stage, null as channel`,
      ];
      groupOrder = ['stage', 'channel'];
      break;
    default: // all
      groupFields = [];
      groupLabels = [];
      groupSelect = [`null`, `null`, `null`];
      groupOrder = [];
  }

  const gn = groupFields.length;
  const seqN = Array.from({length: gn}, (_, i) => String(i+1)).join(',');
  const buildGroupBy = () => gn > 0 ? `GROUP BY ${seqN}` : '';
  const buildOrderBy = () => gn > 0 ? `ORDER BY ${seqN}` : '';

  const feeRows = await all<any>(`
    SELECT ${groupSelect[0]},
      COUNT(DISTINCT f.id) as fee_count,
      COALESCE(SUM(CASE WHEN f.status != 'paid' THEN f.unpaid_amount END), 0) as total_unpaid,
      COALESCE(SUM(f.original_amount), 0) as total_original,
      COALESCE(SUM(f.paid_amount), 0) as total_paid
    FROM fees f JOIN rooms r ON f.room_id = r.id
    ${feeWhere}
    ${buildGroupBy()}
    ${buildOrderBy()}
  `, ...feeValues);

  const queueRows = await all<any>(`
    SELECT ${groupSelect[1]},
      COUNT(DISTINCT sq.id) as touch_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.id END) as delivered_count,
      COUNT(DISTINCT CASE WHEN rec.result = 'promised' OR cr.result = 'promised' THEN sq.id END) as promised_count
    FROM send_queues sq
    JOIN rooms r2 ON sq.room_number = r2.room_number
    LEFT JOIN collection_tasks ct ON sq.task_id = ct.id
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    ${queueWhere}
    ${buildGroupBy()}
    ${buildOrderBy()}
  `, ...queueValues);

  const payRows = await all<any>(`
    SELECT ${groupSelect[2]},
      COUNT(DISTINCT py.id) as payment_count,
      COALESCE(SUM(py.amount), 0) as actual_payment
    FROM payments py
    JOIN rooms r3 ON py.room_number = r3.room_number
    LEFT JOIN fees f3 ON f3.room_number = py.room_number
    ${payWhere}
    ${buildGroupBy()}
    ${buildOrderBy()}
  `, ...payValues);

  const keyOf = (row: any): string => groupFields.map(f => String(row?.[f] ?? '')).join('||');
  const feeMap = new Map(feeRows.map(r => [keyOf(r), r]));
  const queueMap = new Map(queueRows.map(r => [keyOf(r), r]));
  const payMap = new Map(payRows.map(r => [keyOf(r), r]));

  const allKeys = new Set([...feeMap.keys(), ...queueMap.keys(), ...payMap.keys()]);
  const groups: any[] = [];

  for (const k of allKeys) {
    const f = feeMap.get(k) || {};
    const q = queueMap.get(k) || {};
    const p = payMap.get(k) || {};
    const original = f.total_original || 0;
    const unpaid = f.total_unpaid || 0;
    const delivered = q.delivered_count || 0;
    const promised = q.promised_count || 0;
    const actual = p.actual_payment || 0;
    const returnRate = original > 0 ? parseFloat(((actual / original) * 100).toFixed(2)) : 0;
    const touch = q.touch_count || 0;

    const group: any = {
      group_fields: groupFields,
      group_labels: groupLabels,
      building: f.building || q.building || p.building || null,
      stage: f.stage || q.stage || p.stage || null,
      channel: q.channel || null,
      fee_count: f.fee_count || 0,
      total_unpaid: parseFloat(unpaid.toFixed(2)),
      total_original: parseFloat(original.toFixed(2)),
      touch_count: touch,
      delivered_count: delivered,
      promised_count: promised,
      actual_payment: parseFloat(actual.toFixed(2)),
      return_rate: returnRate,
    };
    if (group.stage) group.stage_desc = getStageDescription(group.stage);
    if (group.channel) group.channel_desc = getChannelDescription(group.channel);
    groups.push(group);
  }

  // 汇总
  const totals = {
    fee_count: groups.reduce((s, g) => s + g.fee_count, 0),
    total_unpaid: parseFloat(groups.reduce((s, g) => s + g.total_unpaid, 0).toFixed(2)),
    total_original: parseFloat(groups.reduce((s, g) => s + g.total_original, 0).toFixed(2)),
    touch_count: groups.reduce((s, g) => s + g.touch_count, 0),
    delivered_count: groups.reduce((s, g) => s + g.delivered_count, 0),
    promised_count: groups.reduce((s, g) => s + g.promised_count, 0),
    actual_payment: parseFloat(groups.reduce((s, g) => s + g.actual_payment, 0).toFixed(2)),
    return_rate: 0,
  };
  totals.return_rate = totals.total_original > 0
    ? parseFloat(((totals.actual_payment / totals.total_original) * 100).toFixed(2)) : 0;

  return {
    filters: { startDate, endDate, building, stage: stage || null, channel: channel || null, groupBy },
    groups,
    totals,
  };
}

export async function getCollectionStats(params: any) {
  const { startDate, endDate, building, dimension } = params;
  const dateConditions: string[] = [];
  const dateValues: any[] = [];
  if (startDate) { dateConditions.push('created_at >= ?'); dateValues.push(startDate); }
  if (endDate) { dateConditions.push('created_at <= ?'); dateValues.push(endDate); }
  const dateWhere = dateConditions.length > 0 ? `WHERE ${dateConditions.join(' AND ')}` : '';

  const buildingAnd = building ? " AND r.building = '" + building.replace(/'/g, "''") + "'" : '';

  const overview = await get<any>(`
    SELECT
      (SELECT COUNT(*) FROM fees f JOIN rooms r ON f.room_id = r.id WHERE f.status = 'overdue'${buildingAnd}) as overdue_count,
      (SELECT COUNT(*) FROM fees f JOIN rooms r ON f.room_id = r.id WHERE f.status = 'paid'${buildingAnd}) as paid_count,
      (SELECT COUNT(*) FROM fees f JOIN rooms r ON f.room_id = r.id WHERE 1=1${buildingAnd}) as total_fees,
      (SELECT COALESCE(SUM(f.unpaid_amount), 0) FROM fees f JOIN rooms r ON f.room_id = r.id WHERE f.status != 'paid'${buildingAnd}) as total_unpaid,
      (SELECT COALESCE(SUM(f.paid_amount), 0) FROM fees f JOIN rooms r ON f.room_id = r.id WHERE 1=1${buildingAnd}) as total_paid,
      (SELECT COALESCE(SUM(f.original_amount), 0) FROM fees f JOIN rooms r ON f.room_id = r.id WHERE 1=1${buildingAnd}) as total_original,
      (SELECT COUNT(DISTINCT ct.id) FROM collection_tasks ct LEFT JOIN send_queues sq ON sq.task_id = ct.id LEFT JOIN rooms r ON sq.room_number = r.room_number WHERE 1=1 ${dateWhere.replace('WHERE', 'AND')}${buildingAnd}) as total_tasks,
      (SELECT COUNT(DISTINCT sq.id) FROM send_queues sq LEFT JOIN rooms r ON sq.room_number = r.room_number WHERE 1=1 ${dateWhere.replace('WHERE', 'AND')}${buildingAnd}) as total_sent,
      (SELECT COUNT(DISTINCT sq.id) FROM send_queues sq LEFT JOIN rooms r ON sq.room_number = r.room_number WHERE sq.status = 'delivered' ${dateWhere ? `AND ${dateWhere.replace('WHERE', '')}` : ''}${buildingAnd}) as total_delivered,
      (SELECT COUNT(DISTINCT c.id) FROM complaints c LEFT JOIN rooms r ON c.room_number = r.room_number WHERE c.status = 'open'${buildingAnd}) as open_complaints,
      (SELECT COUNT(DISTINCT rd.id) FROM reductions rd LEFT JOIN rooms r ON rd.room_number = r.room_number WHERE rd.status = 'pending'${buildingAnd}) as pending_reductions
  `, ...dateValues, ...dateValues, ...dateValues);

  let dimensionData: any = {};
  switch (dimension) {
    case 'stage': dimensionData = await getByStage(building); break;
    case 'channel': dimensionData = await getByChannel(dateConditions, dateValues, building); break;
    case 'call_result': dimensionData = await getByCallResult(dateConditions, dateValues, building); break;
    default: dimensionData = await getOverallBreakdown(building);
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

async function getOverallBreakdown(building?: string) {
  const band = building ? `AND r.building = '${building.replace(/'/g, "''")}'` : '';
  const byOverdue = await all(`
    SELECT overdue_level, COUNT(*) as count, COALESCE(SUM(unpaid_amount), 0) as amount
    FROM fees f JOIN rooms r ON f.room_id = r.id
    WHERE status != 'paid' ${band}
    GROUP BY overdue_level ORDER BY overdue_level
  `);
  const byStage = await all(`
    SELECT stage, COUNT(*) as count, COALESCE(SUM(unpaid_amount), 0) as amount
    FROM fees f JOIN rooms r ON f.room_id = r.id
    WHERE status != 'paid' ${band}
    GROUP BY stage ORDER BY stage
  `);
  return {
    byOverdue: byOverdue.map((r: any) => ({ level: r.overdue_level, level_desc: getOverdueLevelDescription(r.overdue_level), count: r.count, amount: r.amount })),
    byStage: byStage.map((r: any) => ({ stage: r.stage, stage_desc: getStageDescription(r.stage), count: r.count, amount: r.amount })),
  };
}

async function getByStage(building?: string) {
  const band = building ? `AND r.building = '${building.replace(/'/g, "''")}'` : '';
  const stageStats = await all(`
    SELECT ct.stage,
      COUNT(DISTINCT ct.id) as task_count,
      COUNT(DISTINCT sq.id) as sent_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.id END) as delivered_count,
      COUNT(DISTINCT CASE WHEN cr.id IS NOT NULL THEN sq.id END) as call_count,
      COUNT(DISTINCT CASE WHEN cr.result = 'promised' OR rec.result = 'promised' THEN sq.id END) as promised_count,
      COALESCE(SUM(DISTINCT CASE WHEN py.id IS NOT NULL THEN py.amount END), 0) as actual_paid
    FROM collection_tasks ct
    LEFT JOIN send_queues sq ON sq.task_id = ct.id
    LEFT JOIN rooms r ON sq.room_number = r.room_number
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    LEFT JOIN payments py ON py.room_number = r.room_number
    WHERE 1=1 ${band}
    GROUP BY ct.stage ORDER BY ct.stage
  `);
  return stageStats.map((r: any) => ({
    ...r, stage_desc: getStageDescription(r.stage),
    delivery_rate: r.sent_count > 0 ? parseFloat(((r.delivered_count / r.sent_count) * 100).toFixed(2)) : 0,
  }));
}

async function getByChannel(dateConditions: string[], values: any[], building?: string) {
  const whereClause = dateConditions.length > 0 ? `AND ${dateConditions.join(' AND ').replace(/sq\./g, 'sq.')}` : '';
  const band = building ? `AND r.building = '${building.replace(/'/g, "''")}'` : '';
  const rows = await all(`
    SELECT sq.channel, COUNT(DISTINCT sq.id) as total_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'sent' THEN sq.id END) as sent_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.id END) as delivered_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'failed' THEN sq.id END) as failed_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'intercepted' THEN sq.id END) as intercepted_count
    FROM send_queues sq LEFT JOIN rooms r ON sq.room_number = r.room_number
    WHERE 1=1 ${whereClause} ${band}
    GROUP BY sq.channel ORDER BY total_count DESC
  `, ...values);
  return rows.map((r: any) => ({
    ...r, channel_desc: getChannelDescription(r.channel),
    success_rate: r.total_count > 0 ? parseFloat((((r.sent_count + r.delivered_count) / r.total_count) * 100).toFixed(2)) : 0,
  }));
}

async function getByCallResult(dateConditions: string[], values: any[], building?: string) {
  const whereClause = dateConditions.length > 0 ? `AND ${dateConditions.join(' AND ').replace(/cr\./g, 'cr.')}` : '';
  const band = building ? `AND r.building = '${building.replace(/'/g, "''")}'` : '';
  return all(`
    SELECT cr.result, COUNT(DISTINCT cr.id) as count, COALESCE(AVG(cr.duration), 0) as avg_duration
    FROM call_records cr LEFT JOIN rooms r ON cr.room_number = r.room_number
    WHERE 1=1 ${whereClause} ${band}
    GROUP BY cr.result ORDER BY count DESC
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
      COALESCE(MAX(CASE WHEN f.status = 'overdue' THEN f.overdue_days END), 0) as max_overdue_days,
      (SELECT COUNT(DISTINCT sq.id) FROM send_queues sq WHERE sq.room_number IN (SELECT r2.room_number FROM rooms r2 WHERE r2.building = r.building)) as touch_count,
      (SELECT COUNT(DISTINCT sq.id) FROM send_queues sq WHERE sq.status = 'delivered' AND sq.room_number IN (SELECT r2.room_number FROM rooms r2 WHERE r2.building = r.building)) as delivered_count,
      (SELECT COALESCE(SUM(py.amount), 0) FROM payments py WHERE py.room_number IN (SELECT r2.room_number FROM rooms r2 WHERE r2.building = r.building)) as actual_payment
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
    return_rate: b.total_original > 0 ? parseFloat(((b.actual_payment / b.total_original) * 100).toFixed(2)) : 0,
    delivery_rate: b.touch_count > 0 ? parseFloat(((b.delivered_count / b.touch_count) * 100).toFixed(2)) : 0,
  }));
}

// ============ 催缴闭环看板 ===============
export async function getClosureBoard(params: any = {}) {
  const { building, stage, startDate, endDate } = params;
  const roomNumber: string | undefined = params.roomNumber;
  const taskId: string | undefined = params.taskId;

  const baseAnds: string[] = [];
  const baseValues: any[] = [];
  if (building) { baseAnds.push(`r.building = ?`); baseValues.push(building); }
  if (stage) {
    const sts = Array.isArray(stage) ? stage : String(stage).split(',');
    baseAnds.push(`f.stage IN (${sts.map(() => '?').join(',')})`);
    baseValues.push(...sts);
  }
  if (roomNumber) { baseAnds.push(`f.room_number = ?`); baseValues.push(roomNumber); }
  const baseWhere = baseAnds.length ? `WHERE ${baseAnds.join(' AND ')}` : '';
  const band = baseWhere.replace('WHERE', 'AND');

  const queueAnds: string[] = [];
  const queueValues: any[] = [];
  if (startDate) { queueAnds.push('sq.created_at >= ?'); queueValues.push(startDate); }
  if (endDate) { queueAnds.push('sq.created_at <= ?'); queueValues.push(endDate); }
  if (building) { queueAnds.push(`r2.building = ?`); queueValues.push(building); }
  if (roomNumber) { queueAnds.push(`sq.room_number = ?`); queueValues.push(roomNumber); }
  if (taskId) { queueAnds.push(`sq.task_id = ?`); queueValues.push(taskId); }
  const queueWhere = queueAnds.length ? `WHERE ${queueAnds.join(' AND ')}` : '';
  const qAnd = queueWhere.replace('WHERE', 'AND');

  const s1 = await get<any>(`
    SELECT
      COUNT(DISTINCT f.id) as step1_fee_count,
      COALESCE(SUM(CASE WHEN f.status != 'paid' THEN f.unpaid_amount END), 0) as step1_unpaid
    FROM fees f JOIN rooms r ON f.room_id = r.id ${baseWhere}
  `, ...baseValues);

  const s2s3 = await get<any>(`
    SELECT
      COUNT(DISTINCT sq.id) as step2_sent_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'sent' OR sq.status = 'delivered' THEN sq.id END) as step2_active,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.id END) as step3_delivered_count,
      COALESCE(SUM(CASE WHEN sq.status = 'delivered' THEN f2.unpaid_amount END), 0) as step3_delivered_amount
    FROM send_queues sq
    JOIN fees f2 ON sq.fee_id = f2.id
    JOIN rooms r2 ON sq.room_number = r2.room_number
    ${queueWhere}
  `, ...queueValues);

  const s4 = await get<any>(`
    SELECT
      COUNT(DISTINCT sq.id) as step4_promised_count,
      COALESCE(SUM(f3.unpaid_amount), 0) as step4_promised_amount
    FROM send_queues sq
    JOIN fees f3 ON sq.fee_id = f3.id
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    ${queueWhere.length ? `${queueWhere} AND (rec.result = 'promised' OR cr.result = 'promised')` :
      "WHERE (rec.result = 'promised' OR cr.result = 'promised')"}
  `, ...queueValues);

  const s56 = await get<any>(`
    SELECT
      COUNT(DISTINCT f.id) as step5_paid_count,
      COALESCE(SUM(f.paid_amount), 0) as step5_paid_amount,
      COUNT(DISTINCT CASE WHEN f.reduction_amount > 0 AND f.status = 'paid' THEN f.id END) as step6_reduced_count,
      COALESCE(SUM(CASE WHEN f.reduction_amount > 0 AND f.status = 'paid' THEN f.reduction_amount END), 0) as step6_reduced_amount
    FROM fees f JOIN rooms r ON f.room_id = r.id ${baseWhere} AND f.status = 'paid'
  `, ...baseValues);

  const step1 = { count: s1?.step1_fee_count || 0, amount: parseFloat((s1?.step1_unpaid || 0).toFixed(2)) };
  const step2 = { count: s2s3?.step2_sent_count || 0, active: s2s3?.step2_active || 0 };
  const step3 = { count: s2s3?.step3_delivered_count || 0, amount: parseFloat((s2s3?.step3_delivered_amount || 0).toFixed(2)) };
  const step4 = { count: s4?.step4_promised_count || 0, amount: parseFloat((s4?.step4_promised_amount || 0).toFixed(2)) };
  const step5 = { count: s56?.step5_paid_count || 0, amount: parseFloat((s56?.step5_paid_amount || 0).toFixed(2)) };
  const step6 = { count: s56?.step6_reduced_count || 0, amount: parseFloat((s56?.step6_reduced_amount || 0).toFixed(2)) };

  const funnelRates: any = {};
  funnelRates.rate_1_to_2 = step1.count > 0 ? parseFloat(((step2.count / step1.count) * 100).toFixed(2)) : 0;
  funnelRates.rate_2_to_3 = step2.count > 0 ? parseFloat(((step3.count / step2.count) * 100).toFixed(2)) : 0;
  funnelRates.rate_3_to_4 = step3.count > 0 ? parseFloat(((step4.count / step3.count) * 100).toFixed(2)) : 0;
  funnelRates.rate_4_to_5 = step4.count > 0 ? parseFloat(((step5.count / step4.count) * 100).toFixed(2)) : 0;
  funnelRates.rate_1_to_5 = step1.count > 0 ? parseFloat(((step5.count / step1.count) * 100).toFixed(2)) : 0;
  funnelRates.recovery_rate = step1.amount > 0 ? parseFloat(((step5.amount / step1.amount) * 100).toFixed(2)) : 0;

  // 追踪明细 (按房号或任务号)
  let tracking: any[] = [];
  if (roomNumber || taskId) {
    const trackWhere = roomNumber ? 'WHERE sq.room_number = ?' : 'WHERE sq.task_id = ?';
    const trackVal = roomNumber ? [roomNumber] : [taskId];
    tracking = await all(`
      SELECT
        sq.room_number, r3.building, r3.owner_name, r3.owner_phone,
        sq.task_id, ct.name as task_name, ct.stage, ct.stage as stage_desc,
        sq.id as queue_id, sq.channel, sq.status, sq.priority,
        sq.created_at, sq.sent_at, sq.delivered_at,
        f4.period, f4.original_amount, f4.reduction_amount, f4.payable_amount,
        f4.paid_amount, f4.unpaid_amount, f4.overdue_days, f4.overdue_level,
        rec.result as receipt_result, rec.promised_pay_at, rec.note as receipt_note,
        cr.result as call_result, cr.duration, cr.operator, cr.note as call_note,
        f4.status as fee_status,
        CASE WHEN f4.status = 'paid' THEN 'step5_paid'
             WHEN rec.result = 'promised' OR cr.result = 'promised' THEN 'step4_promised'
             WHEN sq.status = 'delivered' THEN 'step3_delivered'
             WHEN sq.status = 'sent' OR sq.status = 'pending' THEN 'step2_sent'
             ELSE 'step1_unpaid' END as current_step,
        (SELECT COUNT(*) FROM customer_notes cn WHERE cn.room_number = sq.room_number) as note_count,
        (SELECT COUNT(*) FROM complaints cmp WHERE cmp.room_number = sq.room_number AND cmp.status = 'open') as open_complaint_count,
        (SELECT COUNT(*) FROM blacklists bl WHERE bl.room_number = sq.room_number AND (bl.effective_to IS NULL OR bl.effective_to > datetime('now'))) as is_blacklisted
      FROM send_queues sq
      JOIN fees f4 ON sq.fee_id = f4.id
      JOIN rooms r3 ON sq.room_number = r3.room_number
      LEFT JOIN collection_tasks ct ON sq.task_id = ct.id
      LEFT JOIN receipts rec ON rec.queue_id = sq.id
      LEFT JOIN call_records cr ON cr.queue_id = sq.id
      ${trackWhere}
      ORDER BY sq.created_at DESC
      LIMIT 500
    `, ...trackVal);

    tracking = tracking.map((t: any) => ({
      ...t, stage_desc: getStageDescription(t.stage),
      overdue_level_desc: getOverdueLevelDescription(t.overdue_level),
    }));
  }

  return {
    filters: { building: building || null, stage: stage || null, roomNumber: roomNumber || null, taskId: taskId || null, startDate: startDate || null, endDate: endDate || null },
    steps: {
      step1_unpaid: step1,
      step2_collected: step2,
      step3_delivered: step3,
      step4_promised: step4,
      step5_paid: step5,
      step6_reduced: step6,
    },
    funnel_rates: funnelRates,
    tracking,
  };
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
