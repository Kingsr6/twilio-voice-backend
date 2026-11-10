-- GlobalCall private calling schema (additive)
-- Applied to Neon project Global Caller, database neondb.
-- This migration intentionally leaves wallet/payment/call-charge tables unchanged.

CREATE TABLE IF NOT EXISTS public.private_identities (
  user_id TEXT PRIMARY KEY,
  gc_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (gc_id ~ '^GC-[0-9]{8}$')
);

CREATE TABLE IF NOT EXISTS public.private_directory (
  gc_id TEXT PRIMARY KEY REFERENCES public.private_identities(gc_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.private_call_sessions (
  call_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_user_id TEXT NOT NULL REFERENCES public.private_identities(user_id),
  receiver_user_id TEXT NOT NULL REFERENCES public.private_identities(user_id),
  status TEXT NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing','accepted','rejected','missed','ended','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  ended_by_user_id TEXT REFERENCES public.private_identities(user_id),
  CHECK (caller_user_id <> receiver_user_id)
);

CREATE TABLE IF NOT EXISTS public.private_call_signals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id UUID NOT NULL REFERENCES public.private_call_sessions(call_id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES public.private_identities(user_id),
  recipient_user_id TEXT NOT NULL REFERENCES public.private_identities(user_id),
  signal_type TEXT NOT NULL
    CHECK (signal_type IN ('offer','answer','ice-candidate','reject','hangup')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  CHECK (sender_user_id <> recipient_user_id),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS public.private_devices (
  device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES public.private_identities(user_id) ON DELETE CASCADE,
  device_type TEXT NOT NULL DEFAULT 'web',
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.private_id_counters (
  counter_name TEXT PRIMARY KEY,
  last_value BIGINT NOT NULL CHECK (last_value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.private_id_counters(counter_name,last_value)
VALUES ('globalcaller_gc_id',10000001)
ON CONFLICT (counter_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_private_calls_caller_created
  ON public.private_call_sessions(caller_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_private_calls_receiver_created
  ON public.private_call_sessions(receiver_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_private_signals_recipient_expiry
  ON public.private_call_signals(recipient_user_id,expires_at);
CREATE INDEX IF NOT EXISTS idx_private_devices_user_status
  ON public.private_devices(user_id,status);
