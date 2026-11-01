// Owner-only cap change on the testnet game contract. Usage:
//   node set-limits.mjs dev    -> daily tx count effectively off (1,000,000/day), per_day = total = 0.1 ETH, per_tx 0.01 ETH
//   node set-limits.mjs prod   -> restore 5 tx/day, per_day 0.03 ETH, total 0.1 ETH, per_tx 0.01 ETH
import { loadAccount, view, GAME, G } from "./lib.mjs";
const E = n => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();
const P = { dev: { per_tx: E(0.01), per_day: E(0.1), total: E(0.1), max_tx_per_day: 1_000_000 },
            prod: { per_tx: E(0.01), per_day: E(0.03), total: E(0.1), max_tx_per_day: 5 } }[process.argv[2]];
if (!P) throw new Error("usage: node set-limits.mjs dev|prod");
const a = await loadAccount();
const r = await a.functionCall({ contractId: GAME, methodName: "set_limits", args: { chain: "eth", caps: P }, gas: G });
console.log("set_limits tx", r.transaction.hash, JSON.stringify((await view(a, "get_chain", { chain: "eth" }))[1]));
