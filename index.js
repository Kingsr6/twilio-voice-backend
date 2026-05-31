import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());

app.use(cors());
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// 1. START CALL
app.post("/make-call", async (req, res) => {
  try {
    const call = await client.calls.create({
      to: req.body.to,
      from: process.env.TWILIO_NUMBER,
      url: `${process.env.BASE_URL}/twiml`
    });

    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. TWIML (THIS FIXES NO AUDIO ISSUE)
app.post("/twiml", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const dial = twiml.dial();
  dial.number(req.body.To);

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => {
  res.send("Twilio backend running");
});

const PORT = process.env.PORT || 3000;

app.get("/token", (req, res) => {
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
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_ID
} = process.env;
