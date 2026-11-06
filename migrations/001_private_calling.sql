-- GlobalCall private calling schema
-- Additive migration only. Does not alter wallet/payment/Twilio tables.
-- Safe to re-run on PostgreSQL versions supported by Neon.

BEGIN;

CREATE TABLE IF NOT EXISTS private_identities (
    user_id TEXT PRIMARY KEY,
    gc_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS private_directory (
    gc_id TEXT PRIMARY KEY
        REFERENCES private_identities(gc_id) ON UPDATE CASCADE ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS private_call_sessions (
    call_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    caller_user_id TEXT NOT NULL,
    receiver_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ringing'
        CHECK (status IN ('ringing', 'accepted', 'rejected', 'missed', 'ended', 'failed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (caller_user_id <> receiver_user_id),
    CHECK (ended_at IS NULL OR answered_at IS NULL OR ended_at >= answered_at)
);

CREATE TABLE IF NOT EXISTS private_call_signals (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    call_id UUID NOT NULL
        REFERENCES private_call_sessions(call_id) ON DELETE CASCADE,
    sender_user_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    signal_type TEXT NOT NULL
        CHECK (signal_type IN ('offer', 'answer', 'ice-candidate', 'reject', 'hangup')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
    CHECK (sender_user_id <> recipient_user_id)
);

CREATE TABLE IF NOT EXISTS private_devices (
    device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    device_type TEXT NOT NULL DEFAULT 'web',
    device_name TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_private_calls_caller_created
    ON private_call_sessions(caller_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_private_calls_receiver_created
    ON private_call_sessions(receiver_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_private_signals_recipient_expiry
    ON private_call_signals(recipient_user_id, expires_at, id);
CREATE INDEX IF NOT EXISTS idx_private_signals_call_created
    ON private_call_signals(call_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_private_devices_user_status
    ON private_devices(user_id, status);

-- Cleanup is intentionally exposed as a function; schedule it only after
-- confirming the hosting plan supports scheduled jobs. Call from a cron task
-- or periodically from a protected backend maintenance task.
CREATE OR REPLACE FUNCTION cleanup_expired_private_call_signals()
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    DELETE FROM private_call_signals WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

COMMIT;
