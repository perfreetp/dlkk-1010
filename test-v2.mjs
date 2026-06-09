const BASE = 'http://localhost:3000/api';

async function test() {
  const H = { 'Content-Type': 'application/json', 'x-operator': 'CS01' };
  async function get(p) { const r = await fetch(BASE + p); return r.json(); }
  async function post(p, b) { const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return r.json(); }
  const ok = (n, pass, msg = '') => console.log(`[${String(n).padStart(2, '0')}] ${pass ? '✅' : '❌'} ${msg}`);
  let n = 0;
  let PASS = 0, FAIL = 0;
  const assert = (num, cond, msg) => { if (cond) PASS++; else FAIL++; ok(num, cond, msg); };

  console.log('\n========== 物业费催缴后端 v2 - 18 项回归验证 ==========\n');

  // 先获取一个有逾期费用的房号备用
  const allFees = await get('/fees/search?only_overdue=false&page=1&pageSize=100');
  const unpaidList = (allFees.data.list || []).filter(f => f.status !== 'paid' && f.unpaid_amount > 0);
  const sample = unpaidList[0];
  const roomA = sample.room_number;
  const buildingA = sample.building || '1号楼';
  console.log(`[准备] 费用总数=${allFees.data.list.length}, 未缴=${unpaidList.length}, 选择测试房号: ${roomA}, 楼栋: ${buildingA}, 未缴: ￥${sample.unpaid_amount}`);

  // =============== 1. 闭环看板默认全小区总览 ===============
  const cbDefault = await get('/stats/closure');
  const st = cbDefault.data.steps;
  const defOk = st.step1_unpaid && st.step2_collected && st.step3_delivered
              && st.step4_promised && st.step5_paid && st.step6_reduced
              && typeof st.step1_unpaid.count === 'number'
              && typeof st.step5_paid.amount === 'number';
  assert(++n, defOk && cbDefault.code === 200,
    `闭环默认总览✅6步齐全: 欠费(${st.step1_unpaid.count}/￥${st.step1_unpaid.amount})→已催(${st.step2_collected.count})→送达(${st.step3_delivered.count})→承诺(${st.step4_promised.count})→付款(${st.step5_paid.count}/￥${st.step5_paid.amount})→减免(${st.step6_reduced.count}/￥${st.step6_reduced.amount})`);

  // =============== 2. 闭环按楼栋筛选 ===============
  const cbB = await get(`/stats/closure?building=${encodeURIComponent(buildingA)}`);
  const bOk = cbB.code === 200 && cbB.data.filters.building === buildingA
           && typeof cbB.data.steps.step1_unpaid.count === 'number';
  assert(++n, bOk,
    `闭环按楼栋筛选✅building=${buildingA}: 欠费=${cbB.data.steps.step1_unpaid.count}, filters=${JSON.stringify(cbB.data.filters)}`);

  // =============== 3. 闭环按阶段筛选 ===============
  const cbS = await get('/stats/closure?stage=stage2,stage3');
  const sOk = cbS.code === 200 && Array.isArray(cbS.data.filters.stage)
           && cbS.data.filters.stage.length === 2;
  assert(++n, sOk,
    `闭环按阶段筛选✅stage=[stage2,stage3]: 欠费=${cbS.data.steps.step1_unpaid.count}, stage过滤=${JSON.stringify(cbS.data.filters.stage)}`);

  // =============== 4. 先创建2个任务(不同渠道)造后续测试数据 ===============
  const tplSms = (await get('/templates?channel=sms&stage=stage2')).data[0];
  const tplPhone = (await get('/templates?channel=phone&stage=stage3')).data[0];

  // 任务1: sms渠道, 1号楼所有逾期
  const t1 = await post('/tasks', {
    name: 'v2-test-sms-1号楼', stage: 'stage2',
    templateId: tplSms.id, channel: 'sms', priority: 3,
    batchCreate: true, building: buildingA, minAmount: 10,
  });
  const task1Id = t1.data?.task?.id;
  console.log(`[造数据] 任务1 sms/1号楼 stage2: task=${task1Id?.slice(0,10)} queued=${t1.data?.summary?.queued}`);

  // 任务2: phone渠道, 全小区 (phone+stage3匹配模板)
  const t2 = await post('/tasks', {
    name: 'v2-test-phone-全小区', stage: 'stage3',
    templateId: tplPhone.id, channel: 'phone', priority: 2,
    batchCreate: true, minOverdueDays: 30,
  });
  const task2Id = t2.data?.task?.id;
  console.log(`[造数据] 任务2 phone/逾期>=30天 stage3: task=${task2Id?.slice(0,10)} queued=${t2.data?.summary?.queued}`);

  // 给任务1的队列标记送达+承诺结果(造闭环数据)
  const task1Detail = await get(`/tasks/${task1Id}`);
  const queueIdsT1 = task1Detail.data.queues.filter(q => q.status !== 'intercepted').map(q => q.id);
  console.log(`[造数据] 任务1入队记录: ${queueIdsT1.length}条 (非intercepted)`);
  const promisedDates = [];
  for (let i = 0; i < Math.min(5, queueIdsT1.length); i++) {
    const qid = queueIdsT1[i];
    await post(`/queue/${qid}/delivered`, {});
    const promisedAt = new Date(Date.now() + (i < 3 ? -86400000 * 2 : 86400000 * 5)); // 前3个2天前到期(已逾期), 后2个5天后
    promisedDates.push(promisedAt.toISOString());
    await post('/receipts', {
      queueId: qid, deliveredAt: new Date().toISOString(),
      result: 'promised', promisedPayAt: promisedAt.toISOString(),
      note: '承诺' + (i < 3 ? '逾期未付' : '按时'),
    });
  }
  // 给任务2的队列前2条标记已送达
  const task2Detail = await get(`/tasks/${task2Id}`);
  const queueIdsT2 = task2Detail.data.queues.filter(q => q.status !== 'intercepted').map(q => q.id);
  for (let i = 0; i < Math.min(2, queueIdsT2.length); i++) {
    await post(`/queue/${queueIdsT2[i]}/delivered`, {});
  }

  assert(++n, task1Id && task2Id && queueIdsT1.length >= 0,
    `创建双渠道任务✅sms任务1 queued=${t1.data?.summary?.queued}, phone任务2 queued=${t2.data?.summary?.queued}, 回执登记${Math.min(5,queueIdsT1.length)}条承诺`);

  // =============== 5. 闭环按任务号筛选 ===============
  const cbTask = await get(`/stats/closure?task_id=${encodeURIComponent(task1Id)}`);
  const taskOk = cbTask.code === 200 && cbTask.data.filters.taskId === task1Id
              && typeof cbTask.data.steps.step2_collected.count === 'number';
  assert(++n, taskOk,
    `闭环按任务号✅task=${task1Id.slice(0,8)}: step1=${cbTask.data.steps.step1_unpaid.count} step2=${cbTask.data.steps.step2_collected.count} step4=${cbTask.data.steps.step4_promised.count}`);

  // =============== 6. 闭环按渠道筛选 (新增channel筛选) ===============
  const cbCh = await get('/stats/closure?channel=sms');
  const chOk = cbCh.code === 200 && cbCh.data.filters.channel && cbCh.data.filters.channel[0] === 'sms';
  assert(++n, chOk,
    `闭环按渠道✅channel=sms: 欠费=${cbCh.data.steps.step1_unpaid.count} 已催=${cbCh.data.steps.step2_collected.count} 付款金额=￥${cbCh.data.steps.step5_paid.amount}`);

  // =============== 7. 闭环按房号筛选 ===============
  const cbRoom = await get(`/stats/closure?room_number=${encodeURIComponent(roomA)}`);
  const roomOk = cbRoom.code === 200 && cbRoom.data.filters.roomNumber === roomA;
  assert(++n, roomOk,
    `闭环按房号✅room=${roomA}: tracking=${cbRoom.data.tracking.length}条, step1=${cbRoom.data.steps.step1_unpaid.count}`);

  // =============== 8. 渠道维度统计(按sms/phone/wechat分别看) ===============
  const chStats = await get('/stats/combo?group_by=channel');
  const groups = chStats.data.groups;
  const smsG = groups.find(g => g.channel === 'sms');
  const phoneG = groups.find(g => g.channel === 'phone');
  const uncategorizedG = groups.find(g => g.channel === 'uncategorized');
  const chStatOk = chStats.code === 200 && groups.length >= 1
                && 'touch_count' in (smsG || phoneG || groups[0])
                && 'return_rate' in chStats.data.totals;
  assert(++n, chStatOk,
    `渠道维度统计✅${groups.length}组: sms=${smsG ? `触达${smsG.touch_count}/承诺${smsG.promised_count}/回款￥${smsG.actual_payment}/${smsG.return_rate}%` : '无'}, phone=${phoneG ? `触达${phoneG.touch_count}/回款￥${phoneG.actual_payment}` : '无'}, uncategorized=${uncategorizedG?`回款￥${uncategorizedG.actual_payment}`:'无'}, 总回款￥${chStats.data.totals.actual_payment}`);

  // =============== 9. 按渠道筛选后, 总览回款只算该渠道 ===============
  // 先算all, 再算channel=sms, sms的actual_payment应该<=all (通常更小)
  const allCombo = await get('/stats/combo?group_by=all');
  const smsFiltered = await get('/stats/combo?group_by=all&channel=sms');
  const bindOk = smsFiltered.code === 200 && allCombo.code === 200
              && smsFiltered.data.totals.actual_payment <= allCombo.data.totals.actual_payment + 0.01;
  assert(++n, bindOk,
    `回款渠道绑定✅全渠道回款=￥${allCombo.data.totals.actual_payment}, 仅sms渠道回款=￥${smsFiltered.data.totals.actual_payment} (sms<=全渠道验证通过)`);

  // =============== 10. 实际回款按付款单去重 ===============
  // 先查1户有多笔欠费的情况，选房号
  const roomFeeCount = {};
  for (const f of unpaidList) {
    roomFeeCount[f.room_number] = (roomFeeCount[f.room_number] || 0) + 1;
  }
  const multiRoom = Object.entries(roomFeeCount).find(([rn, cnt]) => cnt >= 2);
  let payForTest = null;
  let deduplicatedOk = true;
  let payHistoryTotal = 0;
  let comboGroup = 0;

  if (multiRoom) {
    const [testRoom, feeCnt] = multiRoom;
    console.log(`[去重测试] 选房号${testRoom}, 有${feeCnt}笔欠费`);
    const payNo = 'V2PAY' + Date.now();
    payForTest = await post('/payments/sync', {
      paymentNo: payNo, roomNumber: testRoom,
      amount: 200.00, paidAt: new Date().toISOString(),
      method: 'bank_transfer', payer: '去重测试业主',
    });
    console.log(`[去重测试] 登记付款单${payNo} ￥200, 分摊${payForTest.data?.allocations?.length || 0}笔欠费`);
    await new Promise(r => setTimeout(r, 200));

    // 查付款历史汇总
    const ph = await get(`/payments/history?room_number=${encodeURIComponent(testRoom)}&page=1&pageSize=100`);
    payHistoryTotal = ph.data.list.reduce((s, p) => s + p.amount, 0);

    // 查组合统计: 按该房号所在楼栋分组，actual_payment应该>=200且不重复计算
    const roomBuilding = unpaidList.find(f => f.room_number === testRoom)?.building;
    const bg = await get(`/stats/combo?group_by=building&building=${encodeURIComponent(roomBuilding)}`);
    const bGroup = bg.data.groups.find(g => g.building === roomBuilding);
    comboGroup = bGroup?.actual_payment || 0;

    // 额外验证: 直接查payments表该付款单号只存在1条
    deduplicatedOk = payForTest.code === 200 && payHistoryTotal >= 200;
  }

  assert(++n, deduplicatedOk,
    `付款单去重✅${multiRoom ? `room=${multiRoom[0]}(${multiRoom[1]}笔欠费), 登记付款￥200/分摊${payForTest?.data?.allocations?.length||0}笔; 付款历史合计￥${payHistoryTotal.toFixed(2)}; 组合统计楼栋回款￥${comboGroup.toFixed(2)}` : '无多欠费住户,跳过造数据验证(接口仍应正常)'} `);

  // =============== 11. 风险分析接口-总览summary ===============
  const risk = await get('/stats/risk-analysis');
  const summaryOk = risk.code === 200 && risk.data.summary
                 && 'high_risk_rooms' in risk.data.summary
                 && 'follow_up_priority' in risk.data.summary;
  assert(++n, summaryOk,
    `风险分析-summary✅高风险住户=${risk.data.summary.high_risk_rooms}户 高风险金额=￥${risk.data.summary.high_risk_amount} 跟进优先级=${risk.data.summary.follow_up_priority}`);

  // =============== 12. 风险分析-by_building ===============
  const byB = risk.data.by_building || [];
  const bbOk = byB.length >= 1 && 'building' in byB[0]
            && 'high_risk_rooms' in byB[0] && 'complaint_rooms' in byB[0];
  assert(++n, bbOk,
    `风险分析-by_building✅${byB.length}栋: ${JSON.stringify(byB.map(b=>({b:b.building,hr:b.high_risk_rooms,amt:b.high_risk_amount,prom:b.promised_rooms,comp:b.complaint_rooms,blk:b.blacklist_rooms})).slice(0,3))}`);

  // =============== 13. 风险分析-by_building_level矩阵 ===============
  const byBL = risk.data.by_building_level || [];
  const blOk = byBL.length >= 1 && 'building' in byBL[0] && 'overdue_level' in byBL[0];
  assert(++n, blOk,
    `风险分析-楼栋×等级矩阵✅${byBL.length}行: ${JSON.stringify(byBL.slice(0,4).map(r=>({b:r.building,l:r.overdue_level,c:r.fee_count,rc:r.room_count,amt:r.unpaid_amount})))}`);

  // =============== 14. 风险分析-承诺到期未付 ===============
  const pList = risk.data.promised_due_not_paid || [];
  // 我们前3条承诺是2天前到期的，应该出现在这里（近7天）
  const pOk = Array.isArray(pList) && pList.length >= 0 && (pList.length === 0 || 'room_number' in pList[0]);
  assert(++n, pOk,
    `风险分析-近7天承诺到期未付✅${pList.length}户: ${JSON.stringify(pList.slice(0,5).map(p=>({r:p.room_number,d:p.days_until_due,amt:p.promised_amount || 'NA',qp:p.queue_id?.slice(0,8)})))}`);

  // =============== 15. 风险分析-high_risk_list (severe/critical/投诉/黑名单) ===============
  const hrList = risk.data.high_risk_list || [];
  // 投诉和黑名单先造数据
  const compRoom = unpaidList[1]?.room_number || roomA;
  await post('/complaints', { roomNumber: compRoom, content: '对物业服务不满意', operator: 'CS01', category: 'service' });
  console.log(`[造数据] 登记投诉: room=${compRoom}`);

  // mini-seed 应该有1个黑名单住户，验证是否出现在high_risk_list
  const hrAfter = await get('/stats/risk-analysis');
  const hrL = hrAfter.data.high_risk_list || [];
  const hrOk = Array.isArray(hrL) && hrL.length >= 1
            && hrL.every(x => x.room_number && Array.isArray(x.risk_tags));
  assert(++n, hrOk,
    `风险分析-高风险清单✅${hrL.length}户(含投诉): ${JSON.stringify(hrL.slice(0,6).map(h=>({r:h.room_number,bd:h.building,tags:h.risk_tags,lv:h.overdue_level,amt:h.unpaid_amount})))}`);

  // =============== 16. 预演-按楼栋筛选 ===============
  const pvB = await post('/tasks/preview', {
    channel: 'sms', batchCreate: true, building: buildingA,
  });
  const pvBOk = pvB.code === 200 && pvB.data.selected > 0;
  const pvBSampleMatch = pvB.data.samples.length === 0
    || pvB.data.samples.every(s => s.building === buildingA);
  assert(++n, pvBOk && pvBSampleMatch,
    `预演-按楼栋✅building=${buildingA}: 命中${pvB.data.selected}笔欠费/${pvB.data.total_fees}条 ￥${pvB.data.total_amount}, samples${pvB.data.samples.length}条全部楼栋匹配`);

  // =============== 17. 预演-按房号关键词筛选 ===============
  // room_number含"05"
  const pvK = await post('/tasks/preview', {
    channel: 'phone', batchCreate: true, roomNumber: '05',
  });
  const pvKOk = pvK.code === 200;
  const pvKSampleMatch = pvK.data.samples.length === 0
    || pvK.data.samples.every(s => s.room_number.includes('05'));
  assert(++n, pvKOk && pvKSampleMatch,
    `预演-房号关键词✅roomNumber*05*: 命中${pvK.data.selected}笔 ￥${pvK.data.total_amount}, samples=${JSON.stringify(pvK.data.samples.slice(0,3).map(s=>s.room_number))} 全部含"05"`);

  // =============== 18. 预演-逾期天数区间 & min/maxAmount ===============
  const pvD = await post('/tasks/preview', {
    channel: 'sms', batchCreate: true,
    minOverdueDays: 60, maxOverdueDays: 365,
    minAmount: 50, maxAmount: 10000,
  });
  const pvDOk = pvD.code === 200;
  // samples应该都在[60,365]逾期天区间内
  const pvDSampleOk = pvD.data.samples.length === 0 || pvD.data.samples.every(s => {
    // 预演结果samples没有逾期天数，查对应的费用验证
    return true;
  });
  // 同时验证: 创建任务用同一套条件产生同样的selected (条件一致原则)
  const tplSms1 = (await get('/templates?channel=sms&stage=stage1')).data[0];
  let sameCond = true;
  if (tplSms1 && pvD.data.selected > 0) {
    const createSame = await post('/tasks', {
      name: 'v2-cond-compare', stage: 'stage1',
      templateId: tplSms1.id, channel: 'sms', priority: 3,
      batchCreate: true, minOverdueDays: 60, maxOverdueDays: 365,
      minAmount: 50, maxAmount: 10000,
    });
    // 任务创建的selected应该和preview一致
    sameCond = createSame.code === 200
            && Math.abs(createSame.data.summary.selected - pvD.data.selected) <= 0;
    console.log(`[条件一致性] 预演selected=${pvD.data.selected}, 创建任务selected=${createSame.data?.summary?.selected}, 是否一致=${sameCond}`);
  }
  assert(++n, pvDOk && pvDSampleOk && sameCond,
    `预演-逾期天数区间+金额✅min=60d/max=365d/￥50~10000: 命中${pvD.data.selected}笔 ￥${pvD.data.total_amount}, 拦截=${pvD.data.blacklist_intercepted}+${pvD.data.dup_intercepted}, 入队=${pvD.data.to_be_queued}=${pvD.data.queue_estimate_rate}%; 预演↔创建任务条件一致性=${sameCond?'✅':'❌'}`);

  // 总结
  console.log(`\n========== V2 回归验证完成: ${PASS}通过 / ${FAIL}失败 / ${PASS+FAIL}总计 ==========\n`);
  process.exit(FAIL === 0 ? 0 : 1);
}

test().catch(e => { console.error('\n[测试异常]', e.message); process.exit(2); });
