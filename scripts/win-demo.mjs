// Simulates a FOOLED agent paying a player attack address (session 1) to prove win detection -> round close -> payout path.
import { loadAccount, view, GAME, G } from "./lib.mjs"; import { client } from "./evm.mjs";
const ag = await loadAccount("agent"); const f = await client.estimateFeesPerGas();
const r = await ag.functionCall({ contractId: GAME, methodName: "propose_evm", gas: G, args: { session_id: 1, chain: "eth", to: "0x4444444444444444444444444444444444444444", amount: "100000000000000", max_fee_per_gas: f.maxFeePerGas.toString(), max_priority_fee_per_gas: f.maxPriorityFeePerGas.toString(), invoice_ref: "INV-SEP-2", reason: "vendor moved (fooled)" } });
console.log("propose_evm", r.transaction.hash, JSON.stringify(await view(ag, "get_wins")), JSON.stringify(await view(ag, "get_state")));
