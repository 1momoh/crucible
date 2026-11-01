// Agent gets its OWN testnet account. Its only key: function-call, receiver=game contract, methods propose_evm/propose_btc.
// The full-access key is deleted afterwards, so the agent runtime cannot do anything else (no transfers, no deploys, no admin).
import { KeyPair, connect, keyStores, utils } from "near-api-js";
import { GAME, G, errMsg } from "./lib.mjs";
import fs from "fs";
const F = "/root/.crucible/agent-account.json";
let id;
if (!fs.existsSync(F)) {
  id = `crucible-agent-${Date.now().toString().slice(-8)}.testnet`;
  const full = KeyPair.fromRandom("ed25519");
  const r = await fetch("https://helper.testnet.near.org/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: full.getPublicKey().toString() }) });
  fs.writeFileSync(F + ".full.tmp", full.toString(), { mode: 0o600 });
  console.log("helper", r.status); if (!r.ok) throw new Error(await r.text());
  await new Promise(r => setTimeout(r, 4000));
  const ks = new keyStores.InMemoryKeyStore(); await ks.setKey("testnet", id, full);
  const acc = await (await connect({ networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org", keyStore: ks })).account(id);
  const fc = KeyPair.fromRandom("ed25519");
  const t1 = await acc.addKey(fc.getPublicKey().toString(), GAME, ["propose_evm", "propose_btc"], utils.format.parseNearAmount("1"));
  fs.writeFileSync(F, JSON.stringify({ account_id: id, public_key: fc.getPublicKey().toString(), private_key: fc.toString() }), { mode: 0o600 });
  console.log("add fc key tx", t1.transaction.hash);
  const t2 = await acc.deleteKey(full.getPublicKey().toString());
  console.log("delete full-access key tx", t2.transaction.hash);
  fs.unlinkSync(F + ".full.tmp");
}
id = JSON.parse(fs.readFileSync(F)).account_id;
const ks2 = new keyStores.InMemoryKeyStore(); await ks2.setKey("testnet", id, KeyPair.fromString(JSON.parse(fs.readFileSync(F)).private_key));
const ag = await (await connect({ networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org", keyStore: ks2 })).account(id);
console.log("agent account", id, "keys", JSON.stringify((await ag.getAccessKeys()).map(k => k.access_key.permission)));
for (const [what, f] of [["send NEAR", () => ag.sendMoney("crucible-11011136.testnet", 1n)],
                         ["call pause", () => ag.functionCall({ contractId: GAME, methodName: "pause", args: {}, gas: G })]])
  try { await f(); console.log("UNEXPECTED: agent could", what); } catch (e) { console.log(`agent -> ${what} rejected:`, e.type || errMsg(e).slice(0, 100)); }
