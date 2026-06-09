import { exec, getDb } from './connection';

export async function initDatabase() {
  await getDb();
  await exec(`
    CREATE TABLE IF NOT EXISTS buildings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      total_rooms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      room_number TEXT NOT NULL UNIQUE,
      building TEXT NOT NULL,
      unit TEXT,
      floor INTEGER,
      area REAL NOT NULL DEFAULT 0,
      owner_name TEXT,
      owner_phone TEXT,
      owner_email TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fees (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      room_number TEXT NOT NULL,
      period TEXT NOT NULL,
      fee_type TEXT NOT NULL DEFAULT 'property',
      original_amount REAL NOT NULL DEFAULT 0,
      reduction_amount REAL NOT NULL DEFAULT 0,
      payable_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      unpaid_amount REAL NOT NULL DEFAULT 0,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid',
      overdue_days INTEGER NOT NULL DEFAULT 0,
      overdue_level TEXT NOT NULL DEFAULT 'normal',
      stage TEXT NOT NULL DEFAULT 'stage1',
      last_recalc_at TEXT,
      recalc_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      stage TEXT,
      channel TEXT NOT NULL,
      content TEXT NOT NULL,
      variables TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stage TEXT NOT NULL,
      template_id TEXT NOT NULL,
      template_content TEXT,
      channel TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_at TEXT,
      total_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      delivered_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      operator TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS send_queues (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      fee_id TEXT NOT NULL,
      room_number TEXT NOT NULL,
      owner_name TEXT,
      owner_phone TEXT,
      channel TEXT NOT NULL,
      template_content TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT,
      delivered_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      delivered_at TEXT,
      result TEXT,
      call_duration INTEGER,
      promised_pay_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      payment_no TEXT NOT NULL UNIQUE,
      fee_ids TEXT NOT NULL,
      room_number TEXT NOT NULL,
      amount REAL NOT NULL,
      paid_at TEXT NOT NULL,
      method TEXT NOT NULL,
      payer TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reductions (
      id TEXT PRIMARY KEY,
      fee_id TEXT NOT NULL,
      room_number TEXT NOT NULL,
      reduction_amount REAL NOT NULL,
      original_unpaid REAL NOT NULL,
      reason TEXT NOT NULL,
      applicant TEXT NOT NULL,
      applicant_note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approver TEXT,
      approval_note TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_notes (
      id TEXT PRIMARY KEY,
      room_number TEXT NOT NULL,
      content TEXT NOT NULL,
      operator TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      room_number TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      operator TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blacklists (
      id TEXT PRIMARY KEY,
      room_number TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      block_channels TEXT NOT NULL,
      operator TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS duplicate_intercept_logs (
      id TEXT PRIMARY KEY,
      fee_id TEXT NOT NULL,
      room_number TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_sent_at TEXT NOT NULL,
      min_interval_hours INTEGER NOT NULL DEFAULT 24,
      intercepted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_records (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      room_number TEXT NOT NULL,
      result TEXT NOT NULL,
      duration INTEGER,
      note TEXT,
      promised_pay_at TEXT,
      operator TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id TEXT PRIMARY KEY,
      api_path TEXT NOT NULL,
      request_body TEXT,
      response_body TEXT,
      status_code INTEGER,
      operator TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_call_results (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      api_name TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT,
      result TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER
    );
  `);
}
