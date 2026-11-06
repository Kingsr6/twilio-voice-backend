# GlobalCall private-calling database migration

## Scope
This migration adds five private-calling tables and indexes plus a cleanup function:
- `private_identities`
- `private_directory`
- `private_call_sessions`
- `private_call_signals`
- `private_devices`

It does **not** alter `wallets`, `payment_intents`, `funding_credits`,
`call_charges`, or `migration_audit`. It does not modify Twilio routes,
Flutterwave handling, environment variables, or production deployment settings.

## Apply to Neon
1. Open the GlobalCall Neon project and select the production branch/database.
2. Take a Neon restore point/branch first if available.
3. Open SQL Editor and run `migrations/001_private_calling.sql` as one script.
4. Confirm the transaction completed successfully.
5. Run the verification SQL in `migrations/001_verify_private_calling.sql`.

Do not paste a connection string or database password into GitHub, chat, or this repository.

## Important implementation rules
- Continue authenticating requests with the existing Base44 authentication middleware.
- Derive `user_id` from the verified Base44 token on the server; never trust a client-supplied user ID.
- Every call-session read/write must verify the authenticated user is the caller or receiver.
- Every signal insert/read must verify call membership and the sender/recipient direction.
- Restrict signal payload size and allowed WebRTC message shapes in the backend.
- Never expose `private_identities.user_id` in public directory responses.
- Allocate GlobalCall IDs server-side in a transaction after checking uniqueness. Do not allocate IDs in the browser.
- Existing GlobalCall ID `GC-10000001` must be migrated only after confirming the corresponding Base44 user ID in the authenticated backend; do not create a guessed mapping.
- `cleanup_expired_private_call_signals()` is not scheduled by this migration. Invoke it through a protected maintenance task when a scheduler is available.

## Rollback
The migration is additive, but dropping these tables deletes private-calling records.
Do not run a rollback in production without a verified backup and explicit review.
