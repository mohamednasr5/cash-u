const jwt = require('jsonwebtoken');
const { getDB } = require('../database');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'لم يتم تقديم رمز المصادقة' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key_change_me');
    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'المستخدم غير موجود أو محظور' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'رمز المصادقة غير صالح أو منتهي الصلاحية' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'هذا الإجراء يتطلب صلاحيات المدير' });
  }
  next();
}

module.exports = { authenticateToken, requireAdmin };
