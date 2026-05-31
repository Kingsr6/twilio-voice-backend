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
