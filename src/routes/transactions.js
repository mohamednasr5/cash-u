const express = require('express');
const router = express.Router();
const { getDB } = require('../database');

// Calculate fee based on provider and type
function calculateFee(provider, type, amount) {
  const fees = {
    vodafone: {
      send: Math.max(1, amount * 0.005),   // 0.5% min 1 EGP
      receive: 0,
      withdraw: Math.max(3, amount * 0.01), // 1% min 3 EGP
      deposit: 0
    },
    orange: {
      send: Math.max(1, Math.min(15, amount * 0.005)),
      receive: 0,
      withdraw: Math.max(3, amount * 0.01),
      deposit: 0
    },
    etisalat: {
      send: Math.max(0.5, Math.min(20, amount * 0.001)),
      receive: 0,
      withdraw: Math.max(5, amount * 0.01),
      deposit: 0
    },
    we: {
      send: Math.max(0.5, Math.min(20, amount * 0.001)),
      receive: 0,
      withdraw: Math.max(3, amount * 0.01),
      deposit: 0
    }
  };
  return fees[provider]?.[type] || 0;
}

// Get all transactions
router.get('/', (req, res) => {
  const db = getDB();
  const { limit = 50, offset = 0, wallet_id, type, date_from, date_to, search } = req.query;

  let query = `
    SELECT t.*, w.name as wallet_name, w.provider, w.phone_number as wallet_phone,
           u.full_name as cashier_name
    FROM transactions t
    LEFT JOIN wallets w ON t.wallet_id = w.id
    LEFT JOIN users u ON t.created_by = u.id
    WHERE 1=1
  `;
  const params = [];

  if (wallet_id) { query += ' AND t.wallet_id = ?'; params.push(wallet_id); }
  if (type) { query += ' AND t.type = ?'; params.push(type); }
  if (date_from) { query += ' AND DATE(t.created_at) >= ?'; params.push(date_from); }
  if (date_to) { query += ' AND DATE(t.created_at) <= ?'; params.push(date_to); }
  if (search) {
    query += ' AND (t.customer_name LIKE ? OR t.customer_phone LIKE ? OR t.reference LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const countQuery = query.replace('SELECT t.*, w.name as wallet_name, w.provider, w.phone_number as wallet_phone, u.full_name as cashier_name', 'SELECT COUNT(*) as count');
  const total = db.prepare(countQuery).get(...params);

  query += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const transactions = db.prepare(query).all(...params);
  res.json({ transactions, total: total.count });
});

// Create transaction (the main operation)
router.post('/', (req, res) => {
  const {
    wallet_id, type, amount, customer_phone, customer_name,
    customer_id, reference, notes, custom_fee
  } = req.body;

  if (!wallet_id || !type || !amount) {
    return res.status(400).json({ error: 'بيانات العملية غير مكتملة' });
  }

  if (amount <= 0) {
    return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });
  }

  const db = getDB();
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ? AND is_active = 1').get(wallet_id);
  
  if (!wallet) {
    return res.status(404).json({ error: 'المحفظة غير موجودة' });
  }

  // Calculate fee
  const fee = custom_fee !== undefined ? parseFloat(custom_fee) : calculateFee(wallet.provider, type, amount);
  
  // Net amount (what actually moves)
  let net_amount = parseFloat(amount);
  let new_balance = wallet.balance;

  // Update balance based on transaction type
  if (type === 'send' || type === 'withdraw') {
    const totalDeduct = net_amount + fee;
    if (wallet.balance < totalDeduct) {
      return res.status(400).json({ error: `رصيد المحفظة غير كافٍ. الرصيد الحالي: ${wallet.balance.toFixed(2)} جنيه` });
    }
    new_balance = wallet.balance - totalDeduct;
    net_amount = -net_amount; // negative for outgoing
  } else if (type === 'receive' || type === 'deposit') {
    new_balance = wallet.balance + net_amount - fee;
  }

  // Check daily limit for outgoing
  if (type === 'send' || type === 'withdraw') {
    const todayUsed = db.prepare(`
      SELECT COALESCE(SUM(ABS(net_amount)), 0) as used 
      FROM transactions 
      WHERE wallet_id = ? AND DATE(created_at) = DATE('now') AND type IN ('send','withdraw')
    `).get(wallet_id).used;

    if (todayUsed + parseFloat(amount) > wallet.daily_limit) {
      return res.status(400).json({ 
        error: `تم تجاوز الحد اليومي. المستخدم: ${todayUsed.toFixed(0)} جنيه من ${wallet.daily_limit.toFixed(0)} جنيه` 
      });
    }
  }

  const doTransaction = db.transaction(() => {
    // Insert transaction
    const result = db.prepare(`
      INSERT INTO transactions (wallet_id, customer_id, type, amount, fee, net_amount, 
        customer_phone, customer_name, reference, notes, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
    `).run(
      wallet_id, customer_id || null, type, parseFloat(amount), fee, net_amount,
      customer_phone || null, customer_name || null, reference || null, notes || null,
      req.user.id
    );

    // Update wallet balance
    db.prepare('UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(new_balance, wallet_id);

    // Update customer stats
    if (customer_id) {
      db.prepare(`
        UPDATE customers SET 
          total_transactions = total_transactions + 1,
          total_amount = total_amount + ?,
          last_transaction = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(Math.abs(parseFloat(amount)), customer_id);
    }

    // Log
    db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
      req.user.id, 'transaction',
      `${type}: ${amount} جنيه - ${wallet.name} - ${customer_name || 'بدون اسم'}`
    );

    return result.lastInsertRowid;
  });

  const transactionId = doTransaction();

  // Notify via WebSocket
  const wss = req.app.get('wss');
  if (wss) {
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'new_transaction',
          data: { wallet_id, type, amount, new_balance }
        }));
      }
    });
  }

  res.json({
    id: transactionId,
    message: 'تمت العملية بنجاح',
    new_balance: parseFloat(new_balance.toFixed(2)),
    fee: parseFloat(fee.toFixed(2))
  });
});

// Cancel / reverse transaction
router.post('/:id/cancel', (req, res) => {
  const db = getDB();
  const transaction = db.prepare(`
    SELECT t.*, w.balance as wallet_balance, w.provider
    FROM transactions t
    JOIN wallets w ON t.wallet_id = w.id
    WHERE t.id = ?
  `).get(req.params.id);

  if (!transaction) return res.status(404).json({ error: 'العملية غير موجودة' });
  if (transaction.status === 'cancelled') return res.status(400).json({ error: 'العملية ملغاة بالفعل' });

  const doCancel = db.transaction(() => {
    // Reverse balance
    let reversedBalance = transaction.wallet_balance;
    if (transaction.type === 'send' || transaction.type === 'withdraw') {
      reversedBalance += Math.abs(transaction.net_amount) + transaction.fee;
    } else if (transaction.type === 'receive' || transaction.type === 'deposit') {
      reversedBalance -= (transaction.net_amount - transaction.fee);
    }

    db.prepare('UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(reversedBalance, transaction.wallet_id);
    db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('cancelled', req.params.id);
    db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
      req.user.id, 'cancel_transaction', `إلغاء عملية #${req.params.id}`
    );
  });

  doCancel();
  res.json({ message: 'تم إلغاء العملية وإعادة الرصيد' });
});

// Get transaction by ID
router.get('/:id', (req, res) => {
  const db = getDB();
  const transaction = db.prepare(`
    SELECT t.*, w.name as wallet_name, w.provider, u.full_name as cashier_name
    FROM transactions t
    LEFT JOIN wallets w ON t.wallet_id = w.id
    LEFT JOIN users u ON t.created_by = u.id
    WHERE t.id = ?
  `).get(req.params.id);
  
  if (!transaction) return res.status(404).json({ error: 'العملية غير موجودة' });
  res.json(transaction);
});

module.exports = router;
