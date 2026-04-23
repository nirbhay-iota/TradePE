// frontend-api-integration.js — COMPLETE FIXED VERSION
// Overrides ALL functions that use the old localStorage DB system

// ---- CONFIG ----
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3001/api'
  : 'https://tradepe.up.railway.app/api';

// ---- TOKEN MANAGEMENT ----
function getToken()        { return localStorage.getItem('cnx_token'); }
function saveToken(t)      { localStorage.setItem('cnx_token', t); }
function clearToken()      { localStorage.removeItem('cnx_token'); localStorage.removeItem('cnx_user'); }
function getStoredUser()   { return JSON.parse(localStorage.getItem('cnx_user') || 'null'); }
function saveStoredUser(u) { localStorage.setItem('cnx_user', JSON.stringify(u)); }

// ---- HTTP HELPER ----
async function apiCall(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, {
    method, headers,
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- BALANCE HELPER ----
// Backend stores USDT. Frontend shows INR. Convert with live rate.
function getUsdtRate() {
  return priceCache?.usdt_inr_rate || 84;
}
function getBalanceINR() {
  if (!currentUser) return 0;
  return (parseFloat(currentUser.usdt_balance) || 0) * getUsdtRate();
}

// ============================================================
// PRICE CACHE
// ============================================================
var priceCache = null;
var currentSnapshotId = null;

async function fetchCryptoPrices() {
  try {
    const data = await apiCall('GET', '/crypto/prices');
    Object.keys(data.prices).forEach(sym => {
      if (cryptoPrices[sym]) {
        cryptoPrices[sym].priceINR  = data.prices[sym].priceINR;
        cryptoPrices[sym].change24h = data.prices[sym].change24h;
      }
    });
    priceCache = data;
    currentSnapshotId = data.snapshot_id;
    Object.keys(data.prices).forEach(sym => {
      if (chartHistory[sym]) {
        chartHistory[sym].push(data.prices[sym].priceINR);
        chartHistory[sym].shift();
      }
    });
    updateMiniCharts();
    updateConversionPreview();
  } catch (err) {
    console.warn('Price fetch failed, using cached:', err.message);
  }
}

// ============================================================
// AUTH — LOGIN
// ============================================================
async function handleLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { showToast('❌ Please fill in all fields', 'error'); return; }
  try {
    showToast('⏳ Signing in...', 'info');
    const data = await apiCall('POST', '/auth/login', { email, password });
    saveToken(data.token);
    saveStoredUser(data.user);
    currentUser = data.user;
    window.currentUser = data.user;
    showApp();
    showToast(`👋 Welcome back, ${data.user.name.split(' ')[0]}!`, 'success');
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

// ============================================================
// AUTH — REGISTER
// ============================================================
async function handleRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const deposit  = document.getElementById('reg-deposit').value || '0'; // ← fixed: .value directly

  if (!name || !email || !password) { showToast('❌ Please fill all fields', 'error'); return; }
  if (password.length < 6) { showToast('❌ Min 6 char password', 'error'); return; }

  try {
    showToast('⏳ Creating account...', 'info');
    const usdtRate    = getUsdtRate();
    const depositVal  = parseFloat(deposit) || 0;
    const initial_usdt = (depositVal / usdtRate).toFixed(8);

    const data = await apiCall('POST', '/auth/register', { name, email, password, initial_usdt });
    saveToken(data.token);
    saveStoredUser(data.user);
    currentUser = data.user;
    window.currentUser = data.user;
    showApp();
    showToast(`🎉 Account created! Welcome, ${name.split(' ')[0]}!`, 'success');
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

// ============================================================
// AUTH — LOGOUT  (overrides handleLogout in index.html)
// ============================================================
function handleLogout() {
  stopQRScan();
  clearToken();
  currentUser = null;
  window.currentUser = null;
  showAuth();
  showToast('👋 Signed out successfully', 'info');
}

// ============================================================
// INIT DASHBOARD  (overrides the one that calls DB.getUserByEmail)
// ============================================================
function initDashboard() {
  if (!currentUser) return;

  // Update sidebar & greeting — use name from backend user object
  const nameEl = document.getElementById('sidebar-username');
  if (nameEl) nameEl.textContent = currentUser.name || currentUser.email;

  const greetEl = document.getElementById('dashboard-greeting');
  if (greetEl) greetEl.textContent = `Good ${getTimeGreeting()}, ${(currentUser.name || currentUser.email).split(' ')[0]}`;

  const dateEl = document.getElementById('dash-date');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  // Use real prices from backend instead of simulated ticks
  fetchCryptoPrices();
  setInterval(fetchCryptoPrices, 15000);
}

function getTimeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}

// ============================================================
// RENDER DASHBOARD  (overrides the one that uses DB.getPayments)
// ============================================================
async function renderDashboard() {
  if (!currentUser) return;

  // Refresh balance from server
  try {
    const me = await apiCall('GET', '/auth/me');
    currentUser = me.user;
    window.currentUser = me.user;
    saveStoredUser(me.user);
  } catch(e) { /* use cached */ }

  const balanceINR = getBalanceINR();

  const dashBalance = document.getElementById('dash-balance');
  if (dashBalance) dashBalance.textContent = formatINR(balanceINR);

  // Fetch payment totals
  try {
    const data = await apiCall('GET', '/payments/history?limit=100');
    const payments = data.transactions || [];
    const totalPaid = payments
      .filter(p => p.status === 'SUCCESS')
      .reduce((s, p) => s + parseFloat(p.inr_amount), 0);

    const dashPaid = document.getElementById('dash-total-paid');
    if (dashPaid) dashPaid.textContent = formatINR(totalPaid);

    const dashTx = document.getElementById('dash-tx-count');
    if (dashTx) dashTx.textContent = payments.filter(p => p.status === 'SUCCESS').length;

    renderRecentTx(payments.slice(0, 5));
  } catch(e) {
    const dashPaid = document.getElementById('dash-total-paid');
    if (dashPaid) dashPaid.textContent = '₹0';
    const dashTx = document.getElementById('dash-tx-count');
    if (dashTx) dashTx.textContent = '0';
  }

  renderMiniCharts();
}

// Override renderRecentTx to handle backend transaction format
function renderRecentTx(payments) {
  const container = document.getElementById('recent-tx-container');
  if (!container) return;

  if (!payments || !payments.length) {
    container.innerHTML = '<div style="text-align: center; padding: 28px; color: var(--muted); font-size: 13px;">No transactions yet</div>';
    return;
  }

  // Handle both old format (localStorage) and new format (backend)
  container.innerHTML = payments.map(p => {
    // Backend format
    const upi    = p.merchant_vpa || p.upiId || '—';
    const inr    = p.inr_amount   || p.amountINR || 0;
    const status = p.status       || 'SUCCESS';
    const date   = p.initiated_at || p.createdAt || new Date().toISOString();
    const statusColor = status === 'SUCCESS' ? 'var(--green)' :
                        status === 'FAILED'  ? 'var(--red)'   : '#f7b335';
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid rgba(30,45,74,0.4);">
        <div>
          <div style="font-weight:600; font-size:14px; color:var(--neon);">${upi}</div>
          <div style="font-size:11px; color:var(--muted); margin-top:2px;">${new Date(date).toLocaleString('en-IN')}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700; font-family:'Space Mono'; color:var(--red);">-${formatINR(parseFloat(inr))}</div>
          <div style="font-size:11px; color:${statusColor};">${status}</div>
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// RENDER WALLET  (overrides the one that calls DB.getUserByEmail)
// ============================================================
async function renderWallet() {
  if (!currentUser) return;

  // Refresh balance from server
  try {
    const me = await apiCall('GET', '/auth/me');
    currentUser = me.user;
    window.currentUser = me.user;
    saveStoredUser(me.user);
  } catch(e) { /* use cached */ }

  const balanceINR = getBalanceINR();
  const walletBal = document.getElementById('wallet-balance');
  if (walletBal) walletBal.textContent = formatINR(balanceINR);

  // Show USDT balance in holdings table
  const usdt = parseFloat(currentUser.usdt_balance) || 0;
  const holdingsTable = document.getElementById('holdings-table');
  if (holdingsTable) {
    holdingsTable.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
        <span style="font-size:12px; color:var(--muted);">Total Balance (USDT)</span>
        <span style="font-weight:700; color:var(--green); font-family:'Space Mono';">${usdt.toFixed(6)} USDT</span>
      </div>
      <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 0; border-bottom:1px solid rgba(30,45,74,0.5);">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="crypto-icon" style="background:#0d1117; color:#26a17b; border:1px solid #26a17b40; width:36px; height:36px; font-size:12px;">₮</div>
          <div>
            <div style="font-weight:700; font-size:14px;">Tether USD</div>
            <div style="font-size:12px; color:var(--muted);" class="mono">${usdt.toFixed(6)} USDT</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:14px; font-weight:700; font-family:'Space Mono'; color:var(--green);">${formatINR(balanceINR)}</div>
          <span class="badge-up">Stablecoin</span>
        </div>
      </div>
    `;
  }
}

// ============================================================
// ADD FUNDS  (shows info — real funding needs a bank deposit flow)
// ============================================================
function addFunds() {
  const amount = parseFloat(document.getElementById('add-funds-amount').value);
  if (!amount || amount < 100) { showToast('❌ Minimum ₹100', 'error'); return; }

  // In a real app, this would initiate a bank deposit.
  // For now, show a message explaining the flow.
  showToast('ℹ️ To add funds, deposit INR via your bank and we convert to USDT. Contact support to enable deposits.', 'info');
  document.getElementById('add-funds-panel').style.display = 'none';
  document.getElementById('add-funds-amount').value = '';
}

// ============================================================
// PROCESS PAYMENT  (calls real backend)
// ============================================================
async function processPayment() {
  const upiId     = scannedUPI || document.getElementById('manual-upi').value.trim();
  const amountINR = parseFloat(document.getElementById('pay-amount-inr').value);
  const note      = document.getElementById('pay-note').value.trim();

  if (!upiId)                           { showToast('❌ Scan or enter a UPI ID', 'error'); return; }
  if (!amountINR || amountINR < 1)      { showToast('❌ Enter a valid amount', 'error'); return; }
  if (!currentSnapshotId)               { showToast('❌ Price not loaded. Wait a moment.', 'error'); return; }

  const balanceINR = getBalanceINR();
  if (balanceINR < amountINR) { showToast('❌ Insufficient balance', 'error'); return; }

  const btn = document.getElementById('pay-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Processing...';

  try {
    const data = await apiCall('POST', '/payments/initiate', {
      upi_id: upiId, inr_amount: amountINR, snapshot_id: currentSnapshotId, note,
    });

    showToast(`✅ Paid ₹${amountINR} to ${upiId} | Ref: ${data.bank_ref_id}`, 'success');

    // Refresh balance
    const me = await apiCall('GET', '/auth/me');
    currentUser = me.user;
    window.currentUser = me.user;
    saveStoredUser(currentUser);

    // Reset form
    document.getElementById('pay-upi-display').textContent = '— Not scanned yet —';
    document.getElementById('pay-amount-inr').value = '';
    document.getElementById('pay-note').value = '';
    document.getElementById('manual-upi').value = '';
    scannedUPI = '';
    updateCryptoAmount();
    renderDashboard();

  } catch (err) {
    showToast('❌ Payment failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔐 Confirm Payment';
  }
}

// ============================================================
// UPDATE CONVERSION PREVIEW  (uses real USDT balance)
// ============================================================
function updateCryptoAmount() {
  const amountINR  = parseFloat(document.getElementById('pay-amount-inr')?.value || 0);
  const sym        = document.getElementById('pay-crypto-select')?.value || 'BTC';
  const price      = cryptoPrices[sym]?.priceINR || 1;
  const cryptoAmt  = amountINR / price;
  const balanceINR = getBalanceINR();

  const convInr = document.getElementById('conv-inr');
  if (convInr) convInr.textContent = formatINR(amountINR || 0);

  const convCrypto = document.getElementById('conv-crypto');
  if (convCrypto) convCrypto.textContent = (cryptoAmt || 0).toFixed(8) + ' ' + sym;

  const convBal = document.getElementById('conv-balance');
  if (convBal) {
    convBal.textContent = formatINR(balanceINR);
    convBal.style.color = balanceINR >= amountINR ? 'var(--green)' : 'var(--red)';
  }
}

function updateConversionPreview() {
  updateCryptoAmount();
}

// ============================================================
// RENDER HISTORY  (fetches from backend)
// ============================================================
async function renderHistory() {
  try {
    const data     = await apiCall('GET', '/payments/history?limit=50');
    const payments = data.transactions || [];

    const totalPaid    = payments.filter(p => p.status === 'SUCCESS').reduce((s, p) => s + parseFloat(p.inr_amount), 0);
    const successCount = payments.filter(p => p.status === 'SUCCESS').length;
    const avgTx        = successCount ? totalPaid / successCount : 0;

    const statsEl = document.getElementById('history-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="card" style="padding:18px;">
          <div style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:6px;">Total Payments</div>
          <div style="font-size:24px; font-weight:700; color:var(--neon); font-family:'Space Mono';">${successCount}</div>
        </div>
        <div class="card" style="padding:18px;">
          <div style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:6px;">Total Spent</div>
          <div style="font-size:24px; font-weight:700; color:var(--red); font-family:'Space Mono';">${formatINR(totalPaid)}</div>
        </div>
        <div class="card" style="padding:18px;">
          <div style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:6px;">Avg Transaction</div>
          <div style="font-size:24px; font-weight:700; color:var(--accent); font-family:'Space Mono';">${formatINR(avgTx)}</div>
        </div>`;
    }

    const statusColors = {
      SUCCESS:  { bg: 'rgba(0,214,143,0.15)',  color: 'var(--green)', icon: '✓' },
      PENDING:  { bg: 'rgba(247,179,53,0.15)', color: '#f7b335',      icon: '⏳' },
      FAILED:   { bg: 'rgba(255,61,113,0.15)', color: 'var(--red)',   icon: '✗' },
      REFUNDED: { bg: 'rgba(123,92,250,0.15)', color: '#a78bfa',      icon: '↩' },
    };

    const container = document.getElementById('payments-table-container');
    if (!container) return;

    if (!payments.length) {
      container.innerHTML = '<div style="text-align:center; padding:60px; color:var(--muted); font-size:14px;">📭 No payments yet.</div>';
      return;
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Date & Time</th><th>UPI ID</th><th>Note</th>
            <th>USDT Spent</th><th>TDS (1%)</th><th>Rate</th><th>INR</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${payments.map(p => {
            const sc = statusColors[p.status] || statusColors.PENDING;
            return `<tr>
              <td class="mono" style="font-size:11px; color:var(--muted);">${new Date(p.initiated_at).toLocaleString('en-IN')}</td>
              <td style="font-weight:600; color:var(--neon);">${p.merchant_vpa}</td>
              <td style="color:var(--muted); font-size:12px;">${p.note || '—'}</td>
              <td class="mono" style="font-size:12px;">${parseFloat(p.usdt_spent).toFixed(6)} USDT</td>
              <td class="mono" style="font-size:12px; color:#f7b335;">${parseFloat(p.tds_deducted).toFixed(6)}</td>
              <td class="mono" style="font-size:11px; color:var(--muted);">₹${parseFloat(p.usdt_inr_rate).toFixed(2)}</td>
              <td style="font-weight:700; font-family:'Space Mono'; color:var(--red);">-${formatINR(parseFloat(p.inr_amount))}</td>
              <td><span style="background:${sc.bg}; color:${sc.color}; border-radius:6px; padding:3px 10px; font-size:12px;">${sc.icon} ${p.status}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

  } catch (err) {
    showToast('❌ Could not load history: ' + err.message, 'error');
  }
}

// ============================================================
// BOOT
// ============================================================
window.addEventListener('load', async () => {
  const storedUser = getStoredUser();
  const token      = getToken();

  if (storedUser && token) {
    currentUser = storedUser;
    window.currentUser = storedUser;
    showApp();
    // Verify token still valid
    try {
      const me = await apiCall('GET', '/auth/me');
      currentUser = me.user;
      window.currentUser = me.user;
      saveStoredUser(me.user);
      renderDashboard(); // re-render with fresh data
    } catch {
      clearToken();
      currentUser = null;
      window.currentUser = null;
      showAuth();
    }
  } else {
    showAuth();
  }
});
