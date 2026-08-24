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
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_ID,
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
    const identity = String(req.query.identity || "user").trim();

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

    return res.json({
      token: token.toJwt(),
      identity,
    });
  } catch (error) {
    console.error("[token] Error:", error);

    return res.status(500).json({
      error: "Failed to generate Twilio token.",
    });
  }
});

// ============================================================
// TWILIO VOICE
// POST /voice
//
// client:USER -> user-to-user
// +234...     -> external PSTN
// ============================================================

app.post("/voice", (req, res) => {
  try {
    const to = String(req.body.To || "").trim();
    const callerId = TWILIO_CALLER_ID || "+18384445450";

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

    return res
      .type("text/xml")
      .send(twiml.toString());
  } catch (error) {
    console.error("[voice] Error:", error);

    return res
      .status(500)
      .type("text/plain")
      .send("Voice processing error.");
  }
});

// ============================================================
// SECURE WALLET ROUTES
// ============================================================
//
// wallet.js handles:
//   GET  /wallet/balance
//   POST /wallet/intent
//   POST /wallet/credit
//   POST /wallet/precall
//   POST /wallet/charge
//   GET  /wallet/transactions
//
// IMPORTANT:
// wallet.js authenticates the Base44 user using the Base44
// access token supplied by the frontend.
// ============================================================

app.use(require("./wallet"));

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`GlobalCall backend running on port ${PORT}`);
});
