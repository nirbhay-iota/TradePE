// routes/crypto.js
// ============================================================
// GET /api/crypto/prices      — Get live prices + save snapshot
// GET /api/crypto/snapshot/:id — Get a specific price snapshot
// ============================================================
// HOW THE PRICE PIPELINE WORKS:
//   1. Frontend calls /api/crypto/prices every ~15 seconds
//   2. We call CoinGecko's free API for INR prices
//   3. We INSERT a row into Price_Snapshots (the audit trail)
//   4. We return the prices + snapshot ID to the frontend
//   5. When a payment is made, it references that snapshot_id
//      so we can PROVE what the price was at payment time

const express = require('express');
const axios   = require('axios');
const { pool } = require('../db/database');

const router = express.Router();


let priceCache = null;
let cacheTime  = 0;
const CACHE_TTL_MS = 15000; 
const COIN_IDS = {
  USDT: 'tether',
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  SOL: 'solana',
  XRP: 'ripple',
};


router.get('/prices', async (req, res) => {
  const now = Date.now();

  // Return cached data if fresh
  if (priceCache && (now - cacheTime) < CACHE_TTL_MS) {
    return res.json(priceCache);
  }

  try {
  
    const coinIds = Object.values(COIN_IDS).join(',');
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price',
      {
        params: {
          ids: coinIds,
          vs_currencies: 'inr,usd',
          include_24hr_change: 'true',
          include_24hr_vol: 'true',
        },
        headers: process.env.COINGECKO_API_KEY
          ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY }
          : {},
        timeout: 5000,
      }
    );

    const data = response.data;

    const prices = {};
    for (const [sym, coinId] of Object.entries(COIN_IDS)) {
      const coin = data[coinId];
      if (coin) {
        prices[sym] = {
          priceINR:   coin.inr,
          priceUSD:   coin.usd,
          change24h:  coin.inr_24h_change || 0,
          volume24h:  coin.inr_24h_vol    || 0,
        };
      }
    }

   
    const usdtInrRate = prices.BTC?.priceINR / prices.BTC?.priceUSD || 84.0;
    const [snapResult] = await pool.query(
      `INSERT INTO Price_Snapshots (usdt_inr_rate, usd_inr_rate, source)
       VALUES (?, ?, 'coingecko')`,
      [usdtInrRate.toFixed(4), usdtInrRate.toFixed(4)]
    );

    const result = {
      prices,
      snapshot_id: snapResult.insertId,
      usdt_inr_rate: usdtInrRate,
      fetched_at: new Date().toISOString(),
      source: 'coingecko'
    };

    // Update cache
    priceCache = result;
    cacheTime  = now;

    return res.json(result);

  } catch (err) {
    console.error('CoinGecko error:', err.message);

    if (priceCache) {
      return res.json({ ...priceCache, stale: true });
    }

    return res.json({
      prices: {
        BTC:  { priceINR: 6850000, priceUSD: 81500, change24h: 0 },
        ETH:  { priceINR:  310000, priceUSD:  3690, change24h: 0 },
        BNB:  { priceINR:   52000, priceUSD:   619, change24h: 0 },
        SOL:  { priceINR:   15800, priceUSD:   188, change24h: 0 },
        XRP:  { priceINR:     220, priceUSD:  2.62, change24h: 0 },
      },
      snapshot_id: null,
      usdt_inr_rate: 84.0,
      fetched_at: new Date().toISOString(),
      source: 'fallback',
      error: 'CoinGecko unavailable'
    });
  }
});


router.get('/snapshot/:id', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM Price_Snapshots WHERE id = ?',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Snapshot not found' });
  return res.json(rows[0]);
});


module.exports = router;
