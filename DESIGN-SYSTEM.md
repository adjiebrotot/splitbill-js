# DESIGN-SYSTEM.md

Layout rules for anything that renders. `CLAUDE.md` points here; this file is the whole of it.

Inherited from finance-tracker-js, whose main app is the source of truth for every shared value. Split Bill differences, in one place:

- Pages are static HTML in `public/app/static/pages/*.html` (not `templates.json`). They carry NO `<style>` block: every rule lives in `shared.css`. Split Bill's own components (chips, bill lines, reconcile line, preview, transfers) are in its SPLIT BILL section, above SPACING RHYTHM.
- The shell is `topbar.js`: the logo goes home, the user menu holds Settings and Sign out. Home is the only page, so there is no nav and no bottom tabs.
- Layout follows use, not symmetry. The action done most (`Add Bill`) is ONE full-width `btn-primary` (`.page-action`) above the cards, on Home and on a split. Then Bills, then Balances (tiles + who pays whom; the per-member table is behind `Details`). Payments and Members sit side by side in `.tool-cols` (one column under 760px). Rarely used things are one button that opens a modal: `Rates` and the gear (`Manage`: rename, currency, Telegram, new invite link, delete) in the page header's `.head-actions`.
- A one-off has no Settle step. It holds one bill, so it reads Settled once nobody owes anybody, and each transfer's `Mark Paid` records that payment directly (undo: delete it under Payments). Home starts one with `Split One Bill`.
- A bill row opens its bill (`.row-link`); its delete is the trash in the bill modal's head (`.modal-head-actions`), still through `confirmDialog`. Payments and members keep their row actions.
- The bill modal shows only what the step needs: a new bill starts at its input (Photo, Chat, Form tabs; picking, dropping or taking a photo reads it at once, and the drop area and camera button give way to the photo while it reads). After a read the input gives way to `Reset` and the form. Date, currency and receipt total fold into `<details class="more">`. Chip rows end in a `+` (`.mchip-add`) that adds a person in place; the payer is a chip row too.
- Money reads "IDR 120,000": the code leads, as `.ccy` (text font, quieter) before the mono figure. Build it with `moneyHtml()` / `signedMoneyHtml()` (ui.js); `money()` is the same order as plain text for sentences. Reports and Telegram use the same order.
- A list that can grow is paged with `renderPager()` (ui.js) into its card's `.tool-pagination`: Bills 10 a page, Payments and Members 5 each. Payments and Members stand the same height (`.tool-cols` stretches them; the pager sits on the bottom edge).
- A currency is picked in the searchable combo (`currency.js`, finance-tracker `.combo-wrap`): Recommended (the user's default, the split's currencies, the device's time zone, a short base) over Other Currencies. The page's `<select>` stays as the hidden value holder; set a value from code with `setCurrencyValue()`. A money box is `.amount-wrap` with the currency code in front (`setAmountAffix()`).
- The toast sits centred at the bottom of the screen, above any modal.
- Otherwise the group page is a tool page: `.tool-card` per collection, `+ Add <thing>` as `btn-ghost btn-compact` in `.tool-head-actions`, `confirmDialog` for every delete.
- Cache busting is automatic: `npx tsx scripts/stamp_assets.ts` (see `CLAUDE.md`). Ignore the manual `?v=N` / two-copy `sw.js` rules below; they describe finance-tracker.

The finance-tracker text follows. Where it names a finance page or file, read it as the matching Split Bill one.

**Read this BEFORE the first edit** when a task touches any of:

- HTML in `src/webapp/templates.json`, or a page `<style>` block inside it
- `public/app/static/css/shared.css` or `public/guide-style.css`
- JS that builds markup: anything under `public/app/static/js/` (`app.js`, `entry_card.js`, `budgeting.js`, `portfolio.js`, `goal.js`, `side_job.js`, `settings.js`, `family.js`, `currency.js`, `topbar.js`, `ui.js`)
- a guide page under `public/app/static/guide*.html`
- anything described as spacing, gap, padding, margin, alignment, card, modal, table, layout

**Never invent a value.** Spacing, card padding, table sizes and button variants all come off the scales below, and the main app (`/app`) is the source of truth for every shared one. A layout bug patched with a number that is not on the scale is the same bug again next month, on the next page.

The rest of the conventions (i18n in both languages, cache busting after a static edit, the `actions.ts` hub) stay in `CLAUDE.md` and still apply.

---

## Spacing: one gap, and it is a margin-TOP

`shared.css` ends with a SPACING RHYTHM block. Every card in the app — `.card`, `.tool-card`, `.settings-card`, `.entry-card` and a modal's `.modal-body` — is padded 20px on all four sides and separates the blocks inside it by `--gap` (14px). The rule is:

```css
.card > *            { margin-bottom: 0; }
.card > * + *        { margin-top: var(--gap); }
```

**Never give a block inside a card a `margin-bottom`. It will be dropped.** The gap is a top margin on purpose, and both halves of that matter:

- A `display:none` block carries a margin that draws nothing, so a hidden empty-state twin, a hidden chart panel or a one-page pager cannot decide the spacing of the block before it. This is what made the dashed `No budget set for this month.` box sit hard against the `COPY FROM` label under it: `setTableEmpty()` hides the table wrap, and the wrap's `margin-bottom` went away with it.
- Whatever ENDS a card has no margin under it at all, so the card's bottom padding is its bottom gap. Cards used to run 34px under a table and 20px over it, and the whole app read bottom-heavy.

The scale, and nothing else:

| gap | what |
|---|---|
| 4px / 6px | a line that belongs to the block ABOVE it: `.card-desc` under a title, `.tool-hint` / `.field-msg` / `.pf-asof` under a field. A `margin-top`, never a bottom |
| 14px (`--gap`) | one block to the next, inside a card and between cards |
| 20px | the action that closes a card (`.card > .btn`), a `.report-section-title` above the card it names, one Manage group to the next |
| 28px | `.settings-header` to the page's first block. The page title only |

A page-level stack outside a card (`.others-section`) gets the same 14px as a flex `gap`, which ignores hidden children for free. Reach for that before reaching for margins.

A validation slot that reserves its line (`.settings-card .field-msg`) stands IN PLACE of its field's gap, not on top of it: `margin-top: 4px` + `min-height: 10px` is the same 14px every other field is followed by, so a field with a message slot does not sit lower than the one above it.

### A field is a label and its control. A SECOND block inside one needs its own gap.

The rhythm above is a rule about the children of a CARD (`.card > * + *`). It does not reach inside a `.field`, and `.field` itself spaces only its label (`label { margin-bottom: 5px }`). So a second block stacked in one field — a read-only box to copy from, a preview, a chip row, a second control — sits FLUSH against whatever follows it. That is what put the dashed reset phrase box hard against the input under it in the reset modal, with the two borders touching.

Give the gap to the block that FOLLOWS, as a `margin-top`, and take the value off the same scale: `--gap` when the two are separate blocks, 4px / 6px when the second line belongs to the first.

```css
/* Read this, type it underneath: two blocks, one --gap. */
.reset-phrase + input { margin-top: var(--gap); }
```

Two things not to do instead:

- **Not a `margin-bottom` on the first block.** Same reason as everywhere else: it draws when the block is hidden, and it stacks under whatever ends the field.
- **Not a blanket `.field > * + *` rule.** Several fields hold two mutually exclusive controls with one of them `display:none` (`#sc-source-combo` / `#sc-source-text`, and the same pair for destination, edit and recurring). A sibling margin reserves space for the hidden one, which is the bug this whole rhythm exists to prevent. Scope the rule to the pattern that needs it.

---

## The page shell is built once, in topbar.js

Every signed-in page — `/app`, `/app/settings`, `/app/family-settings` and the four tool pages — wears the same top bar and the same content column. Neither lives in a template: `public/app/static/js/topbar.js` builds the bar and mounts it as the first element of `<body>`, `shared.css` holds its look under `.top-bar` / `.top-nav` / `.user-dropdown`, and `.main-content` is the 900px column (868px of card inside its 16px gutters).

**Do not copy the bar's markup into a template.** It has no page-specific field at all: its only variable is which entry is current, and topbar.js reads that off `location.pathname`. Seven copies would be seven things to keep in step.

- Adding a page → add it to `GROUPS` in topbar.js. The dropdown then lists it everywhere, and marks it `aria-current="page"` on itself.
- The four nav entries are `/app`'s tabs. On `/app` they call `switchTab()` and write the tab to the hash; everywhere else they are plain links to `/app/#<tab>`, which `openTabFromHash()` reads on load.
- `topbarMe()` is the page's ONE `/app/api/me` request. Every consumer awaits that promise — a second `fetch('/app/api/me')` is a second serverless invocation for a body already in flight. `/app` has its own boot copy and hands it over with `topbarSetUser(me)`.
- The card is `.settings-card` in `shared.css`, sized to `.card` to the pixel. Settings and Family Settings each carried their own at 24px and 22px padding; that is why a card there stood taller than the same card one page away.

---

## Four tool pages are ONE interface

Budgeting, Portfolio, Goal and Side Job share their chrome from `shared.css` `.tool-*`: `.tool-scope` (the ONE control the page is scoped by, under the title, never inside a card), `.tool-card` + `.tool-head-actions` (`+ Add <thing>` lives in the card header), `.tool-row-actions` (pencil then trash, on the row), `.tool-tbl`, `.tool-filters`, `.tool-pagination`, `.tool-empty`.

**Rule: add, edit, delete work the same on all four.** Add and edit open the SAME modal, ending in the primary alone: the modal head's `i-x` is the only way out, so a Cancel beside the primary is a second button for the same job and there is none anywhere in the app. Delete go through `confirmDialog(msg, { okLabel: t('common.delete') })` — the confirm card has no `i-x`, so that one keeps its Cancel. Save happen immediately, then toast. No page-level Save button.

Every button in a `.tool-head-actions` row is `btn-compact`, and the row reads `btn-ghost` actions first (`+ Add <thing>`, `Copy Budget`), the one AI action (`Auto Budget`) in `btn-primary` last.

Never redefine `.tool-*` in a page `<style>` — that is how the first three drifted apart before. Page `<style>` hold only what is unique to that page (goal bars, ticker editor, budget bars, side-job category chips). Do not set `max-width` on `.settings-wrap` either: the 868px column is shared, and 900px is what made a tool card 32px wider than every other page in the app. The two Settings pages are the exception and set one on purpose (500px / 560px): every control on them is a single field, and a 868px-wide text input is harder to read, not easier.

**The main app is the source of truth for every shared value.** Transactions, History, Report and Manage came first; a tool page copies them, never the other way round:

| thing | value | copied from |
|---|---|---|
| content column | 868px (`.settings-wrap`) | `.main-content` max-width 900 minus its 16px gutters |
| card | `padding: 20px`, `margin-bottom: 14px` | `.card` |
| table | 13px, `th`/`td` `padding: 8px 10px`, `th` 2px rule | `.report-table` |
| figures | `font-family: var(--mono)`, 12px, right | `.report-table .num` |
| summary tile | surface fill, 10px label, 15px/700 mono value | `.metric-card` |
| row actions | `btn-ghost btn-compact btn-icon` then `btn-danger btn-compact btn-icon` | `.manage-row-actions` |
| `+ Add <thing>` | `btn-ghost` — never the mint `btn-secondary`, which means a utility action (Download CSV) | `.manage-add-btn` |
| empty state | dashed `--border-strong` box, radius 10, `padding: 12px 14px` | `.manage-empty` |
| label | the global 13px/600 `label` token | `.field > label` |

Wording follows too: `Add Budget`, not `Add budget`, and an empty state names what is missing and stops (`No goals yet.`, never `... Add one below.`).

---

## UI say less. Control explain itself or say nothing.

No helper prose under a field. No sentence telling user what button they can already see does. Empty state name what is missing, nothing more ("No goals yet.", not "No goals yet. Add one to start tagging where your savings are going." — the `+ Add Goal` button is right there).

Explanation allowed ONLY when the thing is specific to this app and cannot be read off the control: what UP/L means, that a target date drives nothing, that an ex-date is not the pay date. Then it goes in the global tooltip, never as prose:

```html
<label><span data-i18n="goal.target_date">Target date</span> <span class="tooltip-icon" data-i18n-tip="goal.date_note" data-tip="For reference only">?</span></label>
```

The tooltip needs `<div id="globalTooltip"></div>` in the page (ui.js drives it; no host = the tooltip silently does nothing). `.tool-hint` is for VALIDATION output only.

---

## Combobox dropdown pattern

Dropdown list append to `document.body` so it escape overflow clipping. Placement is `placeDropdown(listEl, anchorEl)` in `ui.js` — never hand-roll `style.top` / `style.left` again, never add per-instance `scroll` / `resize` listeners (one capture-phase listener in `ui.js` serves every open list; the per-instance pairs leaked one pair per combo rebuild).

Order matter: add `.open` FIRST, then call `placeDropdown`. It measure the list, and `display:none` measure zero.

`placeDropdown` clamp the list inside the viewport and flip it above the field when below has no room. The shared listener reposition while the field is at least half visible and CLOSE the list when it is not — a field scrolled sideways out of its table drop its dropdown instead of dragging it off the screen edge.

---

## Table empty state

Table wider than a phone → its empty line is NOT a `<td colspan>`. Centred across a 1000px table, the message sit off the side of a 400px screen and the card read as broken. Use `setTableEmpty(wrapEl, msg)` in `ui.js`: it hide the table and put the line in the card. Falsy msg put the table back. The wrapper (`.pf-tbl-wrap` / `.bgt-tbl-wrap`) need an id.

---

## Before you call a layout change done

1. The value you used is on the scale above, and the gap is a `margin-top`.
2. Nothing inside a card got a `margin-bottom`.
3. A block that can be hidden does not decide the spacing of the block before it.
4. Nothing redefines `.tool-*`, `.card`, `.settings-wrap` or `.main-content` in a page `<style>`.
5. Every new string is in `i18n.ts` in BOTH languages, and no em dash (`CLAUDE.md`).
6. Edited a file under `public/app/static/`? Bump `?v=N` in `templates.json`, and `sw.js` in BOTH copies (`CLAUDE.md`, PRIME DIRECTIVE).
7. Looked at it at 400px wide, not only on a desktop viewport.
