const express = require("express");
const cors = require("cors");
const twilio = require("twilio");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_ID,
} = process.env;

app.get("/", (req, res) => {
  res.send("Twilio backend running");
});

// TOKEN
app.get("/token", (req, res) => {
  try {
    const identity = req.query.identity || "user";

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
      { identity, ttl: 3600 }
    );

    token.addGrant(voiceGrant);

    res.json({ token: token.toJwt(), identity });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

// VOICE
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const to = req.body.To;

  if (to) {
    const dial = twiml.dial({
      callerId: TWILIO_CALLER_ID,
      answerOnBridge: true,
    });

    dial.number(to);
  } else {
    twiml.say("No number provided");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});


// Render backend (Express) — install: npm i @base44/sdk
const { createClient } = require("@base44/sdk");

let _client = null;
async function getBase44() {
  if (_client) return _client;
  _client = createClient({ appId: process.env.BASE44_APP_ID });
  await _client.auth.loginViaEmailPassword(
    process.env.BASE44_ADMIN_EMAIL,
    process.env.BASE44_ADMIN_PASSWORD
  );
  return _client;
}

const NGN_TO_USD = 0.00065;

app.post("/verify-payment", async (req, res) => {
  const { flw_ref, tx_ref, expected_amount, expected_currency, user_id, txn_record_id } = req.body || {};
  if (!tx_ref || !user_id || !txn_record_id) {
    return res.status(400).json({ verified: false, message: "Missing transaction details." });
  }

  try {
    // 1. Verify the real transaction with Flutterwave (secret key)
    const flwRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref__=${encodeURIComponent(tx_ref)}`,
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    const flwData = await flwRes.json();
    const txn = flwData.data;

    const valid =
      flwData.status === "success" && txn && txn.status === "successful" &&
      Number(txn.amount) >= Number(expected_amount) &&
      txn.currency === (expected_currency || "NGN");

    if (!valid) {
      try { (await getBase44()).entities.WalletTransaction.update(txn_record_id, { status: "failed", flw_reference: flw_ref || "" }); } catch (_) {}
      return res.status(400).json({ verified: false, message: "Payment could not be verified." });
    }

    const base44 = await getBase44();

    // 2. Idempotency — skip if already credited
    const existing = await base44.entities.WalletTransaction.get(txn_record_id);
    if (existing && existing.status === "successful") {
      return res.json({ verified: true, message: "Already credited." });
    }

    // 3. Credit the user's wallet (NGN → USD)
    const user = await base44.entities.User.get(user_id);
    const newBalance = parseFloat(((user.balance ?? 0) + Number(expected_amount) * NGN_TO_USD).toFixed(4));
    await base44.entities.User.update(user_id, { balance: newBalance });

    // 4. Mark transaction successful
    await base44.entities.WalletTransaction.update(txn_record_id, {
      status: "successful",
      flw_reference: flw_ref || txn.flw_ref || "",
      payment_method: txn.payment_type || "flutterwave",
    });

    return res.json({ verified: true, balance: newBalance });
  } catch (e) {
    // If token expired, force re-login and retry once
    try {
      _client = null;
      const base44 = await getBase44();
      const user = await base44.entities.User.get(user_id);
      const newBalance = parseFloat(((user.balance ?? 0) + Number(expected_amount) * NGN_TO_USD).toFixed(4));
      await base44.entities.User.update(user_id, { balance: newBalance });
      await base44.entities.WalletTransaction.update(txn_record_id, { status: "successful", flw_reference: flw_ref || "" });
      return res.json({ verified: true, balance: newBalance });
    } catch (e2) {
      return res.status(500).json({ verified: false, message: "Server error during verification." });
    }
  }
});
