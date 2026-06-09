// @ts-ignore
const initSqlJs = require('sql.js');
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'property-fee.db');

type Database = any;
let db: Database | null = null;
let SqlJsStatic: any = null;

export async function getDb(): Promise<Database> {
  if (db) return db;

  if (!SqlJsStatic) {
    SqlJsStatic = await initSqlJs();
  }

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SqlJsStatic.Database(buf);
  } else {
    db = new SqlJsStatic.Database();
  }

  const saveInterval = 5000;
  setInterval(saveDatabase, saveInterval);

  process.on('beforeExit', saveDatabase);
  process.on('SIGINT', () => { saveDatabase(); process.exit(); });

  return db;
}

export function saveDatabase() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const tmpPath = DB_PATH + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    fs.renameSync(tmpPath, DB_PATH);
  } catch (e) {
    console.error('[DB] 保存失败:', e);
  }
}

export function run(sql: string, ...params: any[]): Promise<{ lastID: any; changes: number }> {
  return new Promise(async (resolve, reject) => {
    try {
      const database = await getDb();
      const stmt = database.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.free();
      const idRes = database.exec('SELECT last_insert_rowid() as id');
      const chRes = database.exec('SELECT changes() as c');
      resolve({
        lastID: idRes?.[0]?.values?.[0]?.[0] ?? 0,
        changes: chRes?.[0]?.values?.[0]?.[0] ?? 0,
      });
    } catch (e) {
      reject(e);
    }
  });
}

export function get<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
  return new Promise(async (resolve, reject) => {
    try {
      const database = await getDb();
      const stmt = database.prepare(sql);
      stmt.bind(params);
      let row: any = undefined;
      if (stmt.step()) {
        row = stmt.getAsObject() as T;
      }
      stmt.free();
      resolve(row as T | undefined);
    } catch (e) {
      reject(e);
    }
  });
}

export function all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
  return new Promise(async (resolve, reject) => {
    try {
      const database = await getDb();
      const stmt = database.prepare(sql);
      stmt.bind(params);
      const rows: any[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      resolve(rows as T[]);
    } catch (e) {
      reject(e);
    }
  });
}

export function exec(sql: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const database = await getDb();
      database.run(sql);
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

export { saveDatabase as forceSave };
