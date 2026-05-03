/* =========================================
   كاشي لينك - app.js
   Main Frontend JavaScript
   ========================================= */

'use strict';

// ── State ─────────────────────────────────
let token = localStorage.getItem('token') || '';
let currentUser = null;
let wallets = [];
let allTransactions = [];
let selectedTransType = 'send';
let selectedWalletId = null;
let txFilters = { wallet_id: '', type: '', date_from: '', date_to: '', search: '' };
let txOffset = 0;
let txTotal = 0;
let ws = null;
let charts = {};
let activeDeviceId = null;
let ussdPresets = {};

// ── API helper ────────────────────────────
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Formatting ────────────────────────────
function formatCurrency(n) {
  return (parseFloat(n) || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج';
}
function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatDateShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ar-EG');
}
function providerEmoji(p) {
  return { vodafone: '🔴', orange: '🟠', etisalat: '🟢', we: '🔵' }[p] || '⚪';
}
function providerName(p) {
  return { vodafone: 'فودافون كاش', orange: 'اورانج كاش', etisalat: 'اتصالات كاش', we: 'وي باي' }[p] || p;
}
function txTypeLabel(t) {
  return { send: 'إرسال', receive: 'استلام', withdraw: 'سحب', deposit: 'إيداع', fee: 'رسوم', balance_check: 'استعلام رصيد' }[t] || t;
}
function txTypeClass(t) {
  return { send: 'danger', receive: 'success', withdraw: 'warning', deposit: 'info', fee: 'muted', balance_check: 'muted' }[t] || '';
}
function statusBadge(s) {
  const map = { completed: ['success', 'مكتمل'], pending: ['warning', 'معلق'], failed: ['danger', 'فاشل'], cancelled: ['muted', 'ملغي'] };
  const [cls, label] = map[s] || ['muted', s];
  return `<span class="badge badge-${cls}">${label}</span>`;
}

// ── Toast ─────────────────────────────────
function showToast(msg, type = 'success', duration = 3500) {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, duration);
}

// ── Auth ──────────────────────────────────
async function login(e) {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const errEl = document.getElementById('loginError');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الدخول...';
  errEl.classList.add('hidden');

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('loginUsername').value.trim(),
        password: document.getElementById('loginPassword').value
      })
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    showMainApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> تسجيل الدخول';
  }
}

function togglePassword() {
  const inp = document.getElementById('loginPassword');
  const btn = inp.nextElementSibling.querySelector('i');
  if (inp.type === 'password') { inp.type = 'text'; btn.className = 'fas fa-eye-slash'; }
  else { inp.type = 'password'; btn.className = 'fas fa-eye'; }
}

function logout() {
  token = '';
  currentUser = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if (ws) ws.close();
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
}

function showMainApp() {
  document.getElementById('loginPage').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  const user = currentUser || JSON.parse(localStorage.getItem('user') || '{}');
  if (user.full_name) {
    const el = document.getElementById('currentUserName');
    if (el) el.textContent = user.full_name;
  }
  // Admin-only elements
  if (user.role !== 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
  }
  initWebSocket();
  navigate('dashboard');
}

// ── WebSocket ─────────────────────────────
function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { document.getElementById('wsStatus').className = 'ws-dot ws-online'; };
  ws.onclose = () => { document.getElementById('wsStatus').className = 'ws-dot ws-offline'; setTimeout(initWebSocket, 5000); };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'new_transaction') {
        showToast(`عملية جديدة: ${txTypeLabel(msg.data.type)} ${formatCurrency(msg.data.amount)}`, 'info');
        // Refresh current page data
        const page = document.querySelector('.page:not(.hidden)')?.id?.replace('page-', '');
        if (page === 'dashboard') loadDashboard();
      }
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {}
  };
  setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
}

// ── Navigation ────────────────────────────
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.remove('hidden');

  // Match nav items
  document.querySelectorAll('.nav-item').forEach(n => {
    if (n.getAttribute('onclick')?.includes(`'${page}'`)) n.classList.add('active');
  });

  const loaders = {
    dashboard: loadDashboard,
    wallets: loadWallets,
    'new-transaction': loadNewTransaction,
    transactions: () => loadTransactions(true),
    android: loadAndroid,
    sms: loadSMS,
    customers: loadCustomers,
    reports: loadReports,
    settings: loadSettings,
    users: loadUsers
  };
  if (loaders[page]) loaders[page]();

  // Mobile: close sidebar
  if (window.innerWidth < 768) document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() {
  const s = document.getElementById('sidebar');
  s.classList.toggle('collapsed');
  s.classList.toggle('open');
}

// ── Dashboard ─────────────────────────────
let dashboardChart = null, providerChart = null;

async function loadDashboard() {
  try {
    const data = await api('/api/stats/overview');

    // Stat cards
    setText('statTotalBalance', formatCurrency(data.total_balance));
    setText('statWalletCount', data.wallet_count);
    setText('statTodayTx', data.today?.count || 0);
    setText('statTodayFees', formatCurrency(data.today?.total_fees));
    setText('statTodayIn', formatCurrency(data.today?.in_amount));
    setText('statTodayOut', formatCurrency(data.today?.out_amount));
    setText('statMonthIn', formatCurrency(data.month?.in_amount));
    setText('statMonthOut', formatCurrency(data.month?.out_amount));
    setText('statMonthFees', formatCurrency(data.month?.total_fees));
    setText('statDevices', data.connected_devices || 0);
    setText('walletBadge', data.wallet_count);
    setText('deviceBadge', data.connected_devices || 0);

    // Alerts
    renderAlerts(data.low_balance_wallets, data.near_limit_wallets);

    // Recent transactions
    renderRecentTransactions(data.recent_transactions || []);

    // Charts
    await loadDailyChart();
    renderProviderChart(data.wallets_summary || []);

  } catch (err) {
    showToast('خطأ في تحميل البيانات: ' + err.message, 'error');
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function renderAlerts(lowBal, nearLimit) {
  const el = document.getElementById('alertsPanel');
  if (!el) return;
  let html = '';
  (lowBal || []).forEach(w => {
    html += `<div class="alert-item danger"><i class="fas fa-exclamation-circle"></i> ${w.name}: رصيد منخفض (${formatCurrency(w.balance)})</div>`;
  });
  (nearLimit || []).forEach(w => {
    html += `<div class="alert-item warning"><i class="fas fa-exclamation-triangle"></i> ${w.name}: اقترب من الحد اليومي</div>`;
  });
  if (!html) html = '<div style="color:var(--text-muted);font-size:13px;padding:10px">لا توجد تنبيهات</div>';
  el.innerHTML = html;
}

function renderRecentTransactions(txs) {
  const el = document.getElementById('recentTransactions');
  if (!el) return;
  if (!txs.length) { el.innerHTML = '<p class="empty-state">لا توجد عمليات اليوم</p>'; return; }
  el.innerHTML = `<table><thead><tr><th>المحفظة</th><th>النوع</th><th>المبلغ</th><th>الرسوم</th><th>العميل</th><th>الوقت</th></tr></thead><tbody>
    ${txs.map(t => `<tr>
      <td><span style="color:${getProviderColor(t.provider)}">${providerEmoji(t.provider)}</span> ${t.wallet_name || ''}</td>
      <td><span class="badge badge-${txTypeClass(t.type)}">${txTypeLabel(t.type)}</span></td>
      <td class="font-bold">${formatCurrency(t.amount)}</td>
      <td class="text-muted">${formatCurrency(t.fee)}</td>
      <td>${t.customer_name || '—'}</td>
      <td class="text-muted">${formatDate(t.created_at)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function getProviderColor(p) {
  return { vodafone: '#e60000', orange: '#ff6600', etisalat: '#00a651', we: '#0066cc' }[p] || '#666';
}

async function loadDailyChart() {
  const el = document.getElementById('dailyChart');
  if (!el) return;
  try {
    const data = await api('/api/stats/chart/daily?days=14');
    if (dashboardChart) { dashboardChart.destroy(); dashboardChart = null; }
    dashboardChart = new Chart(el, {
      type: 'bar',
      data: {
        labels: data.map(d => d.date),
        datasets: [
          { label: 'وارد', data: data.map(d => d.in_amount), backgroundColor: 'rgba(52,168,83,0.7)', borderRadius: 6 },
          { label: 'صادر', data: data.map(d => d.out_amount), backgroundColor: 'rgba(234,67,53,0.7)', borderRadius: 6 },
          { label: 'رسوم', data: data.map(d => d.fees), backgroundColor: 'rgba(26,115,232,0.6)', borderRadius: 6 }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { x: { grid: { display: false } } } }
    });
  } catch {}
}

function renderProviderChart(walletSummary) {
  const el = document.getElementById('providerChart');
  if (!el) return;
  const grouped = {};
  walletSummary.forEach(w => {
    if (!grouped[w.provider]) grouped[w.provider] = 0;
    grouped[w.provider] += w.balance;
  });
  const labels = Object.keys(grouped).map(providerName);
  const vals = Object.values(grouped);
  const colors = Object.keys(grouped).map(getProviderColor);

  if (providerChart) { providerChart.destroy(); providerChart = null; }
  providerChart = new Chart(el, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 2 }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } }, cutout: '65%' }
  });
}

// ── Wallets ───────────────────────────────
async function loadWallets() {
  try {
    wallets = await api('/api/wallets');
    renderWallets(wallets);
    document.getElementById('walletBadge').textContent = wallets.length;
  } catch (err) {
    showToast('خطأ في تحميل المحافظ: ' + err.message, 'error');
  }
}

function renderWallets(list) {
  const el = document.getElementById('walletsGrid');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-wallet fa-3x"></i><p>لا توجد محافظ بعد</p><button class="btn btn-primary" onclick="openWalletModal()">إضافة محفظة</button></div>';
    return;
  }
  el.innerHTML = list.map(walletCardHTML).join('');
}

function walletCardHTML(w) {
  const dailyPct = w.daily_limit > 0 ? Math.min(100, (w.today_out / w.daily_limit) * 100) : 0;
  const monthPct = w.monthly_limit > 0 ? Math.min(100, (w.month_out / w.monthly_limit) * 100) : 0;
  const balanceLow = w.balance < 1000;
  const color = w.color || getProviderColor(w.provider);

  return `<div class="wallet-card" data-provider="${w.provider}" style="--wcolor:${color}">
    <div class="wallet-card-header" style="background:${color}">
      <div class="wallet-card-provider">${providerEmoji(w.provider)} ${providerName(w.provider)}</div>
      <div class="wallet-card-menu">
        <button onclick="editWallet(${w.id})" title="تعديل"><i class="fas fa-edit"></i></button>
        <button onclick="quickTransaction(${w.id})" title="عملية جديدة"><i class="fas fa-plus"></i></button>
      </div>
    </div>
    <div class="wallet-card-body">
      <div class="wallet-name">${w.name}</div>
      <div class="wallet-phone"><i class="fas fa-phone-alt"></i> ${w.phone_number}</div>
      <div class="wallet-balance ${balanceLow ? 'balance-low' : ''}">${formatCurrency(w.balance)}</div>
      <div class="wallet-stats-row">
        <div class="wstat"><span class="wstat-label">وارد اليوم</span><span class="wstat-val text-success">+${formatCurrency(w.today_in || 0)}</span></div>
        <div class="wstat"><span class="wstat-label">صادر اليوم</span><span class="wstat-val text-danger">-${formatCurrency(w.today_out || 0)}</span></div>
      </div>
      <div class="limit-bar-label"><span>الحد اليومي</span><span>${formatCurrency(w.today_out || 0)} / ${formatCurrency(w.daily_limit)}</span></div>
      <div class="limit-bar"><div class="limit-bar-fill ${dailyPct > 80 ? 'danger' : ''}" style="width:${dailyPct}%"></div></div>
      <div class="limit-bar-label" style="margin-top:6px"><span>الحد الشهري</span><span>${formatCurrency(w.month_out || 0)} / ${formatCurrency(w.monthly_limit)}</span></div>
      <div class="limit-bar"><div class="limit-bar-fill ${monthPct > 80 ? 'danger' : ''}" style="width:${monthPct}%"></div></div>
    </div>
    <div class="wallet-card-footer">
      <button class="btn btn-sm btn-primary" onclick="quickTransaction(${w.id})"><i class="fas fa-exchange-alt"></i> عملية</button>
      <button class="btn btn-sm btn-outline" onclick="showWalletTransactions(${w.id})"><i class="fas fa-list"></i> سجل</button>
      <button class="btn btn-sm btn-outline" onclick="updateBalance(${w.id}, '${w.name}', ${w.balance})"><i class="fas fa-coins"></i> رصيد</button>
    </div>
  </div>`;
}

function openWalletModal(wallet = null) {
  document.getElementById('walletModalTitle').textContent = wallet ? 'تعديل المحفظة' : 'محفظة جديدة';
  document.getElementById('walletId').value = wallet?.id || '';
  document.getElementById('walletName').value = wallet?.name || '';
  document.getElementById('walletProvider').value = wallet?.provider || 'vodafone';
  document.getElementById('walletPhone').value = wallet?.phone_number || '';
  document.getElementById('walletOwner').value = wallet?.owner_name || '';
  document.getElementById('walletNID').value = wallet?.national_id || '';
  document.getElementById('walletBalance').value = wallet?.balance || '';
  document.getElementById('walletDailyLimit').value = wallet?.daily_limit || '';
  document.getElementById('walletMonthlyLimit').value = wallet?.monthly_limit || '';
  document.getElementById('walletColor').value = wallet?.color || '#4CAF50';
  document.getElementById('walletPinHint').value = wallet?.pin_hint || '';
  document.getElementById('walletNotes').value = wallet?.notes || '';
  showModal('walletModal');
}

async function editWallet(id) {
  try {
    const w = await api(`/api/wallets/${id}`);
    openWalletModal(w);
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function saveWallet() {
  const id = document.getElementById('walletId').value;
  const body = {
    name: document.getElementById('walletName').value,
    provider: document.getElementById('walletProvider').value,
    phone_number: document.getElementById('walletPhone').value,
    owner_name: document.getElementById('walletOwner').value,
    national_id: document.getElementById('walletNID').value,
    balance: parseFloat(document.getElementById('walletBalance').value) || 0,
    daily_limit: parseFloat(document.getElementById('walletDailyLimit').value) || undefined,
    monthly_limit: parseFloat(document.getElementById('walletMonthlyLimit').value) || undefined,
    color: document.getElementById('walletColor').value,
    pin_hint: document.getElementById('walletPinHint').value,
    notes: document.getElementById('walletNotes').value,
  };
  try {
    if (id) {
      await api(`/api/wallets/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('تم تحديث المحفظة', 'success');
    } else {
      await api('/api/wallets', { method: 'POST', body: JSON.stringify(body) });
      showToast('تم إضافة المحفظة', 'success');
    }
    closeAllModals();
    loadWallets();
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function updateBalance(id, name, currentBalance) {
  const newBal = prompt(`تحديث رصيد "${name}"\nالرصيد الحالي: ${currentBalance} جنيه\nأدخل الرصيد الجديد:`);
  if (newBal === null) return;
  const val = parseFloat(newBal);
  if (isNaN(val) || val < 0) { showToast('رصيد غير صحيح', 'error'); return; }
  try {
    await api(`/api/wallets/${id}/balance`, { method: 'PATCH', body: JSON.stringify({ balance: val }) });
    showToast('تم تحديث الرصيد', 'success');
    loadWallets();
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

function quickTransaction(walletId) {
  selectedWalletId = walletId;
  navigate('new-transaction');
}

function showWalletTransactions(walletId) {
  txFilters.wallet_id = walletId;
  navigate('transactions');
}

// ── New Transaction ───────────────────────
async function loadNewTransaction() {
  await populateWalletDropdowns();
  selectTxType(selectedTransType || 'send');
  updateSummary();
}

function selectTxType(type) {
  selectedTransType = type;
  document.querySelectorAll('.tx-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  updateSummary();
}

function onWalletSelectChange() {
  const walletId = parseInt(document.getElementById('txWallet').value);
  if (!walletId) {
    const bar = document.getElementById('walletInfoBar');
    if (bar) bar.classList.add('hidden');
    return;
  }
  selectedWalletId = walletId;
  const w = wallets.find(x => x.id === walletId);
  if (w) {
    const bar = document.getElementById('walletInfoBar');
    if (bar) bar.classList.remove('hidden');
    setText('selectedBalance', formatCurrency(w.balance));
    setText('selectedDailyLimit', formatCurrency(w.daily_limit));
    setText('selectedDailyUsed', formatCurrency(w.today_out || 0));
  }
  updateSummary();
}

function onAmountChange() { updateSummary(); }

function updateSummary() {
  const amount = parseFloat(document.getElementById('txAmount')?.value) || 0;
  const customFee = document.getElementById('txCustomFee')?.value;
  const walletId = parseInt(document.getElementById('txWallet')?.value);
  const w = wallets.find(x => x.id === walletId);

  let fee = 0;
  if (w && amount > 0) {
    if (customFee !== '' && customFee !== undefined) {
      fee = parseFloat(customFee) || 0;
    } else {
      fee = calcFee(w.provider, selectedTransType, amount);
    }
  }

  const total = selectedTransType === 'send' || selectedTransType === 'withdraw'
    ? amount + fee
    : amount - fee;

  setText('summaryType', txTypeLabel(selectedTransType));
  setText('summaryAmount', formatCurrency(amount));
  setText('summaryFee', formatCurrency(fee));
  setText('summaryTotal', formatCurrency(Math.abs(total)));
  setText('summaryWallet', w ? `${providerEmoji(w.provider)} ${w.name}` : '—');
}

function calcFee(provider, type, amount) {
  const fees = {
    vodafone: { send: Math.max(1, amount * 0.005), receive: 0, withdraw: Math.max(3, amount * 0.01), deposit: 0 },
    orange: { send: Math.max(1, Math.min(15, amount * 0.005)), receive: 0, withdraw: Math.max(3, amount * 0.01), deposit: 0 },
    etisalat: { send: Math.max(0.5, Math.min(20, amount * 0.001)), receive: 0, withdraw: Math.max(5, amount * 0.01), deposit: 0 },
    we: { send: Math.max(0.5, Math.min(20, amount * 0.001)), receive: 0, withdraw: Math.max(3, amount * 0.01), deposit: 0 }
  };
  return fees[provider]?.[type] || 0;
}

async function submitTransaction() {
  const walletId = parseInt(document.getElementById('txWallet').value);
  const amount = parseFloat(document.getElementById('txAmount').value);
  if (!walletId) { showToast('اختر المحفظة', 'warning'); return; }
  if (!amount || amount <= 0) { showToast('أدخل مبلغاً صحيحاً', 'warning'); return; }

  const body = {
    wallet_id: walletId,
    type: selectedTransType,
    amount,
    customer_name: document.getElementById('txCustomerName').value || undefined,
    customer_phone: document.getElementById('txCustomerPhone').value || undefined,
    customer_id: parseInt(document.getElementById('txCustomerId').value) || undefined,
    reference: document.getElementById('txReference').value || undefined,
    notes: document.getElementById('txNotes').value || undefined,
    custom_fee: document.getElementById('txCustomFee').value !== '' ? parseFloat(document.getElementById('txCustomFee').value) : undefined
  };

  const btn = document.getElementById('submitTxBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري التنفيذ...';

  try {
    const res = await api('/api/transactions', { method: 'POST', body: JSON.stringify(body) });
    showToast(`✅ تمت العملية! الرصيد الجديد: ${formatCurrency(res.new_balance)}`, 'success', 5000);
    clearTxForm();
    await populateWalletDropdowns(); // refresh balance
    updateSummary();
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-check"></i> تنفيذ العملية';
  }
}

function clearTxForm() {
  ['txAmount', 'txCustomerName', 'txCustomerPhone', 'txCustomerId', 'txReference', 'txNotes', 'txCustomFee'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  updateSummary();
}

async function lookupCustomer() {
  const phone = document.getElementById('txCustomerPhone')?.value?.trim();
  if (!phone) return;
  try {
    const data = await api(`/api/customers?search=${encodeURIComponent(phone)}&limit=1`);
    if (data.customers?.length) {
      const c = data.customers[0];
      const nameEl = document.getElementById('txCustomerName');
      const idEl = document.getElementById('txCustomerId');
      if (nameEl && !nameEl.value) nameEl.value = c.name;
      if (idEl) idEl.value = c.id;
      showToast(`تم العثور على العميل: ${c.name}`, 'info');
    }
  } catch {}
}

// ── Transactions ──────────────────────────
async function loadTransactions(reset = false) {
  if (reset) { txOffset = 0; allTransactions = []; }

  const params = new URLSearchParams({
    limit: 30, offset: txOffset,
    ...(txFilters.wallet_id ? { wallet_id: txFilters.wallet_id } : {}),
    ...(txFilters.type ? { type: txFilters.type } : {}),
    ...(txFilters.date_from ? { date_from: txFilters.date_from } : {}),
    ...(txFilters.date_to ? { date_to: txFilters.date_to } : {}),
    ...(txFilters.search ? { search: txFilters.search } : {})
  });

  try {
    const data = await api(`/api/transactions?${params}`);
    txTotal = data.total;
    allTransactions = reset ? data.transactions : [...allTransactions, ...data.transactions];
    renderTransactions(allTransactions);
    setText('txTotal', `${txTotal} عملية`);

    const loadMoreBtn = document.getElementById('loadMoreTx');
    if (loadMoreBtn) loadMoreBtn.style.display = allTransactions.length < txTotal ? '' : 'none';
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

function renderTransactions(list) {
  const el = document.getElementById('txBody');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<tr><td colspan="9" class="text-center p-16">لا توجد عمليات</td></tr>';
    return;
  }
  el.innerHTML = list.map(t => `<tr>
    <td>#${t.id}</td>
    <td><span style="color:${getProviderColor(t.provider)}">${providerEmoji(t.provider)}</span> ${t.wallet_name || '—'}</td>
    <td><span class="badge badge-${txTypeClass(t.type)}">${txTypeLabel(t.type)}</span></td>
    <td class="font-bold">${formatCurrency(t.amount)}</td>
    <td class="text-muted">${formatCurrency(t.fee)}</td>
    <td>${t.customer_name || '—'}<br><small class="text-muted">${t.customer_phone || ''}</small></td>
    <td class="text-muted">${t.reference || '—'}</td>
    <td>${statusBadge(t.status)}</td>
    <td>${formatDate(t.created_at)}</td>
    <td>${t.status !== 'cancelled' ? `<button class="btn btn-sm btn-danger" onclick="cancelTransaction(${t.id})"><i class="fas fa-times"></i></button>` : ''}</td>
  </tr>`).join('');
}

function applyTxFilters() {
  txFilters.wallet_id = document.getElementById('filterWallet')?.value || '';
  txFilters.type = document.getElementById('filterType')?.value || '';
  txFilters.date_from = document.getElementById('filterDateFrom')?.value || '';
  txFilters.date_to = document.getElementById('filterDateTo')?.value || '';
  txFilters.search = document.getElementById('txSearch')?.value || '';
  loadTransactions(true);
}

function clearTxFilters() {
  ['filterWallet', 'filterType', 'filterDateFrom', 'filterDateTo', 'txSearch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  txFilters = { wallet_id: '', type: '', date_from: '', date_to: '', search: '' };
  loadTransactions(true);
}

function loadMoreTransactions() {
  txOffset += 30;
  loadTransactions(false);
}

async function cancelTransaction(id) {
  if (!confirm(`هل تريد إلغاء العملية #${id}؟`)) return;
  try {
    await api(`/api/transactions/${id}/cancel`, { method: 'POST' });
    showToast('تم إلغاء العملية وإعادة الرصيد', 'success');
    loadTransactions(true);
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

function exportTransactions() {
  const params = new URLSearchParams({
    ...(txFilters.wallet_id ? { wallet_id: txFilters.wallet_id } : {}),
    ...(txFilters.date_from ? { date_from: txFilters.date_from } : {}),
    ...(txFilters.date_to ? { date_to: txFilters.date_to } : {})
  });
  window.open(`/api/reports/export/transactions?${params}`, '_blank');
}

// ── Android / ADB ─────────────────────────
async function loadAndroid() {
  try {
    await loadUSSDPresets();
    const data = await api('/api/android/devices');
    renderDevices(data.devices || []);
    setText('deviceBadge', (data.devices || []).filter(d => d.is_connected).length);
  } catch (err) {
    const el = document.getElementById('devicesGrid');
    if (el) el.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>ADB غير متاح: ${err.message}</p></div>`;
  }
}

function renderDevices(devices) {
  const el = document.getElementById('devicesGrid');
  if (!el) return;
  if (!devices.length) {
    el.innerHTML = '<div class="empty-state"><i class="fab fa-android fa-3x"></i><p>لا توجد أجهزة. قم بتوصيل هاتفك عبر USB وتفعيل وضع ADB</p></div>';
    return;
  }
  el.innerHTML = devices.map(d => `<div class="device-card ${d.is_connected ? 'connected' : 'disconnected'}">
    <div class="device-header">
      <div class="device-icon"><i class="fab fa-android"></i></div>
      <div class="device-info">
        <div class="device-name">${d.device_name || d.model || 'جهاز غير معروف'}</div>
        <div class="device-id">${d.device_id}</div>
        <div class="device-model">${d.model || ''} · Android ${d.android_version || '?'}</div>
      </div>
      <span class="badge badge-${d.is_connected ? 'success' : 'danger'}">${d.is_connected ? 'متصل' : 'غير متصل'}</span>
    </div>
    <div class="device-wallet">
      ${d.wallet_name ? `<span class="wallet-link">${providerEmoji(d.provider)} ${d.wallet_name} · ${d.phone_number}</span>` : '<span class="text-muted">لم يتم ربط محفظة</span>'}
    </div>
    <div class="device-actions">
      <button class="btn btn-sm btn-primary" onclick="fetchSMS('${d.device_id}')" ${!d.is_connected ? 'disabled' : ''}><i class="fas fa-sms"></i> جلب الرسائل</button>
      <button class="btn btn-sm btn-outline" onclick="openLinkDeviceModal('${d.device_id}')" ${!d.is_connected ? 'disabled' : ''}><i class="fas fa-link"></i> ربط محفظة</button>
      <button class="btn btn-sm btn-outline" onclick="showUSSDPanel('${d.device_id}', '${d.provider || ''}')" ${!d.is_connected ? 'disabled' : ''}><i class="fas fa-phone"></i> USSD</button>
      <button class="btn btn-sm btn-outline" onclick="checkBalance('${d.device_id}', '${d.provider || ''}')" ${!d.is_connected ? 'disabled' : ''}><i class="fas fa-coins"></i> رصيد</button>
    </div>
  </div>`).join('');
}

async function refreshDevices() {
  showToast('جاري تحديث الأجهزة...', 'info', 2000);
  loadAndroid();
}

async function fetchSMS(deviceId) {
  showToast('جاري جلب الرسائل...', 'info', 3000);
  try {
    const data = await api(`/api/android/devices/${deviceId}/sms/fetch`, { method: 'POST' });
    showToast(`تم حفظ ${data.saved} رسالة جديدة`, 'success');
    loadSMSForDevice(deviceId);
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function checkBalance(deviceId, provider) {
  if (!provider) {
    provider = prompt('أدخل المزود (vodafone/orange/etisalat/we):');
    if (!provider) return;
  }
  try {
    await api(`/api/android/devices/${deviceId}/check-balance`, { method: 'POST', body: JSON.stringify({ provider }) });
    showToast(`تم إرسال كود الاستعلام للجهاز`, 'success');
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function loadUSSDPresets() {
  try {
    ussdPresets = await api('/api/android/ussd-presets');
    renderUSSDPanel('', '');
  } catch {}
}

function showUSSDPanel(deviceId, provider) {
  activeDeviceId = deviceId;
  renderUSSDPanel(deviceId, provider);
  document.getElementById('ussdDevicePanel')?.classList.remove('hidden');
}

function renderUSSDPanel(deviceId, selectedProvider) {
  const el = document.getElementById('ussdPanelBody');
  if (!el) return;
  const providers = Object.keys(ussdPresets);
  el.innerHTML = providers.map(p => `
    <div class="ussd-provider-section">
      <h5>${providerEmoji(p)} ${providerName(p)}</h5>
      <div class="ussd-codes">
        ${(ussdPresets[p] || []).map(preset => `
          <button class="ussd-code-btn" onclick="sendUSSD('${deviceId || activeDeviceId}', '${preset.code}')">
            <span class="code-name">${preset.name}</span>
            <span class="code-val">${preset.code}</span>
          </button>`).join('')}
      </div>
    </div>`).join('');
}

async function sendUSSD(deviceId, code) {
  if (!deviceId) { showToast('اختر جهازاً أولاً', 'warning'); return; }
  try {
    await api(`/api/android/devices/${deviceId}/ussd`, { method: 'POST', body: JSON.stringify({ code }) });
    showToast(`تم إرسال: ${code}`, 'success');
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function sendCustomUSSD() {
  const code = document.getElementById('customUSSDCode')?.value?.trim();
  if (!code) return;
  if (!activeDeviceId) { showToast('اختر جهازاً أولاً', 'warning'); return; }
  await sendUSSD(activeDeviceId, code);
}

function openLinkDeviceModal(deviceId) {
  activeDeviceId = deviceId;
  const walletSel = document.getElementById('linkWalletSelect');
  if (walletSel) {
    walletSel.innerHTML = '<option value="">اختر المحفظة</option>' + wallets.map(w => `<option value="${w.id}">${providerEmoji(w.provider)} ${w.name}</option>`).join('');
  }
  showModal('linkDeviceModal');
}

async function linkDeviceToWallet() {
  const walletId = document.getElementById('linkWalletSelect')?.value;
  if (!walletId || !activeDeviceId) { showToast('اختر محفظة', 'warning'); return; }
  try {
    await api(`/api/android/devices/${activeDeviceId}/link`, { method: 'POST', body: JSON.stringify({ wallet_id: walletId }) });
    showToast('تم ربط الجهاز بالمحفظة', 'success');
    closeAllModals();
    loadAndroid();
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

// ── SMS ───────────────────────────────────
async function loadSMS() {
  try {
    const data = await api('/api/android/sms?limit=100');
    renderSMSMessages(data);
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function loadSMSForDevice(deviceId) {
  try {
    const data = await api(`/api/android/sms?device_id=${deviceId}&limit=50`);
    renderSMSMessages(data);
  } catch {}
}

function renderSMSMessages(messages) {
  const el = document.getElementById('smsBody');
  if (!el) return;
  if (!messages.length) {
    el.innerHTML = '<tr><td colspan="7" class="text-center p-16">لا توجد رسائل</td></tr>';
    return;
  }
  el.innerHTML = messages.map(m => `<tr class="${m.is_processed ? '' : 'unprocessed-row'}">
    <td>${m.device_id || '—'}</td>
    <td>${m.sender || '—'}</td>
    <td class="sms-body">${m.message?.substring(0, 100)}${m.message?.length > 100 ? '...' : ''}</td>
    <td>${m.parsed_amount ? formatCurrency(m.parsed_amount) : '—'}</td>
    <td>${m.parsed_type ? txTypeLabel(m.parsed_type) : '—'}</td>
    <td><span class="badge badge-${m.is_processed ? 'muted' : 'warning'}">${m.is_processed ? 'تمت المعالجة' : 'جديد'}</span></td>
    <td>${formatDate(m.created_at)}</td>
    <td>
      ${!m.is_processed ? `<button class="btn btn-sm btn-outline" onclick="processSMS(${m.id})"><i class="fas fa-check"></i></button>` : ''}
    </td>
  </tr>`).join('');
}

async function fetchAllSMS() {
  try {
    const data = await api('/api/android/devices');
    const connected = (data.devices || []).filter(d => d.is_connected);
    if (!connected.length) { showToast('لا توجد أجهزة متصلة', 'warning'); return; }
    for (const d of connected) await fetchSMS(d.device_id);
    loadSMS();
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function processSMS(id) {
  try {
    await api(`/api/android/sms/${id}/process`, { method: 'PATCH' });
    showToast('تمت المعالجة', 'success');
    loadSMS();
  } catch {}
}

// ── Customers ─────────────────────────────
async function loadCustomers() {
  try {
    const data = await api('/api/customers?limit=100');
    renderCustomers(data.customers || []);
    setText('custTotal', `${data.total} عميل`);
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

function renderCustomers(list) {
  const el = document.getElementById('custBody');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<tr><td colspan="7" class="text-center p-16">لا يوجد عملاء</td></tr>';
    return;
  }
  el.innerHTML = list.map(c => `<tr>
    <td>#${c.id}</td>
    <td class="font-bold">${c.name}</td>
    <td>${c.phone || '—'}</td>
    <td>${c.national_id || '—'}</td>
    <td>${c.total_transactions || 0}</td>
    <td>${formatCurrency(c.total_amount)}</td>
    <td>${formatDateShort(c.last_transaction)}</td>
    <td><button class="btn btn-sm btn-outline" onclick="editCustomer(${c.id})"><i class="fas fa-edit"></i></button></td>
  </tr>`).join('');
}

function searchCustomers() {
  const q = document.getElementById('custSearch')?.value || '';
  api(`/api/customers?search=${encodeURIComponent(q)}&limit=100`).then(data => renderCustomers(data.customers));
}

function openUserModal() { showModal('userModal'); }

function openCustomerModal() {
  document.getElementById('customerId').value = '';
  document.getElementById('customerName').value = '';
  document.getElementById('customerPhone').value = '';
  document.getElementById('customerNID').value = '';
  document.getElementById('customerNotes').value = '';
  showModal('customerModal');
}

async function editCustomer(id) {
  try {
    const data = await api('/api/customers');
    const c = data.customers?.find(x => x.id === id);
    if (!c) return;
    document.getElementById('customerId').value = c.id;
    document.getElementById('customerName').value = c.name;
    document.getElementById('customerPhone').value = c.phone || '';
    document.getElementById('customerNID').value = c.national_id || '';
    document.getElementById('customerNotes').value = c.notes || '';
    showModal('customerModal');
  } catch {}
}

async function saveCustomer() {
  const id = document.getElementById('customerId').value;
  const body = {
    name: document.getElementById('customerName').value,
    phone: document.getElementById('customerPhone').value,
    national_id: document.getElementById('customerNID').value,
    notes: document.getElementById('customerNotes').value
  };
  if (!body.name) { showToast('الاسم مطلوب', 'warning'); return; }
  try {
    if (id) {
      await api(`/api/customers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/customers', { method: 'POST', body: JSON.stringify(body) });
    }
    showToast('تم حفظ العميل', 'success');
    closeAllModals();
    loadCustomers();
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

// ── Reports ───────────────────────────────
async function loadReports() {
  await populateWalletDropdowns();
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById('reportDate');
  if (dateEl && !dateEl.value) dateEl.value = today;
  await loadDailySummary(dateEl?.value || today);
}

async function loadDailySummary(date) {
  try {
    const data = await api(`/api/reports/daily-summary?date=${date}`);
    renderDailySummary(data);
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

function renderDailySummary(data) {
  const el = document.getElementById('dailySummaryBody');
  if (!el) return;
  const { summary = [], totals = {}, date } = data;

  setText('reportDateTitle', `تقرير يوم ${date}`);
  setText('rptTotalIn', formatCurrency(totals.in_amount));
  setText('rptTotalOut', formatCurrency(totals.out_amount));
  setText('rptTotalFees', formatCurrency(totals.total_fees));
  setText('rptTotalBalance', formatCurrency(totals.total_balance));
  setText('rptTotalTx', totals.transaction_count);

  el.innerHTML = summary.map(w => `<tr>
    <td><span style="color:${getProviderColor(w.provider)}">${providerEmoji(w.provider)}</span></td>
    <td class="font-bold">${w.wallet_name}</td>
    <td>${w.phone_number}</td>
    <td>${w.transaction_count}</td>
    <td class="text-success">+${formatCurrency(w.in_amount)}</td>
    <td class="text-danger">-${formatCurrency(w.out_amount)}</td>
    <td class="text-muted">${formatCurrency(w.total_fees)}</td>
    <td class="font-bold">${formatCurrency(w.current_balance)}</td>
  </tr>`).join('');
}

function onReportDateChange() {
  const date = document.getElementById('reportDate')?.value;
  if (date) loadDailySummary(date);
}

// ── Settings ──────────────────────────────
async function loadSettings() {
  try {
    const data = await api('/api/stats/settings');
    setValue('settingShopName', data.shop_name);
    setValue('settingShopPhone', data.shop_phone);
    setValue('settingLowBalance', data.low_balance_alert);
    setValue('settingAutoSMS', data.auto_sms_parse);
    const shopEl = document.getElementById('shopName');
    if (shopEl) shopEl.textContent = data.shop_name || 'إدارة المحافظ';
  } catch {}
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val || '';
}

async function saveSettings() {
  const body = {
    shop_name: document.getElementById('settingShopName')?.value || '',
    shop_phone: document.getElementById('settingShopPhone')?.value || '',
    low_balance_alert: document.getElementById('settingLowBalance')?.value || '1000',
    auto_sms_parse: document.getElementById('settingAutoSMS')?.value || '1'
  };
  try {
    await api('/api/stats/settings', { method: 'PUT', body: JSON.stringify(body) });
    showToast('تم حفظ الإعدادات', 'success');
    const shopEl = document.getElementById('shopName');
    if (shopEl && body.shop_name) shopEl.textContent = body.shop_name;
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function changePassword() {
  const old_password = document.getElementById('oldPassword')?.value;
  const new_password = document.getElementById('newPassword')?.value;
  const confirm = document.getElementById('confirmPassword')?.value;
  if (!old_password || !new_password) { showToast('أدخل كلمات المرور', 'warning'); return; }
  if (new_password !== confirm) { showToast('كلمات المرور غير متطابقة', 'warning'); return; }
  if (new_password.length < 6) { showToast('كلمة المرور قصيرة جداً', 'warning'); return; }
  try {
    await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ old_password, new_password }) });
    showToast('تم تغيير كلمة المرور', 'success');
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

// ── Users ─────────────────────────────────
async function loadUsers() {
  try {
    const data = await api('/api/auth/users');
    renderUsers(data);
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

function renderUsers(list) {
  const el = document.getElementById('usersBody');
  if (!el) return;
  const roleMap = { admin: ['danger', 'مدير'], cashier: ['primary', 'كاشير'], viewer: ['muted', 'مشاهد'] };
  el.innerHTML = list.map(u => {
    const [roleCls, roleLabel] = roleMap[u.role] || ['muted', u.role];
    return `<tr>
      <td>#${u.id}</td>
      <td class="font-bold">${u.full_name}</td>
      <td>${u.username}</td>
      <td><span class="badge badge-${roleCls}">${roleLabel}</span></td>
      <td>${u.phone || '—'}</td>
      <td><span class="badge badge-${u.is_active ? 'success' : 'danger'}">${u.is_active ? 'نشط' : 'موقوف'}</span></td>
      <td>${formatDate(u.last_login)}</td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="toggleUserStatus(${u.id}, ${u.is_active})">
          <i class="fas fa-${u.is_active ? 'ban' : 'check'}"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
}

async function saveUser() {
  const body = {
    username: document.getElementById('userUsername').value,
    password: document.getElementById('userPassword').value,
    full_name: document.getElementById('userFullName').value,
    role: document.getElementById('userRole').value,
    phone: document.getElementById('userPhone').value
  };
  if (!body.username || !body.password || !body.full_name) { showToast('البيانات المطلوبة غير مكتملة', 'warning'); return; }
  try {
    await api('/api/auth/users', { method: 'POST', body: JSON.stringify(body) });
    showToast('تم إنشاء الحساب', 'success');
    closeAllModals();
    loadUsers();
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function toggleUserStatus(id, current) {
  try {
    await api(`/api/auth/users/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: current ? 0 : 1 }) });
    showToast('تم تحديث الحالة', 'success');
    loadUsers();
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

// ── Modals ────────────────────────────────
function showModal(id) {
  document.getElementById('modalOverlay').classList.remove('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('hidden');
}

function closeAllModals() {
  document.getElementById('modalOverlay').classList.add('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

function closeModal(e) {
  if (e.target === document.getElementById('modalOverlay')) closeAllModals();
}

// ── Wallet dropdowns ──────────────────────
async function populateWalletDropdowns() {
  try {
    wallets = await api('/api/wallets');
    const opts = wallets.map(w => `<option value="${w.id}">${providerEmoji(w.provider)} ${w.name}</option>`).join('');
    const ids = ['txWallet', 'filterWallet', 'reportWallet'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const first = id === 'txWallet' ? '<option value="">اختر المحفظة</option>' : '<option value="">كل المحافظ</option>';
      el.innerHTML = first + opts;
    });
    if (selectedWalletId) {
      const txW = document.getElementById('txWallet');
      if (txW) { txW.value = selectedWalletId; onWalletSelectChange(); }
    }
  } catch {}
}

// ── Init ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Check existing token
  const saved = localStorage.getItem('token');
  if (saved) {
    token = saved;
    currentUser = JSON.parse(localStorage.getItem('user') || '{}');
    // Validate token
    api('/api/auth/me').then(user => {
      currentUser = user;
      showMainApp();
    }).catch(() => {
      localStorage.removeItem('token');
      token = '';
    });
  }

  // Auto-refresh every 60s
  setInterval(() => {
    const activePage = document.querySelector('.page:not(.hidden)')?.id?.replace('page-', '');
    if (activePage === 'dashboard') loadDashboard();
  }, 60000);

  // Keyboard shortcut: Escape closes modals
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllModals();
  });
});
