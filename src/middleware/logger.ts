import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { run } from '../db/connection';
import { getNow } from '../utils/helpers';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

export function operationLogger(req: Request, res: Response, next: NextFunction) {
  req.requestId = uuidv4();
  req.startTime = Date.now();

  const originalSend = res.send.bind(res);
  res.send = (body: any) => {
    const duration = Date.now() - req.startTime;
    let responseBody = body;
    if (typeof body === 'string') {
      try {
        responseBody = JSON.parse(body);
      } catch {}
    }
    const reqBodyStr = JSON.stringify(req.body).slice(0, 2000);
    const resBodyStr = JSON.stringify(responseBody).slice(0, 4000);
    const operator = (req.headers['x-operator'] as string) || null;
    const ip = req.ip || null;
    const ua = req.headers['user-agent'] as string || null;
    const errorMsg = res.statusCode >= 400
      ? (typeof responseBody === 'object' && responseBody?.message) || null
      : null;
    const status = res.statusCode >= 400 ? 'failed' : 'success';
    const now = getNow();

    run(
      `INSERT INTO operation_logs (id, api_path, request_body, response_body, status_code, operator, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), req.path, reqBodyStr, resBodyStr, res.statusCode, operator, ip, ua, now
    ).catch(console.error);

    run(
      `INSERT INTO api_call_results (id, request_id, api_name, status, payload, result, error_message, started_at, finished_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), req.requestId, req.path, status, reqBodyStr, resBodyStr, errorMsg, now, now, duration
    ).catch(console.error);

    return originalSend(body);
  };

  next();
}

export function getRequestId(req: Request): string {
  return req.requestId;
}
