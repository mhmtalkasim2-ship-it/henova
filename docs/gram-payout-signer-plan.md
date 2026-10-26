# HENOVA automated GRAM payouts — security gate

Status: PREPARATION ONLY. Public payouts must remain disabled.

## Separation
- Public Telegram Mini App authenticates users with signed Telegram initData. No payout signing keys or provider credentials are ever sent to it.
- Supabase API validates requested amount, wallet ownership and request ID.
- PostgreSQL atomically reserves eggs and creates exactly one withdrawal record, with a cooldown and pending-withdrawal guard.
- Dedicated payout worker signs outgoing transactions only after it atomically claims a validated pending payout. Signing credentials belong to a separate KMS/HSM or custody provider with withdrawal limits, not GitHub, frontend, chat, or publicly invokable Supabase functions.
- Do not infer payout authorization from TON Connect account connection: TON Connect does not grant unattended spending authority. Real wallet ownership verification needs a server-verified TON Proof.

## Worker lifecycle
1. Check payout settings and safety flags. Abort unless signer, verifier and test-transfer gates are true; enforce a per-transaction and daily treasury budget.
2. Claim a pending request in a durable transactional lease, with immutable request ID and destination/amount.
3. Recheck destination wallet proof, funds and nonce/seqno; reject duplicate claims.
4. Sign ONE TON native GRAM transfer through the isolated signer. Never store a seed phrase or export keys.
5. Persist signed payload ID, send result and seqno before retry; no blind retry on timeout.
6. Independently verify an outgoing on-chain transfer FROM the configured payout wallet TO the exact user address FOR the exact nanotons amount, on mainnet, with transaction success and sufficient finality. Treat bounced/failed transactions as unpaid. Match trace/hash and block metadata. A raw tx hash supplied by a user or worker is not sufficient proof.
7. Only after verification mark the payout confirmed and send the HENOVA withdrawals-channel proof with a real TON explorer link. Make the notification idempotent and reconcile ambiguous Telegram responses manually.

## Before launch
- Validate 0.05 GRAM test payout on mainnet to a controlled test recipient, including fees and explorer proof.
- Implement wallet signature verification for user withdrawals (TON Proof), even if this is invisible in the UI.
- Configure alerts and emergency pause; limit funds in the payout wallet.
- Audit retries, locks, RLS and role permissions, refunds for definitively failed payments, and accounting conservation.

## Current configured economic policy
- 10,000 eggs = 1 GRAM; min 500 eggs, max 10,000 eggs, one request per 12 hours.
- No signing service installed. No private keys stored. Do not enable payouts until deployed worker and independent TON confirmation are both tested.
