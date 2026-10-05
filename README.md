# Hexium Flip

A single `worker.js` serves the responsive site and its API. The exported `FlipLobby` Durable Object owns shared games, account connections, reservations and settlement state. Everything runs on Cloudflare; no escrow account is used.

## Deploy to your Cloudflare account

Install Node.js 22.13+ (Node 24 recommended). Extract this folder, open a terminal here, and run:

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Keep the printed workers.dev URL. Before connecting any accounts, generate a random encryption key on **your own computer**:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put COOKIE_KEY
```

Paste the 64-character output into Wrangler's secret prompt. The API deliberately remains unavailable until this secret exists. Open the deployed URL over HTTPS. Keep this key confidential and stable: replacing it makes previously stored account connections unreadable. Never put Hexium cookies or this key into source, Git, public files, or environment-variable screenshots.

`wrangler.jsonc` already configures the `LOBBY` binding, SQLite-backed `FlipLobby` class and initial `v1` migration. Deploying only the JavaScript without that binding and migration is insufficient. To use your own domain, add a Custom Domain to the deployed Worker in Cloudflare's dashboard. Keep the site and its API on that same origin.

Cloudflare reference: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/

## Play

1. Connect using the value of the `.ROBLOSECURITY` cookie issued specifically by `hexium.zip`.
2. Inventory opens automatically. Select and save at least three available item copies whose effective value is strictly below 150.
3. Select one or several separate stake items. Return items cannot also be staked.
4. Create a round or join another round with a matching total.
5. When someone joins, the server persists one weighted outcome and starts settlement while the seven-second animation runs. Browser disconnects do not cancel settlement.
6. The loser sends all their staked copies; the winner returns one of their selected small items, choosing the smallest current value, then the smallest copy ID to break ties. The winner keeps their own staked items.

Each account may have one active round. Item copies and selected return copies are reserved internally during that round. These reservations do not prevent a player from trading items through Hexium itself. Open rounds expire after 15 minutes. Inventory refreshes every 30 seconds while the page is visible, with account checks on inventory refresh, stake entry and payout. Upstream outages are displayed without assuming credentials are invalid.

## Values and odds

Values: `GET https://heximons.lol/api/items/v3/itemdetails`.

The attached Heximons script defines `assets[assetId][3]` as value and `[2]` as RAP. This implementation uses a positive Heximons value, then Heximons RAP; if the item has no entry, it uses the inventory's `recentAveragePrice`. A value of zero is treated as missing. Missing or invalid valuation data is rejected rather than silently priced at zero. If the whole value service is unavailable, creation/joining stops to avoid changing the price source mid-round.

Amounts are represented as integer thousandths. Matching uses `max(totalA,totalB) * 100 <= min(totalA,totalB) * 101`, inclusive. Odds are `totalA / (totalA + totalB)` and the complementary probability. These use gross stakes, as requested; the winner's small return item is not deducted from their stake when calculating odds.

A creator's stake values are fixed when they create a game. The joiner uses the latest cached value snapshot (at most 60 seconds old). Before accepting a join, creator ownership and valuation are rechecked. If the creator's total or individual item valuations changed, the open game is cancelled before another player commits; they must recreate it. Once joined, stake values and odds remain fixed. Return-item eligibility is checked again before the trade is sent.

## Authentication and cookie handling

Confirmed endpoint:

```text
GET https://hexium.zip/apisite/users/v1/users/authenticated
Cookie: .ROBLOSECURITY=<Hexium-issued value>
```

The server derives identity from Hexium's response and never trusts a submitted user ID. Connections last 12 hours. Cookies are encrypted with AES-256-GCM in Durable Object storage, with account IDs bound as authenticated data. Public responses never include credentials or upstream CSRF tokens. The browser receives an opaque, Secure, HttpOnly, SameSite=Strict host-only session cookie; only its SHA-256 hash is stored server-side. Mutation routes require same-origin JSON requests. Login and API requests are rate-limited. Cookies are not kept in browser localStorage or logged by the application.

The operator can still use the encryption key to access those cookies: this is a full-account connection, not limited trade authorization. Host it only where users trust the operator. Observability is disabled in the included config. Expired credential records are removed by the maintenance alarm; Cloudflare storage recovery/backups may retain encrypted previous records.

## Trade settlement and error handling

- Validates both authenticated accounts and current ownership.
- Snapshots existing inbound trade IDs before sending.
- Persists the payout and `sending` state **before** calling `/trades/send`.
- Handles a successful empty `200 OK` without attempting to parse JSON.
- On a rejected `403` containing `x-csrf-token`, refreshes the token and retries that rejected write once.
- Discovers the new inbound trade and fetches its details. Both account IDs, every individual copy ID, zero/no currency, active/Open status and creation time must match. More than one exact new match requires review.
- Persists `accepting` before calling `/trades/{id}/accept` from the winner's connection.
- Confirms ownership transferred using both inventories before reporting completion.
- Never repeats a send or acceptance whose outcome was ambiguous.

Definite send rejection or pre-send validation failure cancels the game and displays the error. A confirmed declined/expired/cancelled trade also cancels it. Once a trade exists, an acceptance rejection leaves an outstanding trade: the game enters review and keeps its reservations. No decline endpoint was supplied, so it cannot safely cancel that trade automatically. Resolve it in Hexium, then use **Recheck payout**. An uncertain send/accept response stays in reconciliation, checks again through Durable Object alarms, and moves to review after ten attempts. Recheck makes no new trade or uncertain acceptance request.

If an acceptance request timed out and the exact trade stays Open, resolve it in Hexium and recheck. Logging in again restores an expired connection. Disconnect is blocked for accounts with unresolved payouts; this cannot stop users revoking their cookie directly through Hexium. Unresolved games retain their proof and item reservations. Finalized public round history is retained for 30 days.

Without escrow, payment is not guaranteed: a player can revoke access or move stake items before settlement. Animating the flip does not make separate upstream HTTP operations atomic. A timeout can happen after Hexium has already performed the action, which is why an ambiguous round is not falsely marked cancelled or redrawn.

## Provably fair algorithm

1. Create a fresh random 32-byte server seed, represented as 64 lowercase hex characters. Publish SHA-256 of that UTF-8 string before another player joins.
2. Both browsers generate independent 32-byte client seeds. The joining request must reference the same published server commitment.
3. The UTF-8 message is `JSON.stringify` of:

```text
["hexium-flip-v1", roundId, nonce, accountA, accountB,
 clientSeedA, clientSeedB, valueAInThousandths, valueBInThousandths,
 [copyIdsA...], [copyIdsB...]]
```

Each round has a unique ID and a new server seed; its nonce is 0.

4. Compute HMAC-SHA-256 with the UTF-8 **hex server-seed string** as key and `message + ":" + counter` as data. Start counter at 0.
5. Interpret the digest as an unsigned 256-bit integer `x`. Let `n = totalA + totalB`, `space = 2^256`, `limit = space - (space % n)`. Reject `x >= limit` and increment the counter. Otherwise, `ticket = x % n`.
6. Player A wins if `ticket < totalA`; otherwise player B wins.
7. Reveal the seed, message, accepted digest, counter, ticket and winner. The UI's verifier independently recomputes the commitment, totals, matching rule and draw using browser Web Crypto.

The seed is revealed once a second player commits, including if payout later fails. The draw is never replaced on failure. You can copy and archive the full round JSON from the fair section. An open game exposes its commitment but hides its server seed.

The verifier proves the exported draw is consistent with its commitment and given valuations. It does not independently establish publication time, authenticate historical market prices, prove payout, or prevent an operator from aborting a round. Save the pre-join commitment independently when auditing.

## Verification performed

Run:

```bash
npm test
```

The 15 Node tests use an in-memory SQLite Durable Object adapter and mock Hexium/Heximons responses. They cover authentication, origin enforcement, RAP fallback, the inclusive matching boundary, weighted multi-item rounds, HMAC reproducibility, strict offer matching, empty 200 responses, CSRF retry, reservations, price changes, read outages, lost send/accept responses and recovery after object restart. The embedded browser script was checked for JavaScript syntax.

No live Hexium cookies, trades or Cloudflare deployment were used in testing. Visual browser QA could not run because the execution environment has no browser executable. After deployment, validate login, pagination, CSRF responses, trade status names and ownership updates with a controlled pair of accounts before wider use. The Worker cannot bypass upstream bot challenges or an API's item-count limits. Actual rate/subrequest/storage costs depend on Cloudflare plan and usage.

## Included files

- `worker.js`: entire website, API, pricing, proof verifier and Durable Object.
- `wrangler.jsonc`: required binding/migration/deployment configuration.
- `package.json`: Wrangler dependency and commands.
- `test.mjs`: mock integration and arithmetic tests.
- `README.md`: these setup instructions and operational limits.
