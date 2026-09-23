# Split Bill

Split bills among friends: one-off bills and whole trips. Next.js route handlers + Postgres (Neon) on Vercel, a vanilla-JS PWA, a Telegram bot, OpenRouter for reading chat messages and receipt photos. Same architecture and design system as finance-tracker-js.

## What it does

- **One-off**: one bill, split by item, evenly or by percent. Settle when done.
- **Trip**: many bills over a trip, members with or without the app, many currencies with one group rate table, mid-trip repayments. The owner settles at the end; transfers are ticked off as paid; the owner can reopen.
- **Input**: form, chat text or receipt photo. AI output is always a draft you check.
- **Reports**: group (who pays whom) and individual, as text to copy or PNG / PDF. Unsettled reports say NOT SETTLED.
- **Telegram**: private chat and group chats.

## Accounting integrity

All arithmetic is in `src/engine/` on integer minor units: exact fractions, one rounding per member per bill, deterministic leftover rule, fewest-transfer settlement (exact up to 18 people). The same engine runs in the browser for the live preview. Postgres re-checks every bill at commit. See `CLAUDE.md`.

## Run locally

```bash
npm install
cp .env.example .env.local        # DATABASE_URL, DB_DRIVER=pg, SETUP_SECRET
npx tsx scripts/migrate.ts        # apply schema
npm run dev
```

## Commands

```bash
npm run dev / build / start
npm run typecheck
npm test
npm run gen                        # i18n bundle + engine bundle + asset stamps
```

## Deploy (Vercel)

Set the env vars from `.env.example`, deploy, then apply migrations once per release:

```bash
curl -X POST -H "Authorization: Bearer $SETUP_SECRET" https://<host>/app/api/admin/migrate
```

For Telegram, register the webhook: `POST /app/api/admin/telegram-webhook` with the same header.
