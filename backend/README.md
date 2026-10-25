# HENOVA — Server-side data foundation (not yet live)

The current Telegram Mini App in `index.html` still runs in **local demo mode**. Its balances, hen purchases and egg production are stored in `localStorage` (`henova-demo-v1`).

This folder prepares a **dedicated, separate HENOVA backend**. It has **not** been applied to Supabase, and no MIMA/LTF data has been changed.

## Prepared components

- `backend/henova_schema.sql` — players, real server balances, hens, boosts, daily reward, immutable transaction history, unique request IDs; RLS enabled and no public row access.
- `supabase/functions/henova-api/index.ts` — Telegram Mini App `initData` HMAC check, fresh `auth_date`, server-side balance mutations, UUID request deduplication and state response.
- `supabase/config.toml` — opt-out of **Supabase JWT verification for the single function**, because Telegram identity is independently verified inside the function. Do not turn this off on other functions.

## Requirements before activation

1. Create/select a **dedicated Supabase project for HENOVA**; do **not** run the SQL against the existing MIMA/LTF project.
2. Review and apply `backend/henova_schema.sql` in the HENOVA database, then run security advisors and verify no `anon`/`authenticated` access to player data.
3. Configure **Edge Function secrets only on the server**: `HENOVA_TELEGRAM_BOT_TOKEN` (the token of `@HenovaEggsBot`), and check that `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available. Never commit actual tokens or service keys.
4. Set `HENOVA_ALLOWED_ORIGIN=https://mhmtalkasim2-ship-it.github.io`. Deploy `henova-api` to HENOVA's own Supabase project only, preserving `verify_jwt = false`.
5. Test signed Telegram `initData` and reject tampered/expired signatures. Test duplicate requests, concurrent collect, purchases, fan boosts, denied direct Data API requests and daily limits.
6. Design a **verified one-time balance migration** from the current local demo before switching the front end. Do **not** upload or trust raw `localStorage` values for payouts.
7. Only after these tests, update `index.html` to use the new API; avoid updating the UI and gameplay visuals.

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

Supabase CLI was not available when these files were prepared. `henova_schema.sql` is **a reviewed draft, not an applied migration**. Once the dedicated backend is created, use Supabase's migration tooling to create and test the final migration, and deploy only after validation.
