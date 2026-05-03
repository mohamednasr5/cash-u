const express = require('express');
const router = express.Router();
const { getDB } = require('../database');
const ExcelJS = require('exceljs');

// Export transactions to Excel
router.get('/export/transactions', async (req, res) => {
  const db = getDB();
  const { date_from, date_to, wallet_id } = req.query;

  let query = `
    SELECT t.*, w.name as wallet_name, w.provider, u.full_name as cashier_name
    FROM transactions t
    LEFT JOIN wallets w ON t.wallet_id = w.id
    LEFT JOIN users u ON t.created_by = u.id
    WHERE t.status = 'completed'
  `;
  const params = [];

  if (date_from) { query += ' AND DATE(t.created_at) >= ?'; params.push(date_from); }
  if (date_to) { query += ' AND DATE(t.created_at) <= ?'; params.push(date_to); }
  if (wallet_id) { query += ' AND t.wallet_id = ?'; params.push(wallet_id); }
  
  query += ' ORDER BY t.created_at DESC';
  const transactions = db.prepare(query).all(...params);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'EWallet Manager';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('المعاملات', { views: [{ rightToLeft: true }] });
  
  sheet.columns = [
    { header: '#', key: 'id', width: 8 },
    { header: 'التاريخ', key: 'date', width: 20 },
    { header: 'المحفظة', key: 'wallet', width: 20 },
    { header: 'المزود', key: 'provider', width: 15 },
    { header: 'النوع', key: 'type', width: 12 },
    { header: 'المبلغ', key: 'amount', width: 15 },
    { header: 'الرسوم', key: 'fee', width: 12 },
    { header: 'العميل', key: 'customer', width: 20 },
    { header: 'رقم العميل', key: 'phone', width: 18 },
    { header: 'المرجع', key: 'reference', width: 18 },
    { header: 'الموظف', key: 'cashier', width: 15 },
    { header: 'ملاحظات', key: 'notes', width: 25 },
  ];

  // Style header
  sheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a73e8' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin' } };
  });

  const typeMap = { send: 'إرسال', receive: 'استلام', withdraw: 'سحب', deposit: 'إيداع', fee: 'رسوم', balance_check: 'استعلام رصيد' };
  const providerMap = { vodafone: 'فودافون كاش', orange: 'أورانج كاش', etisalat: 'اتصالات كاش', we: 'وي باي' };

  for (const t of transactions) {
    const row = sheet.addRow({
      id: t.id,
      date: new Date(t.created_at).toLocaleString('ar-EG'),
      wallet: t.wallet_name,
      provider: providerMap[t.provider] || t.provider,
      type: typeMap[t.type] || t.type,
      amount: t.amount,
      fee: t.fee,
      customer: t.customer_name || '',
      phone: t.customer_phone || '',
      reference: t.reference || '',
      cashier: t.cashier_name || '',
      notes: t.notes || '',
    });

    // Color by type
    const colors = { send: 'FFFFE0E0', receive: 'FFE0F0E0', withdraw: 'FFFFF0E0', deposit: 'FFE0F0FF' };
    if (colors[t.type]) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors[t.type] } };
      });
    }
  }

  // Summary row
  const totalAmount = transactions.reduce((s, t) => s + t.amount, 0);
  const totalFees = transactions.reduce((s, t) => s + t.fee, 0);
  sheet.addRow([]);
  const summaryRow = sheet.addRow(['', '', '', '', 'الإجمالي', totalAmount, totalFees]);
  summaryRow.getCell(5).font = { bold: true };
  summaryRow.getCell(6).font = { bold: true };
  summaryRow.getCell(7).font = { bold: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=transactions_${Date.now()}.xlsx`);
  
  await workbook.xlsx.write(res);
  res.end();
});

// Daily summary report
router.get('/daily-summary', (req, res) => {
  const db = getDB();
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  const summary = db.prepare(`
    SELECT 
      w.name as wallet_name, w.provider, w.phone_number, w.color,
      COUNT(t.id) as transaction_count,
      COALESCE(SUM(CASE WHEN t.type IN ('receive','deposit') THEN t.amount ELSE 0 END), 0) as in_amount,
      COALESCE(SUM(CASE WHEN t.type IN ('send','withdraw') THEN t.amount ELSE 0 END), 0) as out_amount,
      COALESCE(SUM(t.fee), 0) as total_fees,
      w.balance as current_balance
    FROM wallets w
    LEFT JOIN transactions t ON t.wallet_id = w.id 
      AND DATE(t.created_at) = ? AND t.status = 'completed'
    WHERE w.is_active = 1
    GROUP BY w.id
    ORDER BY w.sort_order
  `).all(targetDate);

  const totals = {
    in_amount: summary.reduce((s, r) => s + r.in_amount, 0),
    out_amount: summary.reduce((s, r) => s + r.out_amount, 0),
    total_fees: summary.reduce((s, r) => s + r.total_fees, 0),
    transaction_count: summary.reduce((s, r) => s + r.transaction_count, 0),
    total_balance: summary.reduce((s, r) => s + r.current_balance, 0),
  };

  res.json({ date: targetDate, summary, totals });
});

module.exports = router;
