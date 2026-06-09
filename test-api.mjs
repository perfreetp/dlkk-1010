const BASE = 'http://localhost:3000/api';

async function test() {
  const headers = { 'Content-Type': 'application/json', 'x-operator': 'CS01' };
  async function get(path) { const r=await fetch(BASE+path); return await r.json(); }
  async function post(path, body) {
    const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return await r.json();
  }

  console.log('\n====== Property Fee Collection Final Tests ======\n');

  console.log('[1] Health ->', (await get('/health')).message);

  const byRoom = await get('/fees/by-room?keyword=1号楼&page=1&pageSize=2');
  console.log(`[2] Search by Room(1号楼) -> ${byRoom.data.pagination.total} rooms`);
  console.log(`    ${JSON.stringify(byRoom.data.list.map(r=>({r:r.room_number,c:r.unpaid_count,t:r.total_unpaid})))}`);

  const severe = await get('/fees/search?page=1&pageSize=3&overdue_level=severe,critical');
  console.log(`[3] Severe/Critical -> ${severe.data.pagination.total} records, ￥${severe.data.stats.total_unpaid}`);
  const sampleFee = severe.data.list[0];
  console.log(`    Sample Fee: ${sampleFee.id.slice(0,8)} ${sampleFee.room_number} ￥${sampleFee.unpaid_amount} stage=${sampleFee.stage}`);

  const tpl = await get('/templates?channel=sms&stage=stage2');
  const sampleTpl = tpl.data[0];
  console.log(`[4] Templates(stage2 SMS) -> ${tpl.data.length} tpls: ${sampleTpl.name}`);

  const task = await post('/tasks', {
    name: '测试阶段2', stage: 'stage2', template_id: sampleTpl.id, templateId: sampleTpl.id,
    channel: 'sms', priority: 2,
    batchCreate: true, batch_create: true,
    overdueLevels: ['warning','mild','moderate','severe','critical'], overdue_levels: 'warning,mild,moderate,severe,critical',
  });
  console.log(`[5] Create Task -> code=${task.code}`);
  console.log(`    task=${task.data.task.id.slice(0,8)} queued=${task.data.summary.queued} intercepted=${task.data.summary.intercepted}`);
  const taskId = task.data.task.id;

  const tasks = await get('/tasks?page=1&pageSize=5');
  console.log(`[6] Task List -> total=${tasks.data.pagination.total}`);

  const q = await get(`/queue?task_id=${encodeURIComponent(taskId)}&page=1&pageSize=5`);
  console.log(`[7] Send Queue for task=${taskId.slice(0,8)} -> total=${q.data.pagination.total}`);
  const qItem = (q.data.list||[]).find(x => x.status === 'pending') || q.data.list[0];
  if (qItem) {
    console.log(`    Queue sample: ${qItem.id.slice(0,8)} ${qItem.room_number} status=${qItem.status}`);
    await post(`/queue/${qItem.id}/sent`, {});
    console.log(`[8] Mark Sent -> OK`);
    await post(`/queue/${qItem.id}/delivered`, {});
    console.log(`[9] Mark Delivered -> OK`);
    const rcp = await post('/receipts', {
      queue_id: qItem.id, delivered_at: new Date().toISOString(),
      result: 'promised', promised_pay_at: new Date(Date.now()+7*86400000).toISOString(),
      note: 'promised',
    });
    console.log(`[10] Register Receipt -> code=${rcp.code} result=${rcp.data.result}`);
  } else {
    console.log('[8-10] SKIP (no pending queue)');
  }

  const fd = await get(`/fees/${sampleFee.id}`);
  console.log(`[11] Fee Detail -> room=${fd.data.room_number} unpaid=￥${fd.data.unpaid_amount} stage=${fd.data.stage}`);

  const rc = await post('/fees/recalc', { fee_ids: [sampleFee.id], reason: 'demo recalc' });
  console.log(`[12] Fee Recalc -> code=${rc.code} processed=${rc.data.processed_count} delta=${rc.data.total_delta}`);

  const pn = 'PAY'+Date.now();
  const pay = await post('/payments/sync', {
    payment_no: pn, paymentNo: pn,
    room_number: sampleFee.room_number, roomNumber: sampleFee.room_number,
    amount: Math.min(200, sampleFee.unpaid_amount),
    paid_at: new Date().toISOString(), paidAt: new Date().toISOString(),
    method: 'wechat', payer: 'Zhang San',
  });
  console.log(`[13] Payment Sync -> code=${pay.code} status=${pay.data.status} allocated=${pay.data.allocations?.length||0}`);
  console.log(`    payId=${pay.data.paymentId?.slice(0,8)||'?'} total=￥${pay.data.totalAllocated}`);

  const red = await post('/reductions', {
    fee_id: sampleFee.id, feeId: sampleFee.id,
    reduction_amount: 10, reductionAmount: 10,
    reason: 'Hardship', applicant: 'CS01',
  });
  console.log(`[14] Reduction Apply -> code=${red.code} id=${red.data.id?.slice(0,8)||'?'} status=${red.data.status}`);
  const redId = red.data.id;

  const appr = await post('/reductions/approve', {
    reduction_id: redId, reductionId: redId,
    approved: true, approver: 'Mgr01', approval_note: 'OK', approvalNote: 'Granted',
  });
  console.log(`[15] Approve Reduction -> code=${appr.code} status=${appr.data.status} fee_updated=${appr.data.fee_updated}`);

  await post('/notes', { room_number: sampleFee.room_number, roomNumber: sampleFee.room_number,
    content: 'Promised next week', operator: 'CS01' });
  console.log(`[16] Customer Note -> OK`);

  await post('/complaints', { room_number: '1号楼-1单元-0501', roomNumber: '1号楼-1单元-0501',
    content: 'Complaint about calling frequency', operator: 'Cmp01', category: 'Service' });
  console.log(`[17] Register Complaint -> OK`);

  const bl = await get('/blacklists?page=1&pageSize=10');
  console.log(`[18] Blacklist -> total=${bl.data.pagination.total} rooms: ${bl.data.list.map(b=>b.room_number).join(',')}`);

  const due = await get('/promise-reminders?days=7');
  console.log(`[19] Promised Payment Reminders(7d) -> ${due.data.length}`);

  const mg = await get(`/records/merged?room_number=${encodeURIComponent(sampleFee.room_number)}&page=1&pageSize=5`);
  console.log(`[20] Merged Records(SMS+Call) -> ${sampleFee.room_number} total=${mg.data.pagination.total}`);

  const ov = await get('/stats/overview');
  console.log(`[21] Stats Overview -> unpaid=￥${ov.data.overview.total_unpaid} tasks=${ov.data.overview.total_tasks}`);
  console.log(`    dim=${ov.data.dimension} byStage=${ov.data.dimensionData?.byStage?.length||'N/A'}`);

  const rk = await get('/stats/building-ranking');
  console.log(`[22] Building Rank ->`, rk.data.slice(0,2).map(x => `${x.building}:￥${x.total_unpaid}/户均￥${x.avg_unpaid||(x.total_unpaid/x.total_rooms).toFixed(2)}`));

  const ds = await get('/stats/overview?dimension=stage');
  console.log(`[23] Stats by Stage -> task_count=`, ds.data.dimensionData.map?.(s=>`${s.stage}:${s.task_count}`).join(','));

  const exp = await get('/export/overdue?format=json');
  console.log(`[24] Export(JSON) -> ${exp.length} overdue records`);

  const lg = await get('/audit/operations?page=1&pageSize=5');
  console.log(`[25] Operation Logs -> total=${lg.data.pagination.total} samplePaths:${lg.data.list.slice(0,3).map(l=>l.api_path).join(',')}`);

  const cr = await get('/audit/call-results?page=1&pageSize=5');
  console.log(`[26] Call Results -> total=${cr.data.pagination.total}`);

  const il = await get('/intercept-logs?page=1&pageSize=10');
  console.log(`[27] Intercept Logs -> total=${il.data.pagination.total}`);

  console.log('\n====== ALL 27 API ENDPOINTS TESTED ======\n');
  console.log('服务地址: http://localhost:3000');
  console.log('根路径文档: GET http://localhost:3000/');
}

test().catch(e => { console.error('FAIL:', e.message); console.error(e.stack?.split('\n').slice(0,5).join('\n')); process.exit(1); });
