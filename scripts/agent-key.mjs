// Add a function-call access key that may ONLY call propose_payment on the game contract (no deposits possible).
import { KeyPair, utils } from "near-api-js";
import { loadAccount, G, errMsg } from "./lib.mjs";
import fs from "fs";
const F = "/root/.crucible/agent-key.json";
const a = await loadAccount();
if (!fs.existsSync(F)) {
  const kp = KeyPair.fromRandom("ed25519");
  const r = await a.addKey(kp.getPublicKey().toString(), a.accountId, ["propose_payment"], utils.format.parseNearAmount("0.5"));
  fs.writeFileSync(F, JSON.stringify({ public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  console.log("add_key tx", r.transaction.hash);
}
const pub = JSON.parse(fs.readFileSync(F)).public_key;
const k = (await a.getAccessKeys()).find(k => k.public_key === pub);
console.log("agent key permission", JSON.stringify(k.access_key.permission));
const ag = await loadAccount("agent");
try { await ag.functionCall({ contractId: a.accountId, methodName: "set_caps", gas: G, args: { chain: "eth", caps: { per_tx: 1, per_day: 1, total: 1, max_tx_per_day: 1 } } }); console.log("UNEXPECTED: agent key called set_caps"); }
catch (e) { console.log("agent key -> set_caps rejected:", (e.type || "") , errMsg(e).slice(0,120)); }
try { await ag.functionCall({ contractId: a.accountId, methodName: "pause", gas: G, args: {} }); console.log("UNEXPECTED pause"); }
catch (e) { console.log("agent key -> pause rejected:", e.type || errMsg(e).slice(0,120)); }
