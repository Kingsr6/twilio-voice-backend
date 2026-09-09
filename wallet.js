const { Pool } = require("pg");
const crypto = require("crypto");
const express = require("express");

const router = express.Router();

// ============================================================
// CONFIGURATION
// ============================================================

const DATABASE_URL = process.env.DATABASE_URL;
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

if (!DATABASE_URL) console.error("[wallet] DATABASE_URL is missing.");
if (!BASE44_APP_ID) console.error("[wallet] BASE44_APP_ID is missing.");
if (!FLW_SECRET_KEY) console.error("[wallet] FLW_SECRET_KEY is missing.");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// ============================================================
// DATABASE SCHEMA
// ============================================================

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id       TEXT PRIMARY KEY,
      balance       NUMERIC(12,2) NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payment_intents (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      amount              NUMERIC(12,2) NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'NGN',
      tx_ref              TEXT NOT NULL UNIQUE,
      status              TEXT NOT NULL DEFAULT 'pending',
      flw_transaction_id  TEXT UNIQUE,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      credited_at         TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS funding_credits (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      amount              NUMERIC(12,2) NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'NGN',
      tx_ref              TEXT UNIQUE,
      flw_transaction_id  TEXT NOT NULL UNIQUE,
      flw_ref             TEXT,
      payment_method      TEXT,
      status              TEXT NOT NULL DEFAULT 'successful',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS call_charges (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL,
      call_log_id          TEXT NOT NULL UNIQUE,
      destination_number   TEXT NOT NULL,
      destination_network  TEXT NOT NULL,
      duration_seconds     INTEGER NOT NULL,
      billed_minutes       NUMERIC(8,2) NOT NULL,
      rate_per_minute      NUMERIC(8,2) NOT NULL,
      amount               NUMERIC(12,2) NOT NULL,
      currency              TEXT NOT NULL DEFAULT 'NGN',
      provider             TEXT NOT NULL DEFAULT 'twilio',
      provider_call_id     TEXT,
      status               TEXT NOT NULL DEFAULT 'successful',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS migration_audit (
      user_id              TEXT PRIMARY KEY,
      old_base44_balance   NUMERIC(12,2) NOT NULL,
      migrated_pg_balance  NUMERIC(12,2) NOT NULL DEFAULT 0,
      status                TEXT NOT NULL,
      error_message         TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN';

    ALTER TABLE funding_credits
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN';

    ALTER TABLE funding_credits
      ADD COLUMN IF NOT EXISTS payment_method TEXT;

    ALTER TABLE call_charges
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_credits_tx_ref_unique
      ON funding_credits(tx_ref)
      WHERE tx_ref IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_payment_intents_user
      ON payment_intents(user_id);

    CREATE INDEX IF NOT EXISTS idx_payment_intents_tx_ref
      ON payment_intents(tx_ref);

    CREATE INDEX IF NOT EXISTS idx_funding_credits_user
      ON funding_credits(user_id);

    CREATE INDEX IF NOT EXISTS idx_call_charges_user
      ON call_charges(user_id);

    CREATE INDEX IF NOT EXISTS idx_migration_audit_status
      ON migration_audit(status);
  `);

  console.log("[wallet] PostgreSQL schema ready");
}

const schemaReady = initSchema().catch((error) => {
  console.error("[wallet] Schema initialization failed:", error);
  process.exit(1);
});

// ============================================================
// BASE44 AUTHENTICATION
// ============================================================

let createBase44Client = null;

async function getCreateClient() {
  if (!createBase44Client) {
    const module = await import("@base44/sdk");
    createBase44Client = module.createClient;
  }
  return createBase44Client;
}

async function authMiddleware(req, res, next) {
  await schemaReady;

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing authentication token" });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: "Invalid authentication token" });
  }

  if (!BASE44_APP_ID) {
    return res.status(500).json({ error: "BASE44_APP_ID is not configured" });
  }

  try {
    const createClient = await getCreateClient();
    const base44 = createClient({
      appId: BASE44_APP_ID,
      token,
      serverUrl: "https://base44.app",
    });

    const user = await base44.auth.me();
    if (!user || !user.id) {
      return res.status(401).json({ error: "Invalid authentication" });
    }

    req.authUserId = user.id;
    req.base44Client = base44;
    req.authUser = user;
    return next();
  } catch (error) {
    console.error("[wallet/auth] Token validation failed:", error.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
}

router.use(authMiddleware);

// ============================================================
// NETWORK DETECTION / RATES
// ============================================================

const NETWORK_PREFIXES = {
  MTN: ["0703", "0706", "0803", "0806", "0810", "0813", "0814", "0816", "0903", "0906", "0913", "0916"],
  Airtel: ["0701", "0708", "0802", "0808", "0812", "0901", "0902", "0904", "0907", "0912"],
  Glo: ["0705", "0805", "0807", "0811", "0815", "0905", "0915"],
  "9mobile": ["0809", "0817", "0818", "0908", "0909"],
};

function detectNetwork(phoneNumber) {
  if (!phoneNumber) return "Other";

  let number = String(phoneNumber).trim().replace(/[\s().-]/g, "");
  number = number.replace(/^\+234/, "0").replace(/^234/, "0");
  const prefix = number.substring(0, 4);

  for (const [network, prefixes] of Object.entries(NETWORK_PREFIXES)) {
    if (prefixes.includes(prefix)) return network;
  }
  return "Other";
}

let ratesCache = null;
let ratesCacheTime = 0;
const RATES_TTL_MS = 5 * 60 * 1000;

async function getRates(base44Client) {
  const now = Date.now();
  if (ratesCache && now - ratesCacheTime < RATES_TTL_MS) return ratesCache;

  const rates = await base44Client.entities.CallRate.filter({
    country: "Nigeria",
    active: true,
  });

  ratesCache = rates || [];
  ratesCacheTime = now;
  return ratesCache;
}

async function getRateForNetwork(base44Client, network) {
  const rates = await getRates(base44Client);
  return (
    rates.find((rate) => rate.network === network && rate.active === true) ||
    rates.find((rate) => rate.network === "Other" && rate.active === true) ||
    null
  );
}

// ============================================================
// BILLING HELPERS
// ============================================================

const BILLING_INCREMENT_SECONDS = 60;

function calculateBilledMinutes(durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(seconds / BILLING_INCREMENT_SECONDS);
}

function calculateCost(billedMinutes, ratePerMinute) {
  return Number((Number(billedMinutes) * Number(ratePerMinute)).toFixed(2));
}

async function ensureWallet(userId) {
  await pool.query(
    `INSERT INTO wallets (user_id, balance)
     VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function getBalance(clientOrPool, userId) {
  const result = await clientOrPool.query(
    "SELECT balance FROM wallets WHERE user_id = $1",
    [userId]
  );
  return result.rows.length ? Number(result.rows[0].balance) : 0;
}

// ============================================================
// GET /wallet/balance
// ============================================================

router.get("/wallet/balance", async (req, res) => {
  try {
    await ensureWallet(req.authUserId);
    const balance = await getBalance(pool, req.authUserId);
    return res.json({ balance, currency: "NGN" });
  } catch (error) {
    console.error("[wallet/balance] Error:", error);
    return res.status(500).json({ error: "Could not retrieve wallet balance." });
  }
});

// ============================================================
// POST /wallet/intent
// ============================================================

router.post("/wallet/intent", async (req, res) => {
  const rawAmount = Number(req.body?.amount);
  const amount = Math.round(rawAmount * 100) / 100;

  if (!Number.isFinite(amount) || amount < 100) {
    return res.status(400).json({ error: "Minimum wallet funding amount is ₦100." });
  }

  if (amount > 1000000) {
    return res.status(400).json({ error: "Maximum wallet funding amount is ₦1,000,000." });
  }

  const intentId = `pi_${crypto.randomUUID()}`;
  const txRef = `GCWALLET-${crypto.randomUUID()}`;

  try {
    await pool.query(
      `INSERT INTO payment_intents
       (id, user_id, amount, currency, tx_ref, status)
       VALUES ($1, $2, $3, 'NGN', $4, 'pending')`,
      [intentId, req.authUserId, amount, txRef]
    );

    return res.json({
      intent_id: intentId,
      tx_ref: txRef,
      amount,
      currency: "NGN",
    });
  } catch (error) {
    console.error("[wallet/intent] Error:", error);
    return res.status(500).json({ error: "Could not create payment intent." });
  }
});

// ============================================================
// FLUTTERWAVE VERIFICATION
// ============================================================

async function verifyFlwTransaction(transactionId) {
  const url = `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${FLW_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();

  if (!response.ok || data.status !== "success") {
    throw new Error(data.message || `Flutterwave verification failed (${response.status})`);
  }

  const tx = data.data;
  if (!tx || tx.id === undefined || tx.id === null) {
    throw new Error("Flutterwave returned an invalid transaction record.");
  }

  return {
    tx_ref: String(tx.tx_ref || ""),
    amount: Number(tx.amount),
    currency: String(tx.currency || "").toUpperCase(),
    status: String(tx.status || "").toLowerCase(),
    payment_type: tx.payment_type || "Flutterwave",
    transaction_id: String(tx.id),
    flw_ref: tx.flw_ref || null,
  };
}

// ============================================================
// POST /wallet/credit
// Secure, atomic, idempotent funding credit.
// ============================================================

router.post("/wallet/credit", async (req, res) => {
  const txRef = String(req.body?.tx_ref || "").trim();
  const transactionId = String(req.body?.transaction_id || "").trim();

  if (!txRef || !transactionId) {
    return res.status(400).json({ error: "tx_ref and transaction_id are required." });
  }

  if (!FLW_SECRET_KEY) {
    return res.status(500).json({ error: "Flutterwave server configuration is missing." });
  }

  // External API verification happens BEFORE opening the DB transaction.
  // No database lock is held while waiting on Flutterwave.
  let flwTx;
  try {
    flwTx = await verifyFlwTransaction(transactionId);
  } catch (error) {
    console.error("[wallet/credit] Flutterwave verification failed:", error.message);
    return res.status(400).json({
      credited: false,
      error: "Flutterwave did not confirm this payment.",
    });
  }

  if (flwTx.status !== "successful") {
    return res.status(400).json({
      credited: false,
      error: "Flutterwave transaction is not successful.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the intent BEFORE checking/changing its status.
    const intentResult = await client.query(
      `SELECT *
       FROM payment_intents
       WHERE tx_ref = $1
       FOR UPDATE`,
      [txRef]
    );

    if (!intentResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ credited: false, error: "Unknown payment intent." });
    }

    const intent = intentResult.rows[0];

    if (intent.user_id !== req.authUserId) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        credited: false,
        error: "Payment intent does not belong to this account.",
      });
    }

    // Verified Flutterwave data must match the server-created intent.
    if (flwTx.tx_ref !== String(intent.tx_ref)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ credited: false, error: "Transaction reference mismatch." });
    }

    if (!Number.isFinite(flwTx.amount) || flwTx.amount !== Number(intent.amount)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ credited: false, error: "Payment amount mismatch." });
    }

    if (flwTx.currency !== String(intent.currency || "NGN").toUpperCase()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ credited: false, error: "Payment currency mismatch." });
    }

    // Already credited: idempotent success only when it matches the same
    // Flutterwave transaction. Never let one payment claim another intent.
    if (intent.status === "credited") {
      if (intent.flw_transaction_id && String(intent.flw_transaction_id) !== transactionId) {
        await client.query("ROLLBACK");
        return res.status(409).json({ credited: false, error: "Intent is already linked to another payment." });
      }

      const balance = await getBalance(client, req.authUserId);
      await client.query("COMMIT");
      return res.json({
        credited: true,
        idempotent: true,
        amount: Number(intent.amount),
        newBalance: balance,
      });
    }

    // Lock/inspect any existing credit for this transaction ID or tx_ref.
    // Unique constraints remain the final database-level guard.
    const existingByTxId = await client.query(
      `SELECT id, user_id, amount, tx_ref
       FROM funding_credits
       WHERE flw_transaction_id = $1`,
      [transactionId]
    );

    if (existingByTxId.rows.length) {
      const existing = existingByTxId.rows[0];
      if (existing.user_id !== req.authUserId || String(existing.tx_ref) !== txRef) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          credited: false,
          error: "This Flutterwave transaction is already linked to another payment intent.",
        });
      }

      await client.query(
        `UPDATE payment_intents
         SET status = 'credited', flw_transaction_id = $1, credited_at = NOW()
         WHERE id = $2`,
        [transactionId, intent.id]
      );

      const balance = await getBalance(client, req.authUserId);
      await client.query("COMMIT");
      return res.json({
        credited: true,
        idempotent: true,
        amount: Number(existing.amount),
        newBalance: balance,
      });
    }

    const existingByRef = await client.query(
      `SELECT id, user_id, amount, flw_transaction_id
       FROM funding_credits
       WHERE tx_ref = $1`,
      [txRef]
    );

    if (existingByRef.rows.length) {
      const existing = existingByRef.rows[0];
      if (
        existing.user_id !== req.authUserId ||
        String(existing.flw_transaction_id) !== transactionId
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          credited: false,
          error: "This payment reference is already linked to another transaction.",
        });
      }

      const balance = await getBalance(client, req.authUserId);
      await client.query("COMMIT");
      return res.json({
        credited: true,
        idempotent: true,
        amount: Number(existing.amount),
        newBalance: balance,
      });
    }

    // Create/lock wallet row.
    await client.query(
      `INSERT INTO wallets (user_id, balance)
       VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [req.authUserId]
    );

    const walletResult = await client.query(
      `SELECT balance
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [req.authUserId]
    );

    if (!walletResult.rows.length) {
      throw new Error("Wallet row could not be created.");
    }

    const creditId = `cr_${crypto.randomUUID()}`;

    // UNIQUE(tx_ref) + UNIQUE(flw_transaction_id) protect against replay.
    await client.query(
      `INSERT INTO funding_credits
       (id, user_id, amount, currency, tx_ref, flw_transaction_id, flw_ref, payment_method, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'successful')`,
      [
        creditId,
        req.authUserId,
        Number(intent.amount),
        String(intent.currency || "NGN").toUpperCase(),
        txRef,
        transactionId,
        flwTx.flw_ref,
        flwTx.payment_type || "Flutterwave",
      ]
    );

    const newBalanceResult = await client.query(
      `UPDATE wallets
       SET balance = balance + $1,
           updated_at = NOW()
       WHERE user_id = $2
       RETURNING balance`,
      [Number(intent.amount), req.authUserId]
    );

    await client.query(
      `UPDATE payment_intents
       SET status = 'credited',
           flw_transaction_id = $1,
           credited_at = NOW()
       WHERE id = $2
         AND status = 'pending'`,
      [transactionId, intent.id]
    );

    const newBalance = Number(newBalanceResult.rows[0].balance);

    await client.query("COMMIT");

    return res.json({
      credited: true,
      idempotent: false,
      amount: Number(intent.amount),
      newBalance,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    if (error.code === "23505") {
      // A concurrent request won a UNIQUE(tx_ref)/UNIQUE(transaction_id)
      // race. Resolve the final state without changing the wallet again.
      try {
        const existing = await pool.query(
          `SELECT user_id, amount, tx_ref, flw_transaction_id
           FROM funding_credits
           WHERE tx_ref = $1 OR flw_transaction_id = $2
           LIMIT 1`,
          [txRef, transactionId]
        );

        if (existing.rows.length) {
          const row = existing.rows[0];
          if (row.user_id !== req.authUserId) {
            return res.status(409).json({
              credited: false,
              error: "This payment is already linked to another account.",
            });
          }

          if (
            String(row.tx_ref) === txRef &&
            String(row.flw_transaction_id) === transactionId
          ) {
            const balance = await getBalance(pool, req.authUserId);
            return res.json({
              credited: true,
              idempotent: true,
              amount: Number(row.amount),
              newBalance: balance,
            });
          }
        }
      } catch (_) {}
    }

    console.error("[wallet/credit] Error:", error);
    return res.status(500).json({
      credited: false,
      error: "Server error while crediting wallet.",
    });
  } finally {
    client.release();
  }
});

// ============================================================
// POST /wallet/precall
// ============================================================

router.post("/wallet/precall", async (req, res) => {
  try {
    const destinationNumber = String(req.body?.destination_number || "").trim();
    if (!destinationNumber) {
      return res.status(400).json({ error: "destination_number is required." });
    }

    const network = detectNetwork(destinationNumber);
    const rate = await getRateForNetwork(req.base44Client, network);

    if (!rate) {
      return res.json({
        canCall: false,
        reason: `No rate configured for ${network}.`,
        requiredBalance: 0,
        network,
        ratePerMinute: 0,
        currency: "NGN",
      });
    }

    await ensureWallet(req.authUserId);
    const balance = await getBalance(pool, req.authUserId);
    const ratePerMinute = Number(rate.rate_per_minute);

    return res.json({
      canCall: balance >= ratePerMinute,
      reason: balance >= ratePerMinute ? null : "Insufficient balance",
      requiredBalance: ratePerMinute,
      balance,
      network,
      ratePerMinute,
      currency: "NGN",
    });
  } catch (error) {
    console.error("[wallet/precall] Error:", error);
    return res.status(500).json({ error: "Could not check wallet balance." });
  }
});

// ============================================================
// POST /wallet/charge
//
// IMPORTANT: the wallet mutation is atomic and idempotent.
// The current endpoint still receives duration_seconds from the call
// layer. For production-grade anti-tampering, duration should ultimately
// come from a trusted provider webhook/call record rather than the browser.
// ============================================================

router.post("/wallet/charge", async (req, res) => {
  const callLogId = String(req.body?.call_log_id || "").trim();
  const destinationNumber = String(req.body?.destination_number || "").trim();
  const providerCallId = req.body?.provider_call_id
    ? String(req.body.provider_call_id).trim()
    : null;
  const duration = Number(req.body?.duration_seconds);

  if (!callLogId || !destinationNumber || req.body?.duration_seconds === undefined) {
    return res.status(400).json({
      error: "call_log_id, destination_number and duration_seconds are required.",
    });
  }

  if (!Number.isFinite(duration) || duration < 0 || duration > 86400) {
    return res.status(400).json({ error: "duration_seconds must be between 0 and 86400." });
  }

  try {
    // Fast idempotency path.
    const existing = await pool.query(
      `SELECT amount, billed_minutes, rate_per_minute, destination_network
       FROM call_charges
       WHERE call_log_id = $1`,
      [callLogId]
    );

    if (existing.rows.length) {
      const charge = existing.rows[0];
      return res.json({
        charged: false,
        idempotent: true,
        cost: Number(charge.amount),
        billedMinutes: Number(charge.billed_minutes),
        ratePerMinute: Number(charge.rate_per_minute),
        network: charge.destination_network,
      });
    }

    const network = detectNetwork(destinationNumber);
    const rate = await getRateForNetwork(req.base44Client, network);

    if (!rate) {
      return res.status(400).json({
        charged: false,
        error: `No rate configured for ${network}.`,
      });
    }

    const ratePerMinute = Number(rate.rate_per_minute);
    const billedMinutes = calculateBilledMinutes(duration);
    const cost = calculateCost(billedMinutes, ratePerMinute);

    if (billedMinutes <= 0 || cost <= 0) {
      return res.json({ charged: false, cost: 0, reason: "No chargeable duration." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO wallets (user_id, balance)
         VALUES ($1, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [req.authUserId]
      );

      // Row-level lock + conditional deduction prevents negative balances
      // even when multiple calls finish concurrently.
      const deductResult = await client.query(
        `UPDATE wallets
         SET balance = balance - $1,
             updated_at = NOW()
         WHERE user_id = $2
           AND balance >= $1
         RETURNING balance`,
        [cost, req.authUserId]
      );

      if (!deductResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(402).json({
          charged: false,
          reason: "Insufficient balance.",
          cost,
          network,
          ratePerMinute,
        });
      }

      const chargeId = `chg_${crypto.randomUUID()}`;

      try {
        await client.query(
          `INSERT INTO call_charges
           (id, user_id, call_log_id, destination_number, destination_network,
            duration_seconds, billed_minutes, rate_per_minute, amount,
            currency, provider, provider_call_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'NGN', 'twilio', $10, 'successful')`,
          [
            chargeId,
            req.authUserId,
            callLogId,
            destinationNumber,
            network,
            Math.floor(duration),
            billedMinutes,
            ratePerMinute,
            cost,
            providerCallId,
          ]
        );
      } catch (error) {
        if (error.code === "23505") {
          await client.query("ROLLBACK");
          const existingCharge = await pool.query(
            `SELECT amount, billed_minutes, rate_per_minute, destination_network
             FROM call_charges
             WHERE call_log_id = $1`,
            [callLogId]
          );
          const charge = existingCharge.rows[0];
          if (!charge) throw error;

          return res.json({
            charged: false,
            idempotent: true,
            cost: Number(charge.amount),
            billedMinutes: Number(charge.billed_minutes),
            ratePerMinute: Number(charge.rate_per_minute),
            network: charge.destination_network,
          });
        }
        throw error;
      }

      const newBalance = Number(deductResult.rows[0].balance);
      await client.query("COMMIT");

      return res.json({
        charged: true,
        cost,
        newBalance,
        billedMinutes,
        ratePerMinute,
        network,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[wallet/charge] Error:", error);
    return res.status(500).json({ charged: false, error: "Could not charge wallet." });
  }
});

// ============================================================
// GET /wallet/transactions
// Complete authoritative history from Neon.
// ============================================================

router.get("/wallet/transactions", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const result = await pool.query(
      `SELECT *
       FROM (
         SELECT
           id,
           'funding' AS type,
           amount,
           currency,
           status,
           'Wallet funding' AS description,
           payment_method,
           tx_ref,
           NULL::TEXT AS destination_number,
           NULL::TEXT AS destination_network,
           NULL::NUMERIC AS billed_minutes,
           NULL::NUMERIC AS rate_per_minute,
           NULL::INTEGER AS duration_seconds,
           NULL::TEXT AS call_log_id,
           created_at
         FROM funding_credits
         WHERE user_id = $1

         UNION ALL

         SELECT
           id,
           'call_charge' AS type,
           -amount AS amount,
           currency,
           status,
           CONCAT('Call to ', destination_number, ' (', destination_network, ')') AS description,
           'Call charge' AS payment_method,
           NULL::TEXT AS tx_ref,
           destination_number,
           destination_network,
           billed_minutes,
           rate_per_minute,
           duration_seconds,
           call_log_id,
           created_at
         FROM call_charges
         WHERE user_id = $1
       ) AS transactions
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.authUserId, limit]
    );

    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'successful'), 0) AS total_deposits,
         COALESCE(SUM(amount), 0) AS total_funding_credits
       FROM funding_credits
       WHERE user_id = $1`,
      [req.authUserId]
    );

    return res.json({
      transactions: result.rows.map((row) => ({
        id: `${row.type}-${row.id}`,
        type: row.type,
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status,
        description: row.description,
        payment_method: row.payment_method,
        tx_ref: row.tx_ref,
        destination_number: row.destination_number,
        destination_network: row.destination_network,
        billed_minutes:
          row.billed_minutes === null ? null : Number(row.billed_minutes),
        rate_per_minute:
          row.rate_per_minute === null ? null : Number(row.rate_per_minute),
        duration_seconds:
          row.duration_seconds === null ? null : Number(row.duration_seconds),
        call_log_id: row.call_log_id,
        created_at: row.created_at,
      })),
      total_deposits: Number(totals.rows[0]?.total_deposits || 0),
    });
  } catch (error) {
    console.error("[wallet/transactions] Error:", error);
    return res.status(500).json({ error: "Could not load wallet transactions." });
  }
});

// ============================================================
// WALLET MIGRATION
// One-time admin-only Base44 User.balance -> Neon wallets.balance.
// ============================================================

const MIGRATION_LOCK_KEY = 71489263;

async function fetchAllBase44Users(base44Client) {
  const allUsers = [];
  const batchSize = 500;
  let lastDate = null;

  while (true) {
    let batch;

    if (lastDate) {
      batch = await base44Client.entities.User.filter(
        { created_date: { $lt: lastDate } },
        "-created_date",
        batchSize
      );
    } else {
      batch = await base44Client.entities.User.list(
        "-created_date",
        batchSize
      );
    }

    if (!batch || batch.length === 0) break;

    allUsers.push(...batch);
    lastDate = batch[batch.length - 1].created_date;

    if (batch.length < batchSize) break;
  }

  return allUsers;
}

router.post("/wallet/migrate", async (req, res) => {
  await schemaReady;

  if (req.authUser?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }

  const dryRun = req.body?.dry_run === true;
  let lockedClient = null;

  if (!dryRun) {
    lockedClient = await pool.connect();

    try {
      const lockResult = await lockedClient.query(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [MIGRATION_LOCK_KEY]
      );

      if (!lockResult.rows[0].locked) {
        lockedClient.release();
        return res.status(409).json({
          error: "Another wallet migration is already running. Wait for it to finish, then try again.",
        });
      }
    } catch (error) {
      lockedClient.release();
      return res.status(500).json({ error: "Could not obtain migration lock." });
    }
  }

  const db = lockedClient || pool;

  const summary = {
    dry_run: dryRun,
    total_users: 0,
    migrated: 0,
    would_migrate: 0,
    skipped_exists: 0,
    skipped_no_balance: 0,
    skipped_inactive: 0,
    errors: 0,
    total_ngn_migrated: 0,
    total_base44_balance_scanned: 0,
    error_details: [],
  };

  try {
    const users = await fetchAllBase44Users(req.base44Client);
    summary.total_users = users.length;

    for (const user of users) {
      const base44Balance = Number(user.balance ?? 0);
      const isInactive = user.account_status === "inactive";

      try {
        if (base44Balance > 0 && !isInactive) {
          summary.total_base44_balance_scanned += base44Balance;
        }

        const auditResult = await db.query(
          "SELECT status FROM migration_audit WHERE user_id = $1",
          [user.id]
        );

        if (auditResult.rows.length) {
          const status = auditResult.rows[0].status;
          if (status === "migrated" || status === "skipped_exists") {
            summary.skipped_exists++;
            continue;
          }
        }

        if (isInactive) {
          summary.skipped_inactive++;
          if (!dryRun) {
            await db.query(
              `INSERT INTO migration_audit
               (user_id, old_base44_balance, migrated_pg_balance, status)
               VALUES ($1, $2, 0, 'skipped_inactive')
               ON CONFLICT (user_id) DO NOTHING`,
              [user.id, base44Balance]
            );
          }
          continue;
        }

        if (base44Balance <= 0) {
          summary.skipped_no_balance++;
          if (!dryRun) {
            await db.query(
              `INSERT INTO migration_audit
               (user_id, old_base44_balance, migrated_pg_balance, status)
               VALUES ($1, $2, 0, 'skipped_no_balance')
               ON CONFLICT (user_id) DO NOTHING`,
              [user.id, base44Balance]
            );
          }
          continue;
        }

        const walletResult = await db.query(
          "SELECT balance FROM wallets WHERE user_id = $1",
          [user.id]
        );

        const existingBalance = walletResult.rows.length
          ? Number(walletResult.rows[0].balance)
          : null;

        if (existingBalance !== null && existingBalance > 0) {
          summary.skipped_exists++;
          if (!dryRun) {
            await db.query(
              `INSERT INTO migration_audit
               (user_id, old_base44_balance, migrated_pg_balance, status)
               VALUES ($1, $2, $3, 'skipped_exists')
               ON CONFLICT (user_id) DO NOTHING`,
              [user.id, base44Balance, existingBalance]
            );
          }
          continue;
        }

        const activityResult = await db.query(
          `SELECT 1 FROM funding_credits WHERE user_id = $1
           UNION SELECT 1 FROM call_charges WHERE user_id = $1
           LIMIT 1`,
          [user.id]
        );

        if (activityResult.rows.length) {
          summary.skipped_exists++;
          if (!dryRun) {
            await db.query(
              `INSERT INTO migration_audit
               (user_id, old_base44_balance, migrated_pg_balance, status)
               VALUES ($1, $2, $3, 'skipped_exists')
               ON CONFLICT (user_id) DO NOTHING`,
              [user.id, base44Balance, existingBalance ?? 0]
            );
          }
          continue;
        }

        if (dryRun) {
          summary.would_migrate++;
          summary.total_ngn_migrated += base44Balance;
          continue;
        }

        if (existingBalance !== null) {
          const updateResult = await db.query(
            `UPDATE wallets
             SET balance = $1, updated_at = NOW()
             WHERE user_id = $2 AND balance = 0`,
            [base44Balance, user.id]
          );

          if (updateResult.rowCount !== 1) {
            summary.skipped_exists++;
            continue;
          }
        } else {
          await db.query(
            `INSERT INTO wallets (user_id, balance, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (user_id) DO NOTHING`,
            [user.id, base44Balance]
          );
        }

        const verifyResult = await db.query(
          "SELECT balance FROM wallets WHERE user_id = $1",
          [user.id]
        );

        if (!verifyResult.rows.length) {
          summary.errors++;
          summary.error_details.push({
            user_id: user.id,
            error: "Wallet not found after migration.",
          });
          continue;
        }

        const finalBalance = Number(verifyResult.rows[0].balance);

        if (finalBalance === base44Balance) {
          summary.migrated++;
          summary.total_ngn_migrated += base44Balance;

          await db.query(
            `INSERT INTO migration_audit
             (user_id, old_base44_balance, migrated_pg_balance, status)
             VALUES ($1, $2, $3, 'migrated')
             ON CONFLICT (user_id) DO NOTHING`,
            [user.id, base44Balance, finalBalance]
          );
        } else {
          summary.skipped_exists++;
          await db.query(
            `INSERT INTO migration_audit
             (user_id, old_base44_balance, migrated_pg_balance, status)
             VALUES ($1, $2, $3, 'skipped_exists')
             ON CONFLICT (user_id) DO NOTHING`,
            [user.id, base44Balance, finalBalance]
          );
        }
      } catch (error) {
        summary.errors++;
        summary.error_details.push({ user_id: user.id, error: error.message });

        if (!dryRun) {
          await db.query(
            `INSERT INTO migration_audit
             (user_id, old_base44_balance, migrated_pg_balance, status, error_message)
             VALUES ($1, $2, 0, 'error', $3)
             ON CONFLICT (user_id) DO NOTHING`,
            [user.id, base44Balance, error.message]
          ).catch(() => {});
        }
      }
    }

    if (
      !dryRun &&
      summary.total_ngn_migrated > summary.total_base44_balance_scanned
    ) {
      summary.validation_warning =
        "Migrated total exceeds scanned Base44 total. Investigate before switching the frontend.";
    }

    return res.json(summary);
  } catch (error) {
    console.error("[migrate] Fatal error:", error);
    return res.status(500).json({
      error: "Migration failed: " + error.message,
      partial_summary: summary,
    });
  } finally {
    if (lockedClient) {
      try {
        await lockedClient.query(
          "SELECT pg_advisory_unlock($1)",
          [MIGRATION_LOCK_KEY]
        );
      } catch (_) {}
      lockedClient.release();
    }
  }
});

module.exports = router;
