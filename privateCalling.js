const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 5,
});

const SIGNAL_TYPES = new Set(["offer", "answer", "ice-candidate"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALL_STATES = new Set(["accepted", "rejected", "ended", "missed"]);

function cleanText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

async function ensureIdentity(user) {
  const userId = String(user.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize provisioning for this account, including the first insert when no row exists.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
    const found = await client.query(
      "SELECT user_id, gc_id, status FROM public.private_identities WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    if (found.rowCount) {
      await client.query("COMMIT");
      return found.rows[0];
    }

    // Preserve the account's already-issued legacy GlobalCall ID.
    const legacy = userId === "6a1ac9bc6bb8f97c3ef1d689";
    let gcId;
    if (legacy) {
      gcId = "GC-10000001";
      await client.query(
        "UPDATE public.private_id_counters SET last_value = GREATEST(last_value, 10000001), updated_at = NOW() WHERE counter_name = 'globalcaller_gc_id'"
      );
    } else {
      const counter = await client.query(
        "UPDATE public.private_id_counters SET last_value = last_value + 1, updated_at = NOW() WHERE counter_name = 'globalcaller_gc_id' RETURNING last_value"
      );
      if (!counter.rowCount) throw new Error("GlobalCall ID counter is not initialized");
      gcId = "GC-" + String(counter.rows[0].last_value).padStart(8, "0");
    }

    const identity = await client.query(
      "INSERT INTO public.private_identities(user_id, gc_id, status) VALUES($1,$2,'active') RETURNING user_id,gc_id,status",
      [userId, gcId]
    );
    const displayName = cleanText(user.full_name || user.name || user.display_name || user.email?.split("@")[0] || "GlobalCall User", 80);
    await client.query(
      "INSERT INTO public.private_directory(gc_id,display_name,status) VALUES($1,$2,'active') ON CONFLICT(gc_id) DO UPDATE SET display_name=EXCLUDED.display_name,status='active',updated_at=NOW()",
      [gcId, displayName]
    );
    await client.query("COMMIT");
    return identity.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = function createPrivateCallingRouter(requireBase44User) {
  const router = express.Router();
  router.use(requireBase44User);

  router.get("/private/me", async (req, res) => {
    try {
      const identity = await ensureIdentity(req.base44User);
      return res.json({ identity });
    } catch (error) {
      console.error("[private/me]", error);
      return res.status(500).json({ error: "Could not load GlobalCall identity" });
    }
  });

  router.get("/private/directory/:gcId", async (req, res) => {
    try {
      const gcId = cleanText(req.params.gcId, 16).toUpperCase();
      if (!/^GC-\d{8}$/.test(gcId)) return res.status(400).json({ error: "Invalid GlobalCall ID" });
      const result = await pool.query(
        "SELECT d.gc_id, d.display_name FROM public.private_directory d JOIN public.private_identities i ON i.gc_id=d.gc_id WHERE d.gc_id=$1 AND d.status='active' AND i.status='active'",
        [gcId]
      );
      if (!result.rowCount) return res.status(404).json({ error: "GlobalCall ID not found" });
      return res.json({ contact: result.rows[0] });
    } catch (error) {
      console.error("[private/directory]", error);
      return res.status(500).json({ error: "Directory lookup failed" });
    }
  });

  router.post("/private/devices", async (req, res) => {
    try {
      const identity = await ensureIdentity(req.base44User);
      const deviceType = ["web", "android", "ios", "desktop"].includes(req.body.device_type) ? req.body.device_type : "web";
      const deviceName = cleanText(req.body.device_name, 100) || null;
      const result = await pool.query(
        "INSERT INTO public.private_devices(user_id,device_type,device_name) VALUES($1,$2,$3) RETURNING device_id,device_type,device_name,status,last_seen_at",
        [identity.user_id, deviceType, deviceName]
      );
      return res.status(201).json({ device: result.rows[0] });
    } catch (error) {
      console.error("[private/devices]", error);
      return res.status(500).json({ error: "Device registration failed" });
    }
  });

  router.post("/private/calls", async (req, res) => {
    try {
      const caller = await ensureIdentity(req.base44User);
      const gcId = cleanText(req.body.gc_id, 16).toUpperCase();
      if (!/^GC-\d{8}$/.test(gcId)) return res.status(400).json({ error: "A valid GlobalCall ID is required" });
      const receiver = await pool.query(
        "SELECT i.user_id,i.gc_id FROM public.private_identities i JOIN public.private_directory d ON d.gc_id=i.gc_id WHERE i.gc_id=$1 AND i.status='active' AND d.status='active'",
        [gcId]
      );
      if (!receiver.rowCount) return res.status(404).json({ error: "GlobalCall user not found" });
      if (receiver.rows[0].user_id === caller.user_id) return res.status(400).json({ error: "You cannot call your own GlobalCall ID" });
      const call = await pool.query(
        "INSERT INTO public.private_call_sessions(caller_user_id,receiver_user_id,status) VALUES($1,$2,'ringing') RETURNING call_id,status,created_at",
        [caller.user_id, receiver.rows[0].user_id]
      );
      return res.status(201).json({ call: call.rows[0], receiver_gc_id: receiver.rows[0].gc_id });
    } catch (error) {
      console.error("[private/calls:create]", error);
      return res.status(500).json({ error: "Could not start private call" });
    }
  });

  router.get("/private/calls/incoming", async (req, res) => {
    try {
      const identity = await ensureIdentity(req.base44User);
      const result = await pool.query(
        "SELECT c.call_id,c.status,c.created_at,i.gc_id AS caller_gc_id,d.display_name AS caller_name FROM public.private_call_sessions c JOIN public.private_identities i ON i.user_id=c.caller_user_id JOIN public.private_directory d ON d.gc_id=i.gc_id WHERE c.receiver_user_id=$1 AND c.status='ringing' ORDER BY c.created_at DESC LIMIT 20",
        [identity.user_id]
      );
      return res.json({ calls: result.rows });
    } catch (error) {
      console.error("[private/calls:incoming]", error);
      return res.status(500).json({ error: "Could not load incoming calls" });
    }
  });

  router.post("/private/calls/:callId/state", async (req, res) => {
    try {
      const identity = await ensureIdentity(req.base44User);
      if (!UUID_RE.test(req.params.callId)) return res.status(400).json({ error: "Invalid call ID" });
      const nextState = cleanText(req.body?.status, 16);
      if (!CALL_STATES.has(nextState)) return res.status(400).json({ error: "Invalid call state" });
      const update = await pool.query(
        `UPDATE public.private_call_sessions
         SET status=$3,
             answered_at=CASE WHEN $3='accepted' THEN NOW() ELSE answered_at END,
             ended_at=CASE WHEN $3 IN ('rejected','ended','missed') THEN NOW() ELSE ended_at END,
             ended_by_user_id=CASE WHEN $3 IN ('rejected','ended','missed') THEN $2 ELSE ended_by_user_id END
         WHERE call_id=$1 AND (caller_user_id=$2 OR receiver_user_id=$2)
           AND (($3='accepted' AND receiver_user_id=$2 AND status='ringing')
             OR ($3='rejected' AND receiver_user_id=$2 AND status='ringing')
             OR ($3='missed' AND receiver_user_id=$2 AND status='ringing')
             OR ($3='ended' AND status IN ('ringing','accepted')))
         RETURNING call_id,status,answered_at,ended_at`,
        [req.params.callId, identity.user_id, nextState]
      );
      if (!update.rowCount) return res.status(409).json({ error: "Call not found or state transition not allowed" });
      return res.json({ call: update.rows[0] });
    } catch (error) {
      console.error("[private/calls:state]", error);
      return res.status(500).json({ error: "Could not update call" });
    }
  });

  router.post("/private/signals", async (req, res) => {
    try {
      const identity = await ensureIdentity(req.base44User);
      const callId = cleanText(req.body?.call_id, 40);
      const signalType = cleanText(req.body?.signal_type, 24);
      const payload = req.body?.payload && typeof req.body.payload === "object" && !Array.isArray(req.body.payload) ? req.body.payload : null;
      if (!UUID_RE.test(callId) || !SIGNAL_TYPES.has(signalType) || !payload) return res.status(400).json({ error: "Invalid signaling message" });
      if (JSON.stringify(payload).length > 16000) return res.status(413).json({ error: "Signaling payload is too large" });

      const call = await pool.query(
        "SELECT caller_user_id,receiver_user_id,status FROM public.private_call_sessions WHERE call_id=$1",
        [callId]
      );
      if (!call.rowCount) return res.status(404).json({ error: "Call not found" });
      const row = call.rows[0];
      if (identity.user_id !== row.caller_user_id && identity.user_id !== row.receiver_user_id) return res.status(403).json({ error: "Not a participant in this call" });
      if (!["ringing", "accepted"].includes(row.status)) return res.status(409).json({ error: "Call is no longer active" });
      if (signalType === "offer" && identity.user_id !== row.caller_user_id) return res.status(403).json({ error: "Only the caller can send an offer" });
      if (signalType === "answer" && (identity.user_id !== row.receiver_user_id || row.status !== "accepted")) return res.status(403).json({ error: "Only the accepted receiver can send an answer" });
      if (signalType === "ice-candidate" && row.status !== "accepted") return res.status(409).json({ error: "ICE candidates can only be exchanged after the call is accepted" });
      const recipient = identity.user_id === row.caller_user_id ? row.receiver_user_id : row.caller_user_id;
      const saved = await pool.query(
        "INSERT INTO public.private_call_signals(call_id,sender_user_id,recipient_user_id,signal_type,payload) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,created_at",
        [callId, identity.user_id, recipient, signalType, JSON.stringify(payload)]
      );
      return res.status(201).json({ signal: saved.rows[0] });
    } catch (error) {
      console.error("[private/signals:post]", error);
      return res.status(500).json({ error: "Could not send signaling message" });
    }
  });

  router.get("/private/signals/:callId", async (req, res) => {
    try {
      const identity = await ensureIdentity(req.base44User);
      const callId = cleanText(req.params.callId, 40);
      if (!UUID_RE.test(callId)) return res.status(400).json({ error: "Invalid call ID" });
      const participant = await pool.query(
        "SELECT 1 FROM public.private_call_sessions WHERE call_id=$1 AND (caller_user_id=$2 OR receiver_user_id=$2)",
        [callId, identity.user_id]
      );
      if (!participant.rowCount) return res.status(404).json({ error: "Call not found" });
      await pool.query("DELETE FROM public.private_call_signals WHERE expires_at < NOW()");
      const afterId = Number.parseInt(req.query.after || "0", 10);
      const result = await pool.query(
        "SELECT id,sender_user_id,signal_type,payload,created_at FROM public.private_call_signals WHERE call_id=$1 AND recipient_user_id=$2 AND id>$3 AND expires_at>NOW() ORDER BY id ASC LIMIT 100",
        [callId, identity.user_id, Number.isFinite(afterId) && afterId > 0 ? afterId : 0]
      );
      return res.json({ signals: result.rows });
    } catch (error) {
      console.error("[private/signals:get]", error);
      return res.status(500).json({ error: "Could not retrieve signaling messages" });
    }
  });

  return router;
};
