import { Request, Response, NextFunction } from 'express';

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function convertKeys(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(convertKeys);
  if (typeof obj !== 'object') return obj;
  const out: any = {};
  for (const k of Object.keys(obj)) {
    out[snakeToCamel(k)] = convertKeys(obj[k]);
  }
  return out;
}

export function normalizeBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = convertKeys(req.body);
  }
  next();
}

export function normalizeQuery(req: Request, _res: Response, next: NextFunction) {
  if (req.query && typeof req.query === 'object') {
    (req as any).normalizedQuery = convertKeys(req.query);
  }
  next();
}
