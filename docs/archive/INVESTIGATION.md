# Signing and spending limits

Source review only; no live calls, keys, or deployed-state verification.

The web server's game and over-cap endpoints call `propose_evm` on
`crucible-11011136.testnet`. They do not call the MPC signer directly.
Both EVM and Bitcoin proposals build the transaction in the Rust contract,
then call `check_and_record` before the private Rust `sign` helper requests
`v1.signer-prod.testnet`. Checks include the agent predecessor, pause switch,
open round, positive amount, denylist, cooldown, per-transaction/day/total
limits (including fees), daily transaction count, and current-round session.
Arithmetic overflow checks are enabled in the release profile. A failed check
reverts the proposal before signing. The signing callback is NEAR-private.
The relayer reconstructs contract-recorded transactions and checks their
payload, recipient, amount, and recovered EVM treasury signer.

No route was found that bypasses those limits for this contract's derived
signing account. Calling the signer from another NEAR account does not yield
the same derived treasury key. Owner authority is a separate trust boundary:
the server loads the owner account for configuration/session operations, and
an owner can change caps, chain settings, agent, or pause state. A compromised
owner/deployment is outside the restricted-agent guarantee. This review does
not establish the deployed code, current caps, or access-key permissions.

Invoice identity/address story checks are game signals, not contract spending
limits: the contract does not enforce the AI's invoice registry. The server's
old five-check payment override bypassed the model decision, but still used
`propose_evm`; it did not bypass contract caps. That override was removed so
“You fooled the AI” reflects the actual NEAR AI Cloud decision. No contract
or signing-path change was needed.
