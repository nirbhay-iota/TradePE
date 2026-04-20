# backend ko chalana padta hai phle project me folder me jake yeh command:
# npm run dev

# frontend ko bhi serve krna padta hai using command in another terminal of project folder:
# npx serve .



# CryptoNex — Developer Architecture Guide

## 1. What the Current Frontend App Is Doing

### Tech Stack
| Layer | What | Why |
|-------|------|-----|
| HTML structure | Semantic HTML5 | Single file, no build step needed |
| Styling | Tailwind CDN + custom CSS variables | Utility-first, dark theme via `:root` vars |
| Charts | Chart.js v4 (CDN) | Canvas-based, lightweight, good for financial data |
| QR Scanner | html5-qrcode (CDN) | Wraps browser's `getUserMedia` + `BarcodeDetector` API |
| Fonts | Google Fonts (JetBrains Mono, Syne, Space Mono) | Loaded from CDN |

### How the Single-Page App (SPA) Routing Works
There is **no React, no Vue, no router library**. It's manual DOM toggling:
```
showAuth()    → hides #page-app,    shows #page-auth
showApp()     → hides #page-auth,   shows #page-app
switchTab(x)  → hides all .tab-content divs, shows #tab-{x}
```
Each "page" is a `<div>` that is shown/hidden with `style.display`. This is
called a "multi-page illusion" pattern — everything is already in the DOM,
we just hide what we don't need.

---

## 2. Where User Data Is Stored (Current Version)

### localStorage — The "Database"
```
localStorage['cryptonex_users']    = JSON string of User[]
localStorage['cryptonex_payments'] = JSON string of Payment[]
```
`sessionStorage['cryptonex_session']` = currently logged-in user object

**Why this is only for prototyping:**
- Data lives in the BROWSER, not a server
- Anyone can open DevTools and edit their own balance
- If you clear browser data, everything is gone
- No user can log in from a different device
- No security at all (passwords stored in plain text!)

---

## 3. How the Price Simulation Works

```
cryptoPrices = { BTC: { priceINR: 6850000, change24h: 2.3 }, ... }
chartHistory = { BTC: [price1, price2, ... price30], ... }  // ring buffer

setInterval(() => {
  simulatePriceTick()    // adds ±0.3% random noise to each price
  updateMiniCharts()     // pushes new price into chartHistory, re-renders charts
}, 3000)
```
Chart.js re-renders in `'none'` animation mode (instant) so charts
update smoothly without flickering.

---

## 4. How the QR Scanner Works
```
html5QrCode.start({ facingMode: 'environment' }, config, onSuccess, onError)
```
This calls `navigator.mediaDevices.getUserMedia({ video: true })` —
the browser's camera API. When a QR code is detected, `onSuccess(decodedText)`
fires. We parse the UPI deep-link format:
```
upi://pay?pa=merchant@bank&pn=MerchantName&am=500.00&cu=INR
                ↑ UPI VPA         ↑ name        ↑ amount
```
We extract `pa` (payee address) and optionally `am` (amount) from the URL params.

---

## 5. The Full Backend Architecture

```
Browser (HTML/JS)
    │
    │  HTTP REST (JSON)
    ▼
Express Server (Node.js)   ← server.js
    │
    ├── /api/auth/*        ← routes/auth.js
    │       ├── POST /register   → INSERT Users
    │       ├── POST /login      → SELECT + bcrypt.compare → JWT
    │       └── GET  /me         → SELECT (protected by JWT middleware)
    │
    ├── /api/crypto/*      ← routes/crypto.js
    │       └── GET /prices      → CoinGecko API → INSERT Price_Snapshots
    │
    └── /api/payments/*    ← routes/payments.js
            ├── POST /initiate   → Full payment flow (see below)
            └── GET  /history    → SELECT Transactions JOIN Price_Snapshots
    │
    ▼
MySQL 8.0 (cryptonex DB)
    ├── Users
    ├── Price_Snapshots
    ├── Transactions
    └── Tax_Logs
```

---

## 6. The Payment Flow — Step by Step

```
Frontend                        Backend                     Bank API
   │                               │                           │
   ├─── GET /crypto/prices ────────►                           │
   │◄── { prices, snapshot_id } ───┤                           │
   │                               │ INSERT Price_Snapshots    │
   │                               │                           │
   │  [User fills form & clicks Pay]                           │
   │                               │                           │
   ├─── POST /payments/initiate ───►                           │
   │    { upi_id, inr_amount,       │                           │
   │      snapshot_id }             │                           │
   │                               ├─ SELECT Users FOR UPDATE  │
   │                               ├─ Check balance            │
   │                               ├─ Calculate USDT + TDS     │
   │                               ├─ INSERT Transactions(PENDING)
   │                               │                           │
   │                               ├──── POST /transfer ───────►
   │                               │     { toUpiId, amount }   │
   │                               │◄─── { success, ref_id } ──┤
   │                               │                           │
   │                               ├─ UPDATE Transactions(SUCCESS/FAILED)
   │                               ├─ UPDATE Users.usdt_balance
   │                               └─ INSERT Tax_Logs
   │                               │
   │◄── { success, tx_id, ref_id } ─┤
   │                               │
   [UI shows success/failure toast]
```

### Why `FOR UPDATE` on the SELECT?
This is a **database row-level lock**. Without it, if a user clicks Pay twice
very fast (or two requests race), both could read the same balance, both see
"sufficient funds", and both deduct — resulting in a negative balance.
`SELECT ... FOR UPDATE` makes the second request WAIT until the first
transaction commits, then reads the updated balance.

---

## 7. The 4 Database Tables — Why Each Exists

### Users
The master identity table. `usdt_balance` is `DECIMAL(18,8)` because:
- `FLOAT` has binary rounding errors: `0.1 + 0.2 = 0.30000000000000004`
- `DECIMAL` is exact fixed-point arithmetic — critical for money

### Price_Snapshots
Every payment references a snapshot row. This means 6 months later, if
a user disputes "why was I charged 5.9 USDT for ₹500?", you can query:
```sql
SELECT ps.usdt_inr_rate FROM Transactions t
JOIN Price_Snapshots ps ON t.price_snapshot_id = ps.id
WHERE t.tx_id = 'disputed-tx-id';
-- Returns: 84.5500 (the exact rate at time of payment)
```
This is legally required for crypto payment processors in India.

### Transactions
The immutable ledger. Note the status enum:
- `PENDING` → payment initiated, bank API called
- `SUCCESS` → bank confirmed transfer
- `FAILED`  → bank rejected (no funds deducted)
- `REFUNDED` → you reversed it manually

Use `tx_id` as UUID (not auto-increment INT) — UUIDs can't be guessed,
so users can't enumerate other people's transactions.

### Tax_Logs
Indian IT Act Section 194S (effective July 2022): 1% TDS on crypto
transfers above ₹50,000/year (₹10,000 for high-volume). You must:
1. Deduct 1% from each transaction
2. Log it with the user's PAN number
3. Report it quarterly via Form 26AS / TDS return

Store PAN **encrypted** in production (use AES-256 or a KMS).

---

## 8. How to Run Everything

### Prerequisites
```bash
# Install Node.js 18+, MySQL 8.0+
node --version   # >= 18
mysql --version  # >= 8
```

### Step 1: MySQL Setup
```sql
-- In MySQL shell:
CREATE USER 'cryptonex_user'@'localhost' IDENTIFIED BY 'strong_password';
GRANT ALL PRIVILEGES ON cryptonex.* TO 'cryptonex_user'@'localhost';
FLUSH PRIVILEGES;
-- The schema is auto-created by runMigrations() on server start
```

### Step 2: Backend Setup
```bash
cd cryptonex-backend
cp .env.example .env
# Edit .env with your MySQL credentials and secrets
npm install
npm run dev     # uses nodemon for auto-restart
```

### Step 3: Connect Frontend
In `crypto-trading-app.html`, before `</body>`, add:
```html
<script src="frontend-api-integration.js"></script>
```
This overrides the mock functions (`handleLogin`, `processPayment`, etc.)
with real API-calling versions.

Open `crypto-trading-app.html` directly in browser (or serve via any
static server: `npx serve .`)

---

## 9. Connecting a Real Bank / UPI API

### Recommended Indian Fintech APIs for UPI Payouts
| Provider | Sandbox | Docs |
|----------|---------|------|
| Cashfree Payouts | Free sandbox | https://docs.cashfree.com/docs/payout-integration |
| Razorpay X | Free sandbox | https://razorpay.com/docs/razorpayx/ |
| PayU | Request access | https://developer.payu.in |
| Decentro | Free sandbox | https://docs.decentro.tech |

### In `routes/payments.js`, find `transferViaBank()` and replace:
```js
// Cashfree example (already commented in the file)
// 1. Get bearer token
// 2. POST /directTransfer with vpa, amount, transferId
// 3. Return success/failure + referenceId
```

---

## 10. Security Checklist Before Going Live
- [ ] Hash passwords with bcrypt (already done in auth.js)
- [ ] Encrypt PAN numbers with AES-256 before storing
- [ ] Use HTTPS only in production (never HTTP)
- [ ] Move COINGECKO/bank API calls to backend (never expose keys in frontend)
- [ ] Add KYC verification before allowing payments > ₹10,000
- [ ] Implement webhook handler for async bank callbacks
- [ ] Add idempotency keys to bank API calls (prevent duplicate transfers)
- [ ] Set up DB backups (daily minimum)
- [ ] Enable MySQL binary logging for audit trail
- [ ] Add 2FA for high-value accounts
- [ ] Register as a Virtual Digital Asset Service Provider (VASP) with FIU-IND
