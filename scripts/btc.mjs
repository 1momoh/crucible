// Bitcoin testnet4 path: derive P2WPKH address from MPC key; build BIP143 sighash; sign via contract; verify.
import * as bitcoin from "bitcoinjs-lib";
import * as secp from "@noble/secp256k1";
import bs58 from "bs58";
import { loadAccount, G } from "./lib.mjs";
import fs from "fs";
const NET = bitcoin.networks.testnet; // testnet4 uses the same tb1 / version bytes
const C = "crucible-11011136.testnet", PATH = "bitcoin-1";
export async function derive(a) {
  const pk = await a.viewFunction({ contractId: "v1.signer-prod.testnet", methodName: "derived_public_key", args: { path: PATH, predecessor: C, domain_id: 0 } });
  const raw = bs58.decode(pk.split(":")[1]);
  const compressed = secp.ProjectivePoint.fromHex(Buffer.concat([Buffer.from([4]), raw])).toRawBytes(true);
  const pay = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(compressed), network: NET });
  return { pubkey: Buffer.from(compressed), address: pay.address, output: pay.output };
}
export async function utxos(addr) { const r = await fetch(`https://mempool.space/testnet4/api/address/${addr}/utxo`); return r.ok ? r.json() : []; }
/** Build a 1-in tx (P2WPKH) and return its BIP143 sighash for input 0. */
export function buildSighash(fromOut, utxo, to, sats, change, feeSats) {
  const tx = new bitcoin.Transaction(); tx.version = 2;
  tx.addInput(Buffer.from(utxo.txid, "hex").reverse(), utxo.vout);
  tx.addOutput(bitcoin.address.toOutputScript(to, NET), sats);
  const rest = utxo.value - sats - feeSats; if (rest > 546) tx.addOutput(fromOut, rest);
  const scriptCode = bitcoin.payments.p2pkh({ hash: fromOut.slice(2) }).output;
  return { tx, sighash: tx.hashForWitnessV0(0, scriptCode, utxo.value, bitcoin.Transaction.SIGHASH_ALL) };
}
if (process.argv[1].endsWith("btc.mjs")) {
  const a = await loadAccount(process.argv[2] || "");
  const { pubkey, address, output } = await derive(a);
  console.log("BTC testnet4 treasury", address);
  const us = await utxos(address); console.log("utxos", us.length);
  // No funds yet: use a placeholder UTXO so the full sign path can be exercised; such a tx is NOT broadcastable.
  const u = us[0] || { txid: "00".repeat(32), vout: 0, value: 100000, placeholder: true };
  const vendor = address; // self-payment as stand-in vendor for the dry test
  const { tx, sighash } = buildSighash(output, u, vendor, 20000, address, 300);
  const st = await a.viewFunction({ contractId: C, methodName: "get_caps", args: { chain: "btc" } });
  if (!st) { await a.functionCall({ contractId: C, methodName: "set_caps", gas: G, args: { chain: "btc", caps: { per_tx: 20000, per_day: 60000, total: 100000, max_tx_per_day: 3 } } }); await a.functionCall({ contractId: C, methodName: "add_vendor", gas: G, args: { chain: "btc", addr: vendor } }); }
  const r = await a.functionCall({ contractId: C, methodName: "propose_payment", gas: G, args: { session_id: 0, chain: "btc", to: vendor, amount: 20000, invoice_ref: "INV-BTC-1", reason: "vendor invoice (dry)", payload_hex: sighash.toString("hex"), path: PATH } });
  console.log("propose_payment tx", r.transaction.hash);
  const n = (await a.viewFunction({ contractId: C, methodName: "get_state", args: {} })).payments;
  const p = await a.viewFunction({ contractId: C, methodName: "get_payment", args: { id: n - 1 } });
  const s = JSON.parse(p.signature);
  const R = Buffer.from(s.big_r.affine_point, "hex").slice(1), S = Buffer.from(s.s.scalar, "hex");
  let sig = new secp.Signature(BigInt("0x" + R.toString("hex")), BigInt("0x" + S.toString("hex"))).normalizeS();
  const ok = secp.verify(sig, sighash, pubkey);
  tx.setWitness(0, [bitcoin.script.signature.encode(Buffer.from(sig.toCompactRawBytes()), bitcoin.Transaction.SIGHASH_ALL), pubkey]);
  console.log("signature verifies against derived pubkey:", ok, "| signed raw tx", tx.toHex().length / 2, "bytes", u.placeholder ? "(placeholder input, not broadcastable)" : "");
  fs.writeFileSync("/root/crucible/scripts/btc-signed.json", JSON.stringify({ address, propose_tx: r.transaction.hash, raw: tx.toHex(), placeholder: !!u.placeholder }, null, 2));
}
