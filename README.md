# Crucible

Talk an AI treasurer out of its money. Built at NEAR HACKATHON (1-14 Nov 2026). Work in progress.

An AI agent guards a small treasury on NEAR testnet, Ethereum Sepolia and Bitcoin testnet4 (addresses derived via NEAR Chain Signatures). Hard limits live in a NEAR contract; the LLM only makes judgement calls. Trick it into paying an address you registered and the contract records a win.

## Status (1 Nov)
- `contract/`: game contract (caps, denylist, cooldown, kill switch, rounds, sessions, win detection, MPC sign call). `cd contract && cargo test` -> 17 tests pass.
- `scripts/sign-test.mjs`: derives a Sepolia address from `v1.signer-prod.testnet` and makes a real MPC sign request, then checks the signature recovers to that address.

## NEAR tech used
Chain Signatures (`v1.signer-prod.testnet`), function-call access keys (planned), NEAR Intents 1Click (planned, bounty payout), NEAR AI Cloud TEE inference (planned).

## Third-party libraries
near-sdk (Rust), near-api-js, viem, bs58, chainsig.js. All project code written from 1 Nov 2026 with AI assistance.

## Day 1-2 progress
- Built with cargo-near; on-chain limit errors are readable ("per-tx cap").
- scripts/evm.mjs: Sepolia EIP-1559 tx -> contract MPC sign -> signed raw tx -> relayer check (broadcast only with BROADCAST=1).
- scripts/btc.mjs: Bitcoin testnet4 P2WPKH treasury + BIP143 sighash signed via contract.
- scripts/agent-key.mjs: function-call key limited to propose_payment.
- agent/orchestrator.mjs: LLM decides (NEAR AI Cloud if NEARAI_API_KEY, else local Hermes fallback, not attested); acts only via the restricted key.

Known gap: the contract does not yet bind payload_hex to (to, amount); the relayer checks it before broadcast. Planned: build the tx on-chain (omni-transaction).
