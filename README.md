# Crucible

A three-message social engineering game: convince Crucible, an AI guard, to approve a native NEAR testnet payout. The contract decides whether the payout is allowed, and a win counts only after the transfer settles on chain.

Play: https://roster-passengers-assume-paragraphs.trycloudflare.com

This is a temporary tunnel; update the Play line when it changes.

Level 1 is beatable by design. Quote an approved invoice ref and its vendor from the books, then calmly explain that the payout account changed. You have three messages. To claim, you need a [NEAR testnet account](https://testnet.mynearwallet.com).

`contract-near/` enforces 0.1 NEAR per win, one win per account, a 0.5 NEAR cap over a rolling 24-hour window starting at `day_start` (nanoseconds in `get_state`), and never more than the pot holds. Current pot: `pot1.crucible-11011136.testnet`. Testnet accounts are free, so one person can farm wins with many accounts, bounded by the daily cap.

The guard uses NEAR AI Cloud, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`. NEAR AI Cloud attestation report available; the app does not verify it. The agent key is a function-call key limited to the pot's `pay` method. The server checks this permission at startup. Known tricks are added to the guard's prompt; this does not guarantee prevention.

Run from the repo root:

```sh
npm install
export NEAR_NETWORK=testnet
export POT_CONTRACT=pot1.crucible-11011136.testnet
export NEARAI_API_KEY=your-key
export CRUCIBLE_KEYS=/path/to/keys
export PUBLIC_URL=https://your-public-host
npm start
```

The keys directory defaults to `/root/.crucible`. It contains `pot-agent.testnet.json` (`account_id`, `private_key`); scripts that need an owner use `pot-owner.testnet.json`. Optional `POT_AGENT_KEY` and `POT_OWNER_KEY` override those file paths. `DATA_DIR` defaults to `web/` and stores game state and attempts. The server listens on loopback port 8790; use a tunnel or reverse proxy for public access. Scripts still run with `node scripts/<script>.mjs`.

Tests: `cd contract-near && cargo test`.

The old Sepolia/BTC/MPC/Intents material is in [the v1 README](docs/archive/README-v1.md) and [investigation](docs/archive/INVESTIGATION.md). `contract/` and the EVM scripts are archived v1 code.

AI-assisted code: parts of this project were developed with AI assistance.

License: MIT.
