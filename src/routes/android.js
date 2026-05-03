const express = require('express');
const router = express.Router();
const { exec, spawn } = require('child_process');
const { getDB } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const ADB = process.env.ADB_PATH || 'adb';

function runADB(args) {
  return new Promise((resolve, reject) => {
    exec(`${ADB} ${args}`, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

function runADBDevice(deviceId, args) {
  return runADB(`-s ${deviceId} ${args}`);
}

// Get connected devices
router.get('/devices', async (req, res) => {
  try {
    const output = await runADB('devices');
    const lines = output.split('\n').slice(1);
    const devices = [];
    
    for (const line of lines) {
      const parts = line.trim().split('\t');
      if (parts.length === 2 && parts[1] === 'device') {
        const deviceId = parts[0];
        const db = getDB();
        
        // Get device info
        let model = 'Unknown';
        let androidVersion = 'Unknown';
        
        try {
          model = await runADBDevice(deviceId, 'shell getprop ro.product.model');
          androidVersion = await runADBDevice(deviceId, 'shell getprop ro.build.version.release');
        } catch (e) {}

        // Update or insert in DB
        const existing = db.prepare('SELECT * FROM android_devices WHERE device_id = ?').get(deviceId);
        if (existing) {
          db.prepare(`
            UPDATE android_devices SET model = ?, android_version = ?, is_connected = 1, last_seen = CURRENT_TIMESTAMP
            WHERE device_id = ?
          `).run(model, androidVersion, deviceId);
        } else {
          db.prepare(`
            INSERT INTO android_devices (device_id, device_name, model, android_version, is_connected, last_seen)
            VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
          `).run(deviceId, model, model, androidVersion);
        }

        const dbDevice = db.prepare(`
          SELECT d.*, w.name as wallet_name, w.provider, w.phone_number
          FROM android_devices d
          LEFT JOIN wallets w ON d.wallet_id = w.id
          WHERE d.device_id = ?
        `).get(deviceId);

        devices.push({ ...dbDevice, status: 'connected' });
      }
    }

    // Mark disconnected devices
    const db = getDB();
    const connectedIds = devices.map(d => d.device_id);
    if (connectedIds.length > 0) {
      db.prepare(`UPDATE android_devices SET is_connected = 0 WHERE device_id NOT IN (${connectedIds.map(() => '?').join(',')})`)
        .run(...connectedIds);
    } else {
      db.prepare('UPDATE android_devices SET is_connected = 0').run();
    }

    // Also return DB-saved devices that may be disconnected
    const allDevices = db.prepare(`
      SELECT d.*, w.name as wallet_name, w.provider, w.phone_number
      FROM android_devices d
      LEFT JOIN wallets w ON d.wallet_id = w.id
      ORDER BY d.is_connected DESC, d.last_seen DESC
    `).all();

    res.json({ devices: allDevices });
  } catch (err) {
    res.json({ devices: [], error: 'ADB غير متاح: ' + err.message });
  }
});

// Link device to wallet
router.post('/devices/:deviceId/link', requireAdmin, (req, res) => {
  const { wallet_id, device_name } = req.body;
  const db = getDB();
  
  db.prepare(`
    UPDATE android_devices SET wallet_id = ?, device_name = COALESCE(?, device_name)
    WHERE device_id = ?
  `).run(wallet_id, device_name, req.params.deviceId);

  if (wallet_id) {
    db.prepare('UPDATE wallets SET android_device_id = ? WHERE id = ?').run(req.params.deviceId, wallet_id);
  }

  res.json({ message: 'تم ربط الجهاز بالمحفظة' });
});

// Get SMS messages from device
router.post('/devices/:deviceId/sms/fetch', async (req, res) => {
  const { deviceId } = req.params;
  const db = getDB();
  
  try {
    // Read SMS via content provider
    const output = await runADBDevice(deviceId, `shell content query --uri content://sms/inbox --projection "_id,address,body,date" --sort "date DESC" --limit 100`);
    
    const messages = [];
    const lines = output.split('\n');
    let current = {};

    for (const line of lines) {
      if (line.startsWith('Row:')) {
        if (current._id) {
          messages.push(current);
        }
        current = {};
      }
      const match = line.match(/(\w+)=([^,\n]+)/g);
      if (match) {
        for (const kv of match) {
          const [k, v] = kv.split('=');
          current[k.trim()] = v.trim();
        }
      }
    }
    if (current._id) messages.push(current);

    // Save & parse messages
    const device = db.prepare('SELECT * FROM android_devices WHERE device_id = ?').get(deviceId);
    let savedCount = 0;

    for (const msg of messages) {
      const existing = db.prepare('SELECT id FROM sms_messages WHERE device_id = ? AND sender = ? AND message = ?').get(deviceId, msg.address, msg.body);
      
      if (!existing) {
        const parsed = parseSMS(msg.body, msg.address);
        
        db.prepare(`
          INSERT INTO sms_messages (device_id, sender, message, wallet_id, parsed_amount, parsed_type, parsed_reference, is_processed, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        `).run(deviceId, msg.address, msg.body, device?.wallet_id || null, parsed.amount, parsed.type, parsed.reference);
        
        savedCount++;
      }
    }

    const allMessages = db.prepare(`
      SELECT * FROM sms_messages WHERE device_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(deviceId);

    res.json({ saved: savedCount, messages: allMessages });
  } catch (err) {
    res.status(500).json({ error: 'فشل جلب الرسائل: ' + err.message });
  }
});

// Parse SMS content
function parseSMS(body, sender) {
  const result = { amount: null, type: null, reference: null };
  
  // Vodafone Cash patterns
  if (sender.includes('VOD') || body.includes('Vodafone Cash') || body.includes('فودافون كاش')) {
    const amountMatch = body.match(/(\d+(?:\.\d+)?)\s*(?:جنيه|EGP|LE)/i);
    if (amountMatch) result.amount = parseFloat(amountMatch[1]);
    
    if (body.includes('تحويل') || body.includes('Transfer')) result.type = 'send';
    else if (body.includes('استلمت') || body.includes('received')) result.type = 'receive';
    else if (body.includes('سحب') || body.includes('Withdrawal')) result.type = 'withdraw';
    else if (body.includes('إيداع') || body.includes('Deposit')) result.type = 'deposit';
    
    const refMatch = body.match(/(?:مرجع|Ref|Transaction)[:\s]+(\w+)/i);
    if (refMatch) result.reference = refMatch[1];
  }
  
  // Orange Cash
  if (sender.includes('ORA') || body.includes('Orange Cash') || body.includes('أورانج كاش')) {
    const amountMatch = body.match(/(\d+(?:\.\d+)?)\s*(?:جنيه|EGP)/i);
    if (amountMatch) result.amount = parseFloat(amountMatch[1]);
    if (body.includes('تحويل')) result.type = 'send';
    else if (body.includes('استلام')) result.type = 'receive';
  }

  // General amount detection
  if (!result.amount) {
    const amountMatch = body.match(/(\d+(?:,\d+)?(?:\.\d+)?)\s*(?:جنيه|EGP|LE|جنيهًا)/i);
    if (amountMatch) result.amount = parseFloat(amountMatch[1].replace(',', ''));
  }

  return result;
}

// Send USSD code via ADB
router.post('/devices/:deviceId/ussd', async (req, res) => {
  const { code } = req.body;
  const { deviceId } = req.params;
  
  if (!code) return res.status(400).json({ error: 'الكود مطلوب' });
  
  // Safety: only allow wallet-related USSD codes
  const allowedPrefixes = ['*9*', '*99*', '*100*', '*111*', '*150*', '#'];
  const isAllowed = allowedPrefixes.some(p => code.startsWith(p)) || code.startsWith('#');
  
  if (!isAllowed) {
    return res.status(400).json({ error: 'كود غير مسموح به' });
  }

  try {
    const encodedCode = encodeURIComponent(code);
    await runADBDevice(deviceId, `shell am start -a android.intent.action.CALL -d tel:${encodedCode}`);
    
    // Wait a moment then take screenshot to see result
    await new Promise(r => setTimeout(r, 3000));
    
    db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
      req.user.id, 'ussd_sent', `USSD: ${code} → جهاز: ${deviceId}`
    );

    res.json({ message: 'تم إرسال الكود', code });
  } catch (err) {
    res.status(500).json({ error: 'فشل إرسال الكود: ' + err.message });
  }
});

// Check balance via USSD
router.post('/devices/:deviceId/check-balance', async (req, res) => {
  const { provider } = req.body;
  const { deviceId } = req.params;
  
  const codes = {
    vodafone: '*9*13#',
    orange: '*100*6#',
    etisalat: '*588*1#',
    we: '*150*1#'
  };

  const code = codes[provider];
  if (!code) return res.status(400).json({ error: 'مزود غير معروف' });

  try {
    const encodedCode = encodeURIComponent(code);
    await runADBDevice(deviceId, `shell am start -a android.intent.action.CALL -d tel:${encodedCode}`);
    res.json({ message: `تم إرسال كود الاستعلام: ${code}` });
  } catch (err) {
    res.status(500).json({ error: 'فشل: ' + err.message });
  }
});

// Screenshot device screen
router.get('/devices/:deviceId/screenshot', async (req, res) => {
  const { deviceId } = req.params;
  try {
    await runADBDevice(deviceId, 'shell screencap -p /sdcard/screen.png');
    const data = await runADBDevice(deviceId, 'exec-out cat /sdcard/screen.png');
    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(data, 'binary'));
  } catch (err) {
    res.status(500).json({ error: 'فشل التقاط الشاشة: ' + err.message });
  }
});

// Get saved SMS messages
router.get('/sms', (req, res) => {
  const db = getDB();
  const { device_id, wallet_id, limit = 50 } = req.query;
  
  let query = 'SELECT * FROM sms_messages WHERE 1=1';
  const params = [];
  
  if (device_id) { query += ' AND device_id = ?'; params.push(device_id); }
  if (wallet_id) { query += ' AND wallet_id = ?'; params.push(wallet_id); }
  
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));
  
  const messages = db.prepare(query).all(...params);
  res.json(messages);
});

// Mark SMS as processed
router.patch('/sms/:id/process', (req, res) => {
  const db = getDB();
  db.prepare('UPDATE sms_messages SET is_processed = 1 WHERE id = ?').run(req.params.id);
  res.json({ message: 'تم' });
});

// USSD presets
router.get('/ussd-presets', (req, res) => {
  const presets = {
    vodafone: [
      { name: 'الاستعلام عن الرصيد', code: '*9*13#' },
      { name: 'تحويل أموال', code: '*9*7#' },
      { name: 'القائمة الرئيسية', code: '*9#' },
      { name: 'آخر عملية', code: '*9*500#' },
    ],
    orange: [
      { name: 'الاستعلام عن الرصيد', code: '*100*6#' },
      { name: 'القائمة الرئيسية', code: '*100#' },
      { name: 'تحويل أموال', code: '*100*3#' },
    ],
    etisalat: [
      { name: 'الاستعلام عن الرصيد', code: '*588*1#' },
      { name: 'القائمة الرئيسية', code: '*588#' },
    ],
    we: [
      { name: 'الاستعلام عن الرصيد', code: '*150*1#' },
      { name: 'القائمة الرئيسية', code: '*150#' },
    ]
  };
  res.json(presets);
});

module.exports = router;
