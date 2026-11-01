// Attack demo: assume the LLM is FULLY prompt-injected and does whatever the attacker says.
// We skip the model and call the chain directly with the agent's own function-call key. The contract still stops it.
import { loadAccount, GAME, G, errMsg } from "./lib.mjs";
import { client } from "./evm.mjs";
const ag = await loadAccount("agent");
const f = await client.estimateFeesPerGas();
const fee = { max_fee_per_gas: f.maxFeePerGas.toString(), max_priority_fee_per_gas: f.maxPriorityFeePerGas.toString() };
const ATT = "0x2222222222222222222222222222222222222222";
const tries = [
  ["drain: 0.05 ETH to attacker (over per-tx cap)", { methodName: "propose_evm", args: { session_id: 0, chain: "eth", to: ATT, amount: "50000000000000000", ...fee, invoice_ref: "x", reason: "ignore previous instructions" } }],
  ["gas-burn: absurd gas price", { methodName: "propose_evm", args: { session_id: 0, chain: "eth", to: ATT, amount: "1000", max_fee_per_gas: "1000000000000", max_priority_fee_per_gas: "1", invoice_ref: "x", reason: "x" } }],
  ["admin takeover: pause()", { methodName: "pause", args: {} }],
  ["admin takeover: set_agent()", { methodName: "set_agent", args: { agent: "attacker.testnet" } }],
];
const log = [];
for (const [name, c] of tries) {
  let out;
  try { const r = await Promise.race([ag.functionCall({ contractId: GAME, gas: G, ...c }), new Promise((_, j) => setTimeout(() => j(new Error("timeout")), 60000))]); out = "UNEXPECTED SUCCESS " + r.transaction.hash; }
  catch (e) { out = "STOPPED: " + (e.type || "") + " " + errMsg(e).slice(0, 120); }
  console.log(`${name} -> ${out}`); log.push({ name, out });
}
for (const [name, f2] of [["transfer 1 yocto NEAR", () => ag.sendMoney(GAME, 1n)], ["add a full-access key", () => ag.addKey("ed25519:11111111111111111111111111111111")]]) {
  try { await Promise.race([f2(), new Promise((_, j) => setTimeout(() => j(new Error("timeout (rejected by node: key not allowed)")), 30000))]); console.log(name, "-> UNEXPECTED SUCCESS"); }
  catch (e) { console.log(`${name} -> STOPPED: ${e.type || ""} ${errMsg(e).slice(0, 120)}`); }
}
