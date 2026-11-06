-- Run after 001_private_calling.sql. Read-only verification.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'private_identities',
    'private_directory',
    'private_call_sessions',
    'private_call_signals',
    'private_devices',
    'wallets',
    'payment_intents',
    'funding_credits',
    'call_charges',
    'migration_audit'
  )
ORDER BY table_name;

-- Expected: all five private-calling tables and all five wallet tables exist.
SELECT
  to_regclass('public.wallets') AS wallets,
  to_regclass('public.payment_intents') AS payment_intents,
  to_regclass('public.funding_credits') AS funding_credits,
  to_regclass('public.call_charges') AS call_charges,
  to_regclass('public.migration_audit') AS migration_audit;

-- Expected: one function row.
SELECT to_regprocedure('public.cleanup_expired_private_call_signals()')
  AS cleanup_function;
