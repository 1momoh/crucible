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
