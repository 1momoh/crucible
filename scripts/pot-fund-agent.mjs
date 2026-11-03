// Send gas money to the agent account: node pot-fund-agent.mjs <NEAR>
import { account, OWNER_KEY, AGENT_KEY } from "./near-net.mjs"; import { utils } from "near-api-js"; import fs from "fs";
const o = await account(OWNER_KEY), a = JSON.parse(fs.readFileSync(AGENT_KEY)).account_id;
const r = await o.sendMoney(a, BigInt(utils.format.parseNearAmount(process.argv[2] || "0.3"))); console.log("fund agent", r.transaction.hash);
