const express = require("express");
const cors = require("cors");
const twilio = require("twilio");

const app = express();

// Middleware
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ===============================
// ENV VARIABLES (Render)
// ===============================
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_ID,
} = process.env;

// ===============================
// HEALTH CHECK
// ===============================
app.get("/", (req, res) => {
  res.send("Twilio backend is running");
});

// ===============================
// 1. GET /token
// (Used by BASE44 / Twilio Voice SDK)
// ===============================
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

    res.json({
      identity,
      token: token.toJwt(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// 2. POST /voice
// (Twilio webhook - connects the call)
// ===============================
app.post("/voice", (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();

    const toNumber = req.body.To;

    if (toNumber) {
      const dial = twiml.dial({
        callerId: TWILIO_CALLER_ID,
        answerOnBridge: true,
      });

      dial.number(toNumber);
    } else {
      twiml.say("No destination number provided.");
    }

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
