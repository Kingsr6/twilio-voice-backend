const express = require("express");
const cors = require("cors");
const twilio = require("twilio");

const app = express();

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_ID,
  FLW_SECRET_KEY,
} = process.env;

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.send("GlobalCall backend running");
});

// ============================================================
// TWILIO TOKEN
// GET /token?identity=USERNAME
// ============================================================

app.get("/token", (req, res) => {
  try {
    const identity = req.query.identity || "user";

    if (
      !TWILIO_ACCOUNT_SID ||
      !TWILIO_API_KEY ||
      !TWILIO_API_SECRET ||
      !TWILIO_TWIML_APP_SID
    ) {
      return res.status(500).json({
        error: "Twilio server configuration is incomplete.",
      });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: true,
    });

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,
      TWILIO_API_SECRET,
      {
        identity,
        ttl: 3600,
      }
    );

    token.addGrant(voiceGrant);

    res.json({
      token: token.toJwt(),
      identity,
    });
  } catch (err) {
    console.error("[token] Error:", err);

    res.status(500).json({
      error: "Failed to generate Twilio token.",
    });
  }
});

// ============================================================
// TWILIO VOICE
// POST /voice
//
// Supports:
// client:USER  -> user-to-user
// +234...      -> external PSTN
// ============================================================

app.post("/voice", (req, res) => {
  try {
    const to = String(req.body.To || "").trim();

    const callerId =
      TWILIO_CALLER_ID || "+18384445450";

    const twiml = new twilio.twiml.VoiceResponse();

    if (!to) {
      twiml.say("No destination number provided.");
      return res
        .type("text/xml")
        .send(twiml.toString());
    }

    const dial = twiml.dial({
      callerId,
      answerOnBridge: true,
    });

    if (to.startsWith("client:")) {
      const clientId = to.replace(/^client:/, "").trim();

      if (!clientId) {
        twiml.say("Invalid client destination.");
      } else {
        dial.client(clientId);
      }
    } else {
      dial.number(to);
    }

    res
      .type("text/xml")
      .send(twiml.toString());
  } catch (err) {
    console.error("[voice] Error:", err);

    res.status(500).type("text/plain").send(
      "Voice processing error."
    );
  }
});

// ============================================================
// FLUTTERWAVE PAYMENT VERIFICATION
// POST /verify-payment
//
// IMPORTANT:
// This endpoint ONLY verifies the payment with Flutterwave.
// Your Base44 frontend should credit the wallet only when
// this endpoint returns { verified: true }.
//
// Required Render environment variable:
// FLW_SECRET_KEY
// ============================================================

app.post("/verify-payment", async (req, res) => {
  const {
    transaction_id,
    flw_ref,
    tx_ref,
    expected_amount,
    expected_currency,
    user_id,
    txn_record_id,
  } = req.body || {};

  console.log(
    "[verify-payment] === Verification request ==="
  );

  console.log("[verify-payment] tx_ref:", tx_ref);
  console.log(
    "[verify-payment] transaction_id:",
    transaction_id
  );
  console.log("[verify-payment] user_id:", user_id);
  console.log(
    "[verify-payment] txn_record_id:",
    txn_record_id
  );
  console.log(
    "[verify-payment] expected_amount:",
    expected_amount
  );

  // ----------------------------------------------------------
  // Validate required fields
  // ----------------------------------------------------------

  if (
    !transaction_id ||
    !tx_ref ||
    expected_amount === undefined ||
    !user_id ||
    !txn_record_id
  ) {
    console.error(
      "[verify-payment] FAIL — missing required fields"
    );

    return res.status(400).json({
      verified: false,
      message: "Missing required fields.",
    });
  }

  // ----------------------------------------------------------
  // Check Flutterwave secret
  // ----------------------------------------------------------

  if (!FLW_SECRET_KEY) {
    console.error(
      "[verify-payment] FAIL — FLW_SECRET_KEY not set"
    );

    return res.status(500).json({
      verified: false,
      message:
        "Server payment configuration error. Contact support.",
    });
  }

  try {
    // --------------------------------------------------------
    // Step 1 — Verify transaction directly with Flutterwave
    // --------------------------------------------------------

    console.log(
      "[verify-payment] Step 1 — Verifying Flutterwave transaction:",
      transaction_id
    );

    const flwResponse = await fetch(
      `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(
        transaction_id
      )}/verify`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const flwData = await flwResponse.json();

    console.log(
      "[verify-payment] Flutterwave status:",
      flwData.status
    );

    console.log(
      "[verify-payment] Transaction status:",
      flwData.data?.status
    );

    console.log(
      "[verify-payment] Flutterwave tx_ref:",
      flwData.data?.tx_ref
    );

    console.log(
      "[verify-payment] Charged amount:",
      flwData.data?.charged_amount
    );

    console.log(
      "[verify-payment] Currency:",
      flwData.data?.currency
    );

    // --------------------------------------------------------
    // Flutterwave API itself failed
    // --------------------------------------------------------

    if (
      !flwResponse.ok ||
      flwData.status !== "success"
    ) {
      console.error(
        "[verify-payment] FAIL — Flutterwave verification failed:",
        flwData.message
      );

      return res.status(200).json({
        verified: false,
        message:
          "Flutterwave could not verify this transaction.",
      });
    }

    const txn = flwData.data;

    if (!txn) {
      console.error(
        "[verify-payment] FAIL — Flutterwave returned no transaction data."
      );

      return res.status(200).json({
        verified: false,
        message:
          "Flutterwave returned no transaction information.",
      });
    }

    // --------------------------------------------------------
    // Step 2 — Verify transaction reference
    // --------------------------------------------------------

    if (txn.tx_ref !== tx_ref) {
      console.error(
        "[verify-payment] FAIL — tx_ref mismatch."
      );

      console.error(
        "[verify-payment] Expected:",
        tx_ref
      );

      console.error(
        "[verify-payment] Received:",
        txn.tx_ref
      );

      return res.status(200).json({
        verified: false,
        message: "Transaction reference mismatch.",
      });
    }

    console.log(
      "[verify-payment] Step 2 — tx_ref matches ✓"
    );

    // --------------------------------------------------------
    // Step 3 — Verify amount
    // --------------------------------------------------------

    const paidAmount = Number(txn.charged_amount);
    const expectedAmount = Number(expected_amount);

    if (
      !Number.isFinite(paidAmount) ||
      !Number.isFinite(expectedAmount) ||
      paidAmount < expectedAmount
    ) {
      console.error(
        "[verify-payment] FAIL — amount mismatch."
      );

      console.error(
        "[verify-payment] Expected:",
        expectedAmount
      );

      console.error(
        "[verify-payment] Charged:",
        paidAmount
      );

      return res.status(200).json({
        verified: false,
        message: `Amount mismatch. Expected ₦${expectedAmount}, got ₦${paidAmount}.`,
      });
    }

    console.log(
      "[verify-payment] Step 3 — amount verified ✓"
    );

    // --------------------------------------------------------
    // Step 4 — Verify currency
    // --------------------------------------------------------

    const expectedCurrency =
      expected_currency || "NGN";

    if (txn.currency !== expectedCurrency) {
      console.error(
        "[verify-payment] FAIL — currency mismatch."
      );

      console.error(
        "[verify-payment] Expected:",
        expectedCurrency
      );

      console.error(
        "[verify-payment] Received:",
        txn.currency
      );

      return res.status(200).json({
        verified: false,
        message: `Currency mismatch. Expected ${expectedCurrency}, got ${txn.currency}.`,
      });
    }

    console.log(
      "[verify-payment] Step 4 — currency verified ✓"
    );

    // --------------------------------------------------------
    // Step 5 — Verify successful status
    // --------------------------------------------------------

    if (txn.status !== "successful") {
      console.error(
        "[verify-payment] FAIL — transaction status:",
        txn.status
      );

      return res.status(200).json({
        verified: false,
        message: `Transaction status is "${txn.status}", not "successful".`,
      });
    }

    console.log(
      "[verify-payment] Step 5 — status verified ✓"
    );

    // --------------------------------------------------------
    // ALL CHECKS PASSED
    // --------------------------------------------------------

    console.log(
      "[verify-payment] === ALL CHECKS PASSED — verified ✓ ==="
    );

    return res.status(200).json({
      verified: true,
      tx_ref: txn.tx_ref,
      flw_reference:
        flw_ref || txn.flw_ref || "",
      payment_method:
        txn.payment_type || "Flutterwave",
      amount: paidAmount,
      currency: txn.currency,
    });
  } catch (error) {
    console.error(
      "[verify-payment] === ERROR ==="
    );

    console.error(
      "[verify-payment] Message:",
      error.message
    );

    console.error(
      "[verify-payment] Stack:",
      error.stack
    );

    return res.status(500).json({
      verified: false,
      message:
        "Server error during verification. Contact support.",
    });
  }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `GlobalCall backend running on port ${PORT}`
  );
});
