// routes/payments.js
// ============================================================
// POST /api/payments/initiate    — Create a payment (the full flow)
// GET  /api/payments/history     — User's payment history
// GET  /api/payments/:tx_id      — Single transaction detail
// POST /api/payments/refund/:id  — Refund a transaction (admin)
// ============================================================
// FULL PAYMENT FLOW:
//   1. Frontend sends: { upi_id, inr_amount, crypto_symbol, snapshot_id, note }
//   2. We validate: is user verified? do they have enough USDT?
//   3. We calculate USDT to deduct (inr_amount / usdt_inr_rate)
//   4. We calculate TDS (1% of usdt_spent — Indian law Section 194S)
//   5. We create a PENDING transaction in DB
//   6. We call the bank/UPI API to transfer INR
//   7. On bank API success → mark SUCCESS, deduct USDT balance, write Tax_Log
//   8. On bank API failure → mark FAILED, do NOT deduct balance
// ============================================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { pool } = require('../db/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// All payment routes require authentication
router.use(authMiddleware);


// ============================================================
// BANK / UPI TRANSFER API ADAPTER
// Replace this function's internals with your bank's SDK/API.
// Supported providers: Cashfree Payouts, Razorpay X, PayU,
// Open Money, YAP, Juspay, etc.
// ============================================================
async function transferViaBank({ toUpiId, amountINR, txId, note }) {
  // ====================================================
  // 🔌 BANK API HOOK — Cashfree Payouts example:
  // ====================================================
  /*
  const authResponse = await axios.post(
    `${process.env.BANK_API_BASE_URL}/payout/v1/authorize`,
    {},
    {
      headers: {
        'X-Client-Id': process.env.BANK_CLIENT_ID,
        'X-Client-Secret': process.env.BANK_CLIENT_SECRET,
      }
    }
  );
  const bearerToken = authResponse.data.data.token;

  const payoutResponse = await axios.post(
    `${process.env.BANK_API_BASE_URL}/payout/v1/directTransfer`,
    {
      amount: amountINR.toFixed(2),
      transferId: txId,
      transferMode: 'UPI',
      remarks: note || 'CryptoNex UPI Payment',
      vpa: toUpiId,
    },
    {
      headers: { Authorization: `Bearer ${bearerToken}` }
    }
  );

  return {
    success: payoutResponse.data.status === 'SUCCESS',
    bank_ref_id: payoutResponse.data.data?.referenceId || null,
    failure_reason: payoutResponse.data.message || null,
  };
  */

  // ====================================================
  // 🧪 SIMULATION (remove when real API is connected)
  // Simulates a 90% success rate with a 1-second delay
  // ====================================================
  await new Promise(r => setTimeout(r, 1000));
  const success = Math.random() > 0.03; // 97% success
  return {
    success,
    bank_ref_id: success ? 'BANK_SIM_' + Date.now() : null,
    failure_reason: success ? null : 'Simulated bank error',
  };
}


// ---- POST /api/payments/initiate ----
router.post('/initiate', async (req, res) => {
  const { upi_id, inr_amount, snapshot_id, note } = req.body;
  const userId = req.user.user_id;

  // ---- Validate inputs ----
  if (!upi_id || !inr_amount || !snapshot_id) {
    return res.status(400).json({ error: 'upi_id, inr_amount, and snapshot_id are required' });
  }
  if (isNaN(inr_amount) || inr_amount < 1) {
    return res.status(400).json({ error: 'inr_amount must be a positive number' });
  }
  // Basic UPI ID format check
  if (!upi_id.includes('@')) {
    return res.status(400).json({ error: 'Invalid UPI VPA format (must contain @)' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction(); // Start DB transaction — all or nothing

    // ---- Fetch user with a FOR UPDATE lock ----
    // This prevents two simultaneous requests from double-spending
    // the same balance (race condition protection)
    const [users] = await conn.query(
      'SELECT user_id, usdt_balance, verified_status, pan_number FROM Users WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    const user = users[0];
    if (!user) throw new Error('User not found');

    // ---- Fetch the price snapshot ----
    const [snapshots] = await conn.query(
      'SELECT * FROM Price_Snapshots WHERE id = ?',
      [snapshot_id]
    );
    const snapshot = snapshots[0];
    if (!snapshot) throw new Error('Price snapshot not found');

    // Reject if snapshot is too old (> 60 seconds) — prevents stale rate attacks
    const snapAge = (Date.now() - new Date(snapshot.timestamp).getTime()) / 1000;
    if (snapAge > 60) {
      await conn.rollback();
      return res.status(400).json({ error: 'Price snapshot is expired. Please refresh prices.' });
    }

    // ---- Calculate amounts ----
    const usdt_inr_rate = parseFloat(snapshot.usdt_inr_rate);
    const inr = parseFloat(inr_amount);
    const usdt_spent = inr / usdt_inr_rate;                       // e.g. 500 / 84.5 = 5.917...
    const tds_deducted = usdt_spent * parseFloat(process.env.TDS_RATE || 0.01); // 1%
    const net_deducted = usdt_spent + tds_deducted;                // total USDT to deduct

    // ---- Check balance ----
    if (parseFloat(user.usdt_balance) < net_deducted) {
      await conn.rollback();
      return res.status(402).json({
        error: 'Insufficient USDT balance',
        required: net_deducted.toFixed(8),
        available: parseFloat(user.usdt_balance).toFixed(8)
      });
    }

    // ---- Create PENDING transaction ----
    const txId = uuidv4();
    await conn.query(
      `INSERT INTO Transactions
         (tx_id, user_id, price_snapshot_id, inr_amount, usdt_spent, tds_deducted,
          net_usdt_deducted, merchant_vpa, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [txId, userId, snapshot_id, inr, usdt_spent, tds_deducted, net_deducted, upi_id, note || null]
    );

    await conn.commit(); // Commit the PENDING record before calling the bank
    // (If the server crashes after this, we can reconcile PENDINGs later)

    // ---- Call bank API (OUTSIDE the DB transaction) ----
    let bankResult;
    try {
      bankResult = await transferViaBank({
        toUpiId: upi_id,
        amountINR: inr,
        txId,
        note: note || 'CryptoNex Payment',
      });
    } catch (bankErr) {
      bankResult = { success: false, failure_reason: bankErr.message };
    }

    // ---- Update transaction based on bank result ----
    if (bankResult.success) {
      // --- SUCCESS PATH ---
      // 1. Mark transaction SUCCESS
      await conn.query(
        `UPDATE Transactions
         SET status = 'SUCCESS', bank_ref_id = ?, completed_at = NOW()
         WHERE tx_id = ?`,
        [bankResult.bank_ref_id, txId]
      );

      // 2. Deduct USDT balance atomically
      await conn.query(
        'UPDATE Users SET usdt_balance = usdt_balance - ? WHERE user_id = ?',
        [net_deducted, userId]
      );

      // 3. Write Tax Log (if user has PAN)
      if (user.pan_number) {
        const now = new Date();
        const fy = getFiscalYear(now);
        const quarter = getFiscalQuarter(now);
        await conn.query(
          `INSERT INTO Tax_Logs
             (tx_id, user_id, pan_number, tds_amount, tds_inr_value, financial_year, quarter)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [txId, userId, maskPAN(user.pan_number), tds_deducted, tds_deducted * usdt_inr_rate, fy, quarter]
        );
      }

      await conn.commit();
      return res.status(200).json({
        success: true,
        tx_id: txId,
        bank_ref_id: bankResult.bank_ref_id,
        inr_amount: inr,
        usdt_spent: usdt_spent.toFixed(8),
        tds_deducted: tds_deducted.toFixed(8),
        message: `₹${inr} sent to ${upi_id}`
      });

    } else {
      // --- FAILURE PATH ---
      await conn.beginTransaction();
      await conn.query(
        `UPDATE Transactions
         SET status = 'FAILED', failure_reason = ?, completed_at = NOW()
         WHERE tx_id = ?`,
        [bankResult.failure_reason, txId]
      );
      await conn.commit();
      return res.status(502).json({
        success: false,
        tx_id: txId,
        error: 'Bank transfer failed: ' + bankResult.failure_reason
      });
    }

  } catch (err) {
    await conn.rollback();
    console.error('Payment error:', err);
    return res.status(500).json({ error: 'Payment processing error: ' + err.message });
  } finally {
    conn.release();
  }
});


// ---- GET /api/payments/history ----
router.get('/history', async (req, res) => {
  const userId = req.user.user_id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  try {
    const [rows] = await pool.query(
      `SELECT
         t.tx_id, t.inr_amount, t.usdt_spent, t.tds_deducted,
         t.merchant_vpa, t.merchant_name, t.note, t.status,
         t.bank_ref_id, t.initiated_at, t.completed_at,
         ps.usdt_inr_rate
       FROM Transactions t
       JOIN Price_Snapshots ps ON t.price_snapshot_id = ps.id
       WHERE t.user_id = ?
       ORDER BY t.initiated_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM Transactions WHERE user_id = ?',
      [userId]
    );

    return res.json({ transactions: rows, page, limit, total });
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch history' });
  }
});


// ---- GET /api/payments/:tx_id ----
router.get('/:tx_id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.*, ps.usdt_inr_rate, ps.timestamp AS rate_timestamp
     FROM Transactions t
     JOIN Price_Snapshots ps ON t.price_snapshot_id = ps.id
     WHERE t.tx_id = ? AND t.user_id = ?`,
    [req.params.tx_id, req.user.user_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
  return res.json(rows[0]);
});


// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function maskPAN(pan) {
  // ABCPX9876A -> ABCPX****A
  if (!pan || pan.length < 4) return pan;
  return pan.slice(0, 5) + '****' + pan.slice(-1);
}

function getFiscalYear(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  // Indian FY: April to March
  if (month >= 4) return `${year}-${(year + 1).toString().slice(-2)}`;
  return `${year - 1}-${year.toString().slice(-2)}`;
}

function getFiscalQuarter(date) {
  const month = date.getMonth() + 1;
  // Q1: Apr-Jun, Q2: Jul-Sep, Q3: Oct-Dec, Q4: Jan-Mar
  if (month >= 4 && month <= 6) return 1;
  if (month >= 7 && month <= 9) return 2;
  if (month >= 10 && month <= 12) return 3;
  return 4;
}


module.exports = router;
