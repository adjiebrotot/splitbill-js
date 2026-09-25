# CLAUDE.md

## When explaining coding, use plain English. No filler. Caveman-style.
**Rules:**
1. Drop: articles (a / an / the), filler (just / really / basically / actually / simply), pleasantries, hedging. Fragments OK.
2. Short synonyms: big not extensive, fix not implement a solution for. Technical terms exact. Code blocks unchanged. Errors quoted exact.
3. Pattern: [thing] [action] [reason]. [next step].
4. Code / commits / PRs: write normal.

---

## Golden rule: accounting integrity

Every number comes from `src/engine/` (pure, no I/O). Server, browser preview (`public/app/static/js/engine.js`), Telegram and PNG/PDF reports all call it. Nothing else adds money.

- Money is integer **minor units**: `BIGINT` in Postgres, `bigint` in TypeScript. No floats, ever. The currency's minor-unit count is stored next to every amount.
- pg returns BIGINT as a string. Read money with `toMinor()` (`src/num.ts`). API JSON carries amounts as minor-unit strings.
- One rounding per member per bill, then the leftover rule (payer first, else fraction holders in join order). Never floor per item and sum.
- Every write goes through `write()` in `src/services/actions.ts`: lock group row, check status + permission, validate with the engine, write, log `group_events`, bump `revision`, recompute and refuse to commit unless books balance.
- Postgres re-checks each bill at COMMIT (deferred triggers in `src/migrations/001_initial.ts`). Do not weaken them.
- Change the engine → run `node scripts/build_engine.mjs` (bundle is checked in; test fails when stale). Bump `ENGINE_VERSION` when a number could change.
- New invariant or edge case → add it to `tests/unit/engine_*.test.ts` and, if it needs the DB, `tests/unit/db_actions.test.ts` / `scripts/integrity_harness.ts`.

## Automate before asking

If code can do it, do it; an error is only for what code cannot decide. A trip bill or payment in a currency with no rate gets the market rate on save (`_autoRatesFor` fetches BEFORE `write()`, `_addAutoRates` inserts inside it, source `auto`, first rate of a currency is "from the start"); the page calls `rate/fill` for any gap left. A one-off is named after its bill (`saveBill`), and one left without a bill is deleted (client on close, `cleanup()` after a day).

## Architecture: single hub

All media (web API, Telegram, future ones) call `src/services/actions.ts`. No route or bot handler touches the DB or a service directly for a business operation. Actions return `{ ok, data }` or `{ ok: false, code, params }`; `code` maps to `err.<code>` in `src/i18n.ts`.

```
web / Telegram → actions.ts → repo.ts (one-query group load) + ledger.ts → engine
```

## AI reads, code computes

Chat and receipt photos go through `src/services/ai_parse.ts`. The models (OpenRouter, `llm_client.ts`) only COPY names and numbers; amounts are evaluated exactly by `amount_expr.ts` / the engine's `parseAmount`, names matched to members by code. AI output is always a draft the person saves through the normal bill form. Unknown names are reported, never created by the AI: the draft keeps them per line (`unknown`, `payer_unknown`, `participants_unknown`) and the form offers one-tap `+ Name`, which adds that person through `member/add` and puts them back where the message placed them. A line meant for everyone carries `everyone: true`, so a person added later joins it. Prompt or parsing change → run `scripts/parse_harness.ts` (live, costs money) and keep `tests/unit/ai_parse.test.ts` green.

## Telegram is a medium, not a second app

`src/telegram/bot.ts` parses updates and calls `actions.ts`, nothing else. Group chats run with privacy mode ON: only `/cmd@bot`, bare `/cmd` when the bot spoke last, and replies to the bot arrive, so every group flow is a command or a ForceReply. Keep `allowed_updates` = message, callback_query, my_chat_member (`telegram/api.ts`). Test with `tests/unit/db_telegram.test.ts` (Bot API and AI mocked).

## Admin console: `/admin`

Static page `admin.html` + `admin.js`, JSON under `/app/api/admin/*` (`src/webapp/admin_routes.ts`), sign-in by `ADMIN_PASSWORD` (`admin_auth.ts`, own cookie, not a member session). Routes call only `src/services/admin_actions.ts`; anything touching a group's books goes through `actions.ts` (`adminHandOverGroups` uses the same lock / log / revision / verify gate). DB viewer is read-only; add a new secret column to `MASKED`. The page is **English only** by owner decision: plain labels, no i18n keys; error codes still need `err.<code>` in both languages (test).

## Node runtime

Route handlers that touch `pg`, `@node-rs/bcrypt`, `@napi-rs/canvas` or `pdf-lib` export `runtime = "nodejs"`. Native packages stay in `serverExternalPackages` (`next.config.mjs`).

## Pages are static; the CDN serves them

`public/app/static/pages/*.html`, reached by `rewrites()` in `next.config.mjs`. No function renders a page. Each page's `boot.js` redirects signed-out users (hint cookie `sb_auth`), picks the language (`sb_lang`), and starts ONE `/app/api/boot` request. Add a page → add the rewrite, the `shellFor()` mapping and `STATIC` entry in `public/sw.js`.

## Cache busting is a script

After ANY change under `public/app/static/` or `public/sw.js`:

```
npx tsx scripts/build_i18n.ts      # if src/i18n.ts changed
node scripts/build_engine.mjs      # if src/engine changed
npx tsx scripts/stamp_assets.ts    # always, last
```

(`npm run gen` runs all three.) `stamp_assets` writes content hashes into every `?v=` and derives the `sw.js` CACHE name. `tests/unit/assets.test.ts` fails when anything is stale. There is ONE `sw.js`, in `public/`.

## Layout: read DESIGN-SYSTEM.md first

Anything that renders follows `DESIGN-SYSTEM.md`. Never invent a spacing value, padding, table size or button variant. Pages hold no `<style>`; rules go in `shared.css`.

## i18n: every UI string in BOTH languages

`src/i18n.ts` is the only source. English + Bahasa Indonesia, both always. Static HTML uses `data-i18n*` attributes; JS uses `t('key')`; errors are `err.<code>`. Indonesian must read naturally ("Akun" for account). **No em dash in any user-facing string**; a missing value prints `-`. `tests/unit/i18n.test.ts` checks keys, translations and em dashes.

## Never put JSON.stringify() inside a double-quoted HTML attribute

Escape with `esc()` (ui.js) first. Same for any value in an attribute.

## Secrets

`LLM_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `SETUP_SECRET`, `ADMIN_PASSWORD` live in `.env.local` (gitignored) and Vercel env. Never commit them.

## Tests

```
npm test                                    # unit + contract tests
TEST_DATABASE_URL=postgresql://... npm test # also runs the Postgres tests (one schema per file)
DATABASE_URL=... DB_DRIVER=pg npx tsx scripts/integrity_harness.ts
```
