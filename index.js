import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

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
app.listen(PORT, () => console.log("Server running on port " + PORT));
