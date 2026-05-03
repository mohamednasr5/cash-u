const express = require('express');
const router = express.Router();
const { getDB } = require('../database');

// Customers
router.get('/', (req, res) => {
  const db = getDB();
  const { search, limit = 50, offset = 0 } = req.query;
  
  let query = 'SELECT * FROM customers WHERE 1=1';
  const params = [];
  
  if (search) {
    query += ' AND (name LIKE ? OR phone LIKE ? OR national_id LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  
  query += ' ORDER BY last_transaction DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  const customers = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as count FROM customers').get();
  
  res.json({ customers, total: total.count });
});

router.post('/', (req, res) => {
  const { name, phone, national_id, notes } = req.body;
  const db = getDB();
  
  if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });
  
  const result = db.prepare(`
    INSERT INTO customers (name, phone, national_id, notes)
    VALUES (?, ?, ?, ?)
  `).run(name, phone, national_id, notes);
  
  res.json({ id: result.lastInsertRowid, message: 'تم إضافة العميل' });
});

router.put('/:id', (req, res) => {
  const { name, phone, national_id, notes } = req.body;
  const db = getDB();
  db.prepare('UPDATE customers SET name=?, phone=?, national_id=?, notes=? WHERE id=?').run(name, phone, national_id, notes, req.params.id);
  res.json({ message: 'تم التحديث' });
});

router.get('/:id/transactions', (req, res) => {
  const db = getDB();
  const transactions = db.prepare(`
    SELECT t.*, w.name as wallet_name, w.provider
    FROM transactions t
    JOIN wallets w ON t.wallet_id = w.id
    WHERE t.customer_id = ? OR t.customer_phone = (SELECT phone FROM customers WHERE id = ?)
    ORDER BY t.created_at DESC LIMIT 50
  `).all(req.params.id, req.params.id);
  res.json(transactions);
});

module.exports = router;
