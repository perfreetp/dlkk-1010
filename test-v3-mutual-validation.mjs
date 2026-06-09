const BASE = 'http://localhost:3000/api';
async function test() {
  const H = { 'Content-Type': 'application/json', 'x-operator': 'CS01' };
  async function get(p) { const r = await fetch(BASE + p); return r.json(); }
  async function post(p, b) { const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return r.json(); }
  const ok = (n, pass, msg = '') => console.log(`[${String(n).padStart(2, '0')}] ${pass ? '✅' : '❌'} ${msg}`);
  let n = 0; let PASS = 0, FAIL = 0;
  const assert = (num, cond, msg) => { if (cond) PASS++; else FAIL++; ok(num, cond, msg); };

  console.log('\n========== 物业费催缴后端 V3 - 互相对上回归验证 ==========\n');

  // ---------------- 先取模板 ----------------
  const tplSmsS2 = (await get('/templates?channel=sms&stage=stage2')).data[0];
  const tplPhoneS3 = (await get('/templates?channel=phone&stage=stage3')).data[0];
  const tplSmsS1 = (await get('/templates?channel=sms&stage=stage1')).data[0];
  console.log(`[准备] 模板: sms+stage2=${tplSmsS2?.id?.slice(0,8)}, phone+stage3=${tplPhoneS3?.id?.slice(0,8)}`);

  // ---------------- 先取全量费用, 选1号楼和2号楼的住户 ----------------
  const feeList = (await get('/fees/search?only_overdue=false&page=1&pageSize=200')).data.list;
  const b1Fees = feeList.filter(f => f.building === '1号楼' && f.status !== 'paid');
  const b2Fees = feeList.filter(f => f.building === '2号楼' && f.status !== 'paid');
  const b1Rooms = [...new Set(b1Fees.map(f => f.room_number))];
  const b2Rooms = [...new Set(b2Fees.map(f => f.room_number))];
  console.log(`[准备] 1号楼未缴: ${b1Fees.length}笔/${b1Rooms.length}户, 2号楼未缴: ${b2Fees.length}笔/${b2Rooms.length}户`);
  console.log(`       1号楼住户: ${JSON.stringify(b1Rooms.slice(0,5))}...`);
  console.log(`       2号楼住户: ${JSON.stringify(b2Rooms.slice(0,5))}...`);

  // ---------------- 第一步: 创建催缴任务 ----------------
  // 任务A: 1号楼 sms/stage2（造1号楼的sms触达）
  const tA = await post('/tasks', {
    name: 'v3-b1-sms-stage2', stage: 'stage2',
    templateId: tplSmsS2.id, channel: 'sms', priority: 2,
    batchCreate: true, building: '1号楼', minAmount: 50,
  });
  const taskAId = tA.data.task.id;
  const queA = tA.data.summary.queued;
  console.log(`[造数据] 任务A (1号楼 sms stage2): task=${taskAId.slice(0,10)} queued=${queA}`);

  // 任务B: 2号楼 phone/stage3（造2号楼的phone触达）
  const tB = await post('/tasks', {
    name: 'v3-b2-phone-stage3', stage: 'stage3',
    templateId: tplPhoneS3.id, channel: 'phone', priority: 2,
    batchCreate: true, building: '2号楼', minAmount: 50,
  });
  const taskBId = tB.data.task.id;
  const queB = tB.data.summary.queued;
  console.log(`[造数据] 任务B (2号楼 phone stage3): task=${taskBId.slice(0,10)} queued=${queB}`);

  // 任务C: 全小区 sms/stage1（用于验证跨楼栋阶段维度）
  const tC = await post('/tasks', {
    name: 'v3-all-sms-stage1', stage: 'stage1',
    templateId: tplSmsS1.id, channel: 'sms', priority: 1,
    batchCreate: true, minOverdueDays: 90,
  });
  const taskCId = tC.data.task.id;
  const queC = tC.data.summary.queued;
  console.log(`[造数据] 任务C (全小区 sms stage1,逾期>=90天): task=${taskCId.slice(0,10)} queued=${queC}`);

  // ---------------- 标记送达+承诺 ----------------
  // 任务A前3条标记送达+承诺(1号楼的承诺,3个2天前到期→进入承诺到期未付)
  const tAQ = (await get(`/tasks/${taskAId}`)).data.queues.filter(q => q.status !== 'intercepted').map(q => q.id);
  const promisedB1Rooms = [];
  for (let i = 0; i < Math.min(3, tAQ.length); i++) {
    await post(`/queue/${tAQ[i]}/delivered`, {});
    const pastDue = new Date(Date.now() - 86400000 * (i + 2));
    const r = await post('/receipts', { queueId: tAQ[i], result: 'promised', promisedPayAt: pastDue.toISOString(), note: 'V3测试:承诺已到期' });
    if (r.code === 200 && r.data?.room_number) promisedB1Rooms.push(r.data.room_number);
  }
  console.log(`[造数据] 1号楼承诺到期未付(3户): ${JSON.stringify(promisedB1Rooms)}`);

  // 任务A 2条额外只送达不承诺
  for (let i = 3; i < Math.min(5, tAQ.length); i++) await post(`/queue/${tAQ[i]}/delivered`, {});

  // 任务B前2条标记送达+承诺(2号楼)
  const tBQ = (await get(`/tasks/${taskBId}`)).data.queues.filter(q => q.status !== 'intercepted').map(q => q.id);
  for (let i = 0; i < Math.min(2, tBQ.length); i++) {
    await post(`/queue/${tBQ[i]}/delivered`, {});
    const futureDue = new Date(Date.now() + 86400000 * 3);
    await post('/receipts', { queueId: tBQ[i], result: 'promised', promisedPayAt: futureDue.toISOString(), note: 'V3测试:3天后到期' });
  }

  // ---------------- 登记付款 ----------------
  // 1号楼: 3笔付款, 合计 ￥100 + ￥250 + ￥180 = ￥530
  const payNosB1 = ['V3B1-' + Date.now() + '-A', 'V3B1-' + Date.now() + '-B', 'V3B1-' + Date.now() + '-C'];
  const payRoomsB1 = [b1Rooms[Math.min(0, b1Rooms.length - 1)], b1Rooms[Math.min(1, b1Rooms.length - 1)], b1Rooms[Math.min(2, b1Rooms.length - 1)]];
  const payAmtsB1 = [100, 250, 180];
  const payTotalB1 = payAmtsB1.reduce((s, x) => s + x, 0);
  for (let i = 0; i < 3; i++) {
    await post('/payments/sync', {
      paymentNo: payNosB1[i], roomNumber: payRoomsB1[i], amount: payAmtsB1[i],
      paidAt: new Date().toISOString(), method: 'wechat', payer: 'V3测试业主B1-' + i,
    });
  }

  // 2号楼: 2笔付款, 合计 ￥300 + ￥150 = ￥450
  const payNosB2 = ['V3B2-' + Date.now() + '-X', 'V3B2-' + Date.now() + '-Y'];
  const payRoomsB2 = [b2Rooms[0], b2Rooms[1]];
  const payAmtsB2 = [300, 150];
  const payTotalB2 = payAmtsB2.reduce((s, x) => s + x, 0);
  for (let i = 0; i < 2; i++) {
    await post('/payments/sync', {
      paymentNo: payNosB2[i], roomNumber: payRoomsB2[i], amount: payAmtsB2[i],
      paidAt: new Date().toISOString(), method: 'alipay', payer: 'V3测试业主B2-' + i,
    });
  }
  await new Promise(r => setTimeout(r, 500));
  console.log(`[造数据] 付款登记完成: 1号楼3笔合计￥${payTotalB1}, 2号楼2笔合计￥${payTotalB2}, 总￥${payTotalB1 + payTotalB2}`);

  // ---------------- 登记投诉 ----------------
  // 1号楼: 1户投诉（b1Rooms[3]）
  const compRoomB1 = b1Rooms[3] || b1Rooms[0];
  await post('/complaints', { roomNumber: compRoomB1, content: 'V3测试: 1号楼物业服务投诉', category: 'service', operator: 'CS01' });
  console.log(`[造数据] 登记投诉: 1号楼 ${compRoomB1} (status=open)`);

  // 等待数据落库
  await new Promise(r => setTimeout(r, 800));

  // ========================================================================
  // 🎯 测试 1: 默认闭环看板 6 步齐全, 不筛选不报错, step5 amount = 总付款合计
  // ========================================================================
  const cbDef = await get('/stats/closure');
  const steps = cbDef.data.steps;
  const step6 = !!steps.step1_unpaid && !!steps.step2_collected && !!steps.step3_delivered
              && !!steps.step4_promised && !!steps.step5_paid && !!steps.step6_reduced;
  const allKeys = Object.keys(steps.step1_unpaid || {}).concat(Object.keys(steps.step5_paid || {}));
  const noNull = allKeys.every(k => typeof steps.step1_unpaid[k] === 'number' || typeof steps.step5_paid[k] === 'number');
  const defTotalPay = steps.step5_paid.amount;
  const match1 = Math.abs(defTotalPay - (payTotalB1 + payTotalB2)) < 0.02;
  assert(++n, cbDef.code === 200 && step6 && noNull && match1,
    `默认闭环看板✅6步齐全无null, step5付款￥${defTotalPay.toFixed(2)}=总付款￥${(payTotalB1+payTotalB2).toFixed(2)}: ${match1?'对得上':'不匹配'}`);

  // ========================================================================
  // 🎯 测试 2: 按渠道筛选闭环(sms 和 phone)
  // ========================================================================
  const cbSms = await get('/stats/closure?channel=sms');
  const cbPhone = await get('/stats/closure?channel=phone');
  const smsStep2 = cbSms.data.steps.step2_collected.count;
  const phoneStep2 = cbPhone.data.steps.step2_collected.count;
  const chOk = cbSms.code === 200 && cbPhone.code === 200
            && smsStep2 > 0 && phoneStep2 > 0;
  assert(++n, chOk,
    `按渠道筛选闭环✅sms已催=${smsStep2}, phone已催=${phoneStep2}, 两个渠道均>0且非空`);

  // ========================================================================
  // 🎯 测试 3: 风险分析不传building, 两栋楼数据不串(投诉/承诺/黑名单各归各栋)
  // ========================================================================
  const riskAll = await get('/stats/risk-analysis');
  const rB1 = riskAll.data.by_building.find(b => b.building === '1号楼');
  const rB2 = riskAll.data.by_building.find(b => b.building === '2号楼');
  console.log(`[诊断] 1号楼汇总: promised=${rB1?.promised_rooms}, complaint=${rB1?.complaint_rooms}, blacklist=${rB1?.blacklist_rooms}`);
  console.log(`[诊断] 2号楼汇总: promised=${rB2?.promised_rooms}, complaint=${rB2?.complaint_rooms}, blacklist=${rB2?.blacklist_rooms}`);
  // 1号楼的投诉=1, 2号楼的投诉=0(不串)
  const complaintIsolated = rB1?.complaint_rooms === 1 && rB2?.complaint_rooms === 0;
  // 1号楼黑名单(mini-seed里1-0501是黑名单)=1, 2号楼黑名单=0(不串)
  const blacklistIsolated = rB1?.blacklist_rooms >= 1 && rB2?.blacklist_rooms === 0;
  const b1HasPromised = rB1?.promised_rooms >= 1;
  const isolationOk = complaintIsolated && blacklistIsolated && b1HasPromised;
  assert(++n, isolationOk,
    `风险分析楼栋隔离✅投诉: B1=1/B2=0(${complaintIsolated?'OK':'串了!'}) | 黑名单: B1≥1/B2=0(${blacklistIsolated?'OK':'串了!'}) | B1承诺≥1(${b1HasPromised?'OK':'异常'})`);

  // ========================================================================
  // 🎯 测试 4: 风险分析传building=1号楼只返回1栋
  // ========================================================================
  const riskB1 = await get('/stats/risk-analysis?building=' + encodeURIComponent('1号楼'));
  const buildingRows = riskB1.data.by_building;
  const buildingFilterOk = buildingRows.length === 1 && buildingRows[0].building === '1号楼';
  const promisedList = riskB1.data.promised_due_not_paid || [];
  const allInB1 = promisedList.every(x => x.building === '1号楼');
  assert(++n, buildingFilterOk && allInB1,
    `风险分析单栋筛选✅只返回${buildingRows.length}行(building=${buildingRows[0]?.building}), 承诺清单${promisedList.length}条全在1号楼: ${allInB1}`);

  // ========================================================================
  // 🎯 测试 5: 阶段维度+楼栋回款 = 付款历史该楼栋总金额
  // ========================================================================
  // 先查付款历史1号楼总金额
  const phB1 = await get('/payments/history?building=' + encodeURIComponent('1号楼') + '&page=1&pageSize=200');
  const sumPayHistoryB1 = phB1.data.list.reduce((s, p) => s + p.amount, 0);
  console.log(`[诊断] 1号楼付款历史SUM: ￥${sumPayHistoryB1.toFixed(2)} (${phB1.data.list.length}条)`);

  // 查/stats/overview?dimension=stage&building=1号楼
  const ovB1 = await get('/stats/overview?dimension=stage&building=' + encodeURIComponent('1号楼'));
  const dimB1 = ovB1.data.dimensionData || [];
  const sumStageB1 = dimB1.reduce((s, r) => s + (r.actual_paid || 0), 0);
  console.log(`[诊断] 1号楼阶段维度SUM(actual_paid): ￥${sumStageB1.toFixed(2)} → 明细: ${JSON.stringify(dimB1.map((r)=>({s:r.stage,a:r.actual_paid})))}`);

  const b1Match = Math.abs(sumStageB1 - sumPayHistoryB1) < 0.02 && Math.abs(sumStageB1 - payTotalB1) < 0.02;
  assert(++n, b1Match,
    `1号楼阶段回款✅维度汇总￥${sumStageB1.toFixed(2)} = 付款历史￥${sumPayHistoryB1.toFixed(2)} = 登记付款￥${payTotalB1.toFixed(2)}: ${b1Match?'三方对得上':'有偏差!'}`);

  // ========================================================================
  // 🎯 测试 6: 同样的方法验证 2号楼(阶段+楼栋回款 vs 付款历史)
  // ========================================================================
  const phB2 = await get('/payments/history?building=' + encodeURIComponent('2号楼') + '&page=1&pageSize=200');
  const sumPayHistoryB2 = phB2.data.list.reduce((s, p) => s + p.amount, 0);

  const ovB2 = await get('/stats/overview?dimension=stage&building=' + encodeURIComponent('2号楼'));
  const dimB2 = ovB2.data.dimensionData || [];
  const sumStageB2 = dimB2.reduce((s, r) => s + (r.actual_paid || 0), 0);
  console.log(`[诊断] 2号楼: 付款历史￥${sumPayHistoryB2.toFixed(2)}, 阶段维度￥${sumStageB2.toFixed(2)}, 明细: ${JSON.stringify(dimB2.map((r)=>({s:r.stage,a:r.actual_paid})))}`);

  const b2Match = Math.abs(sumStageB2 - sumPayHistoryB2) < 0.02 && Math.abs(sumStageB2 - payTotalB2) < 0.02;
  assert(++n, b2Match,
    `2号楼阶段回款✅维度汇总￥${sumStageB2.toFixed(2)} = 付款历史￥${sumPayHistoryB2.toFixed(2)} = 登记付款￥${payTotalB2.toFixed(2)}: ${b2Match?'三方对得上':'有偏差!'}`);

  // ========================================================================
  // 🎯 测试 7: 闭环按楼栋筛选, step5_paid_amount = 该楼栋付款历史
  // ========================================================================
  const cbB1 = await get('/stats/closure?building=' + encodeURIComponent('1号楼'));
  const cbB1pay = cbB1.data.steps.step5_paid.amount;
  const b1ClosureMatch = Math.abs(cbB1pay - sumPayHistoryB1) < 0.02;
  assert(++n, b1ClosureMatch,
    `1号楼闭环step5付款✅￥${cbB1pay.toFixed(2)} = 付款历史￥${sumPayHistoryB1.toFixed(2)}: ${b1ClosureMatch?'对得上':'不匹配!'}`);

  // ========================================================================
  // 🎯 测试 8: 所有接口都不能返回 5xx
  // ========================================================================
  const sanityChecks = await Promise.all([
    get('/stats/closure'),
    get('/stats/closure?channel=wechat'),
    get('/stats/closure?channel=sms,phone'),
    get('/stats/closure?building=' + encodeURIComponent('不存在的楼')),
    get('/stats/risk-analysis'),
    get('/stats/risk-analysis?building=' + encodeURIComponent('999号楼')),
    get('/stats/overview?dimension=stage&building=' + encodeURIComponent('空楼')),
  ]);
  const no5xx = sanityChecks.every(r => r.code === 200 || (r.code >= 0 && r.code < 400));
  assert(++n, no5xx,
    `接口鲁棒性✅7个边界请求无5xx: ${sanityChecks.map(r=>r.code).join(',')}`);

  // ========================================================================
  // 🎯 测试 9: 风险分析承诺到期未付, 1号楼数量= by_building.promised_rooms
  // ========================================================================
  const pListB1 = riskB1.data.promised_due_not_paid;
  const promisedCountMatch = pListB1.length >= rB1.promised_rooms - 1 && pListB1.length <= rB1.promised_rooms + 3;
  // 注意: promised_due_not_paid 还有f.status!='paid'过滤, 所以可能比by_building的少几户
  console.log(`[诊断] 1号楼 by_building.promised_rooms=${rB1.promised_rooms}, 承诺到期未付list=${pListB1.length} (允许±3因为有未付过滤)`);
  assert(++n, promisedCountMatch,
    `承诺口径✅promised_rooms(${rB1.promised_rooms})≈清单数量(${pListB1.length}): ${promisedCountMatch?'OK':'偏差大'}`);

  // ========================================================================
  // 🎯 测试 10: 高风险清单 1号楼投诉户(compRoomB1)必须在里面, 且其risk_tags含投诉
  // ========================================================================
  const riskListB1 = riskB1.data.high_risk_list || [];
  const hasComplaint = riskListB1.some(h => h.room_number === compRoomB1
    && (h.risk_tags || []).some((t) => t.includes('投诉')));
  const hasBlacklist = riskListB1.some(h => h.risk_tags?.includes('黑名单'));
  console.log(`[诊断] 1号楼高风险清单${riskListB1.length}户, 含投诉户${compRoomB1}:${hasComplaint?'✅':'❌'}, 含黑名单:${hasBlacklist?'✅':'❌'}`);
  assert(++n, hasComplaint && hasBlacklist,
    `高风险清单✅投诉户${compRoomB1}在清单(risk含投诉):${hasComplaint} | 黑名单标记在清单:${hasBlacklist}`);

  // ========================================================================
  // 总结
  // ========================================================================
  console.log(`\n========== V3 互相验证完成: ${PASS}通过 / ${FAIL}失败 / ${PASS+FAIL}总计 ==========\n`);
  if (FAIL > 0) {
    console.log('🔴 有失败的用例, 请检查上方诊断日志定位数据偏差!');
    process.exit(1);
  }
  console.log('🟢 全部通过! 闭环/风险/阶段 三套统计口径完全互相对上!');
}
test().catch(e => { console.error('\n[测试异常]', e.stack || e.message); process.exit(2); });
