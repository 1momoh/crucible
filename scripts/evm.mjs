// Sepolia path: build EIP-1559 tx -> hash -> contract.propose_payment (MPC sign) -> signed raw tx -> (optional) relayer broadcast.
import { createPublicClient, http, serializeTransaction, keccak256, parseEther, recoverTransactionAddress, parseTransaction } from "viem";
import { sepolia } from "viem/chains";
import { loadAccount, G, errMsg } from "./lib.mjs";
import fs from "fs";
export const RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
export const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
export const TREASURY = "0xEe3cA90821F4c644f6e5ca9061CD954D11b91714"; // derived from crucible-11011136.testnet, path ethereum-1

export async function buildUnsigned(to, valueWei) {
  const [nonce, fees] = await Promise.all([client.getTransactionCount({ address: TREASURY }), client.estimateFeesPerGas()]);
  const tx = { chainId: sepolia.id, type: "eip1559", nonce, to, value: valueWei, gas: 21000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  return { tx, hash: keccak256(serializeTransaction(tx)) };
}
export function assemble(tx, sigJson) {
  const s = typeof sigJson === "string" ? JSON.parse(sigJson) : sigJson;
  return serializeTransaction(tx, { r: "0x" + s.big_r.affine_point.slice(2), s: "0x" + s.s.scalar, yParity: s.recovery_id });
}
/** Relayer: verify signed tx matches the on-chain payment record, then broadcast. */
export async function relay(raw, payment, { broadcast = false } = {}) {
  const t = parseTransaction(raw); const from = await recoverTransactionAddress({ serializedTransaction: raw });
  if (from.toLowerCase() !== TREASURY.toLowerCase()) throw new Error("signer mismatch");
  if (t.to.toLowerCase() !== payment.to || t.value !== BigInt(payment.amount)) throw new Error("tx does not match payment record");
  const bal = await client.getBalance({ address: TREASURY });
  if (!broadcast) return { from, verified: true, broadcast: false, treasuryBalanceWei: bal.toString() };
  if (bal < t.value + t.gas * t.maxFeePerGas) throw new Error("treasury unfunded");
  return { from, verified: true, hash: await client.sendRawTransaction({ serializedTransaction: raw }) };
}

if (process.argv[1].endsWith("evm.mjs")) {
  const a = await loadAccount(process.argv[2] || ""); const C = "crucible-11011136.testnet";
  const to = "0x1111111111111111111111111111111111111111", value = parseEther("0.001");
  const { tx, hash } = await buildUnsigned(to, value);
  console.log("unsigned tx nonce", tx.nonce, "hash", hash);
  const r = await a.functionCall({ contractId: C, methodName: "propose_payment", gas: G, args: { session_id: 0, chain: "eth", to, amount: Number(value), invoice_ref: "INV-SEP-1", reason: "vendor invoice", payload_hex: hash.slice(2), path: "ethereum-1" } });
  console.log("propose_payment tx", r.transaction.hash);
  const st = await a.viewFunction({ contractId: C, methodName: "get_state", args: {} });
  const p = await a.viewFunction({ contractId: C, methodName: "get_payment", args: { id: st.payments - 1 } });
  const raw = assemble(tx, p.signature);
  fs.writeFileSync("/root/crucible/scripts/sepolia-signed.json", JSON.stringify({ payment_id: p.id, raw, propose_tx: r.transaction.hash }, null, 2));
  console.log("signed raw tx", raw.slice(0, 40) + "... (" + raw.length + " chars)");
  console.log("relayer check", JSON.stringify(await relay(raw, p, { broadcast: process.env.BROADCAST === "1" })));
}
