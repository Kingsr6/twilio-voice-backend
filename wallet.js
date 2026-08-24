const express = require("express");
const { Pool } = require("pg");

const router = express.Router();

// ============================================================
// CONFIGURATION
// ============================================================

const DATABASE_URL = process.env.DATABASE_URL;
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

if (!DATABASE_URL) {
  console.error("[wallet] DATABASE_URL is missing.");
}

if (!BASE44_APP_ID) {
  console.error("[wallet] BASE44_APP_ID is missing.");
}

if (!FLW_SECRET_KEY) {
  console.error("[wallet] FLW_SECRET_KEY is missing.");
}

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
      tx_ref              TEXT,
      flw_transaction_id  TEXT NOT NULL UNIQUE,
      flw_ref             TEXT,
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
      provider             TEXT NOT NULL DEFAULT 'twilio',
      provider_call_id     TEXT,
      status               TEXT NOT NULL DEFAULT 'successful',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_payment_intents_user
      ON payment_intents(user_id);

    CREATE INDEX IF NOT EXISTS idx_payment_intents_tx_ref
      ON payment_intents(tx_ref);

    CREATE INDEX IF NOT EXISTS idx_funding_credits_user
      ON funding_credits(user_id);

    CREATE INDEX IF NOT EXISTS idx_call_charges_user
      ON call_charges(user_id);
  `);

  console.log("[wallet] PostgreSQL schema ready");
}

// Every wallet request waits until the schema exists.
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
    return res.status(401).json({
      error: "Missing authentication token",
    });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  if (!token) {
    return res.status(401).json({
      error: "Invalid authentication token",
    });
  }

  // IMPORTANT:
  // The browser cannot choose the app ID.
  // Render uses its own trusted environment variable.
  const appId = BASE44_APP_ID;

  if (!appId) {
    return res.status(500).json({
      error: "BASE44_APP_ID is not configured.",
    });
  }

  try {
    const createClient = await getCreateClient();

    const base44 = createClient({
      appId,
      token,
      serverUrl: "https://base44.app",
    });

    const user = await base44.auth.me();

    if (!user || !user.id) {
      return res.status(401).json({
        error: "Invalid authentication.",
      });
    }

    // Canonical identity comes from Base44.
    req.authUserId = user.id;
    req.base44Client = base44;
    req.authUser = user;

    next();
  } catch (error) {
    console.error(
      "[wallet/auth] Token validation failed:",
      error.message
    );

    return res.status(401).json({
      error: "Authentication failed.",
    });
  }
}

// ALL wallet endpoints require authentication.
router.use(authMiddleware);

// ============================================================
// NIGERIAN NETWORK DETECTION
// ============================================================

const NETWORK_PREFIXES = {
  MTN: [
    "0703",
    "0706",
    "0803",
    "0806",
    "0810",
    "0813",
    "0814",
    "0816",
    "0903",
    "0906",
    "0913",
    "0916",
  ],

  Airtel: [
    "0701",
    "0708",
    "0802",
    "0808",
    "0812",
    "0901",
    "0902",
    "0904",
    "0907",
    "0912",
  ],

  Glo: [
    "0705",
    "0805",
    "0807",
    "0811",
    "0815",
    "0905",
    "0915",
  ],

  "9mobile": [
    "0809",
    "0817",
    "0818",
    "0908",
    "0909",
  ],
};

function detectNetwork(phoneNumber) {
  if (!phoneNumber) {
    return "Other";
  }

  let number = String(phoneNumber).trim();

  // +2348012345678 -> 08012345678
  number = number
    .replace(/^\+234/, "0")
    .replace(/^234/, "0");

  const prefix = number.substring(0, 4);

  for (const [network, prefixes] of Object.entries(
    NETWORK_PREFIXES
  )) {
    if (prefixes.includes(prefix)) {
      return network;
    }
  }

  return "Other";
}

// ============================================================
// RATE LOOKUP
// Base44 CallRate is authoritative.
// ============================================================

let ratesCache = null;
let ratesCacheTime = 0;

const RATES_TTL_MS = 5 * 60 * 1000;

async function getRates(base44Client) {
  const now = Date.now();

  if (
    ratesCache &&
    now - ratesCacheTime < RATES_TTL_MS
  ) {
    return ratesCache;
  }

  const rates =
    await base44Client.entities.CallRate.filter({
      country: "Nigeria",
      active: true,
    });

  ratesCache = rates || [];
  ratesCacheTime = now;

  return ratesCache;
}

async function getRateForNetwork(
  base44Client,
  network
) {
  const rates = await getRates(base44Client);

  const rate = rates.find(
    (item) =>
      item.network === network &&
      item.active === true
  );

  return rate || null;
}

// ============================================================
// BILLING CALCULATIONS
// ============================================================

const BILLING_INCREMENT_SECONDS = 60;

function calculateBilledMinutes(
  durationSeconds
) {
  const seconds = Number(durationSeconds);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  return (
    Math.ceil(
      seconds / BILLING_INCREMENT_SECONDS
    ) *
    (BILLING_INCREMENT_SECONDS / 60)
  );
}

function calculateCost(
  billedMinutes,
  ratePerMinute
) {
  return Number(
    (
      billedMinutes *
      Number(ratePerMinute)
    ).toFixed(2)
  );
}

// ============================================================
// WALLET HELPER
// ============================================================

async function ensureWallet(userId) {
  await pool.query(
    `
      INSERT INTO wallets (user_id, balance)
      VALUES ($1, 0)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );
}

// ============================================================
// GET /wallet/balance
// ============================================================

router.get(
  "/wallet/balance",
  async (req, res) => {
    try {
      await ensureWallet(req.authUserId);

      const result = await pool.query(
        `
          SELECT balance
          FROM wallets
          WHERE user_id = $1
        `,
        [req.authUserId]
      );

      return res.json({
        balance: Number(
          result.rows[0]?.balance || 0
        ),
        currency: "NGN",
      });
    } catch (error) {
      console.error(
        "[wallet/balance] Error:",
        error
      );

      return res.status(500).json({
        error: "Could not retrieve wallet balance.",
      });
    }
  }
);

// ============================================================
// POST /wallet/intent
//
// Render creates the tx_ref.
// Browser does NOT create the payment reference.
// ============================================================

router.post(
  "/wallet/intent",
  async (req, res) => {
    const amount = Number(req.body.amount);
    const userId = req.authUserId;

    if (
      !Number.isFinite(amount) ||
      amount < 100
    ) {
      return res.status(400).json({
        error: "Minimum wallet funding amount is ₦100.",
      });
    }

    if (amount > 1000000) {
      return res.status(400).json({
        error:
          "Maximum wallet funding amount is ₦1,000,000.",
      });
    }

    const intentId =
      "pi_" +
      Date.now() +
      "_" +
      Math.random()
        .toString(36)
        .slice(2, 10);

    const txRef =
      `GCWALLET-${userId.slice(0, 8)}-` +
      `${Date.now()}-` +
      Math.random()
        .toString(36)
        .slice(2, 10);

    try {
      await pool.query(
        `
          INSERT INTO payment_intents
          (
            id,
            user_id,
            amount,
            tx_ref,
            status
          )
          VALUES
          ($1, $2, $3, $4, 'pending')
        `,
        [
          intentId,
          userId,
          amount,
          txRef,
        ]
      );

      return res.json({
        intent_id: intentId,
        tx_ref: txRef,
        amount,
        currency: "NGN",
      });
    } catch (error) {
      console.error(
        "[wallet/intent] Error:",
        error
      );

      return res.status(500).json({
        error: "Could not create payment intent.",
      });
    }
  }
);

// ============================================================
// POST /wallet/credit
//
// Secure Flutterwave wallet credit.
// ============================================================

router.post(
  "/wallet/credit",
  async (req, res) => {
    const {
      tx_ref,
      transaction_id,
      flw_ref,
    } = req.body;

    const userId = req.authUserId;

    if (!tx_ref || !transaction_id) {
      return res.status(400).json({
        error:
          "tx_ref and transaction_id are required.",
      });
    }

    if (!FLW_SECRET_KEY) {
      return res.status(500).json({
        error:
          "Flutterwave server configuration is missing.",
      });
    }

    try {
      // --------------------------------------------------------
      // 1. Find payment intent
      // --------------------------------------------------------

      const intentResult =
        await pool.query(
          `
            SELECT *
            FROM payment_intents
            WHERE tx_ref = $1
          `,
          [String(tx_ref)]
        );

      if (intentResult.rows.length === 0) {
        return res.status(404).json({
          credited: false,
          error:
            "Unknown payment intent.",
        });
      }

      const intent =
        intentResult.rows[0];

      // --------------------------------------------------------
      // 2. Verify ownership
      // --------------------------------------------------------

      if (intent.user_id !== userId) {
        return res.status(403).json({
          credited: false,
          error:
            "Payment intent does not belong to this account.",
        });
      }

      // --------------------------------------------------------
      // 3. Idempotency
      // --------------------------------------------------------

      if (intent.status === "credited") {
        await ensureWallet(userId);

        const balanceResult =
          await pool.query(
            `
              SELECT balance
              FROM wallets
              WHERE user_id = $1
            `,
            [userId]
          );

        return res.json({
          credited: true,
          idempotent: true,
          amount: Number(intent.amount),
          newBalance: Number(
            balanceResult.rows[0]?.balance || 0
          ),
        });
      }

      // --------------------------------------------------------
      // 4. Verify Flutterwave transaction
      // --------------------------------------------------------

      const verifyResponse =
        await fetch(
          `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(
            transaction_id
          )}/verify`,
          {
            method: "GET",
            headers: {
              Authorization:
                `Bearer ${FLW_SECRET_KEY}`,
              "Content-Type":
                "application/json",
            },
          }
        );

      const verifyData =
        await verifyResponse.json();

      if (
        !verifyResponse.ok ||
        verifyData.status !==
          "success"
      ) {
        console.error(
          "[wallet/credit] Flutterwave verification failed:",
          verifyData.message
        );

        return res.status(400).json({
          credited: false,
          error:
            "Flutterwave did not confirm this payment.",
        });
      }

      const transaction =
        verifyData.data;

      if (
        !transaction ||
        transaction.status !==
          "successful"
      ) {
        return res.status(400).json({
          credited: false,
          error:
            "Flutterwave transaction is not successful.",
        });
      }

      // --------------------------------------------------------
      // 5. tx_ref MUST match
      // --------------------------------------------------------

      if (
        transaction.tx_ref !==
        intent.tx_ref
      ) {
        return res.status(400).json({
          credited: false,
          error:
            "Transaction reference mismatch.",
        });
      }

      // --------------------------------------------------------
      // 6. Amount MUST match
      // --------------------------------------------------------

      const paidAmount = Number(
        transaction.amount
      );

      const expectedAmount = Number(
        intent.amount
      );

      if (
        !Number.isFinite(paidAmount) ||
        paidAmount !== expectedAmount
      ) {
        return res.status(400).json({
          credited: false,
          error: "Payment amount mismatch.",
        });
      }

      // --------------------------------------------------------
      // 7. Currency MUST be NGN
      // --------------------------------------------------------

      if (
        transaction.currency !==
        "NGN"
      ) {
        return res.status(400).json({
          credited: false,
          error:
            "Payment currency must be NGN.",
        });
      }

      // --------------------------------------------------------
      // 8. Check transaction wasn't already credited
      // --------------------------------------------------------

      const existingCredit =
        await pool.query(
          `
            SELECT *
            FROM funding_credits
            WHERE flw_transaction_id = $1
          `,
          [String(transaction_id)]
        );

      if (
        existingCredit.rows.length > 0
      ) {
        const existing =
          existingCredit.rows[0];

        if (
          existing.user_id !==
          userId
        ) {
          return res.status(403).json({
            credited: false,
            error:
              "This transaction was already claimed by another account.",
          });
        }

        await pool.query(
          `
            UPDATE payment_intents
            SET
              status = 'credited',
              flw_transaction_id = $1,
              credited_at = NOW()
            WHERE id = $2
              AND status = 'pending'
          `,
          [
            String(transaction_id),
            intent.id,
          ]
        );

        await ensureWallet(userId);

        const balanceResult =
          await pool.query(
            `
              SELECT balance
              FROM wallets
              WHERE user_id = $1
            `,
            [userId]
          );

        return res.json({
          credited: true,
          idempotent: true,
          amount: expectedAmount,
          newBalance: Number(
            balanceResult.rows[0]?.balance || 0
          ),
        });
      }

      // --------------------------------------------------------
      // 9. Atomic credit
      // --------------------------------------------------------

      const creditId =
        "cr_" +
        Date.now() +
        "_" +
        Math.random()
          .toString(36)
          .slice(2, 10);

      const client =
        await pool.connect();

      try {
        await client.query(
          "BEGIN"
        );

        await client.query(
          `
            INSERT INTO wallets
            (
              user_id,
              balance
            )
            VALUES ($1, 0)
            ON CONFLICT (user_id)
            DO NOTHING
          `,
          [userId]
        );

        await client.query(
          `
            UPDATE wallets
            SET
              balance = balance + $1,
              updated_at = NOW()
            WHERE user_id = $2
          `,
          [
            expectedAmount,
            userId,
          ]
        );

        await client.query(
          `
            INSERT INTO funding_credits
            (
              id,
              user_id,
              amount,
              tx_ref,
              flw_transaction_id,
              flw_ref
            )
            VALUES
            ($1, $2, $3, $4, $5, $6)
          `,
          [
            creditId,
            userId,
            expectedAmount,
            intent.tx_ref,
            String(
              transaction_id
            ),
            flw_ref ||
              transaction.flw_ref ||
              null,
          ]
        );

        const markResult =
          await client.query(
            `
              UPDATE payment_intents
              SET
                status = 'credited',
                flw_transaction_id = $1,
                credited_at = NOW()
              WHERE id = $2
                AND status = 'pending'
            `,
            [
              String(
                transaction_id
              ),
              intent.id,
            ]
          );

        if (
          markResult.rowCount !== 1
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res.json({
            credited: true,
            idempotent: true,
            amount: expectedAmount,
          });
        }

        await client.query(
          "COMMIT"
        );
      } catch (error) {
        await client.query(
          "ROLLBACK"
        );

        if (
          error.code === "23505"
        ) {
          return res.json({
            credited: true,
            idempotent: true,
            amount: expectedAmount,
          });
        }

        throw error;
      } finally {
        client.release();
      }

      // --------------------------------------------------------
      // 10. Return new balance
      // --------------------------------------------------------

      const balanceResult =
        await pool.query(
          `
            SELECT balance
            FROM wallets
            WHERE user_id = $1
          `,
          [userId]
        );

      return res.json({
        credited: true,
        amount: expectedAmount,
        newBalance: Number(
          balanceResult.rows[0]?.balance ||
            0
        ),
      });
    } catch (error) {
      console.error(
        "[wallet/credit] Error:",
        error
      );

      return res.status(500).json({
        credited: false,
        error:
          "Server error while crediting wallet.",
      });
    }
  }
);

// ============================================================
// POST /wallet/precall
// ============================================================

router.post(
  "/wallet/precall",
  async (req, res) => {
    try {
      const {
        destination_number,
      } = req.body;

      if (!destination_number) {
        return res.status(400).json({
          error:
            "destination_number is required.",
        });
      }

      const network =
        detectNetwork(
          destination_number
        );

      const rate =
        await getRateForNetwork(
          req.base44Client,
          network
        );

      if (!rate) {
        return res.json({
          canCall: false,
          reason:
            `No rate configured for ${network}.`,
          requiredBalance: 0,
          network,
          ratePerMinute: 0,
        });
      }

      await ensureWallet(
        req.authUserId
      );

      const result =
        await pool.query(
          `
            SELECT balance
            FROM wallets
            WHERE user_id = $1
          `,
          [req.authUserId]
        );

      const balance = Number(
        result.rows[0]?.balance || 0
      );

      const ratePerMinute =
        Number(
          rate.rate_per_minute
        );

      if (
        balance < ratePerMinute
      ) {
        return res.json({
          canCall: false,
          reason:
            "Insufficient balance",
          requiredBalance:
            ratePerMinute,
          network,
          ratePerMinute,
        });
      }

      return res.json({
        canCall: true,
        requiredBalance:
          ratePerMinute,
        network,
        ratePerMinute,
      });
    } catch (error) {
      console.error(
        "[wallet/precall] Error:",
        error
      );

      return res.status(500).json({
        error:
          "Could not check wallet balance.",
      });
    }
  }
);

// ============================================================
// POST /wallet/charge
//
// Atomic, idempotent call billing.
// ============================================================

router.post(
  "/wallet/charge",
  async (req, res) => {
    const {
      call_log_id,
      destination_number,
      duration_seconds,
      provider_call_id,
    } = req.body;

    const userId =
      req.authUserId;

    if (
      !call_log_id ||
      !destination_number ||
      duration_seconds ===
        undefined
    ) {
      return res.status(400).json({
        error:
          "call_log_id, destination_number and duration_seconds are required.",
      });
    }

    try {
      // --------------------------------------------------------
      // Idempotency check
      // --------------------------------------------------------

      const existing =
        await pool.query(
          `
            SELECT *
            FROM call_charges
            WHERE call_log_id = $1
          `,
          [call_log_id]
        );

      if (
        existing.rows.length > 0
      ) {
        const charge =
          existing.rows[0];

        return res.json({
          charged: false,
          idempotent: true,
          cost: Number(
            charge.amount
          ),
          billedMinutes: Number(
            charge.billed_minutes
          ),
          ratePerMinute: Number(
            charge.rate_per_minute
          ),
          network:
            charge.destination_network,
        });
      }

      // --------------------------------------------------------
      // Rate
      // --------------------------------------------------------

      const network =
        detectNetwork(
          destination_number
        );

      const rate =
        await getRateForNetwork(
          req.base44Client,
          network
        );

      if (!rate) {
        return res.status(400).json({
          charged: false,
          error:
            `No rate configured for ${network}.`,
        });
      }

      const ratePerMinute =
        Number(
          rate.rate_per_minute
        );

      const billedMinutes =
        calculateBilledMinutes(
          Number(
            duration_seconds
          )
        );

      const cost =
        calculateCost(
          billedMinutes,
          ratePerMinute
        );

      if (
        billedMinutes <= 0 ||
        cost <= 0
      ) {
        return res.json({
          charged: false,
          cost: 0,
          reason:
            "No chargeable duration.",
        });
      }

      const chargeId =
        "chg_" +
        Date.now() +
        "_" +
        Math.random()
          .toString(36)
          .slice(2, 10);

      // --------------------------------------------------------
      // Atomic deduction
      // --------------------------------------------------------

      const client =
        await pool.connect();

      try {
        await client.query(
          "BEGIN"
        );

        await client.query(
          `
            INSERT INTO wallets
            (
              user_id,
              balance
            )
            VALUES ($1, 0)
            ON CONFLICT (user_id)
            DO NOTHING
          `,
          [userId]
        );

        const deductResult =
          await client.query(
            `
              UPDATE wallets
              SET
                balance = balance - $1,
                updated_at = NOW()
              WHERE user_id = $2
                AND balance >= $1
            `,
            [cost, userId]
          );

        if (
          deductResult.rowCount !==
          1
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res.json({
            charged: false,
            reason:
              "Insufficient balance.",
            cost,
            network,
            ratePerMinute,
          });
        }

        await client.query(
          `
            INSERT INTO call_charges
            (
              id,
              user_id,
              call_log_id,
              destination_number,
              destination_network,
              duration_seconds,
              billed_minutes,
              rate_per_minute,
              amount,
              provider,
              provider_call_id
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `,
          [
            chargeId,
            userId,
            call_log_id,
            destination_number,
            network,
            Number(
              duration_seconds
            ),
            billedMinutes,
            ratePerMinute,
            cost,
            "twilio",
            provider_call_id ||
              null,
          ]
        );

        await client.query(
          "COMMIT"
        );
      } catch (error) {
        await client.query(
          "ROLLBACK"
        );

        // Another request won the race.
        if (
          error.code ===
          "23505"
        ) {
          const existing2 =
            await pool.query(
              `
                SELECT *
                FROM call_charges
                WHERE call_log_id = $1
              `,
              [call_log_id]
            );

          if (
            existing2.rows.length >
            0
          ) {
            const charge =
              existing2.rows[0];

            return res.json({
              charged: false,
              idempotent: true,
              cost: Number(
                charge.amount
              ),
              billedMinutes:
                Number(
                  charge.billed_minutes
                ),
              ratePerMinute:
                Number(
                  charge.rate_per_minute
                ),
              network:
                charge.destination_network,
            });
          }
        }

        throw error;
      } finally {
        client.release();
      }

      const balanceResult =
        await pool.query(
          `
            SELECT balance
            FROM wallets
            WHERE user_id = $1
          `,
          [userId]
        );

      return res.json({
        charged: true,
        cost,
        newBalance: Number(
          balanceResult.rows[0]?.balance ||
            0
        ),
        billedMinutes,
        ratePerMinute,
        network,
      });
    } catch (error) {
      console.error(
        "[wallet/charge] Error:",
        error
      );

      return res.status(500).json({
        charged: false,
        error:
          "Could not charge wallet.",
      });
    }
  }
);

// ============================================================
// GET /wallet/transactions
// ============================================================

router.get(
  "/wallet/transactions",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
            SELECT
              id,
              amount,
              status,
              destination_number,
              destination_network,
              billed_minutes,
              created_at
            FROM call_charges
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 100
          `,
          [req.authUserId]
        );

      return res.json(
        result.rows.map(
          (charge) => ({
            id: charge.id,
            amount:
              -Number(
                charge.amount
              ),
            status:
              charge.status,
            description:
              `Call to ${charge.destination_number} (${charge.destination_network}) — ${Number(
                charge.billed_minutes
              )} min`,
            created_at:
              charge.created_at,
          })
        )
      );
    } catch (error) {
      console.error(
        "[wallet/transactions] Error:",
        error
      );

      return res.status(500).json({
        error:
          "Could not load wallet transactions.",
      });
    }
  }
);

// ============================================================
// EXPORT ROUTER
// ============================================================

module.exports = router;
