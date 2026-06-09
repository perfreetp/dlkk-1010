import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function convertKeys(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(convertKeys);
  if (typeof obj !== 'object') return obj;
  const out: any = {};
  for (const k of Object.keys(obj)) {
    let v = obj[k];
    if (typeof v === 'string' && v.includes(',')) v = v.split(',');
    out[snakeToCamel(k)] = convertKeys(v);
  }
  return out;
}

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(convertKeys(req.body));
    if (!result.success) {
      return res.status(400).json({
        code: 400,
        message: '请求参数错误',
        errors: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(convertKeys(req.query));
    if (!result.success) {
      return res.status(400).json({
        code: 400,
        message: '查询参数错误',
        errors: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    (req as any).validatedQuery = result.data;
    next();
  };
}
