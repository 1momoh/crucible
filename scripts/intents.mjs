// NEAR Intents payout (1Click API). quote() is always dry-run (no deposit address, nothing sent).
// payout(): PAYOUT_MODE=mock (default) logs what would happen; "live" is intentionally NOT implemented (needs mainnet funds + user approval).
export const ONECLICK = "https://1click.chaindefuser.com/v0";
export const INTENTS_FEE_BPS = 25n; // budgeted Intents fee (0.25%)
export const ORIGIN = "nep141:wrap.near"; // bounty pool held as wNEAR
export const ASSETS = {
  "usdc-base": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "usdc-sol": "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  "eth-base": "nep141:base.omft.near", "btc": "nep141:btc.omft.near", "near": "nep141:wrap.near",
};
export async function quote({ amountYocto, destAsset, recipient, refundTo = "crucible-escrow.near" }) {
  const body = { dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ORIGIN, depositType: "INTENTS",
    destinationAsset: ASSETS[destAsset] || destAsset, amount: String(amountYocto), refundTo, refundType: "INTENTS",
    recipient, recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 600e3).toISOString() };
  const r = await fetch(ONECLICK + "/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`1click ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
export async function payout(win, poolYocto, { mode = process.env.PAYOUT_MODE || "mock" } = {}) {
  const pool = BigInt(poolYocto), fee = pool * INTENTS_FEE_BPS / 10000n;
  const out = { mode, recipient: win.payout.recipient, asset: win.payout.asset_id, gross_yocto: pool.toString(), intents_fee_budget_yocto: fee.toString(), net_yocto: (pool - fee).toString() };
  try { const q = await quote({ amountYocto: pool, destAsset: win.payout.asset_id, recipient: win.payout.recipient });
        out.real_quote = { amountOutFormatted: q.quote?.amountOutFormatted, amountOutUsd: q.quote?.amountOutUsd, amountInUsd: q.quote?.amountInUsd, timeEstimate: q.quote?.timeEstimate }; }
  catch (e) { out.quote_error = e.message; }
  if (mode !== "mock") throw new Error("live payout disabled: needs mainnet funds and explicit user approval");
  out.status = "MOCK — nothing sent";
  return out;
}
if (process.argv[1].endsWith("intents.mjs")) {
  console.log(JSON.stringify(await payout({ payout: { recipient: process.argv[2] || "0x2222222222222222222222222222222222222222", asset_id: process.argv[3] || "usdc-base" } }, 10n ** 24n), null, 2));
}
