# HENOVA 🥚

An original Telegram chicken-farm Mini App — an independent project from MIMA.

## First working prototype

Open [index.html](./index.html) in a browser to preview the mobile interface. This is an English-default standalone frontend with optional Arabic and Turkish settings.

Features implemented in the demo:
- Free starter hen that produces 10 eggs/hour
- 60-egg shared collection basket that restarts after Collect
- Hen packs with demo Coin balances and purchases
- Daily login demo reward, referral link sharing, and five navigation tabs
- Wallet preview with 1 egg = 0.0001 GRAM, minimum 50 eggs, once per 24 hours

## Security and payment notice

**Prototype only. No real GRAM transfers.** Browser localStorage can be altered by users and is never a safe source of truth for money or rewarded balances. Withdraw and deposit are disabled. Before any public launch, implement Telegram identity verification, a secured database ledger, server-side farming logic, anti-double-spend checks, deposit verification and funded TON payout processing. Never put bot tokens or payout wallet keys in web code.

## Telegram

https://t.me/HenovaEggsBot
