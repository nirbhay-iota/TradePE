require('dotenv').config(); 

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path'); // Added the path module here
const { testConnection, runMigrations } = require('./db/database');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? '*' // Temporarily set to '*' so your Railway domain doesn't block itself
    : '*',                                  
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100,                   
  message: { error: 'Too many requests, please try again later.' }
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 60,
});

app.use('/api/auth', authLimiter);
app.use('/api/', generalLimiter);

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/crypto', require('./routes/crypto'));
app.use('/api/payments', require('./routes/payments'));

// Health Check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ==========================================
// FRONTEND ROUTING 
// ==========================================
// Expose the public folder so the browser can download the CSS, JS, and Images
app.use(express.static(path.join(__dirname, 'public')));

// Serve the index.html file when someone visits the main URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ==========================================

// 404 handler (Will only catch bad API routes now, not the frontend)
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// START
async function start() {
  try {
    await testConnection();      
    await runMigrations();        
    app.listen(PORT, '0.0.0.0', () => { // Added 0.0.0.0 for reliable cloud binding
      console.log(`\n CryptoNex backend running on port ${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/health`);
      console.log(`   API:    http://localhost:${PORT}/api/...\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
