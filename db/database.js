// db/database.js
// ============================================================
// MySQL Connection Pool using mysql2/promise
// We use a pool (not a single connection) so that multiple
// concurrent requests each get their own connection from the
// pool — this prevents "can't use connection in parallel" errors.
// ============================================================

const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');

// Create the pool once at startup. mysql2 manages acquiring/releasing.
const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               process.env.DB_PORT     || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'cryptonex',
  waitForConnections: true,
  connectionLimit:    10,     // max simultaneous connections
  queueLimit:         0,      // 0 = unlimited queue
  timezone:           '+00:00', // always store UTC in DB
  // Automatically cast DECIMAL columns to JS numbers:
  typeCast: function (field, next) {
    if (field.type === 'DECIMAL' || field.type === 'NEWDECIMAL') {
      return parseFloat(field.string());
    }
    return next();
  }
});

// ---- Helper: run a schema migration on startup ----
async function runMigrations() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // Split on semicolons to run each statement independently
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  const conn = await pool.getConnection();
  try {
    for (const stmt of statements) {
      await conn.query(stmt);
    }
    console.log('✅ Database migrations complete');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
    throw err;
  } finally {
    conn.release();
  }
}

// ---- Helper: test the connection on startup ----
async function testConnection() {
  const conn = await pool.getConnection();
  console.log('✅ MySQL connected');
  conn.release();
}

module.exports = { pool, testConnection, runMigrations };
