# HENOVA — Server-side data foundation (not yet live)

The current Telegram Mini App in `index.html` still runs in **local demo mode**. Its balances, hen purchases and egg production are stored in `localStorage` (`henova-demo-v1`).

**Database status (2026-10-25): ACTIVE schema on the dedicated Free HENOVA Supabase project.**
- Project ID: `gnkyduafxivfyrpoznnp` (HENOVA, region `eu-west-1`)
- Applied migration versions: `20261025193516`, `20261025193630`
- Created: `public.henova_players`, `public.henova_events`, and `public.henova_process_action` (service-role only)
- Both tables have RLS enabled with **no client access policies**, deliberately keeping all operations behind Telegram-authenticating API
- Verified roles: `anon` and `authenticated` have no direct table or action RPC access. Supabase's RLS event-trigger helper EXECUTE privileges have also been restricted.
- Transactional smoke tests passed: collect capped at 60, duplicate request ignored, daily reward +100 coins, red hen purchased for 1000 coins, fan boost costs 500 coins. Fake test records were rolled back, leaving both tables empty.
- Checked Supabase security and performance advisors: no WARN/ERROR findings. The INFO notices about RLS without policies are **intentional**.
- No MIMA/LTF data has been changed. The live Telegram app **still uses local demo balances** until secure API integration and verified migration are complete.

## Deployed database and prepared API

- `backend/henova_schema.sql` — reference SQL source for players, balances, hens, boosts, daily rewards, and idempotent transaction ledger.
- `supabase/migrations/20261025193516_henova_initial_players_events_secure_actions.sql` — versioned copy of applied HENOVA schema migration.
- `supabase/migrations/20261025193630_henova_restrict_rls_event_trigger_permissions.sql` — hardens Supabase's default RLS helper function.
- `supabase/functions/henova-api/index.ts` — Telegram Mini App `initData` HMAC check, fresh `auth_date`, server-side balance mutations, UUID request deduplication and state response.
- `supabase/config.toml` — opt-out of **Supabase JWT verification for the single function**, because Telegram identity is independently verified inside the function. Do not turn this off on other functions.

## Remaining requirements before the Mini App can use the database

1. **Already completed:** HENOVA's separate Free Supabase database and migrations. Do not rerun migrations in the MIMA/LTF organization.
2. Configure **Edge Function secrets only on the server**: `HENOVA_TELEGRAM_BOT_TOKEN` (the token of `@HenovaEggsBot`), and check that `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available. Never commit actual tokens or service keys.
3. **Deployment complete:** `henova-api` ACTIVE v1 on the HENOVA project with `verify_jwt = false`; access still requires valid Telegram initData verified inside the function. Confirm `HENOVA_ALLOWED_ORIGIN=https://mhmtalkasim2-ship-it.github.io` (default if not explicitly set).
4. Test signed Telegram `initData` and reject tampered/expired signatures. Test duplicate requests, concurrent collect, purchases, fan boosts, denied direct Data API requests and daily limits.
5. Design a **verified one-time balance migration** from the current local demo before switching the front end. Do **not** upload or trust raw `localStorage` values for payouts.
6. Only after these tests, update `index.html` to use the new API; avoid updating the UI and gameplay visuals.

## Action contracts (planned API)

`POST /functions/v1/henova-api`, JSON body:

- `{"initData":"<raw Telegram.WebApp.initData>","action":"state"}`
- `{"initData":"...","action":"collect","requestId":"<UUID>"}`
- `{"initData":"...","action":"daily","requestId":"<UUID>"}`
- `{"initData":"...","action":"purchase","item":"red","requestId":"<UUID>"}`
- `{"initData":"...","action":"boost","requestId":"<UUID>"}`

Use `crypto.randomUUID()` once per intended action and reuse the **same requestId** for retries.

### Security invariants

- The browser sends no trusted balance, farm speed, user ID, prices or egg count.
- HMAC verification uses the **bot token kept in Edge Function secrets**, not a public Supabase key.
- SQL transactions lock the user's row and reject repeated request IDs.
- All mutable player tables have RLS; no client policies grant access.
- The `henova_process_action` database function is executable by `service_role` only.
- No public withdrawal or real-currency exchange is implemented.

## Important

The database migrations **are applied on the dedicated HENOVA project**, and the records are mirrored in `supabase/migrations/`. `henova-api` was deployed in 2026-10-25 and reports ACTIVE v1. **The `henova-api` Edge Function has been deployed (ACTIVE, version 1, 2026-10-25) with Telegram HMAC verification. Its secrets and valid user requests have not yet been confirmed by a live end-to-end test; do not call it production-verified yet.** `index.html` has not been switched off `localStorage`. Never copy unverified local balances as authoritative payout amounts.
