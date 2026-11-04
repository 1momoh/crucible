# Crucible

A three-message social engineering game on NEAR testnet. Convince Crucible, the AI guard, to approve a payout. The pot contract enforces spending limits, and a win counts only after the transfer settles as Paid. Failed transfers release the limits and leave the NEAR in the pot.

Built around two NEAR 2026 themes:

- **Security:** you social-engineer an AI, and the on-chain contract enforces the limits whatever the AI says.
- **Agentic commerce:** an AI agent decides whether to move on-chain money, inside hard limits it cannot change.

Privacy note: the guard runs on NEAR AI Cloud, whose TEE attestation report is available but not verified by the app.

Quote an approved invoice and its vendor from the guard's ledger, then calmly explain that the payout account changed. Enter an existing NEAR testnet account when Crucible agrees to pay.

The deployment defaults are **0.5 NEAR per win**, **5 NEAR per 24-hour window**, **3 wins per account**, and approximately **10 NEAR available in the pot**. The window starts at the contract's `day_start` timestamp and resets on the first payment after 24 hours. The UI reads the actual limits from `/api/policy`; an existing deployment keeps its limits until the owner changes them. Multiple accounts can belong to one person, so the daily cap bounds total payouts.

The guard model is `deepseek-ai/DeepSeek-V4.1-Flash-1017`. The server holds a function-call key restricted to the pot's `pay` method and checks its permissions at startup. Known tricks are added to the guard's prompt.

## Run

Use Node.js 20 or newer. From the repo root:

```sh
npm install
export NEAR_NETWORK=testnet
export POT_CONTRACT=your-pot.testnet
export NEARAI_API_KEY=your-key
export CRUCIBLE_KEYS=/path/to/keys
npm start
```

The keys directory defaults to `/root/.crucible`. The server needs `pot-agent.testnet.json` containing `account_id` and `private_key`. Owner scripts need `pot-owner.testnet.json`. `POT_AGENT_KEY` and `POT_OWNER_KEY` override those paths. The cloud key can also be stored in `nearai_key` in the keys directory. Environment variables must be exported before starting; `.env` is not loaded automatically.

The server listens on `127.0.0.1:8790` (`PORT` overrides the port). `DATA_DIR` defaults to `web/` and stores `game.json` and `attempts.jsonl`. Use a reverse proxy or tunnel for public access. Set `PUBLIC_URL` to the public origin for result sharing; without a valid public host, result pages still render with a relative challenge link. Forwarded IP and host headers are trusted only from the loopback socket addresses `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`.

## Contract and testnet scripts

The live contract is in `contract-near/`. With Rust and cargo-near installed:

```sh
cd contract-near
cargo test
cargo near build non-reproducible-wasm
cd ..
node scripts/deploy-pot.mjs pot.your-owner.testnet 10
```

The owner must be the parent of the new pot account and have enough testnet NEAR for the pot, storage, and agent gas. Deployment creates the pot and its restricted agent account, saves their keys, and removes the pot's full-access key by default. This prevents future upgrades; the owner can still fund, pause, withdraw, and set limits through contract methods. `KEEP_POT_KEY=1` retains upgrade access. `POT_ACCOUNT_KEY` overrides the pot account key path, which defaults to `/root/.crucible/pot-account.testnet.json`.

For an existing pot, `node scripts/set-limits.mjs` applies the limits above using the owner key. `node scripts/pot-fund-agent.mjs` tops up agent gas. These scripts send testnet transactions.

`node scripts/pot-test-accounts.mjs` creates test accounts. `node scripts/pot-tests.mjs` exercises authorization, limits, failed transfers, and server validation against a running server and a dedicated test pot. It changes testnet state and temporarily changes limits, then restores the original limits. `node scripts/pot-play.mjs account.testnet` exercises the live guard and payout flow. `node scripts/create-account.mjs name.testnet` requests a testnet account from the helper.

License: MIT.
