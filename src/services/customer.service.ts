import { run, get, all } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import { getNow } from '../utils/helpers';

export async function addCustomerNote(data: any) {
  const { roomNumber, content, operator } = data;
  const room = await get('SELECT id FROM rooms WHERE room_number = ?', roomNumber);
  if (!room) throw new Error('房号不存在');
  const id = uuidv4();
  await run(
    `INSERT INTO customer_notes (id, room_number, content, operator, created_at) VALUES (?, ?, ?, ?, ?)`,
    id, roomNumber, content, operator, getNow()
  );
  return { id, roomNumber, createdAt: getNow() };
}

export async function getCustomerNotes(roomNumber?: string, page = 1, pageSize = 50) {
  const conditions: string[] = [];
  const values: any[] = [];
  if (roomNumber) { conditions.push('room_number LIKE ?'); values.push(`%${roomNumber}%`); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRow = await get<any>(`SELECT COUNT(*) as total FROM customer_notes ${whereClause}`, ...values);
  const total = countRow?.total || 0;
  const offset = (page - 1) * pageSize;
  const list = await all(
    `SELECT * FROM customer_notes ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...values, pageSize, offset
  );
  return {
    list,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function markComplaint(data: any) {
  const { roomNumber, content, category, operator } = data;
  const room = await get('SELECT id FROM rooms WHERE room_number = ?', roomNumber);
  if (!room) throw new Error('房号不存在');
  const id = uuidv4();
  await run(
    `INSERT INTO complaints (id, room_number, content, category, operator, status, resolution, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, ?)`,
    id, roomNumber, content, category || null, operator, getNow()
  );
  return { id, roomNumber, status: 'open', createdAt: getNow() };
}

export async function resolveComplaint(id: string, resolution: string) {
  const now = getNow();
  await run(`UPDATE complaints SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?`, resolution, now, id);
  return { id, status: 'resolved', resolvedAt: now };
}

export async function getComplaints(status?: string, roomNumber?: string, page = 1, pageSize = 50) {
  const conditions: string[] = [];
  const values: any[] = [];
  if (status) { conditions.push('status = ?'); values.push(status); }
  if (roomNumber) { conditions.push('room_number LIKE ?'); values.push(`%${roomNumber}%`); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRow = await get<any>(`SELECT COUNT(*) as total FROM complaints ${whereClause}`, ...values);
  const total = countRow?.total || 0;
  const offset = (page - 1) * pageSize;
  const list = await all(
    `SELECT * FROM complaints ${whereClause} ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?`,
    ...values, pageSize, offset
  );
  return {
    list,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function addBlacklist(data: any) {
  const { roomNumber, reason, blockChannels, operator, effectiveFrom, effectiveTo } = data;
  const existing = await get(
    `SELECT * FROM blacklists WHERE room_number = ? AND (effective_to IS NULL OR effective_to > datetime('now'))`,
    roomNumber
  );
  if (existing) throw new Error('该住户已在黑名单中');
  const id = uuidv4();
  await run(`
    INSERT INTO blacklists (id, room_number, reason, block_channels, operator, effective_from, effective_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, id, roomNumber, reason,
    (blockChannels && blockChannels.join) ? blockChannels.join(',') : (blockChannels || 'sms,phone,email,wechat,letter'),
    operator, effectiveFrom || getNow(), effectiveTo || null, getNow());
  return { id, roomNumber, status: 'blacklisted' };
}

export async function removeBlacklist(id: string) {
  const result = await run('DELETE FROM blacklists WHERE id = ?', id);
  return { deleted: result.changes || 0 };
}

export async function getBlacklists(page = 1, pageSize = 50) {
  const countRow = await get<any>(
    `SELECT COUNT(*) as total FROM blacklists WHERE effective_to IS NULL OR effective_to > datetime('now')`
  );
  const total = countRow?.total || 0;
  const offset = (page - 1) * pageSize;
  const list = await all(`
    SELECT b.*, r.owner_name, r.owner_phone, r.building, r.unit
    FROM blacklists b JOIN rooms r ON b.room_number = r.room_number
    WHERE b.effective_to IS NULL OR b.effective_to > datetime('now')
    ORDER BY b.created_at DESC LIMIT ? OFFSET ?
  `, pageSize, offset);
  return {
    list: list.map((r: any) => ({ ...r, block_channels_list: (r.block_channels || '').split(',').filter(Boolean) })),
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getInterceptLogs(page = 1, pageSize = 50) {
  const countRow = await get<any>('SELECT COUNT(*) as total FROM duplicate_intercept_logs');
  const total = countRow?.total || 0;
  const offset = (page - 1) * pageSize;
  const list = await all(`
    SELECT dil.*, r.owner_name, r.building
    FROM duplicate_intercept_logs dil JOIN rooms r ON dil.room_number = r.room_number
    ORDER BY dil.intercepted_at DESC LIMIT ? OFFSET ?
  `, pageSize, offset);
  return {
    list,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  };
}
