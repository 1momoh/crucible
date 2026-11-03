// Create + deploy the native NEAR pot. Usage:
//   NEAR_NETWORK=testnet node deploy-pot.mjs <pot-account-id> [pot NEAR, default 1]
// The owner key file (POT_OWNER_KEY) must be the parent of <pot-account-id>, e.g. pot.crucible.near under crucible.near.
// Creates <pot>, deploys the wasm, inits limits, creates agent.<pot> holding ONLY a function-call key for `pay`,
// and tops up so `available` == the pot amount. Keys go to /root/.crucible/ (chmod 600), never printed.
import { account, NET, G, YOCTO, toNear, OWNER_KEY } from "./near-net.mjs";
import { KeyPair, transactions, utils } from "near-api-js";
import fs from "fs";
const [pot, potNear = "1"] = process.argv.slice(2);
if (!pot) throw new Error("usage: deploy-pot.mjs <pot-account-id> [pot NEAR]");
const owner = await account(OWNER_KEY);
if (!pot.endsWith("." + owner.accountId)) throw new Error("pot must be a subaccount of the owner " + owner.accountId);
const agentId = "agent." + pot, wasm = fs.readFileSync(new URL("../contract-near/target/near/crucible_pot.wasm", import.meta.url));
const N = s => BigInt(utils.format.parseNearAmount(s));
const PER_WIN = N("0.1"), DAILY = N(process.env.DAILY_CAP || "0.5"), RESERVE = N("0.05"), POT_AMT = N(potNear);
const storage = BigInt(wasm.length + 2000) * 10n ** 19n; // code + state headroom at 1e19 yocto/byte
const potKey = KeyPair.fromRandom("ed25519"), agentKey = KeyPair.fromRandom("ed25519");
const save = (f, id, k) => fs.writeFileSync(f, JSON.stringify({ account_id: id, public_key: k.getPublicKey().toString(), private_key: k.toString() }), { mode: 0o600 });
save(`/root/.crucible/pot-account.${NET}.json`, pot, potKey);
const { createAccount, transfer, addKey, deployContract, functionCall, fullAccessKey, functionCallAccessKey } = transactions;
const init = { owner: owner.accountId, agent: agentId, per_win: PER_WIN.toString(), max_wins_per_account: 1, daily_cap: DAILY.toString(), reserve: RESERVE.toString() };
let r = await owner.signAndSendTransaction({ receiverId: pot, actions: [createAccount(), transfer(storage + RESERVE + POT_AMT), addKey(potKey.getPublicKey(), fullAccessKey()),
  deployContract(wasm), functionCall("new", init, G, 0n)] });
console.log("create+deploy+init", r.transaction.hash, Object.keys(r.status)[0]);
const potAcc = await account(`/root/.crucible/pot-account.${NET}.json`);
save(`/root/.crucible/pot-agent.${NET}.json`, agentId, agentKey);
r = await potAcc.signAndSendTransaction({ receiverId: agentId, actions: [createAccount(), transfer(N("0.3")),
  addKey(agentKey.getPublicKey(), functionCallAccessKey(pot, ["pay"], N("1")))] });
console.log("agent (function-call key only, method pay)", agentId, r.transaction.hash);
const st = await potAcc.viewFunction({ contractId: pot, methodName: "get_state" });
const gap = POT_AMT - BigInt(st.available);
if (gap > 0n) { r = await owner.functionCall({ contractId: pot, methodName: "fund", args: {}, gas: G, attachedDeposit: gap }); console.log("top up", toNear(gap), r.transaction.hash); }
console.log("state", JSON.stringify(await potAcc.viewFunction({ contractId: pot, methodName: "get_state" })));
