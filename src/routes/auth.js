const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// Login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  }

  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET || 'secret_key_change_me',
    { expiresIn: '24h' }
  );

  // Log activity
  db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
    user.id, 'login', `تسجيل دخول من ${req.ip}`
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      phone: user.phone
    }
  });
});

// Get current user
router.get('/me', authenticateToken, (req, res) => {
  const { password, ...user } = req.user;
  res.json(user);
});

// Change password
router.post('/change-password', authenticateToken, (req, res) => {
  const { old_password, new_password } = req.body;
  const db = getDB();
  
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  
  if (!bcrypt.compareSync(old_password, user.password)) {
    return res.status(400).json({ error: 'كلمة المرور القديمة غير صحيحة' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
  }

  const hashedPassword = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, req.user.id);
  
  res.json({ message: 'تم تغيير كلمة المرور بنجاح' });
});

// Get all users (admin only)
router.get('/users', authenticateToken, requireAdmin, (req, res) => {
  const db = getDB();
  const users = db.prepare('SELECT id, username, full_name, role, phone, is_active, created_at, last_login FROM users ORDER BY id').all();
  res.json(users);
});

// Create user (admin only)
router.post('/users', authenticateToken, requireAdmin, (req, res) => {
  const { username, password, full_name, role, phone } = req.body;
  const db = getDB();

  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'البيانات المطلوبة غير مكتملة' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    return res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (username, password, full_name, role, phone)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, hashedPassword, full_name, role || 'cashier', phone);

  res.json({ id: result.lastInsertRowid, message: 'تم إنشاء الحساب بنجاح' });
});

// Update user
router.put('/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { full_name, role, phone, is_active } = req.body;
  const db = getDB();

  db.prepare(`
    UPDATE users SET full_name = ?, role = ?, phone = ?, is_active = ?
    WHERE id = ?
  `).run(full_name, role, phone, is_active, req.params.id);

  res.json({ message: 'تم تحديث الحساب بنجاح' });
});

module.exports = router;
