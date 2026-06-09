import { get, all } from '../db/connection';
import { createObjectCsvStringifier } from 'csv-writer';
import { getOverdueLevelDescription, getStageDescription, getChannelDescription } from '../utils/helpers';

interface ComboParams {
  startDate?: string;
  endDate?: string;
  building?: string;
  stage?: string | string[];
  channel?: string | string[];
  groupBy?: 'building' | 'stage' | 'channel' | 'building_stage' | 'building_channel' | 'stage_channel' | 'all';
}

// 按"付款单→住户→对应催缴渠道/任务/楼栋"的去重查询模板
// 解决：一笔付款对应多笔多费导致 SUM 重复放大；回款和渠道/任务绑定
function buildPaymentDistinctSQL(
  groupExpr: string,
  whereJoin: string,
  whereValues: any[],
  dateRangeSql: { start?: string; end?: string },
): { sql: string; values: any[] } {
  const conds: string[] = [];
  const values: any[] = [...whereValues];
  if (dateRangeSql.start) { conds.push(`py.paid_at >= ?`); values.push(dateRangeSql.start); }
  if (dateRangeSql.end)   { conds.push(`py.paid_at <= ?`); values.push(dateRangeSql.end);   }
  const finalWhere = conds.length ? `AND ${conds.join(' AND ')}` : '';
  const sql = `
    SELECT ${groupExpr},
      COUNT(DISTINCT px.payment_id) as payment_count,
      COALESCE(SUM(px.payment_amount), 0) as actual_payment
    FROM (
      SELECT DISTINCT py.id as payment_id, py.amount as payment_amount, py.room_number as prn
      FROM payments py ${whereJoin ? `JOIN ${whereJoin}` : ''}
      WHERE 1=1 ${finalWhere}
    ) px
    LEFT JOIN payments py2 ON py2.id = px.payment_id
    LEFT JOIN rooms rpx ON rpx.room_number = px.prn
    LEFT JOIN (
      SELECT sq2.room_number as qrn, MIN(sq2.channel) as first_channel, MIN(sq2.task_id) as first_task_id
      FROM send_queues sq2 GROUP BY sq2.room_number
    ) qmap ON qmap.qrn = px.prn
    LEFT JOIN collection_tasks ctpx ON ctpx.id = qmap.first_task_id
    LEFT JOIN fees fpx ON fpx.room_number = px.prn
    GROUP BY 1
    ORDER BY 1
  `;
  return { sql, values };
}

// 不重复计算付款：先按 (py.id + 分组键) 去重
function buildPaymentGroupedSQL(opts: {
  groupSelect: string;           // SELECT 列表达式，如 "rpx.building as building"
  groupByOrdinal: string;        // "1,2" 或 ""
  building?: string;
  stage?: string[];
  channel?: string[];
  startDate?: string;
  endDate?: string;
  bindChannelToTask?: boolean;   // 渠道筛选：只取做过对应渠道催缴的住户的付款
}): { sql: string; values: any[] } {
  const { groupSelect, groupByOrdinal, building, stage, channel, startDate, endDate, bindChannelToTask = true } = opts;
  const values: any[] = [];
  const conds: string[] = [];

  let joinSql = `
    JOIN rooms rpx ON rpx.room_number = py.room_number
    LEFT JOIN (
      SELECT DISTINCT sq.room_number as qrn, sq.channel as ch, ct.stage as t_stage, ct.id as tid
      FROM send_queues sq LEFT JOIN collection_tasks ct ON ct.id = sq.task_id
    ) tm ON tm.qrn = py.room_number
    LEFT JOIN fees fpx ON fpx.room_number = py.room_number
  `;

  if (building) { conds.push(`rpx.building = ?`); values.push(building); }
  if (stage && stage.length > 0) {
    // 阶段绑定到催缴任务阶段（若有）或 费用阶段
    const ph = stage.map(() => '?').join(',');
    conds.push(`(tm.t_stage IN (${ph}) OR fpx.stage IN (${ph}))`);
    values.push(...stage, ...stage);
  }
  if (channel && channel.length > 0 && bindChannelToTask) {
    const ph = channel.map(() => '?').join(',');
    // 只取该渠道催缴任务覆盖住户的付款
    conds.push(`tm.ch IN (${ph})`);
    values.push(...channel);
  }
  if (startDate) { conds.push(`py.paid_at >= ?`); values.push(startDate); }
  if (endDate)   { conds.push(`py.paid_at <= ?`); values.push(endDate);   }
  const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  // 先按 py.id + 分组键去重，再外聚合，确保一笔付款只算一次
  const sql = `
    SELECT ${groupSelect},
      COUNT(DISTINCT pxx.pid) as payment_count,
      COALESCE(SUM(pxx.pamt), 0) as actual_payment
    FROM (
      SELECT DISTINCT py.id as pid, py.amount as pamt, py.room_number as prn
      FROM payments py
      ${joinSql}
      ${whereSql}
    ) pxx
    LEFT JOIN rooms rpx2 ON rpx2.room_number = pxx.prn
    LEFT JOIN (
      SELECT sq2.room_number as qrn,
        MIN(sq2.channel) as first_channel,
        MIN(ct2.stage) as first_stage,
        MIN(rpx3.building) as first_building
      FROM send_queues sq2
      LEFT JOIN collection_tasks ct2 ON ct2.id = sq2.task_id
      LEFT JOIN rooms rpx3 ON rpx3.room_number = sq2.room_number
      GROUP BY sq2.room_number
    ) qmap2 ON qmap2.qrn = pxx.prn
    ${groupByOrdinal ? `GROUP BY ${groupByOrdinal} ORDER BY ${groupByOrdinal}` : ''}
  `;
  return { sql, values };
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
  if (building) { queueCond.push(`r2.building = ?`); queueValues.push(building); }
  if (stage && stage.length > 0) {
    queueCond.push(`ct.stage IN (${stage.map(() => '?').join(',')})`);
    queueValues.push(...stage);
  }
  if (channel && channel.length > 0) {
    queueCond.push(`sq.channel IN (${channel.map(() => '?').join(',')})`);
    queueValues.push(...channel);
  }
  const queueWhere = queueCond.length ? `WHERE ${queueCond.join(' AND ')}` : '';

  let groupFields: string[] = [];
  let groupLabels: string[] = [];
  let feeGroupSelect = '';
  let queueGroupSelect = '';
  let payGroupSelect = '';   // 用于 pxx 外 SELECT 的列
  let payGroupBuild: (o: any) => string; // 传入 group key 的解析函数

  switch (groupBy) {
    case 'building':
      groupFields = ['building'];
      groupLabels = ['楼栋'];
      feeGroupSelect = `r.building as building`;
      queueGroupSelect = `r2.building as building`;
      payGroupSelect = `rpx2.building as building`;
      break;
    case 'stage':
      groupFields = ['stage'];
      groupLabels = ['阶段'];
      feeGroupSelect = `f.stage as stage`;
      queueGroupSelect = `ct.stage as stage`;
      payGroupSelect = `COALESCE(qmap2.first_stage, (SELECT MIN(f3.stage) FROM fees f3 WHERE f3.room_number = pxx.prn)) as stage`;
      break;
    case 'channel':
      groupFields = ['channel'];
      groupLabels = ['渠道'];
      feeGroupSelect = `NULL as channel`;
      queueGroupSelect = `sq.channel as channel`;
      // 对没有催缴记录的付款，渠道归为 other/uncategorized
      payGroupSelect = `COALESCE(qmap2.first_channel, 'uncategorized') as channel`;
      break;
    case 'building_stage':
      groupFields = ['building', 'stage'];
      groupLabels = ['楼栋', '阶段'];
      feeGroupSelect = `r.building as building, f.stage as stage`;
      queueGroupSelect = `r2.building as building, ct.stage as stage`;
      payGroupSelect = `COALESCE(rpx2.building, qmap2.first_building) as building,
        COALESCE(qmap2.first_stage, (SELECT MIN(f3.stage) FROM fees f3 WHERE f3.room_number = pxx.prn)) as stage`;
      break;
    case 'building_channel':
      groupFields = ['building', 'channel'];
      groupLabels = ['楼栋', '渠道'];
      feeGroupSelect = `r.building as building, NULL as channel`;
      queueGroupSelect = `r2.building as building, sq.channel as channel`;
      payGroupSelect = `COALESCE(rpx2.building, qmap2.first_building) as building,
        COALESCE(qmap2.first_channel, 'uncategorized') as channel`;
      break;
    case 'stage_channel':
      groupFields = ['stage', 'channel'];
      groupLabels = ['阶段', '渠道'];
      feeGroupSelect = `f.stage as stage, NULL as channel`;
      queueGroupSelect = `ct.stage as stage, sq.channel as channel`;
      payGroupSelect = `COALESCE(qmap2.first_stage, (SELECT MIN(f3.stage) FROM fees f3 WHERE f3.room_number = pxx.prn)) as stage,
        COALESCE(qmap2.first_channel, 'uncategorized') as channel`;
      break;
    default: // all
      groupFields = [];
      groupLabels = [];
      feeGroupSelect = `NULL as _all`;
      queueGroupSelect = `NULL as _all`;
      payGroupSelect = `NULL as _all`;
  }

  const gn = groupFields.length;
  const seqN = gn > 0 ? Array.from({length: gn}, (_, i) => String(i+1)).join(',') : '1';
  const feeGroupBy = gn > 0 ? `GROUP BY ${seqN} ORDER BY ${seqN}` : '';
  const queueGroupBy = gn > 0 ? `GROUP BY ${seqN} ORDER BY ${seqN}` : '';

  const feeRows = await all<any>(`
    SELECT ${feeGroupSelect},
      COUNT(DISTINCT f.id) as fee_count,
      COALESCE(SUM(CASE WHEN f.status != 'paid' THEN f.unpaid_amount END), 0) as total_unpaid,
      COALESCE(SUM(f.original_amount), 0) as total_original,
      COALESCE(SUM(f.paid_amount), 0) as total_paid
    FROM fees f JOIN rooms r ON f.room_id = r.id
    ${feeWhere}
    ${feeGroupBy}
  `, ...feeValues);

  const queueRows = await all<any>(`
    SELECT ${queueGroupSelect},
      COUNT(DISTINCT sq.id) as touch_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.id END) as delivered_count,
      COUNT(DISTINCT CASE WHEN rec.result = 'promised' OR cr.result = 'promised' THEN sq.id END) as promised_count
    FROM send_queues sq
    JOIN rooms r2 ON sq.room_number = r2.room_number
    LEFT JOIN collection_tasks ct ON sq.task_id = ct.id
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    ${queueWhere}
    ${queueGroupBy}
  `, ...queueValues);

  // 按付款单去重：渠道绑定到任务
  const bindChannel = (groupBy === 'channel' || groupBy === 'building_channel' || groupBy === 'stage_channel' || (channel && channel.length > 0));
  const payQuery = buildPaymentGroupedSQL({
    groupSelect: payGroupSelect,
    groupByOrdinal: seqN,
    building, stage, channel,
    startDate, endDate,
    bindChannelToTask: !!bindChannel,
  });
  const payRows = await all<any>(payQuery.sql, ...payQuery.values);

  const keyOf = (row: any): string => groupFields.length === 0 ? '__all__' : groupFields.map(f => String(row?.[f] ?? '')).join('||');
  const feeMap = new Map(feeRows.map(r => [keyOf(r), r]));
  const queueMap = new Map(queueRows.map(r => [keyOf(r), r]));
  const payMap = new Map(payRows.map(r => [keyOf(r), r]));

  const allKeys = new Set([...feeMap.keys(), ...queueMap.keys(), ...payMap.keys()]);
  const groups: any[] = [];

  for (const k of allKeys) {
    const f = feeMap.get(k) || {};
    const q = queueMap.get(k) || {};
    const payRow = payMap.get(k) || {};
    const original = f.total_original || 0;
    const unpaid = f.total_unpaid || 0;
    const delivered = q.delivered_count || 0;
    const promised = q.promised_count || 0;
    const actual = payRow.actual_payment || 0;
    const paymentCount = payRow.payment_count || 0;
    const returnRate = original > 0 ? parseFloat(((actual / original) * 100).toFixed(2)) : 0;
    const touch = q.touch_count || 0;

    const group: any = {
      group_fields: groupFields,
      group_labels: groupLabels,
      building: f.building || q.building || payRow.building || null,
      stage: f.stage || q.stage || payRow.stage || null,
      channel: q.channel || payRow.channel || null,
      fee_count: f.fee_count || 0,
      total_unpaid: parseFloat(unpaid.toFixed(2)),
      total_original: parseFloat(original.toFixed(2)),
      touch_count: touch,
      delivered_count: delivered,
      promised_count: promised,
      payment_count: paymentCount,
      actual_payment: parseFloat(actual.toFixed(2)),
      return_rate: returnRate,
    };
    if (group.stage) group.stage_desc = getStageDescription(group.stage);
    if (group.channel && group.channel !== 'uncategorized') group.channel_desc = getChannelDescription(group.channel);
    if (group.channel === 'uncategorized') group.channel_desc = '无催缴记录';
    groups.push(group);
  }

  // 汇总：回款同样去重，totals.actual_payment 来自 payRows 汇总
  const totals = {
    fee_count: groups.reduce((s, g) => s + g.fee_count, 0),
    total_unpaid: parseFloat(groups.reduce((s, g) => s + g.total_unpaid, 0).toFixed(2)),
    total_original: parseFloat(groups.reduce((s, g) => s + g.total_original, 0).toFixed(2)),
    touch_count: groups.reduce((s, g) => s + g.touch_count, 0),
    delivered_count: groups.reduce((s, g) => s + g.delivered_count, 0),
    promised_count: groups.reduce((s, g) => s + g.promised_count, 0),
    payment_count: groups.reduce((s, g) => s + g.payment_count, 0),
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
  const bandRooms = building ? `AND rpx.building = '${building.replace(/'/g, "''")}'` : '';
  const bandQmap = building ? `AND rq.building = '${building.replace(/'/g, "''")}'` : '';
  const stageStats = await all(`
    SELECT ct.stage,
      COUNT(DISTINCT ct.id) as task_count,
      COUNT(DISTINCT sq.id) as sent_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.id END) as delivered_count,
      COUNT(DISTINCT CASE WHEN cr.id IS NOT NULL THEN sq.id END) as call_count,
      COUNT(DISTINCT CASE WHEN cr.result = 'promised' OR rec.result = 'promised' THEN sq.id END) as promised_count
    FROM collection_tasks ct
    LEFT JOIN send_queues sq ON sq.task_id = ct.id
    LEFT JOIN rooms r ON sq.room_number = r.room_number
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    WHERE 1=1 ${band}
    GROUP BY ct.stage ORDER BY ct.stage
  `);
  // 回款：单独去重查询，每处 JOIN 都加楼栋条件
  const payStats = await all<any>(`
    SELECT COALESCE(qmap.t_stage, (SELECT MIN(f.stage) FROM fees f WHERE f.room_number = px.prn)) as stage,
      COUNT(DISTINCT px.pid) as payment_count,
      COALESCE(SUM(px.pamt), 0) as actual_paid
    FROM (
      SELECT DISTINCT py.id as pid, py.amount as pamt, py.room_number as prn
      FROM payments py
    ) px
    LEFT JOIN rooms rpx ON rpx.room_number = px.prn
    LEFT JOIN (
      SELECT sq.room_number as qrn, MIN(ct.stage) as t_stage
      FROM send_queues sq
      LEFT JOIN collection_tasks ct ON ct.id = sq.task_id
      LEFT JOIN rooms rq ON sq.room_number = rq.room_number
      WHERE 1=1 ${bandQmap}
      GROUP BY sq.room_number
    ) qmap ON qmap.qrn = px.prn
    WHERE rpx.building IS NOT NULL ${bandRooms}
    GROUP BY 1
  `);
  const payMap = new Map(payStats.map((r: any) => [r.stage, r]));
  return stageStats.map((r: any) => {
    const p = payMap.get(r.stage) || {};
    return {
      ...r,
      payment_count: p.payment_count || 0,
      actual_paid: p.actual_paid || 0,
      stage_desc: getStageDescription(r.stage),
      delivery_rate: r.sent_count > 0 ? parseFloat(((r.delivered_count / r.sent_count) * 100).toFixed(2)) : 0,
    };
  });
}

async function getByChannel(dateConditions: string[], values: any[], building?: string) {
  const whereClause = dateConditions.length > 0 ? `AND ${dateConditions.join(' AND ').replace(/sq\./g, 'sq.')}` : '';
  const band = building ? `AND r.building = '${building.replace(/'/g, "''")}'` : '';
  const rows = await all(`
    SELECT sq.channel, COUNT(DISTINCT sq.id) as total_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'sent' THEN sq.id END) as sent_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.id END) as delivered_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'failed' THEN sq.id END) as failed_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'intercepted' THEN sq.id END) as intercepted_count,
      COUNT(DISTINCT CASE WHEN rec.result = 'promised' OR cr.result = 'promised' THEN sq.id END) as promised_count
    FROM send_queues sq LEFT JOIN rooms r ON sq.room_number = r.room_number
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    WHERE 1=1 ${whereClause} ${band}
    GROUP BY sq.channel ORDER BY total_count DESC
  `, ...values);

  // 按渠道去重回款
  const payByChannel = await all<any>(`
    SELECT COALESCE(qmap.ch, 'uncategorized') as channel,
      COUNT(DISTINCT px.pid) as payment_count,
      COALESCE(SUM(px.pamt), 0) as actual_payment
    FROM (
      SELECT DISTINCT py.id as pid, py.amount as pamt, py.room_number as prn
      FROM payments py
    ) px
    LEFT JOIN (SELECT room_number as qrn, MIN(channel) as ch FROM send_queues GROUP BY room_number) qmap ON qmap.qrn = px.prn
    LEFT JOIN rooms r ON r.room_number = px.prn
    WHERE 1=1 ${band}
    GROUP BY 1 ORDER BY actual_payment DESC
  `);
  const payMap = new Map(payByChannel.map((r: any) => [r.channel, r]));
  return rows.map((r: any) => {
    const p = payMap.get(r.channel) || {};
    return {
      ...r,
      payment_count: p.payment_count || 0,
      actual_payment: p.actual_payment || 0,
      channel_desc: getChannelDescription(r.channel),
      success_rate: r.total_count > 0 ? parseFloat((((r.sent_count + r.delivered_count) / r.total_count) * 100).toFixed(2)) : 0,
    };
  });
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
      (SELECT COUNT(DISTINCT sq.id) FROM send_queues sq WHERE sq.status = 'delivered' AND sq.room_number IN (SELECT r2.room_number FROM rooms r2 WHERE r2.building = r.building)) as delivered_count
    FROM rooms r
    LEFT JOIN fees f ON f.room_id = r.id
    GROUP BY r.building
    ORDER BY total_unpaid DESC
  `);

  // 楼栋回款：按付款单去重
  const payByBuilding = await all<any>(`
    SELECT rpx.building as building,
      COUNT(DISTINCT px.pid) as payment_count,
      COALESCE(SUM(px.pamt), 0) as actual_payment
    FROM (
      SELECT DISTINCT py.id as pid, py.amount as pamt, py.room_number as prn
      FROM payments py
    ) px
    LEFT JOIN rooms rpx ON rpx.room_number = px.prn
    WHERE rpx.building IS NOT NULL
    GROUP BY rpx.building
  `);
  const payMap = new Map(payByBuilding.map((r: any) => [r.building, r]));
  return buildings.map((b: any) => {
    const p = payMap.get(b.building) || {};
    const actual = p.actual_payment || 0;
    const rateVal = b.total_original > 0 ? (actual / b.total_original) * 100 : 0;
    return {
      ...b,
      payment_count: p.payment_count || 0,
      actual_payment: actual,
      avg_unpaid: b.total_rooms > 0 ? parseFloat((b.total_unpaid / b.total_rooms).toFixed(2)) : 0,
      overdue_rate: b.total_fees > 0 ? parseFloat(((b.overdue_fees / b.total_fees) * 100).toFixed(2)) : 0,
      collection_rate: b.total_original > 0 ? parseFloat(((b.total_paid / b.total_original) * 100).toFixed(2)) : 0,
      return_rate: parseFloat(rateVal.toFixed(2)),
      delivery_rate: b.touch_count > 0 ? parseFloat(((b.delivered_count / b.touch_count) * 100).toFixed(2)) : 0,
    };
  });
}

// ============ 催缴闭环看板 ===============
export async function getClosureBoard(params: any = {}) {
  // 统一 try/catch: 任何 SQL 异常都返回默认值, 绝不 throw 500
  const safeGet = async (sql: string, ...vals: any[]) => { try { return (await get<any>(sql, ...vals)) || {}; } catch (e) { return {}; } };
  const safeAll = async (sql: string, ...vals: any[]) => { try { return (await all<any>(sql, ...vals)) || []; } catch (e) { return []; } };
  const defStep = () => ({ count: 0, room_count: 0, amount: 0, active: 0 });

  let building: any, stage: any, startDate: any, endDate: any, channel: any;
  let roomNumber: string | undefined, taskId: string | undefined;
  let stsArr: any, chArr: any;

  try {
    building = params.building; stage = params.stage;
    startDate = params.startDate; endDate = params.endDate; channel = params.channel;
    roomNumber = params.roomNumber; taskId = params.taskId;

    stsArr = (() => {
      if (!stage) return null;
      return Array.isArray(stage) ? stage : String(stage).split(',').filter(Boolean);
    })();
    chArr = (() => {
      if (!channel) return null;
      return Array.isArray(channel) ? channel : String(channel).split(',').filter(Boolean);
    })();

  // 核心：构造"过滤后覆盖到的住户集合+费用集合"
  // 当 task_id 存在时，所有 6 步都基于该任务覆盖到的费用
  const scopeAnds: string[] = [];
  const scopeValues: any[] = [];
  if (building) { scopeAnds.push(`r.building = ?`); scopeValues.push(building); }
  if (stsArr && stsArr.length > 0) {
    const ph = stsArr.map(() => '?').join(',');
    scopeAnds.push(`f.stage IN (${ph})`); scopeValues.push(...stsArr);
  }
  if (roomNumber) { scopeAnds.push(`f.room_number = ?`); scopeValues.push(roomNumber); }

  // 任务号过滤时，费用限定为该任务催缴的费用
  if (taskId) {
    scopeAnds.push(`f.id IN (SELECT fee_id FROM send_queues sq WHERE sq.task_id = ?)`);
    scopeValues.push(taskId);
  }
  const scopeWhere = scopeAnds.length ? `WHERE ${scopeAnds.join(' AND ')}` : '';

  // 步骤 2-4 的 send_queues 过滤（同时用于付款的渠道/任务绑定）
  const qAnds: string[] = [];
  const qValues: any[] = [];
  if (startDate) { qAnds.push('sq.created_at >= ?'); qValues.push(startDate); }
  if (endDate)   { qAnds.push('sq.created_at <= ?'); qValues.push(endDate);   }
  if (building)  { qAnds.push(`r2.building = ?`); qValues.push(building);  }
  if (roomNumber){ qAnds.push(`sq.room_number = ?`); qValues.push(roomNumber);}
  if (taskId)    { qAnds.push(`sq.task_id = ?`); qValues.push(taskId);    }
  if (stsArr && stsArr.length > 0) {
    const ph = stsArr.map(() => '?').join(',');
    qAnds.push(`ct.stage IN (${ph})`); qValues.push(...stsArr);
  }
  if (chArr && chArr.length > 0) {
    const ph = chArr.map(() => '?').join(',');
    qAnds.push(`sq.channel IN (${ph})`); qValues.push(...chArr);
  }
  const qWhere = qAnds.length ? `WHERE ${qAnds.join(' AND ')}` : '';

  // step1: 欠费
  const s1 = await safeGet(
    `SELECT
      COUNT(DISTINCT f.id) as step1_fee_count,
      COUNT(DISTINCT f.room_id) as step1_room_count,
      COALESCE(SUM(CASE WHEN f.status != 'paid' THEN f.unpaid_amount END), 0) as step1_unpaid
    FROM fees f JOIN rooms r ON f.room_id = r.id ${scopeWhere}
  `, ...scopeValues);

  // step2: 已催 (send_queues) & step3: 送达
  const s2s3 = await safeGet(
    `SELECT
      COUNT(DISTINCT sq.id) as step2_sent_count,
      COUNT(DISTINCT sq.room_number) as step2_room_count,
      COUNT(DISTINCT CASE WHEN sq.status IN ('sent','delivered','pending') THEN sq.id END) as step2_active,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.id END) as step3_delivered_count,
      COUNT(DISTINCT CASE WHEN sq.status = 'delivered' THEN sq.room_number END) as step3_room_count,
      COALESCE(SUM(CASE WHEN sq.status = 'delivered' THEN f2.unpaid_amount END), 0) as step3_delivered_amount
    FROM send_queues sq
    JOIN fees f2 ON sq.fee_id = f2.id
    JOIN rooms r2 ON sq.room_number = r2.room_number
    LEFT JOIN collection_tasks ct ON sq.task_id = ct.id
    ${qWhere}
  `, ...qValues);

  // step4: 承诺 (receipts/call_records 中 result=promised)
  const s4 = await safeGet(
    `SELECT
      COUNT(DISTINCT sq.id) as step4_promised_count,
      COUNT(DISTINCT sq.room_number) as step4_room_count,
      COALESCE(SUM(f3.unpaid_amount), 0) as step4_promised_amount
    FROM send_queues sq
    JOIN fees f3 ON sq.fee_id = f3.id
    JOIN rooms r2 ON sq.room_number = r2.room_number
    LEFT JOIN collection_tasks ct ON sq.task_id = ct.id
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    ${qWhere.length ? `${qWhere} AND (rec.result = 'promised' OR cr.result = 'promised')` :
      "WHERE (rec.result = 'promised' OR cr.result = 'promised')"}
  `, ...qValues);

  // step5: 付款 & step6: 减免
  // ---- step5 付款单去重后金额，独立查询（避免嵌套参数错乱） ----
  const amtConds: string[] = [];
  const amtValues: any[] = [];
  if (startDate) { amtConds.push(`py.paid_at >= ?`); amtValues.push(startDate); }
  if (endDate)   { amtConds.push(`py.paid_at <= ?`); amtValues.push(endDate);   }
  if (chArr && chArr.length > 0) {
    const ph = chArr.map(() => '?').join(',');
    amtConds.push(`py.room_number IN (SELECT DISTINCT sq2.room_number FROM send_queues sq2 WHERE sq2.channel IN (${ph}))`);
    amtValues.push(...chArr);
  }
  // scope 限定住户: py.room_number 必须在 scope 覆盖的住户集合里
  // 注意: scopeWhere 里已经有占位符(带?)的话不能直接嵌入字符串,必须传参
  amtConds.push(`py.room_number IN (SELECT DISTINCT r.room_number FROM fees f JOIN rooms r ON f.room_id = r.id ${scopeWhere})`);
  amtValues.push(...scopeValues);
  const amtWhere = amtConds.length ? `WHERE ${amtConds.join(' AND ')}` : '';

  const s5amt = await safeGet(
    `SELECT
      COUNT(DISTINCT px.pid) as pay_count,
      COUNT(DISTINCT px.prn) as pay_rooms,
      COALESCE(SUM(px.pamt), 0) as total_amount
    FROM (
      SELECT DISTINCT py.id as pid, py.amount as pamt, py.room_number as prn
      FROM payments py ${amtWhere}
    ) px
  `, ...amtValues);

  // ---- step5_count/step6: fees+scope 维度 ----
  const s56 = await safeGet(
    `SELECT
      COUNT(DISTINCT f.id) as step5_paid_count,
      COUNT(DISTINCT CASE WHEN f.status = 'paid' THEN f.room_id END) as step5_room_count,
      COUNT(DISTINCT CASE WHEN f.reduction_amount > 0 AND f.status = 'paid' THEN f.id END) as step6_reduced_count,
      COUNT(DISTINCT CASE WHEN f.reduction_amount > 0 AND f.status = 'paid' THEN f.room_id END) as step6_room_count,
      COALESCE(SUM(CASE WHEN f.reduction_amount > 0 AND f.status = 'paid' THEN f.reduction_amount END), 0) as step6_reduced_amount
    FROM fees f JOIN rooms r ON f.room_id = r.id
    ${scopeWhere} AND f.status = 'paid'
  `, ...scopeValues);

  const step1 = {
    count: s1?.step1_fee_count || 0,
    room_count: s1?.step1_room_count || 0,
    amount: parseFloat((s1?.step1_unpaid || 0).toFixed(2)),
  };
  const step2 = {
    count: s2s3?.step2_sent_count || 0,
    room_count: s2s3?.step2_room_count || 0,
    active: s2s3?.step2_active || 0,
  };
  const step3 = {
    count: s2s3?.step3_delivered_count || 0,
    room_count: s2s3?.step3_room_count || 0,
    amount: parseFloat((s2s3?.step3_delivered_amount || 0).toFixed(2)),
  };
  const step4 = {
    count: s4?.step4_promised_count || 0,
    room_count: s4?.step4_room_count || 0,
    amount: parseFloat((s4?.step4_promised_amount || 0).toFixed(2)),
  };
  const step5 = {
    count: s56?.step5_paid_count || 0,
    room_count: s56?.step5_room_count || 0,
    amount: parseFloat((s5amt?.total_amount || 0).toFixed(2)),
  };
  const step6 = {
    count: s56?.step6_reduced_count || 0,
    room_count: s56?.step6_room_count || 0,
    amount: parseFloat((s56?.step6_reduced_amount || 0).toFixed(2)),
  };

  const funnelRates: any = {};
  funnelRates.rate_1_to_2 = step1.count > 0 ? parseFloat(((step2.count / step1.count) * 100).toFixed(2)) : 0;
  funnelRates.rate_2_to_3 = step2.count > 0 ? parseFloat(((step3.count / step2.count) * 100).toFixed(2)) : 0;
  funnelRates.rate_3_to_4 = step3.count > 0 ? parseFloat(((step4.count / step3.count) * 100).toFixed(2)) : 0;
  funnelRates.rate_4_to_5 = step4.count > 0 ? parseFloat(((step5.count / step4.count) * 100).toFixed(2)) : 0;
  funnelRates.rate_1_to_5 = step1.count > 0 ? parseFloat(((step5.count / step1.count) * 100).toFixed(2)) : 0;
  funnelRates.room_recovery_rate = step1.room_count > 0 ? parseFloat(((step5.room_count / step1.room_count) * 100).toFixed(2)) : 0;
  funnelRates.recovery_rate = step1.amount > 0 ? parseFloat(((step5.amount / step1.amount) * 100).toFixed(2)) : 0;

  // 追踪明细 (按房号或任务号)
  let tracking: any[] = [];
  if (roomNumber || taskId) {
    const trackConds: string[] = [];
    const trackVal: any[] = [];
    if (roomNumber) { trackConds.push(`sq.room_number = ?`); trackVal.push(roomNumber); }
    if (taskId)     { trackConds.push(`sq.task_id = ?`);     trackVal.push(taskId);     }
    const trackWhere = trackConds.length ? `WHERE ${trackConds.join(' AND ')}` : '';
    tracking = await safeAll(
      `SELECT
        sq.room_number, r3.building, r3.owner_name, r3.owner_phone,
        sq.task_id, ct.name as task_name, ct.stage, ct.stage as stage_desc,
        sq.id as queue_id, sq.channel, sq.status, sq.priority,
        sq.created_at, sq.sent_at, sq.delivered_at,
        f4.period, f4.original_amount, f4.reduction_amount, f4.payable_amount,
        f4.paid_amount, f4.unpaid_amount, f4.overdue_days, f4.overdue_level,
        rec.result as receipt_result, rec.promised_pay_at, rec.note as receipt_note,
        cr.result as call_result, cr.duration, cr.operator, cr.note as call_note,
        f4.status as fee_status,
        CASE WHEN f4.status = 'paid' AND f4.reduction_amount > 0 THEN 'step6_reduced'
             WHEN f4.status = 'paid' THEN 'step5_paid'
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
      channel_desc: getChannelDescription(t.channel),
    }));
  }

  return {
    filters: {
      building: building || null,
      stage: stsArr || null,
      channel: chArr || null,
      roomNumber: roomNumber || null,
      taskId: taskId || null,
      startDate: startDate || null,
      endDate: endDate || null,
    },
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
  } catch (e) {
    // 兜底: 任何异常都返回稳定的空结构, 永不 500
    const d = defStep();
    return {
      filters: {
        building: building || null, stage: stsArr?.length ? stsArr : null,
        channel: chArr?.length ? chArr : null,
        roomNumber: roomNumber || null, taskId: taskId || null,
        startDate: startDate || null, endDate: endDate || null,
      },
      steps: {
        step1_unpaid: d, step2_collected: d, step3_delivered: d,
        step4_promised: d, step5_paid: d, step6_reduced: d,
      },
      funnel_rates: {
        rate_1_to_2: 0, rate_2_to_3: 0, rate_3_to_4: 0, rate_4_to_5: 0,
        rate_1_to_5: 0, room_recovery_rate: 0, recovery_rate: 0,
      },
      tracking: [],
      _error: (e as any)?.message,
    };
  }
}

// ============ 收费风险分析 ===============
export async function getRiskAnalysis(params: any = {}) {
  const { building, startDate, endDate } = params;
  const band = building ? `AND r.building = '${building.replace(/'/g, "''")}'` : '';

  // 维度1: 按楼栋汇总
  // ---- 关键: 子查询里的房间必须和主查询当前行的 r.building 关联, 防止数据串栋 ----
  const byBuilding = await all(`
    SELECT
      r.building,
      COUNT(DISTINCT r.id) as total_rooms,
      COUNT(DISTINCT CASE WHEN f.status != 'paid' THEN f.id END) as unpaid_fees,
      COUNT(DISTINCT CASE WHEN f.overdue_level IN ('severe','critical') AND f.status != 'paid' THEN r.id END) as high_risk_rooms,
      COALESCE(SUM(CASE WHEN f.overdue_level IN ('severe','critical') AND f.status != 'paid' THEN f.unpaid_amount END), 0) as high_risk_amount,
      COALESCE(SUM(CASE WHEN f.status != 'paid' THEN f.unpaid_amount END), 0) as total_unpaid,
      (SELECT COUNT(DISTINCT sq.room_number) FROM send_queues sq
        LEFT JOIN rooms r2 ON sq.room_number = r2.room_number
        LEFT JOIN receipts rec ON rec.queue_id = sq.id
        LEFT JOIN call_records cr ON cr.queue_id = sq.id
        WHERE r2.building = r.building ${band ? `AND r2.building = '${building.replace(/'/g, "''")}'` : ''}
          AND (rec.result = 'promised' OR cr.result = 'promised')
      ) as promised_rooms,
      (SELECT COUNT(DISTINCT cmp.room_number) FROM complaints cmp
        LEFT JOIN rooms r3 ON r3.room_number = cmp.room_number
        WHERE r3.building = r.building ${band ? `AND r3.building = '${building.replace(/'/g, "''")}'` : ''}
          AND cmp.status = 'open'
      ) as complaint_rooms,
      (SELECT COUNT(DISTINCT bl.room_number) FROM blacklists bl
        LEFT JOIN rooms r4 ON r4.room_number = bl.room_number
        WHERE r4.building = r.building ${band ? `AND r4.building = '${building.replace(/'/g, "''")}'` : ''}
          AND (bl.effective_to IS NULL OR bl.effective_to > datetime('now'))
      ) as blacklist_rooms
    FROM rooms r
    LEFT JOIN fees f ON f.room_id = r.id
    WHERE 1=1 ${band}
    GROUP BY r.building
    ORDER BY total_unpaid DESC
  `);

  // 维度2: 按逾期等级 x 楼栋 矩阵
  const byBuildingLevel = await all(`
    SELECT
      r.building, f.overdue_level,
      COUNT(DISTINCT f.id) as fee_count,
      COUNT(DISTINCT r.id) as room_count,
      COALESCE(SUM(f.unpaid_amount), 0) as unpaid_amount
    FROM fees f JOIN rooms r ON f.room_id = r.id
    WHERE f.status != 'paid' ${band}
    GROUP BY r.building, f.overdue_level
    ORDER BY r.building, f.overdue_level
  `);

  // 维度3: 近 7 天承诺到期未付
  const promisedNotPaid = await all(`
    SELECT
      r.room_number, r.building, r.owner_name, r.owner_phone,
      sq.id as queue_id, sq.channel, sq.task_id,
      COALESCE(rec.promised_pay_at, cr.promised_pay_at) as promised_pay_at,
      f.period, f.unpaid_amount, f.overdue_level, f.overdue_days,
      CASE WHEN rec.result = 'promised' THEN 'receipt' ELSE 'call' END as promised_source
    FROM send_queues sq
    JOIN rooms r ON sq.room_number = r.room_number
    JOIN fees f ON f.id = sq.fee_id
    LEFT JOIN receipts rec ON rec.queue_id = sq.id
    LEFT JOIN call_records cr ON cr.queue_id = sq.id
    WHERE (rec.result = 'promised' OR cr.result = 'promised')
      AND f.status != 'paid'
      AND DATE(COALESCE(rec.promised_pay_at, cr.promised_pay_at)) <= DATE('now','+7 days')
      AND DATE(COALESCE(rec.promised_pay_at, cr.promised_pay_at)) >= DATE('now','-30 days')
      ${band}
    ORDER BY COALESCE(rec.promised_pay_at, cr.promised_pay_at) ASC
    LIMIT 200
  `);

  // 维度4: 高风险清单 (severe/critical + 投诉/黑名单)
  const riskList = await all(`
    SELECT
      r.room_number, r.building, r.owner_name, r.owner_phone,
      f.overdue_level, MAX(f.overdue_days) as max_overdue_days,
      COUNT(DISTINCT f.id) as unpaid_fees,
      COALESCE(SUM(f.unpaid_amount), 0) as total_unpaid,
      (SELECT COUNT(*) FROM complaints cmp WHERE cmp.room_number = r.room_number AND cmp.status = 'open') as open_complaints,
      CASE WHEN bl.id IS NOT NULL THEN 1 ELSE 0 END as is_blacklisted,
      bl.reason as blacklist_reason,
      (SELECT COUNT(*) FROM send_queues sq WHERE sq.room_number = r.room_number) as touch_count
    FROM rooms r
    JOIN fees f ON f.room_id = r.id
    LEFT JOIN blacklists bl ON bl.room_number = r.room_number AND (bl.effective_to IS NULL OR bl.effective_to > datetime('now'))
    WHERE f.status != 'paid' ${band}
    GROUP BY r.id, r.room_number, r.building, r.owner_name, r.owner_phone, f.overdue_level, bl.id, bl.reason
    HAVING f.overdue_level IN ('severe', 'critical')
        OR open_complaints > 0
        OR is_blacklisted = 1
    ORDER BY total_unpaid DESC
    LIMIT 300
  `);

  // 维度5: 汇总 KPIs
  const totals = await get<any>(`
    SELECT
      COUNT(DISTINCT CASE WHEN f.overdue_level IN ('severe','critical') AND f.status != 'paid' THEN r.id END) as high_risk_rooms,
      COALESCE(SUM(CASE WHEN f.overdue_level IN ('severe','critical') AND f.status != 'paid' THEN f.unpaid_amount END), 0) as high_risk_amount,
      COUNT(DISTINCT CASE WHEN f.status != 'paid' THEN r.id END) as unpaid_rooms,
      COALESCE(SUM(CASE WHEN f.status != 'paid' THEN f.unpaid_amount END), 0) as total_unpaid
    FROM fees f JOIN rooms r ON f.room_id = r.id
    WHERE 1=1 ${band}
  `);

  const decoratedByBuildingLevel = byBuildingLevel.map((row: any) => ({
    ...row,
    level_desc: getOverdueLevelDescription(row.overdue_level),
  }));
  const decoratedPromised = promisedNotPaid.map((row: any) => ({
    ...row,
    level_desc: getOverdueLevelDescription(row.overdue_level),
    channel_desc: getChannelDescription(row.channel),
    days_until_due: row.promised_pay_at ? Math.ceil((new Date(row.promised_pay_at).getTime() - Date.now()) / 86400000) : null,
  }));
  const decoratedRiskList = riskList.map((row: any) => ({
    ...row,
    level_desc: getOverdueLevelDescription(row.overdue_level),
    risk_tags: [
      row.overdue_level === 'critical' ? '极端逾期' : null,
      row.overdue_level === 'severe' ? '重度逾期' : null,
      row.open_complaints > 0 ? `投诉中(${row.open_complaints})` : null,
      row.is_blacklisted ? '黑名单' : null,
    ].filter(Boolean),
  }));

  return {
    filters: { building: building || null, startDate: startDate || null, endDate: endDate || null },
    summary: {
      high_risk_rooms: totals?.high_risk_rooms || 0,
      high_risk_amount: parseFloat((totals?.high_risk_amount || 0).toFixed(2)),
      unpaid_rooms: totals?.unpaid_rooms || 0,
      total_unpaid: parseFloat((totals?.total_unpaid || 0).toFixed(2)),
      promised_due_rooms: promisedNotPaid.length,
      follow_up_priority: (totals?.high_risk_amount || 0) > 50000 ? 'urgent' : (totals?.high_risk_amount || 0) > 10000 ? 'high' : 'normal',
    },
    by_building: byBuilding.map((r: any) => ({
      ...r,
      high_risk_rate: r.total_rooms > 0 ? parseFloat(((r.high_risk_rooms / r.total_rooms) * 100).toFixed(2)) : 0,
    })),
    by_building_level: decoratedByBuildingLevel,
    promised_due_not_paid: decoratedPromised,
    high_risk_list: decoratedRiskList,
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
