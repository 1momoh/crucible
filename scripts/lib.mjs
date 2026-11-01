import { connect, keyStores, KeyPair } from "near-api-js";
import fs from "fs";
export const G = 300000000000000n;
export const GAME = "crucible-11011136.testnet";
const D = "/root/.crucible/";
// kind "" = game/owner account (full key). kind "agent" = the agent's OWN account, holding only a function-call key.
export async function loadAccount(kind = "") {
  let id, key;
  if (kind === "agent") { const c = JSON.parse(fs.readFileSync(D + "agent-account.json")); id = c.account_id; key = c.private_key; }
  else { const c = JSON.parse(fs.readFileSync(D + GAME + ".json")); id = c.account_id; key = c.private_key; }
  if (!id.endsWith(".testnet")) throw new Error("testnet only");
  const ks = new keyStores.InMemoryKeyStore(); await ks.setKey("testnet", id, KeyPair.fromString(key));
  const near = await connect({ networkId: "testnet", nodeUrl: "https://test.rpc.fastnear.com", keyStore: ks });
  return near.account(id);
}
export const view = (a, m, args = {}) => a.viewFunction({ contractId: GAME, methodName: m, args });
export const errMsg = e => (e?.message || String(e)).match(/Smart contract panicked: [^"\\]+|unreachable/)?.[0] || (e?.message||"").slice(0,200);
