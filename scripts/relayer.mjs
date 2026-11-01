// Relayer watcher. Polls the game contract; for each MPC-signed payment it assembles the raw tx
// purely from contract data (unsigned_hex + signature), re-verifies it, and broadcasts only if BROADCAST=1.
// Wins are paid out via NEAR Intents; PAYOUT_MODE=mock (default) only logs the quote (0.25% Intents fee assumed).
import { parseTransaction, serializeTransaction, recoverTransactionAddress, keccak256 } from "viem";
import * as bitcoin from "bitcoinjs-lib";
import { loadAccount, view } from "./lib.mjs";
import { client, TREASURY } from "./evm.mjs";
import fs from "fs";
import { payout } from "./intents.mjs";
const STATE = "/root/crucible/scripts/relayer-state.json";
const BROADCAST = process.env.BROADCAST === "1";
const PAYOUT_MODE = process.env.PAYOUT_MODE || "mock";
export const INTENTS_FEE_BPS = 25n;
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : { next: 0, done: {}, paid_wins: [] };
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
const sigOf = j => (typeof j === "string" ? JSON.parse(j) : j);

export async function evmRaw(p) {
  const unsigned = "0x" + p.unsigned_hex;
  if (keccak256(unsigned).slice(2) !== p.payload_hex) throw new Error("payload != keccak(unsigned)");
  const tx = parseTransaction(unsigned), s = sigOf(p.signature);
  const raw = serializeTransaction(tx, { r: "0x" + s.big_r.affine_point.slice(2), s: "0x" + s.s.scalar, yParity: s.recovery_id });
  const from = await recoverTransactionAddress({ serializedTransaction: raw });
  if (from.toLowerCase() !== TREASURY.toLowerCase()) throw new Error("signer mismatch " + from);
  if (tx.to.toLowerCase() !== p.to.toLowerCase() || tx.value !== BigInt(p.amount)) throw new Error("tx does not match payment record");
  return { raw, tx };
}
export function btcRaw(p, pubkeyHex) {
  const t = bitcoin.Transaction.fromHex(p.unsigned_hex), s = sigOf(p.signature);
  const r = Buffer.from(s.big_r.affine_point.slice(2), "hex"), sv = Buffer.from(s.s.scalar, "hex");
  const der = bitcoin.script.signature.encode(Buffer.concat([r, sv]), bitcoin.Transaction.SIGHASH_ALL);
  t.setWitness(0, [der, Buffer.from(pubkeyHex, "hex")]);
  if (t.outs[0].value !== Number(p.amount) || Buffer.from(t.outs[0].script).toString("hex") !== p.to) throw new Error("btc tx does not match record");
  return t.toHex();
}
function quotePayout(win, pool) {
  const fee = pool * INTENTS_FEE_BPS / 10000n;
  return { mode: PAYOUT_MODE, asset_in: "nep141:wrap.near", asset_out: win.payout.asset_id, recipient: win.payout.recipient, gross: pool.toString(), intents_fee: fee.toString(), net: (pool - fee).toString() };
}

export async function tick(a) {
  const n = (await view(a, "get_state")).payments;
  for (let i = st.next; i < n; i++) {
    const p = await view(a, "get_payment", { id: i });
    if (st.done[i]) continue;
    if (!p.signature) { console.log(`payment ${i}: not signed (yet)`); break; }
    try {
      if (p.chain === "eth") {
        const { raw, tx } = await evmRaw(p);
        const onchainNonce = await client.getTransactionCount({ address: TREASURY, blockTag: "pending" });
        if (tx.nonce < onchainNonce) { st.done[i] = { skipped: "nonce already used", nonce: tx.nonce }; console.log(`payment ${i}: stale nonce ${tx.nonce}`); continue; }
        if (!BROADCAST) { console.log(`payment ${i}: verified eth tx to ${p.to} ${p.amount} wei (dry run, BROADCAST!=1)`); break; }
        const hash = await client.sendRawTransaction({ serializedTransaction: raw });
        st.done[i] = { chain: "eth", hash }; console.log(`payment ${i}: BROADCAST sepolia ${hash}`);
      } else if (p.chain === "btc") {
        const pub = JSON.parse(fs.readFileSync("/root/crucible/scripts/btc-pubkey.json")).pubkey;
        const raw = btcRaw(p, pub);
        if (!BROADCAST) { console.log(`payment ${i}: verified btc tx (dry run)`); break; }
        const r = await fetch("https://mempool.space/testnet4/api/tx", { method: "POST", body: raw });
        const txt = await r.text(); if (!r.ok) throw new Error("mempool: " + txt);
        st.done[i] = { chain: "btc", txid: txt }; console.log(`payment ${i}: BROADCAST testnet4 ${txt}`);
      }
      if (p.is_win) {
        const w = (await view(a, "get_wins")).find(w => w.payment_id === p.id);
        const q = await payout(w, 10n ** 24n); // demo bounty pool: 1 NEAR; mock unless explicitly approved
        st.paid_wins.push({ payment: i, ...q }); console.log(`WIN payout (${PAYOUT_MODE}):`, JSON.stringify(q));
      }
    } catch (e) { st.done[i] = { rejected: e.message }; console.log(`payment ${i}: REJECTED by relayer: ${e.message}`); }
    st.next = i + 1; save();
  }
  save();
}
if (process.argv[1].endsWith("relayer.mjs")) {
  const a = await loadAccount();
  console.log(`relayer up: broadcast=${BROADCAST} payout=${PAYOUT_MODE}`);
  do { await tick(a); if (process.env.ONCE === "1") break; await new Promise(r => setTimeout(r, 10000)); } while (true);
}
