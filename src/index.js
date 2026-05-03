require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');

const { initDB } = require('./database');
const authRoutes = require('./routes/auth');
const walletsRoutes = require('./routes/wallets');
const transactionsRoutes = require('./routes/transactions');
const statsRoutes = require('./routes/stats');
const androidRoutes = require('./routes/android');
const customersRoutes = require('./routes/customers');
const reportsRoutes = require('./routes/reports');
const { authenticateToken } = require('./middleware/auth');
const { setupWebSocket } = require('./utils/websocket');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Init DB
initDB();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'تم تجاوز الحد المسموح به من الطلبات' }
});
app.use('/api/', limiter);

// Setup WebSocket
setupWebSocket(wss);
app.set('wss', wss);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/wallets', authenticateToken, walletsRoutes);
app.use('/api/transactions', authenticateToken, transactionsRoutes);
app.use('/api/stats', authenticateToken, statsRoutes);
app.use('/api/android', authenticateToken, androidRoutes);
app.use('/api/customers', authenticateToken, customersRoutes);
app.use('/api/reports', authenticateToken, reportsRoutes);

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'حدث خطأ في الخادم', details: err.message });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ الخادم يعمل على المنفذ ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
});

module.exports = { app, wss };
