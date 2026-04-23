// CryptoNex Backend 

require('dotenv').config(); 

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { testConnection, runMigrations } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3001;


app.use(helmet());

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? 'https://your-frontend-domain.com'   
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


app.use('/api/auth', require('./routes/auth'));
app.use('/api/crypto', require('./routes/crypto'));
app.use('/api/payments', require('./routes/payments'));


app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// 404 handler
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
    app.listen(PORT, () => {
      console.log(`\n CryptoNex backend running on http://localhost:${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/health`);
      console.log(`   API:    http://localhost:${PORT}/api/...\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
