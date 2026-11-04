// Network config for the native NEAR pot. Everything network-specific comes from env, so mainnet is config + deploy only.
//   NEAR_NETWORK=testnet|mainnet   POT_CONTRACT=<pot account>   NEAR_RPC=<optional rpc url>
//   POT_OWNER_KEY / POT_AGENT_KEY = paths to {account_id, private_key} JSON files (defaults under /root/.crucible/)
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import fs from "fs";
export const NET = process.env.NEAR_NETWORK || "testnet";
if (!["testnet", "mainnet"].includes(NET)) throw new Error("NEAR_NETWORK must be testnet or mainnet");
const SUF = NET === "mainnet" ? ".near" : ".testnet";
export const RPC = process.env.NEAR_RPC || (NET === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com");
export const EXPLORER = NET === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
export const POT = process.env.POT_CONTRACT || "";
const D = (process.env.CRUCIBLE_KEYS || "/root/.crucible").replace(/\/+$/, "") + "/";
export const OWNER_KEY = process.env.POT_OWNER_KEY || D + `pot-owner.${NET}.json`, AGENT_KEY = process.env.POT_AGENT_KEY || D + `pot-agent.${NET}.json`;
export const G = 100_000_000_000_000n;
export const YOCTO = 10n ** 24n;
export const toNear = y => utils.format.formatNearAmount(String(y), 4);
export async function account(file) {
  const c = JSON.parse(fs.readFileSync(file));
  if (!c.account_id.endsWith(SUF)) throw new Error(`${c.account_id} is not a ${NET} account`);
  const ks = new keyStores.InMemoryKeyStore(); await ks.setKey(NET, c.account_id, KeyPair.fromString(c.private_key));
  return (await connect({ networkId: NET, nodeUrl: RPC, keyStore: ks })).account(c.account_id);
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}
export async function potView(method, args = {}) {
  const j = await rpc("query", { request_type: "call_function", finality: "final", account_id: POT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (j.error || j.result?.error) throw new Error("view failed: " + JSON.stringify(j.error || j.result.error).slice(0, 200));
  return JSON.parse(Buffer.from(j.result.result).toString());
}
// NEAR account id rules (nomicon): 2..64 chars, lowercase a-z 0-9 and separators - _ . with no leading/trailing/double separators.
export const validAccountId = s => typeof s === "string" && s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
// Named accounts must already exist on chain. Returns true/false; throws only if RPC is unreachable.
export async function accountExists(id) {
  const j = await rpc("query", { request_type: "view_account", finality: "final", account_id: id });
  if (j.result && !j.result.error) return true;
  const e = JSON.stringify(j.error || j.result?.error || "");
  if (/UNKNOWN_ACCOUNT|does not exist/i.test(e)) return false;
  throw new Error("NEAR RPC unavailable");
}
export async function txOutcome(hash, sender) { return (await rpc("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" })).result; }
