const express = require('express');
const router = express.Router();
const { getDB } = require('../database');

// Dashboard overview
router.get('/overview', (req, res) => {
  const db = getDB();

  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance), 0) as total FROM wallets WHERE is_active = 1').get();
  const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE is_active = 1').get();

  const todayStats = db.prepare(`
    SELECT 
      COUNT(*) as count,
      COALESCE(SUM(CASE WHEN type IN ('receive','deposit') THEN amount ELSE 0 END), 0) as in_amount,
      COALESCE(SUM(CASE WHEN type IN ('send','withdraw') THEN amount ELSE 0 END), 0) as out_amount,
      COALESCE(SUM(fee), 0) as total_fees
    FROM transactions
    WHERE DATE(created_at) = DATE('now') AND status = 'completed'
  `).get();

  const monthStats = db.prepare(`
    SELECT 
      COUNT(*) as count,
      COALESCE(SUM(CASE WHEN type IN ('receive','deposit') THEN amount ELSE 0 END), 0) as in_amount,
      COALESCE(SUM(CASE WHEN type IN ('send','withdraw') THEN amount ELSE 0 END), 0) as out_amount,
      COALESCE(SUM(fee), 0) as total_fees
    FROM transactions
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND status = 'completed'
  `).get();

  const walletsSummary = db.prepare(`
    SELECT w.id, w.name, w.provider, w.phone_number, w.balance, w.daily_limit, w.monthly_limit, w.color,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE wallet_id = w.id AND DATE(created_at) = DATE('now') AND type IN ('send','withdraw') AND status='completed') as today_out,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE wallet_id = w.id AND DATE(created_at) = DATE('now') AND type IN ('receive','deposit') AND status='completed') as today_in,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE wallet_id = w.id AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND type IN ('send','withdraw') AND status='completed') as month_out
    FROM wallets w WHERE w.is_active = 1
    ORDER BY w.balance DESC
  `).all();

  const lowBalanceWallets = walletsSummary.filter(w => w.balance < 1000);
  const nearLimitWallets = walletsSummary.filter(w => w.daily_limit > 0 && (w.today_out / w.daily_limit) > 0.8);

  const recentTransactions = db.prepare(`
    SELECT t.*, w.name as wallet_name, w.provider, w.color
    FROM transactions t
    JOIN wallets w ON t.wallet_id = w.id
    ORDER BY t.created_at DESC LIMIT 10
  `).all();

  const deviceCount = db.prepare('SELECT COUNT(*) as count FROM android_devices WHERE is_connected = 1').get();

  res.json({
    total_balance: totalBalance.total,
    wallet_count: walletCount.count,
    today: todayStats,
    month: monthStats,
    wallets_summary: walletsSummary,
    low_balance_wallets: lowBalanceWallets,
    near_limit_wallets: nearLimitWallets,
    recent_transactions: recentTransactions,
    connected_devices: deviceCount.count
  });
});

// Chart data - daily for last 30 days
router.get('/chart/daily', (req, res) => {
  const db = getDB();
  const days = parseInt(req.query.days) || 30;

  const data = db.prepare(`
    SELECT 
      DATE(created_at) as date,
      COALESCE(SUM(CASE WHEN type IN ('receive','deposit') THEN amount ELSE 0 END), 0) as in_amount,
      COALESCE(SUM(CASE WHEN type IN ('send','withdraw') THEN amount ELSE 0 END), 0) as out_amount,
      COALESCE(SUM(fee), 0) as fees,
      COUNT(*) as count
    FROM transactions
    WHERE created_at >= DATE('now', '-${days} days') AND status = 'completed'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all();

  res.json(data);
});

// Chart data - by provider
router.get('/chart/providers', (req, res) => {
  const db = getDB();

  const data = db.prepare(`
    SELECT 
      w.provider,
      COUNT(t.id) as transaction_count,
      COALESCE(SUM(t.amount), 0) as total_amount,
      COALESCE(SUM(t.fee), 0) as total_fees,
      COALESCE(SUM(w.balance), 0) as total_balance
    FROM wallets w
    LEFT JOIN transactions t ON t.wallet_id = w.id AND t.status = 'completed'
      AND strftime('%Y-%m', t.created_at) = strftime('%Y-%m', 'now')
    WHERE w.is_active = 1
    GROUP BY w.provider
  `).all();

  res.json(data);
});

// Hourly distribution today
router.get('/chart/hourly', (req, res) => {
  const db = getDB();

  const data = db.prepare(`
    SELECT 
      strftime('%H', created_at) as hour,
      COUNT(*) as count,
      COALESCE(SUM(amount), 0) as amount
    FROM transactions
    WHERE DATE(created_at) = DATE('now') AND status = 'completed'
    GROUP BY strftime('%H', created_at)
    ORDER BY hour
  `).all();

  res.json(data);
});

// Top customers
router.get('/top-customers', (req, res) => {
  const db = getDB();
  const customers = db.prepare(`
    SELECT customer_name, customer_phone,
      COUNT(*) as transaction_count,
      SUM(amount) as total_amount,
      MAX(created_at) as last_transaction
    FROM transactions
    WHERE customer_name IS NOT NULL AND status = 'completed'
      AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    GROUP BY customer_phone
    ORDER BY total_amount DESC
    LIMIT 10
  `).all();
  res.json(customers);
});

// Settings
router.get('/settings', (req, res) => {
  const db = getDB();
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  settings.forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

router.put('/settings', (req, res) => {
  const db = getDB();
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
  const updateMany = db.transaction((settings) => {
    for (const [key, value] of Object.entries(settings)) {
      update.run(key, String(value));
    }
  });
  updateMany(req.body);
  res.json({ message: 'تم حفظ الإعدادات' });
});

// Activity log
router.get('/activity', (req, res) => {
  const db = getDB();
  const logs = db.prepare(`
    SELECT l.*, u.full_name, u.username
    FROM activity_log l
    LEFT JOIN users u ON l.user_id = u.id
    ORDER BY l.created_at DESC LIMIT 100
  `).all();
  res.json(logs);
});

module.exports = router;
