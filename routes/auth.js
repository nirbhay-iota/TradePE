// POST /api/auth/register  — Create new user
// POST /api/auth/login     — Sign in, receive JWT
// GET  /api/auth/me        — Get current user profile (protected)

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { pool } = require('../db/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { name, email, password, upi_vpa, initial_usdt } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const [existing] = await pool.query(
      'SELECT user_id FROM Users WHERE email = ?', [email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const startBalance = parseFloat(initial_usdt) || 0;
    const [result] = await pool.query(
      `INSERT INTO Users (name, email, password_hash, upi_vpa, usdt_balance)
       VALUES (?, ?, ?, ?, ?)`,
      [name, email.toLowerCase(), password_hash, upi_vpa || null, startBalance]
    );

    const userId = result.insertId;

    const token = jwt.sign(
      { user_id: userId, email: email.toLowerCase() },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return res.status(201).json({
      message: 'Account created successfully',
      token,
      user: { user_id: userId, name, email, upi_vpa: upi_vpa || null, usdt_balance: startBalance }
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Server error during registration' });
  }
});


router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT user_id, name, email, password_hash, upi_vpa, usdt_balance, verified_status FROM Users WHERE email = ?',
      [email.toLowerCase()]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { user_id: user.user_id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    delete user.password_hash;

    return res.json({ message: 'Login successful', token, user });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error during login' });
  }
});


router.get('/me', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT user_id, name, email, upi_vpa, usdt_balance, verified_status, created_at
       FROM Users WHERE user_id = ?`,
      [req.user.user_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});


module.exports = router;
