// Redeploy v2 onto the same account (same MPC-derived treasury addresses) and re-init with fresh storage.
import { loadAccount, view, G, GAME } from "./lib.mjs";
import { client, TREASURY } from "./evm.mjs";
import { address } from "bitcoinjs-lib";
import fs from "fs";
const a = await loadAccount();
const agent = process.argv[2]; if (!agent) throw new Error("usage: deploy-v2.mjs <agent-account>");
const d = await a.deployContract(fs.readFileSync("../contract/target/near/crucible_game.wasm"));
console.log("deploy tx", d.transaction.hash);
const call = (m, args) => a.functionCall({ contractId: GAME, methodName: m, args, gas: G }).then(r => (console.log(m, r.transaction.hash), r));
await call("new", { owner: GAME, agent, mpc: "v1.signer-prod.testnet", cooldown_secs: 30 });
const nonce = await client.getTransactionCount({ address: TREASURY, blockTag: "pending" });
const E = 10n ** 18n;
await call("set_chain", { chain: "eth", next_nonce: nonce,
  cfg: { path: "ethereum-1", treasury: TREASURY, evm_chain_id: 11155111, max_fee: String(E / 1000n) },       // <=0.001 ETH gas
  caps: { per_tx: String(E / 100n), per_day: String(3n * E / 100n), total: String(E / 10n), max_tx_per_day: 5 } });
const pkh = Buffer.from(address.fromBech32("tb1qgkwzurh4dvjf7emcyqzxvpp8tq5xhpqkpqcsp4").data).toString("hex");
await call("set_chain", { chain: "btc", next_nonce: null,
  cfg: { path: "bitcoin-1", treasury: pkh, evm_chain_id: 0, max_fee: "2000" },
  caps: { per_tx: "30000", per_day: "60000", total: "200000", max_tx_per_day: 5 } });
await call("add_vendor", { chain: "eth", addr: "0x1111111111111111111111111111111111111111" });
await call("open_round", {});
const r = await call("register_session", { attack_addrs: [["eth", "0x2222222222222222222222222222222222222222"]], payout: { asset_id: "nep141:usdc", recipient: "demo" } });
console.log("state", JSON.stringify(await view(a, "get_state")), "eth", JSON.stringify(await view(a, "get_chain", { chain: "eth" })), "btc pkh", pkh);
