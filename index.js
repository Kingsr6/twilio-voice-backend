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

// Trim environment values so trailing spaces/newlines pasted into Render do not
// corrupt Twilio credential signing or webhook validation.
const envValue = (name) => String(process.env[name] || "").trim();
const TWILIO_ACCOUNT_SID = envValue("TWILIO_ACCOUNT_SID");
const TWILIO_API_KEY = envValue("TWILIO_API_KEY");
const TWILIO_API_SECRET = envValue("TWILIO_API_SECRET");
const TWILIO_TWIML_APP_SID = envValue("TWILIO_TWIML_APP_SID");
const TWILIO_CALLER_ID = envValue("TWILIO_CALLER_ID");
const TWILIO_AUTH_TOKEN = envValue("TWILIO_AUTH_TOKEN");
const BASE44_APP_ID = envValue("BASE44_APP_ID");

// ============================================================
// BASE44 AUTH FOR VOICE TOKEN
// ============================================================

let createBase44Client = null;

async function getCreateClient() {
  if (!createBase44Client) {
    const module = await import("@base44/sdk");
    createBase44Client = module.createClient;
  }
  return createBase44Client;
}

async function requireBase44User(req, res, next) {
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
      return res.status(401).json({ error: "Invalid or expired authentication token" });
    }

    req.base44User = user;
    return next();
  } catch (error) {
    console.error("[voice/auth] token validation failed:", error.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.send("GlobalCall backend running");
});

// ============================================================
// TWILIO TOKEN
// GET /token
//
// The token endpoint is authenticated with the Base44 access token.
// The browser cannot impersonate another GlobalCall user by choosing
// an arbitrary identity.
// ============================================================

// Validate the key/secret pair and TwiML App against the configured account.
// Cache successful validation briefly to avoid an extra Twilio API call on every token.
let twilioCredentialsVerifiedAt = 0;
let twilioCredentialsVerificationPromise = null;
const TWILIO_CREDENTIALS_CACHE_MS = 5 * 60 * 1000;

async function verifyTwilioCredentials() {
  if (Date.now() - twilioCredentialsVerifiedAt < TWILIO_CREDENTIALS_CACHE_MS) return;
  if (twilioCredentialsVerificationPromise) return twilioCredentialsVerificationPromise;

  twilioCredentialsVerificationPromise = (async () => {
    if (!/^AC[0-9a-fA-F]{32}$/.test(TWILIO_ACCOUNT_SID)) {
      throw new Error("TWILIO_ACCOUNT_SID must be an Account SID beginning with AC.");
    }
    if (!/^SK[0-9a-fA-F]{32}$/.test(TWILIO_API_KEY)) {
      throw new Error("TWILIO_API_KEY must be an API Key SID beginning with SK, not the Account SID.");
    }
    if (!TWILIO_API_SECRET || /^(AC|SK|AP)[0-9a-fA-F]{32}$/.test(TWILIO_API_SECRET)) {
      throw new Error("TWILIO_API_SECRET must contain the API key secret, not a SID.");
    }
    if (!/^AP[0-9a-fA-F]{32}$/.test(TWILIO_TWIML_APP_SID)) {
      throw new Error("TWILIO_TWIML_APP_SID must be a TwiML App SID beginning with AP.");
    }

    const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, {
      accountSid: TWILIO_ACCOUNT_SID,
    });
    try {
      await client.api.v2010.account.fetch();
    } catch (_) {
      throw new Error("Twilio rejected the API key/secret for the configured account. Check that TWILIO_API_KEY and TWILIO_API_SECRET are a matching pair belonging to TWILIO_ACCOUNT_SID.");
    }
    try {
      await client.applications(TWILIO_TWIML_APP_SID).fetch();
    } catch (_) {
      throw new Error("Twilio could not find the configured TwiML App under this account. Check TWILIO_TWIML_APP_SID and ensure it belongs to TWILIO_ACCOUNT_SID.");
    }
    twilioCredentialsVerifiedAt = Date.now();
  })();

  try {
    await twilioCredentialsVerificationPromise;
  } finally {
    twilioCredentialsVerificationPromise = null;
  }
}

app.get("/token", requireBase44User, async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  try {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !TWILIO_TWIML_APP_SID) {
      return res.status(500).json({
        error: "Twilio server configuration is incomplete. Required: TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID.",
      });
    }

    await verifyTwilioCredentials();

    const user = req.base44User;
    const requestedIdentity = String(req.query.identity || "").trim();
    const allowedIdentities = new Set(
      [user.id, user.globalcall_number, user.extension, user.username, user.email]
        .filter(Boolean)
        .map((value) => String(value).trim())
    );
    const identity = requestedIdentity
      ? requestedIdentity
      : String(user.globalcall_number || user.extension || user.id).trim();

    if (!identity || identity.length > 121 || !/^[A-Za-z0-9_.:@+-]+$/.test(identity)) {
      return res.status(400).json({
        error: "The voice identity is invalid. Use a short identity containing only letters, numbers, underscores, dots, colons, @, +, or hyphens.",
      });
    }
    if (!allowedIdentities.has(identity)) {
      return res.status(403).json({
        error: "The requested voice identity does not belong to this account.",
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
      { identity, ttl: 3600 }
    );
    token.addGrant(voiceGrant);

    const jwt = token.toJwt();
    console.log(`[token] issued voice token identity=${identity} account=${TWILIO_ACCOUNT_SID.slice(0, 8)} apiKey=${TWILIO_API_KEY.slice(0, 8)} ttl=3600s`);
    return res.json({ token: jwt, identity, expires_in: 3600 });
  } catch (error) {
    const message = error && error.message ? error.message : "Unknown token generation error";
    console.error("[token] Token generation failed:", message);
    return res.status(500).json({
      error: message.startsWith("TWILIO_") || message.startsWith("Twilio ")
        ? message
        : "Failed to generate Twilio token. Check the Twilio credential configuration.",
    });
  }
});OOK
// POST /voice
//
// Internal calls: client:IDENTITY
// Nigerian PSTN: +234XXXXXXXXXX / 0XXXXXXXXXX
//
// Twilio signature validation prevents arbitrary third parties from
// using this endpoint as an unauthenticated voice-routing endpoint.
// ============================================================

function validateTwilioWebhook(req) {
  if (!TWILIO_AUTH_TOKEN) return false;

  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.get("host");
  const url = `${forwardedProto}://${host}${req.originalUrl}`;

  return twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );
}

function normalizeNigeriaNumber(value) {
  let number = String(value || "").trim().replace(/[\s().-]/g, "");

  if (number.startsWith("00")) number = "+" + number.slice(2);
  if (number.startsWith("234")) number = "+" + number;
  if (/^0\d{10}$/.test(number)) number = "+234" + number.slice(1);

  if (!/^\+234\d{10}$/.test(number)) return null;
  return number;
}

app.post("/voice", (req, res) => {
  try {
    if (!validateTwilioWebhook(req)) {
      return res.status(403).type("text/plain").send("Invalid Twilio signature.");
    }

    const to = String(req.body.To || "").trim();
    const callerId = TWILIO_CALLER_ID;

    if (!callerId) {
      return res.status(500).type("text/plain").send("Twilio caller ID is not configured.");
    }

    const twiml = new twilio.twiml.VoiceResponse();

    if (!to) {
      twiml.say("No destination number provided.");
      return res.type("text/xml").send(twiml.toString());
    }

    const dial = twiml.dial({
      callerId,
      answerOnBridge: true,
    });

    if (to.startsWith("client:")) {
      const clientId = to.replace(/^client:/, "").trim();
      if (!clientId || !/^[A-Za-z0-9_.:@+-]{1,128}$/.test(clientId)) {
        twiml.say("Invalid client destination.");
      } else {
        dial.client(clientId);
      }
    } else {
      const nigeriaNumber = normalizeNigeriaNumber(to);
      if (!nigeriaNumber) {
        twiml.say("Only Nigerian destination numbers are supported.");
      } else {
        dial.number(nigeriaNumber);
      }
    }

    return res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("[voice] Error:", error);
    return res.status(500).type("text/plain").send("Voice processing error.");
  }
});

// ============================================================
// SECURE WALLET ROUTES
// ============================================================

app.use(require("./wallet"));

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`GlobalCall backend running on port ${PORT}`);
});
