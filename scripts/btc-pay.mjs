// One real BTC testnet4 payment via the agent key: propose_btc (contract builds + MPC signs) -> relayer assembles + broadcasts.
import { loadAccount, view, GAME, G, errMsg } from "./lib.mjs";
import fs from "fs";
const { address } = JSON.parse(fs.readFileSync("/root/crucible/scripts/btc-pubkey.json"));
const u = (await (await fetch(`https://mempool.space/testnet4/api/address/${address}/utxo`)).json()).filter(x => x.status.confirmed || process.env.ALLOW_UNCONFIRMED === "1")[0];
if (!u) throw new Error("no confirmed utxo yet");
const to = process.argv[2] || "0014459c2e0ef56b249f6778200466042758286b8416"; // default: back to the treasury (keeps test funds)
const ag = await loadAccount("agent");
const r = await ag.functionCall({ contractId: GAME, methodName: "propose_btc", gas: G,
  args: { session_id: 0, to, amount: "20000", fee: "500", utxo: { txid: u.txid, vout: u.vout, value: u.value }, invoice_ref: "INV-BTC-1", reason: "testnet4 e2e" } });
const n = (await view(ag, "get_state")).payments;
const p = await view(ag, "get_payment", { id: n - 1 });
console.log("propose_btc near tx", r.transaction.hash, "payment", p.id, "signed", !!p.signature, "unsigned", p.unsigned_hex.slice(0, 24) + "…");
