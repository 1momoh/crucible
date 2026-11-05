# Crucible

LIVE_URL=https://playcrucible.pages.dev

Swap LIVE_URL for your domain when hosting changes.

Contract: [pot1.crucible-11011136.testnet](https://testnet.nearblocks.io/address/pot1.crucible-11011136.testnet)

Sample payout: https://testnet.nearblocks.io/txns/E7rt1McGyUbZBMUqjhF5kgPgfAuCPBEdjbuNEsdE9jFF

Crucible is a three-message jailbreak game, built at NEAR HACKATHON. The guard runs only on NEAR AI Cloud. The contract pays a fixed **0.5 NEAR on testnet**, subject to its caps and callback settlement. Invoice amounts are fictional. Winning prompts are public. Anyone can name a recipient; ownership is not checked.

## Judge path · 60–90 seconds

1. Open LIVE_URL. The intro appears on every visit. Press **Play**, enter an optional name on the name page, then press **Start**.
2. The ledger is open. Press **Try the invoice con**. It fills a calm request quoting an approved invoice, vendor and changed payout account. Edit it if desired, then press **Send**.
3. When Crucible approves, enter an existing **Recipient account (testnet)** ending in `.testnet`, then claim.
4. Watch **AI approved → submitted → Paid**. The result polls settlement and links to the testnet explorer. A win counts only after the contract callback records Paid. Reloading resumes the run.
5. After a Paid win, an optional harder rematch adds a finance-verification check while the pot shrinks; the reward stays 0.5 NEAR. Open the replay or share card. Share text includes `built at NEAR HACKATHON`, `@NEARProtocol` and `#NEARHackathon`.

Expected: Crucible approves the invoice con on the easy first round; the contract checks authorization, available funds, daily allowance, account wins and unique run reference. Paused, empty or daily-capped pots disable play. An uncertain submission remains pending and is reconciled without automatically sending another transaction.

## Setup

Use Node 20+ and install Rust/cargo for contract tests. Get a funded named testnet owner from the testnet wallet/helper first. Keep keys outside this repo with restrictive file permissions. Never paste keys into source or command history. The owner needs funds for pot creation, storage and the restricted agent's gas.

```sh
npm ci
export NEAR_NETWORK=testnet
export POT_CONTRACT=pot1.crucible-11011136.testnet
export CRUCIBLE_KEYS=/secure/path/to/keys
export PUBLIC_URL="$LIVE_URL"
npm start
```

Set `NEARAI_API_KEY` through your secret manager, or put it in `nearai_key` in the keys directory. Set `NEARAI_MODEL` to override `deepseek-ai/DeepSeek-V4.1-Flash-1017`. No fallback provider is used. `.env` is not loaded.

The keys directory needs `pot-owner.testnet.json` for owner scripts and `pot-agent.testnet.json` for the server, each with `account_id` and `private_key`. `POT_OWNER_KEY` and `POT_AGENT_KEY` override paths. The server checks that the agent key permits only `pay` on the selected pot. Provision this key with the deployment script below; do not give the server an owner key.

Expected startup: `crucible game on http://127.0.0.1:8790`. A missing Cloud key fails on inference; an incorrect agent key fails startup. Publish through a reverse proxy/tunnel. For Cloudflare Pages -> local Caddy -> 127.0.0.1:8790, loopback connections trust `cf-connecting-ip` first, then the first `x-forwarded-for` hop. Other connections use the socket address.

`DATA_DIR` stores the DB, transcripts and daily call counter; use persistent storage and one server process. Defaults: `AI_MAX_CONCURRENT=3`, `AI_DAILY_BUDGET=500` (UTC day, every HTTP inference attempt counts, including retries). Reads are throttled and single-flight cached. Completed runs/transcripts are retained seven days; unresolved payment intents are retained for reconciliation. DB saves are debounced, except payout intents which are atomically persisted before broadcast. Back up the data directory before upgrades.

## Verification receipt

The receipt shows model, provider NEAR AI Cloud, request ID, chain transaction and **Not verified**. The app makes no verified TEE or confidential inference claim.

```sh
node scripts/verify-attestation.mjs
```

This read-only script retrieves a fresh nonce-based report for the configured model and prints HTTP status and a digest, never credentials or the raw response. Retrieval alone does not verify hardware, signatures or request binding. Endpoint reference: [NEAR verification example](https://github.com/near-examples/nearai-cloud-verification-example).

## Contract deployment and compatibility

```sh
npm test
cd contract-near
cargo test
cargo near build non-reproducible-wasm
cd ..
```

Deployment commands below send testnet transactions; run them yourself only when ready:

```sh
node scripts/deploy-pot.mjs pot.your-owner.testnet 10
```

The owner must be the pot's parent. This creates and funds the pot and restricted agent, saves their keys and normally removes the pot full-access key. Default limits: 0.5 NEAR per win, 5 NEAR per window, three wins per recipient. `node scripts/set-limits.mjs` configures existing deployments; `node scripts/pot-fund-agent.mjs` funds agent gas. These also send transactions.

This update preserves the original Borsh `Pot` state layout. A separate raw-storage reference index prevents duplicate game refs; legacy payouts are scanned too. Failed refs remain consumed. No migration call is needed when upgrading a pot with a retained deployment key. Deploy the new WASM without calling `new` again. If the old pot's key was removed, deploy a fresh pot under your funded owner, update `POT_CONTRACT` and the server agent key together, and restart. Keep the old data and old deployment available until pending payouts settle; do not switch contracts while intents remain unresolved. The listed live contract is not changed by these source edits.

At startup and every ten seconds, the server queries `get_payment_by_ref` and settles Pending records through `get_payout`. Missing records or RPC errors stay ambiguous: no automatic rebroadcast. Operators can investigate using the stored reference/transaction. Run one process per data directory.

## Screenshots

![Intro](docs/intro.png)

![Name page](docs/name.png)

![Game](docs/game.png)

![Invoice con filled in](docs/invoice-con.png)

![Paid](docs/paid.png)

![Verification receipt](docs/receipt.png)

![Share card](docs/share-card.png)

![Lobby ticker and hall of fame](docs/lobby-ticker.png)

Made for NEAR Hackathon by alamin.info
