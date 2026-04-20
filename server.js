// server.js
// ============================================================
// CryptoNex Backend — Express Server Entry Point
// Run: node server.js  (or: npm run dev  with nodemon)
// ============================================================

require('dotenv').config(); // Load .env FIRST before anything else

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { testConnection, runMigrations } = require('./db/database');

const app  = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// MIDDLEWARE STACK
// ============================================================

// helmet() sets ~15 security HTTP headers automatically
// (X-Frame-Options, Content-Security-Policy, etc.)
app.use(helmet());

// CORS — allow only your frontend origin in production
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? 'https://your-frontend-domain.com'   // 🔌 Replace with your domain
    : '*',                                  // Dev: allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parse JSON request bodies
app.use(express.json());

// Rate limiting — prevent brute force / abuse
// Auth endpoints get stricter limits
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // max 20 attempts per window
  message: { error: 'Too many requests, please try again later.' }
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
});

app.use('/api/auth', authLimiter);
app.use('/api/', generalLimiter);


// ============================================================
// ROUTES
// ============================================================
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/crypto',   require('./routes/crypto'));
app.use('/api/payments', require('./routes/payments'));


// Health check endpoint (useful for Docker/load balancer)
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});


// ============================================================
// START
// ============================================================
async function start() {
  try {
    await testConnection();       // Verify DB is reachable
    await runMigrations();        // Create tables if they don't exist
    app.listen(PORT, () => {
      console.log(`\n🚀 CryptoNex backend running on http://localhost:${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/health`);
      console.log(`   API:    http://localhost:${PORT}/api/...\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
