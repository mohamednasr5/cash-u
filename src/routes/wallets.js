const express = require('express');
const router = express.Router();
const { getDB } = require('../database');
const { requireAdmin } = require('../middleware/auth');
const dayjs = require('dayjs');

// Get all wallets
router.get('/', (req, res) => {
  const db = getDB();
  const today = dayjs().format('YYYY-MM-DD');
  const thisMonth = dayjs().format('YYYY-MM');

  // Reset daily/monthly used if needed
  const wallets = db.prepare(`
    SELECT w.*,
      (SELECT COALESCE(SUM(ABS(net_amount)), 0) FROM transactions 
       WHERE wallet_id = w.id AND DATE(created_at) = DATE('now') AND type IN ('send','withdraw')) as today_out,
      (SELECT COALESCE(SUM(net_amount), 0) FROM transactions 
       WHERE wallet_id = w.id AND DATE(created_at) = DATE('now') AND type IN ('receive','deposit')) as today_in,
      (SELECT COALESCE(SUM(ABS(net_amount)), 0) FROM transactions 
       WHERE wallet_id = w.id AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND type IN ('send','withdraw')) as month_out,
      (SELECT COUNT(*) FROM transactions WHERE wallet_id = w.id AND DATE(created_at) = DATE('now')) as today_count
    FROM wallets w
    WHERE w.is_active = 1
    ORDER BY w.sort_order, w.provider, w.name
  `).all();

  res.json(wallets);
});

// Get single wallet
router.get('/:id', (req, res) => {
  const db = getDB();
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'المحفظة غير موجودة' });
  res.json(wallet);
});

// Create wallet
router.post('/', requireAdmin, (req, res) => {
  const { name, provider, phone_number, owner_name, national_id, balance, daily_limit, monthly_limit, notes, pin_hint, color, android_device_id } = req.body;
  const db = getDB();

  if (!name || !provider || !phone_number || !owner_name) {
    return res.status(400).json({ error: 'البيانات الأساسية مطلوبة' });
  }

  const providerLimits = {
    vodafone: { daily: 60000, monthly: 200000 },
    orange: { daily: 70000, monthly: 400000 },
    etisalat: { daily: 120000, monthly: 400000 },
    we: { daily: 50000, monthly: 200000 }
  };

  const limits = providerLimits[provider] || { daily: 60000, monthly: 200000 };

  const result = db.prepare(`
    INSERT INTO wallets (name, provider, phone_number, owner_name, national_id, balance, 
      daily_limit, monthly_limit, notes, pin_hint, color, android_device_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 
      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM wallets))
  `).run(
    name, provider, phone_number, owner_name, national_id || null,
    balance || 0,
    daily_limit || limits.daily,
    monthly_limit || limits.monthly,
    notes || null, pin_hint || null,
    color || '#4CAF50',
    android_device_id || null
  );

  // Log
  db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
    req.user.id, 'wallet_create', `إنشاء محفظة: ${name} - ${phone_number}`
  );

  res.json({ id: result.lastInsertRowid, message: 'تم إضافة المحفظة بنجاح' });
});

// Update wallet
router.put('/:id', requireAdmin, (req, res) => {
  const { name, owner_name, national_id, balance, daily_limit, monthly_limit, notes, pin_hint, color, android_device_id, is_active } = req.body;
  const db = getDB();

  db.prepare(`
    UPDATE wallets SET 
      name = COALESCE(?, name),
      owner_name = COALESCE(?, owner_name),
      national_id = COALESCE(?, national_id),
      balance = COALESCE(?, balance),
      daily_limit = COALESCE(?, daily_limit),
      monthly_limit = COALESCE(?, monthly_limit),
      notes = COALESCE(?, notes),
      pin_hint = COALESCE(?, pin_hint),
      color = COALESCE(?, color),
      android_device_id = COALESCE(?, android_device_id),
      is_active = COALESCE(?, is_active),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, owner_name, national_id, balance, daily_limit, monthly_limit, notes, pin_hint, color, android_device_id, is_active, req.params.id);

  res.json({ message: 'تم تحديث المحفظة بنجاح' });
});

// Update wallet balance (manual)
router.patch('/:id/balance', (req, res) => {
  const { balance } = req.body;
  const db = getDB();

  if (balance === undefined || balance < 0) {
    return res.status(400).json({ error: 'رصيد غير صحيح' });
  }

  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'المحفظة غير موجودة' });

  db.prepare('UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(balance, req.params.id);

  // Log balance change
  db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
    req.user.id, 'balance_update', 
    `تحديث رصيد ${wallet.name}: ${wallet.balance} → ${balance}`
  );

  res.json({ message: 'تم تحديث الرصيد', balance });
});

// Delete wallet (soft delete)
router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE wallets SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'تم تعطيل المحفظة' });
});

// Get wallet transactions
router.get('/:id/transactions', (req, res) => {
  const db = getDB();
  const { limit = 50, offset = 0, type, date_from, date_to } = req.query;

  let query = `
    SELECT t.*, u.full_name as cashier_name
    FROM transactions t
    LEFT JOIN users u ON t.created_by = u.id
    WHERE t.wallet_id = ?
  `;
  const params = [req.params.id];

  if (type) { query += ' AND t.type = ?'; params.push(type); }
  if (date_from) { query += ' AND DATE(t.created_at) >= ?'; params.push(date_from); }
  if (date_to) { query += ' AND DATE(t.created_at) <= ?'; params.push(date_to); }

  query += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const transactions = db.prepare(query).all(...params);
  const total = db.prepare(`SELECT COUNT(*) as count FROM transactions WHERE wallet_id = ?`).get(req.params.id);

  res.json({ transactions, total: total.count });
});

// Reorder wallets
router.post('/reorder', requireAdmin, (req, res) => {
  const { orders } = req.body; // [{id, sort_order}]
  const db = getDB();
  const update = db.prepare('UPDATE wallets SET sort_order = ? WHERE id = ?');
  const updateMany = db.transaction((orders) => {
    for (const { id, sort_order } of orders) {
      update.run(sort_order, id);
    }
  });
  updateMany(orders);
  res.json({ message: 'تم إعادة الترتيب' });
});

module.exports = router;
