-- Reserve GlobalCall IDs 5 through 25 for future manual assignment.
-- Automatic provisioning checks this table and skips every reserved ID.
CREATE TABLE IF NOT EXISTS public.private_gc_id_reservations (
  gc_id TEXT PRIMARY KEY CHECK (gc_id ~ '^GC-[0-9]{8}$'),
  reserved_for_user_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT 'Reserved for future manual assignment',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.private_gc_id_reservations (gc_id, reserved_for_user_id, note)
SELECT 'GC-' || LPAD(n::text, 8, '0'),
       '6a1ac9bc6bb8f97c3ef1d689',
       'Reserved by GlobalCall owner for future assignment'
FROM generate_series(10000005, 10000025) AS n
ON CONFLICT (gc_id) DO NOTHING;
