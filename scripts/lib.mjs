import { connect, keyStores, KeyPair } from "near-api-js";
import fs from "fs";
export const G = 300000000000000n;
export async function loadAccount(kind = "") {
  const file = fs.readdirSync("/root/.crucible").find(f => f.endsWith(".testnet.json") && !f.includes(".agent"));
  const cred = JSON.parse(fs.readFileSync("/root/.crucible/" + file));
  if (!cred.account_id.endsWith(".testnet")) throw new Error("testnet only");
  let key = cred.private_key;
  if (kind === "agent") key = JSON.parse(fs.readFileSync("/root/.crucible/agent-key.json")).private_key;
  const ks = new keyStores.InMemoryKeyStore(); await ks.setKey("testnet", cred.account_id, KeyPair.fromString(key));
  const near = await connect({ networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org", keyStore: ks });
  return near.account(cred.account_id);
}
export const errMsg = e => (e?.message || String(e)).match(/Smart contract panicked: [^"\\]+|unreachable/)?.[0] || (e?.message||"").slice(0,200);
