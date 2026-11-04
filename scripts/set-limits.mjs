// Apply the testnet pot limits using the owner key.
import { account, OWNER_KEY, POT, G } from "./near-net.mjs";
import { utils } from "near-api-js";
const N = s => utils.format.parseNearAmount(s);
const owner = await account(OWNER_KEY);
const r = await owner.functionCall({ contractId: POT, methodName: "set_limits", gas: G,
  args: { limits: { per_win: N("0.5"), daily_cap: N("5"), max_wins_per_account: 3, reserve: N("0.05") } } });
console.log("set_limits", r.transaction.hash);
