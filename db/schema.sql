-- ============================================================
-- CryptoNex Database Schema
-- Engine: MySQL 8.0+
-- Run this file once to initialize your database
-- ============================================================



-- ============================================================
-- TABLE 1: Users
-- Stores all registered users and their USDT balances.
-- IMPORTANT: DECIMAL(18,8) is used for money — NEVER FLOAT.
-- Float has rounding errors. e.g. 0.1 + 0.2 = 0.30000000004
-- ============================================================
CREATE TABLE IF NOT EXISTS Users (
  user_id       INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  name          VARCHAR(100)    NOT NULL,
  email         VARCHAR(255)    NOT NULL UNIQUE,
  password_hash VARCHAR(255)    NOT NULL,               -- bcrypt hash, never plain text
  upi_vpa       VARCHAR(100)    DEFAULT NULL,           -- e.g. user@okaxis
  pan_number    VARCHAR(20)     DEFAULT NULL,           -- masked on SELECT, e.g. ABCPX9876A
  usdt_balance  DECIMAL(18, 8)  NOT NULL DEFAULT 0.00000000,
  verified_status BOOLEAN       NOT NULL DEFAULT FALSE, -- KYC verified?
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id),
  INDEX idx_email (email)
) ENGINE=InnoDB;


-- ============================================================
-- TABLE 2: Price_Snapshots
-- Every time a payment is initiated, we capture the USDT/INR
-- rate at that exact millisecond. This is legally required
-- as audit proof — "the price WAS X when we charged Y".
-- ============================================================
CREATE TABLE IF NOT EXISTS Price_Snapshots (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  usdt_inr_rate DECIMAL(18, 4)  NOT NULL,               -- e.g. 84.5500 INR per 1 USDT
  usd_inr_rate  DECIMAL(18, 4)  NOT NULL DEFAULT 0.0000, -- from forex API
  source        VARCHAR(50)     NOT NULL DEFAULT 'coingecko', -- which API gave us this
  timestamp     TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3), -- millisecond precision!

  PRIMARY KEY (id),
  INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB;


-- ============================================================
-- TABLE 3: Transactions (The Core Ledger)
-- This is the heart of the app. Every UPI payment lives here.
-- Status lifecycle: PENDING -> SUCCESS or FAILED or REFUNDED
-- ============================================================
CREATE TABLE IF NOT EXISTS Transactions (
  tx_id           CHAR(36)        NOT NULL,             -- UUID like 'a1b2c3d4-...' (not INT, harder to guess/enumerate)
  user_id         INT UNSIGNED    NOT NULL,
  price_snapshot_id INT UNSIGNED  NOT NULL,             -- FK to Price_Snapshots (the rate used)
  
  inr_amount      DECIMAL(12, 2)  NOT NULL,             -- The bill e.g. 500.00 INR
  usdt_spent      DECIMAL(18, 8)  NOT NULL,             -- Calculated: inr_amount / usdt_inr_rate
  tds_deducted    DECIMAL(18, 8)  NOT NULL DEFAULT 0.00000000, -- 1% of usdt_spent per IT rules
  net_usdt_deducted DECIMAL(18,8) NOT NULL,             -- usdt_spent + tds_deducted
  
  merchant_vpa    VARCHAR(100)    NOT NULL,             -- Who got paid e.g. zomato@icici
  merchant_name   VARCHAR(100)    DEFAULT NULL,         -- Parsed from QR if available
  note            VARCHAR(255)    DEFAULT NULL,         -- User-entered note
  
  status          ENUM('PENDING','SUCCESS','FAILED','REFUNDED') NOT NULL DEFAULT 'PENDING',
  bank_ref_id     VARCHAR(100)    DEFAULT NULL,         -- Reference ID from the bank API
  failure_reason  VARCHAR(255)    DEFAULT NULL,         -- If FAILED, why?
  
  initiated_at    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    TIMESTAMP       DEFAULT NULL,         -- Set when SUCCESS or FAILED

  PRIMARY KEY (tx_id),
  FOREIGN KEY fk_tx_user (user_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
  FOREIGN KEY fk_tx_price (price_snapshot_id) REFERENCES Price_Snapshots(id) ON DELETE RESTRICT,
  INDEX idx_user_tx (user_id),
  INDEX idx_status (status),
  INDEX idx_initiated (initiated_at)
) ENGINE=InnoDB;


-- ============================================================
-- TABLE 4: Tax_Logs
-- Indian IT Act Section 194S: 1% TDS on crypto transfers.
-- Every deduction must be logged with PAN for ITR filing.
-- ============================================================
CREATE TABLE IF NOT EXISTS Tax_Logs (
  log_id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  tx_id           CHAR(36)        NOT NULL,             -- FK to Transactions
  user_id         INT UNSIGNED    NOT NULL,
  pan_number      VARCHAR(20)     NOT NULL,             -- e.g. ABCPX9876A (store encrypted in prod)
  tds_amount      DECIMAL(18, 8)  NOT NULL,             -- Same as tds_deducted in Transactions
  tds_inr_value   DECIMAL(12, 4)  NOT NULL,             -- INR equivalent at time of deduction
  financial_year  VARCHAR(10)     NOT NULL,             -- e.g. '2024-25'
  quarter         TINYINT UNSIGNED NOT NULL,            -- 1, 2, 3, or 4
  form_26as_filed BOOLEAN         NOT NULL DEFAULT FALSE, -- Has this been reported to IT dept?
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (log_id),
  FOREIGN KEY fk_tax_tx (tx_id) REFERENCES Transactions(tx_id) ON DELETE RESTRICT,
  FOREIGN KEY fk_tax_user (user_id) REFERENCES Users(user_id) ON DELETE RESTRICT,
  INDEX idx_tax_fy (financial_year),
  INDEX idx_tax_user (user_id),
  UNIQUE KEY unique_tx_tax (tx_id)                     -- One TDS log per transaction max
) ENGINE=InnoDB;


-- ============================================================
-- USEFUL VIEWS (optional but helpful for reporting)
-- ============================================================

-- Full transaction detail view (joins all tables)
CREATE OR REPLACE VIEW v_transaction_detail AS
SELECT
  t.tx_id,
  u.name            AS user_name,
  u.email           AS user_email,
  t.inr_amount,
  t.usdt_spent,
  t.tds_deducted,
  t.net_usdt_deducted,
  ps.usdt_inr_rate  AS rate_used,
  t.merchant_vpa,
  t.merchant_name,
  t.note,
  t.status,
  t.bank_ref_id,
  t.initiated_at,
  t.completed_at
FROM Transactions t
JOIN Users u         ON t.user_id = u.user_id
JOIN Price_Snapshots ps ON t.price_snapshot_id = ps.id;


-- User balance + stats summary
CREATE OR REPLACE VIEW v_user_summary AS
SELECT
  u.user_id,
  u.name,
  u.email,
  u.usdt_balance,
  u.verified_status,
  COUNT(t.tx_id)          AS total_transactions,
  SUM(t.inr_amount)       AS total_inr_spent,
  SUM(t.tds_deducted)     AS total_tds_paid
FROM Users u
LEFT JOIN Transactions t ON u.user_id = t.user_id AND t.status = 'SUCCESS'
GROUP BY u.user_id;
