// Testnet contract/server edge-case tests for the pot. Testnet only.
import { account, NET, POT, OWNER_KEY, AGENT_KEY, potView, toNear } from "./near-net.mjs";
import { KeyPair, utils, connect, keyStores } from "near-api-js";
import fs from "fs";
if (NET !== "testnet") throw new Error("testnet only");
const N = x => BigInt(utils.format.parseNearAmount(x)), T = JSON.parse(fs.readFileSync("/root/.crucible/pot-test.json"));
const sleep = ms => new Promise(z => setTimeout(z, ms));
const owner = await account(OWNER_KEY), agent = await account(AGENT_KEY);
const ks = new keyStores.InMemoryKeyStore(); await ks.setKey("testnet", T.stranger.account_id, KeyPair.fromString(T.stranger.private_key));
const stranger = await (await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC || "https://rpc.testnet.near.org", keyStore: ks })).account(T.stranger.account_id);
const res = [], rec = (name, pass, info) => { res.push({ name, pass, ...info }); console.log(pass ? "PASS" : "FAIL", name, JSON.stringify(info)); };
const call = async (who, method, args, deposit = 0n) => { try { const r = await who.functionCall({ contractId: POT, methodName: method, args, gas: 100_000_000_000_000n, attachedDeposit: deposit });
  return { ok: true, tx: r.transaction.hash, ret: Buffer.from(r.status?.SuccessValue || "", "base64").toString() }; }
  catch (e) { return { ok: false, err: (e.message || "").replace(/^.*Smart contract panicked: /s, "").slice(0, 120), tx: e?.context?.transactionHash || null }; } };
const st = async () => { await sleep(3500); return potView("get_state", {}); }, lim = async l => call(owner, "set_limits", { limits: { per_win: N("0.1").toString(), max_wins_per_account: 1, daily_cap: N(l).toString(), reserve: N("0.05").toString() } });
const B = "http://127.0.0.1:8790";
const step = process.argv[2] || "all", w4 = process.env.RACE_TO || T.w4.account_id;

const want = k => step === "all" || step.split(",").includes(k);
if (want("t3"))
// T3: invalid + nonexistent account rejected by the server (format + RPC existence)
for (const [nm, addr] of [["invalid format", "Bad..Acc!"], ["nonexistent account", "no-such-acct-zz91.testnet"], ["mainnet-suffix on testnet", "someone.near"]]) {
  const r = await fetch(B + "/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: "pt-t3-000000000000", mode: 1, addr }) });
  const j = await r.json(); rec("T3 reject " + nm, r.status === 400, { code: r.status, error: j.error });
}
// T6: unauthorized caller
if (want("t6")) { const r = await call(stranger, "pay", { to: w4, game_ref: "x" }); rec("T6 stranger pay rejected", !r.ok && /unauthorized/.test(r.err), r); }
if (want("t6")) { const r = await call(agent, "withdraw", { amount: N("0.1").toString() }); rec("T6 agent key cannot withdraw", !r.ok, { err: r.err.slice(0, 90) }); }
if (want("t6")) { const r = await call(stranger, "set_limits", { limits: { per_win: N("1").toString(), max_wins_per_account: 9, daily_cap: N("9").toString(), reserve: "0" } }); rec("T6 stranger set_limits rejected", !r.ok, r); }
// T4: daily cap (today already 0.3 paid): cap 0.3 -> next pay blocked
if (want("t4")) { const s = await lim("0.3"); const r = await call(agent, "pay", { to: w4, game_ref: "t4" }); rec("T4 daily cap holds", !r.ok && /daily cap/.test(r.err), { set_limits_tx: s.tx, ...r }); await lim(process.env.CAP_AFTER || "0.5"); }
// T8: failed transfer to nonexistent named account -> Failed, limits released, NEAR stays
if (want("t8")) { const ghost = "ghost-" + Date.now() + ".testnet", b = await st(); const r = await call(agent, "pay", { to: ghost, game_ref: "t8" }); await sleep(4000);
  const a = await st(), wins = await potView("wins_of", { account_id: ghost }), p = (await potView("get_payouts", { from: Math.max(0, a.payouts - 1), limit: 1 }))[0];
  rec("T8 failed transfer refunded, limits released", r.ok && r.ret === "false" && p.status === "Failed" && wins === 0 && a.today === b.today && a.in_flight === "0" && BigInt(a.available) >= BigInt(b.available) - N("0.01"),
    { tx: r.tx, ret: r.ret, status: p.status, wins, today_before: toNear(b.today), today_after: toNear(a.today), avail_before: toNear(b.available), avail_after: toNear(a.available) }); }
// T7: race, owner + agent pay w4 in parallel -> exactly one pays
if (want("t7")) { const [x, y] = await Promise.all([call(agent, "pay", { to: w4, game_ref: "t7a" }), call(owner, "pay", { to: w4, game_ref: "t7b" })]);
  const wins = await potView("wins_of", { account_id: w4 }), okN = [x, y].filter(r => r.ok && r.ret === "true").length;
  rec("T7 double-payout race pays once", wins === 1 && okN === 1, { a: x, b: y, wins }); }
// T5: empty pot (withdraw down to 0.05), pay blocked, then refill
if (want("t5")) { await lim("1"); const s = await st(), take = BigInt(s.available) - N("0.05"); const w = await call(owner, "withdraw", { amount: take.toString() });
  const stranger2 = process.env.T5_TO || T.w5?.account_id || "w5-pt." + owner.accountId; const r = await call(agent, "pay", { to: stranger2, game_ref: "t5" });
  const srv = await (await fetch(B + "/api/lobby")).json();
  const f = await call(owner, "fund", {}, take); rec("T5 empty pot blocked gracefully", w.ok && !r.ok && /pot empty/.test(r.err) && f.ok, { withdraw_tx: w.tx, pay: r, lobby_jackpot_while_empty: srv.jackpot, refund_tx: f.tx }); await lim(process.env.CAP_AFTER || "0.5"); }
console.log("STATE", JSON.stringify(await st()));
// T9: rate limit
if (want("t9")) { await sleep(61000); let codes = []; for (let i = 0; i < 32; i++) codes.push((await fetch(B + "/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
  rec("T9 rate limit 30/min", codes.slice(0, 30).every(c => c !== 429) && codes[30] === 429, { first: codes[0], c31: codes[30], c32: codes[31] }); }
fs.writeFileSync(`/root/crucible/scripts/pot-test-results.${step}.json`, JSON.stringify(res, null, 1));
