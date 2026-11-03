// Testnet only: create throwaway winner accounts + one stranger account under the owner, keys in /root/.crucible/pot-test.json.
import { account, NET, OWNER_KEY } from "./near-net.mjs";
import { KeyPair, utils } from "near-api-js";
import fs from "fs";
if (NET !== "testnet") throw new Error("testnet only");
const owner = await account(OWNER_KEY), out = {};
for (const n of ["w1", "w2", "w3", "w4", "stranger"]) {
  const id = `${n}-pt.${owner.accountId}`, k = KeyPair.fromRandom("ed25519");
  const r = await owner.createAccount(id, k.getPublicKey(), BigInt(utils.format.parseNearAmount("0.02")));
  out[n] = { account_id: id, private_key: k.toString() }; console.log(n, id, r.transaction.hash);
}
fs.writeFileSync("/root/.crucible/pot-test.json", JSON.stringify(out), { mode: 0o600 });
