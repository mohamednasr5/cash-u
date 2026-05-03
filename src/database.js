const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/ewallet.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDB() {
  const db = getDB();

  db.exec(`
    -- جدول المستخدمين (موظفين المحل)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT DEFAULT 'cashier' CHECK(role IN ('admin', 'cashier', 'viewer')),
      phone TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    );

    -- جدول المحافظ الإلكترونية
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('vodafone', 'orange', 'etisalat', 'we')),
      phone_number TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      national_id TEXT,
      balance REAL DEFAULT 0,
      daily_limit REAL DEFAULT 60000,
      monthly_limit REAL DEFAULT 200000,
      daily_used REAL DEFAULT 0,
      monthly_used REAL DEFAULT 0,
      daily_reset_date TEXT,
      monthly_reset_date TEXT,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      pin_hint TEXT,
      android_device_id TEXT,
      color TEXT DEFAULT '#4CAF50',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- جدول العملاء
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      national_id TEXT,
      notes TEXT,
      total_transactions INTEGER DEFAULT 0,
      total_amount REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_transaction DATETIME
    );

    -- جدول المعاملات
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      customer_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('send', 'receive', 'withdraw', 'deposit', 'fee', 'balance_check')),
      amount REAL NOT NULL,
      fee REAL DEFAULT 0,
      net_amount REAL NOT NULL,
      customer_phone TEXT,
      customer_name TEXT,
      reference TEXT,
      notes TEXT,
      status TEXT DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'failed', 'cancelled')),
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (wallet_id) REFERENCES wallets(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    -- جدول رسائل SMS المستقبلة من الهاتف
    CREATE TABLE IF NOT EXISTS sms_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      sender TEXT,
      message TEXT NOT NULL,
      wallet_id INTEGER,
      parsed_amount REAL,
      parsed_type TEXT,
      parsed_reference TEXT,
      is_processed INTEGER DEFAULT 0,
      received_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (wallet_id) REFERENCES wallets(id)
    );

    -- جدول الأجهزة المتصلة (Android)
    CREATE TABLE IF NOT EXISTS android_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      device_name TEXT,
      model TEXT,
      android_version TEXT,
      wallet_id INTEGER,
      is_connected INTEGER DEFAULT 0,
      last_seen DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (wallet_id) REFERENCES wallets(id)
    );

    -- جدول إعدادات النظام
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- جدول سجل الأحداث
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- جدول أهداف يومية/شهرية
    CREATE TABLE IF NOT EXISTS targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('daily', 'monthly')),
      target_amount REAL NOT NULL,
      month TEXT,
      year TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_sms_device ON sms_messages(device_id);
    CREATE INDEX IF NOT EXISTS idx_sms_processed ON sms_messages(is_processed);
  `);

  // Insert default admin if not exists
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO users (username, password, full_name, role)
      VALUES (?, ?, ?, ?)
    `).run('admin', hashedPassword, 'مدير النظام', 'admin');
    console.log('✅ تم إنشاء حساب المدير الافتراضي: admin / admin123');
  }

  // Default settings
  const defaultSettings = [
    ['shop_name', 'محل تحويل الأموال'],
    ['shop_phone', ''],
    ['currency', 'جنيه مصري'],
    ['default_fee_send', '0.5'],
    ['default_fee_receive', '0'],
    ['default_fee_withdraw', '1'],
    ['auto_sms_parse', '1'],
    ['low_balance_alert', '1000'],
  ];

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of defaultSettings) {
    insertSetting.run(key, value);
  }

  console.log('✅ قاعدة البيانات جاهزة');
  return db;
}

module.exports = { getDB, initDB };
