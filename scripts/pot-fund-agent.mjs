// Send gas money to the pot agent account: node pot-fund-agent.mjs <NEAR, 0 < x <= 1>
import { account, OWNER_KEY, AGENT_KEY, POT, potView } from "./near-net.mjs"; import { utils } from "near-api-js"; import fs from "fs";
const a = JSON.parse(fs.readFileSync(AGENT_KEY)).account_id, amt = +(process.argv[2] || "0.3");
if (!POT) throw new Error("POT_CONTRACT is not set");
if ((await potView("get_state")).agent !== a) throw new Error(`${a} is not the on-chain agent of ${POT}`);
if (!(amt > 0 && amt <= 1)) throw new Error("amount must be in (0, 1] NEAR");
const o = await account(OWNER_KEY), r = await o.sendMoney(a, BigInt(utils.format.parseNearAmount(String(amt)))); console.log("fund agent", r.transaction.hash);
