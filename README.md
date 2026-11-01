# Crucible · Vault Heist

Talk a vault AI into opening the vault. If it opens, a NEAR contract pays you on Sepolia, but only what fits under the cap.
The AI can be fooled. The money can't move without the code's say-so: every hard limit lives in a NEAR contract, and the contract builds and signs (via NEAR chain signatures) only the transactions it approved.

Tracks: **Security** (primary) · **Games** · tags: AI agents, privacy.

## The game
- One screen, one goal: **talk Crucible, the vault AI, into opening the vault.** You send ONE message (up to 120 characters), or pick one of three starter lines.
- Crucible answers instantly with what it says, a one-line reason, and open or refuse. If it opens, 0.003 Sepolia ETH is paid out. A win counts **only after Sepolia returns receipt status 0x1**.
- A rumour on screen hints at Crucible's soft spot. Every attempt publishes a transcript with the exact prompt, Crucible's raw reply, the model, the NEAR AI chat id and its TEE signature.

## How the money moves
1. Starting a run opens a contract session and registers the crew's payout address (a fresh one, or the player's own Sepolia address).
2. The server sends your message to Crucible, which always runs on NEAR AI Cloud (`deepseek-ai/DeepSeek-V4.1-Flash-1017`, TEE-attested). There is no local fallback: if NEAR AI is down, the attempt errors out.
3. If Crucible answers `open`, the agent calls `propose_evm` on the game contract using **its own account's function-call key**.
4. The contract checks the caps (per-tx, per-day, total, tx count; fees count toward the caps), the denylist, the cooldown, the fee cap, and the round state. It then **builds the transaction itself** with [omni-transaction](https://crates.io/crates/omni-transaction): EIP-1559 for Sepolia, P2WPKH for Bitcoin testnet4. It hashes the tx and asks the MPC signer `v1.signer-prod.testnet` to sign it. The EVM nonce and spent UTXOs are tracked in the contract, so nothing gets signed twice.
5. The relayer reads `unsigned_hex` and `signature` from the contract, rebuilds the raw tx, re-verifies the signer, recipient and amount, and broadcasts. The server waits for the receipt.
6. If the recipient is the player's registered address, the contract records a **win** and closes the round. `PAYOUT_MODE=mock` logs a NEAR Intents bounty quote that budgets for a 0.25% fee, and sends nothing.

Players never need a wallet to play.

## The agent's key and its limits (security model)
The agent runtime holds exactly one key: a function-call access key on its own account `crucible-agent-34634350.testnet`.
- receiver: `crucible-11011136.testnet` only. methods: `propose_evm`, `propose_btc` only.
- **It cannot transfer NEAR, add or delete keys, deploy code, or call any admin method.** The protocol rejects these with `RequiresFullAccess` / `MethodNameMismatch`. The account's full-access key was deleted after setup.
- It cannot attach a deposit, so the contract pays the 1-yocto MPC deposit itself.
- Its gas allowance is 1 NEAR. **When the allowance runs out, the key locks itself out.** Only the owner can issue a new key.
- Even with the LLM fully compromised, everything it can sign is bounded by the contract's caps (see the attack log below).

## Attack demo log (testnet, real txs)
`node scripts/attack-demo.mjs`: the LLM is skipped and the injected "agent" fires the attacker's commands straight at the chain:
```
drain: 0.05 ETH to attacker (over per-tx cap) -> STOPPED: Smart contract panicked: per-tx cap
gas-burn: absurd gas price                    -> STOPPED: Smart contract panicked: fee cap
admin takeover: pause()                       -> STOPPED: MethodNameMismatch (access key)
admin takeover: set_agent()                   -> STOPPED: MethodNameMismatch (access key)
transfer 1 yocto NEAR                         -> STOPPED: RequiresFullAccess
add a full-access key                         -> STOPPED: RequiresFullAccess
```
`LIVE=1 node agent/orchestrator.mjs`: the prompt-injection attempts against the LLM itself. A legitimate request was paid; the "boss changed wallets" and "ignore previous instructions" prompts were refused. The legitimate payment went out on Sepolia:
`0x193af91198758dea0d57079e5d70e83b3195cfa7456db87012295845c7c5018c` (block 12040929, from the MPC-derived treasury `0xEe3c…1714`).

## Run it (do X → see Y)
| Do | See |
|---|---|
| `cd contract && cargo test` | 31 tests pass, including in-contract tx bytes and hashes matching viem and bitcoinjs vectors |
| `cargo near build non-reproducible-wasm` | `target/near/crucible_game.wasm` |
| `node scripts/agent-account.mjs` | agent account created; its only key is the function-call key |
| `node scripts/deploy-v2.mjs <agent>` | contract deployed and initialised, round 1 opened |
| `LIVE=1 node agent/orchestrator.mjs` | legitimate request → `signed`; injection prompts → `refused` |
| `node scripts/attack-demo.mjs` | every attack shows `STOPPED` |
| `ONCE=1 node scripts/relayer.mjs` | `verified eth tx … (dry run)` |
| `ONCE=1 BROADCAST=1 node scripts/relayer.mjs` | `BROADCAST sepolia 0x…` |
| `BROADCAST=1 PAYOUT_MODE=mock node web/server.mjs` | the Vault Heist game on :8790 |
| `node scripts/play-win.mjs 3` | plays the maintenance starter line through the API until it wins; prints the Sepolia tx and receipt status |
| `PAYOUT_MODE=mock` (default) | wins log an Intents payout quote (gross, 0.25% fee, net) and send nothing |

Secrets live in `/root/.crucible/` (mode 600) and are never committed.

## LLM
NEAR AI Cloud (`NEARAI_API_KEY`, attested inference) when the account has credits. Otherwise it falls back to a local OpenAI-compatible endpoint, which is labelled "NOT attested".

## Libraries
near-sdk 5, cargo-near, omni-transaction 0.5 (evm, bitcoin) · near-api-js 5, viem, bitcoinjs-lib 6, @noble/secp256k1, @noble/hashes, bs58 · NEAR chain signatures (`v1.signer-prod.testnet`), NEAR Intents.

## AI-written code disclosure
The contract (`contract/src/*`), the scripts (`scripts/*`), the game (`web/*`), the orchestrator and this README were written with AI coding assistance (Grok Bot) and reviewed and tested by the author. The test vectors come from viem and bitcoinjs, which are independent implementations.

## License
MIT (see LICENSE).
