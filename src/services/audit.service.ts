import { run, get, all } from '../db/connection';
import { paginate } from '../utils/helpers';

export async function getOperationLogs(params: any) {
  const { apiPath, startDate, endDate, operator, page, pageSize } = params;
  const conditions: string[] = [];
  const values: any[] = [];
  if (apiPath) { conditions.push('api_path LIKE ?'); values.push(`%${apiPath}%`); }
  if (startDate) { conditions.push('created_at >= ?'); values.push(startDate); }
  if (endDate) { conditions.push('created_at <= ?'); values.push(endDate); }
  if (operator) { conditions.push('operator LIKE ?'); values.push(`%${operator}%`); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await get<any>(`SELECT COUNT(*) as total FROM operation_logs ${whereClause}`, ...values);
  const total = countRow?.total || 0;
  const offset = (page - 1) * pageSize;
  const list = await all(`
    SELECT id, api_path, status_code, operator, ip, user_agent, created_at,
           SUBSTR(request_body, 1, 500) as request_preview,
           SUBSTR(response_body, 1, 500) as response_preview
    FROM operation_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `, ...values, pageSize, offset);
  return { list, pagination: paginate(total, page, pageSize) };
}

export async function getOperationLogDetail(id: string) {
  const log = await get<any>(`SELECT * FROM operation_logs WHERE id = ?`, id);
  if (!log) return null;
  return { ...log, request: safeParse(log.request_body), response: safeParse(log.response_body) };
}

export async function getCallResults(params: any) {
  const { requestId, apiName, status, startDate, endDate, page, pageSize } = params;
  const conditions: string[] = [];
  const values: any[] = [];
  if (requestId) { conditions.push('request_id LIKE ?'); values.push(`%${requestId}%`); }
  if (apiName) { conditions.push('api_name LIKE ?'); values.push(`%${apiName}%`); }
  if (status) { conditions.push('status = ?'); values.push(status); }
  if (startDate) { conditions.push('started_at >= ?'); values.push(startDate); }
  if (endDate) { conditions.push('started_at <= ?'); values.push(endDate); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await get<any>(`SELECT COUNT(*) as total FROM api_call_results ${whereClause}`, ...values);
  const total = countRow?.total || 0;
  const offset = (page - 1) * pageSize;
  const [list, statusCount, avgDur] = await Promise.all([
    all(`
      SELECT id, request_id, api_name, status,
             SUBSTR(payload, 1, 200) as payload_preview,
             SUBSTR(result, 1, 300) as result_preview,
             SUBSTR(error_message, 1, 200) as error_preview,
             started_at, finished_at, duration_ms
      FROM api_call_results ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?
    `, ...values, pageSize, offset),
    all(`SELECT status, COUNT(*) as count FROM api_call_results ${whereClause} GROUP BY status`, ...values),
    get<any>(`SELECT COALESCE(AVG(duration_ms), 0) as avg_ms FROM api_call_results ${whereClause}`, ...values),
  ]);
  return {
    list, pagination: paginate(total, page, pageSize),
    summary: { byStatus: statusCount, avgDurationMs: (avgDur as any)?.avg_ms || 0 },
  };
}

export async function getCallResultDetail(requestId: string) {
  return get(`SELECT * FROM api_call_results WHERE request_id = ?`, requestId);
}

function safeParse(json: string | null | undefined): any {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return json; }
}
