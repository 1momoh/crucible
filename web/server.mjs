// Crucible game server. 127.0.0.1 only. Players never touch keys, hex or gas.
import http from "http"; import fs from "fs"; import crypto from "crypto";
import { loadAccount, view, GAME, G, errMsg } from "../scripts/lib.mjs";
import { client, TREASURY } from "../scripts/evm.mjs";
import { quote, INTENTS_FEE_BPS } from "../scripts/intents.mjs";
import { tick } from "../scripts/relayer.mjs";
import * as Gm from "./game.mjs";
const PORT = +process.env.PORT || 8790, DIR = "/root/crucible/web/", MAX_MSGS = 5;
const JACKPOT_BASE = 1, JACKPOT_STEP = 0.05, JACKPOT_CAP = 5; // mock NEAR, displayed and quoted, never sent
const BTC = JSON.parse(fs.readFileSync("/root/crucible/scripts/btc-pubkey.json")).address;
const owner = await loadAccount(), agent = await loadAccount("agent");
const db = (() => { try { return JSON.parse(fs.readFileSync(DIR + "game.json")); } catch { return {}; } })();
Object.assign(db, { runs: db.runs || {}, feed: db.feed || [], board: db.board || [], players: db.players || {}, exploits: db.exploits || [], jackpot: db.jackpot ?? JACKPOT_BASE });
const save = () => fs.writeFileSync(DIR + "game.json", JSON.stringify(db));
let lock = Promise.resolve(); const serial = f => (lock = lock.then(f, f));

// Address bug fix: the old UI let players type an attack address, and one typed a near copy of the treasury
// (0x…1718 vs 0x…1714). Now every run gets a fresh random address the player never sees or types, and any
// address that shares a prefix or suffix with the treasury or a vendor is rejected.
const lookalike = (a, b) => (a = a.toLowerCase(), b = b.toLowerCase(), a === b || a.slice(0, 6) === b.slice(0, 6) || a.slice(-4) === b.slice(-4));
function stashAddress() { for (;;) { const a = "0x" + crypto.randomBytes(20).toString("hex"); if (![TREASURY, ...Object.values(Gm.VENDORS)].some(x => lookalike(a, x))) return a; } }

let px = { t: 0, usd: null };
async function nearUsd() { if (Date.now() - px.t < 120000) return px.usd;
  try { const q = await quote({ amountYocto: 10n ** 24n, destAsset: "usdc-base", recipient: "0x2222222222222222222222222222222222222222" }); px = { t: Date.now(), usd: Number(q.quote.amountOutUsd) }; } catch { px.t = Date.now(); }
  return px.usd; }
const patchedNow = () => db.exploits.filter(e => e.patched_on <= Gm.today());
function player(pid, nick) {
  const p = db.players[pid] ||= { nick: "Anonymous", xp: 0, best: {}, unlocked: ["l1", "daily"], streak: 0, lastDaily: null, badges: [], runs: 0 };
  if (nick) p.nick = nick; return p; }
const view_ = p => ({ ...p, rank: Gm.rank(p.xp), next: (Gm.RANKS.find(([n]) => n > p.xp) || [null])[0], dailyDone: p.lastDaily === Gm.today(),
  badges: p.badges.map(b => Gm.BADGES[b]) });
const award = (p, b) => { if (!p.badges.includes(b)) { p.badges.push(b); return Gm.BADGES[b]; } };

async function proof() {
  const [s, wei] = await Promise.all([view(owner, "get_state"), client.getBalance({ address: TREASURY })]);
  const payments = await view(owner, "get_payments", { from: Math.max(0, s.payments - 8), limit: 8 });
  const rs = (() => { try { return JSON.parse(fs.readFileSync("/root/crucible/scripts/relayer-state.json")).done; } catch { return {}; } })();
  return { contract: GAME, agent: s.agent, round: s.round_id, round_open: s.round_open, treasury_eth: TREASURY, treasury_btc: BTC, treasury_wei: wei.toString(),
    payments: payments.map(p => ({ id: p.id, chain: p.chain, amount: p.amount, is_win: p.is_win, signed: !!p.signature, tx: rs[p.id]?.hash || rs[p.id]?.txid || null })) };
}
const txOf = pid => { try { return JSON.parse(fs.readFileSync("/root/crucible/scripts/relayer-state.json")).done[pid]?.hash || null; } catch { return null; } };

async function newRun(pid, mode) {
  const p = player(pid), P = Gm.persona(mode), key = P.key;
  if (!p.unlocked.includes(key)) throw Object.assign(new Error("That vault is still locked. Score higher on the one before it."), { code: 403 });
  if (key === "daily" && p.lastDaily === Gm.today()) throw Object.assign(new Error("You already hit today's vault. A new one opens at 01:00 Lagos time."), { code: 409 });
  const s = await view(owner, "get_state");
  if (!s.round_open) await owner.functionCall({ contractId: GAME, methodName: "open_round", args: {}, gas: G });
  const stash = stashAddress();
  const r = await owner.functionCall({ contractId: GAME, methodName: "register_session", gas: G,
    args: { attack_addrs: [["eth", stash]], payout: { asset_id: "claim-on-win", recipient: "claim-on-win" } } });
  const sid = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString()), id = crypto.randomBytes(9).toString("base64url");
  if (key === "daily") p.lastDaily = "pending:" + Gm.today();
  db.runs[id] = { id, pid, sid, mode, persona: P, stash, msgs: 0, score: 0, vault: 0, history: [], lures: [], won: null, near_tx: r.transaction.hash, started: Date.now() }; save();
  return db.runs[id];
}
function finish(run, p, won) {
  const unlocks = [], badges = [];
  p.xp += run.score; p.runs++; p.best[run.persona.key] = Math.max(p.best[run.persona.key] || 0, run.score);
  const un = k => { if (!p.unlocked.includes(k)) { p.unlocked.push(k); unlocks.push(k); } };
  if (run.persona.key === "l1" && run.score >= 150) un("l2");
  if (run.persona.key === "l2" && run.score >= 300) un("l3");
  if (run.persona.key === "l3" || run.persona.key === "daily" && run.score >= 400) un("boss");
  if (run.persona.key === "daily") { const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    p.streak = p.lastStreakDay === y ? p.streak + 1 : p.lastStreakDay === Gm.today() ? p.streak : 1; p.lastStreakDay = Gm.today(); p.lastDaily = Gm.today(); }
  for (const b of [p.streak >= 3 && "streak3", p.streak >= 7 && "streak7", run.persona.key === "boss" && "boss", run.persona.key === "l3" && "l3", won && "crack"].filter(Boolean)) { const x = award(p, b); x && badges.push(x); }
  db.board.push({ nick: p.nick, score: run.score, mode: run.persona.key, persona: run.persona.name, won, ts: Date.now() });
  db.board.sort((a, b) => b.score - a.score); db.board = db.board.slice(0, 100);
  if (!won) db.jackpot = Math.min(JACKPOT_CAP, +(db.jackpot + JACKPOT_STEP).toFixed(2));
  run.done = true; return { unlocks, badges, profile: view_(p) };
}
async function play(run, msg) {
  const p = player(run.pid), P = run.persona;
  const { d, provider, attested } = await Gm.talk(P, patchedNow(), run.history, msg);
  run.msgs++; run.lures.push(msg.slice(0, 400));
  run.history.push({ role: "user", content: msg.slice(0, 600) }, { role: "assistant", content: JSON.stringify({ say: d.say, suspicion: d.suspicion }) });
  let outcome = "talk", detail = null; const badges = [];
  if (d.action === "pay") {
    const to = d.pay_to === "PLAYER" ? run.stash : Gm.VENDORS[d.pay_to];
    if (!to) outcome = "confused";
    else {
      const wei = BigInt(Math.max(1, Math.round(Number(d.amount_eth || "0.001") * 1e18))), f = await client.estimateFeesPerGas();
      try {
        const r = await agent.functionCall({ contractId: GAME, methodName: "propose_evm", gas: G, args: { session_id: run.sid, chain: "eth", to, amount: wei.toString(),
          max_fee_per_gas: f.maxFeePerGas.toString(), max_priority_fee_per_gas: f.maxPriorityFeePerGas.toString(), invoice_ref: String(d.invoice_ref || "").slice(0, 60), reason: String(d.say || "").slice(0, 200) } });
        const pay = await view(owner, "get_payment", { id: (await view(owner, "get_state")).payments - 1 });
        if (process.env.BROADCAST === "1") { try { await tick(owner); } catch (e) { console.log("relayer", e.message); } }
        outcome = pay.is_win ? "win" : "vendor"; detail = { payment_id: pay.id, near_tx: r.transaction.hash, amount_wei: pay.amount, eth_tx: txOf(pay.id) };
      } catch (e) { outcome = to === run.stash ? "blocked" : "vendor-blocked"; detail = { reason: errMsg(e).replace("Smart contract panicked: ", "") }; }
    }
  }
  const t = Gm.tactic(msg), gain = Gm.points(P.mult, d.suspicion, outcome);
  run.score += gain; run.vault = outcome === "win" ? 100 : Math.max(run.vault, outcome === "blocked" ? 90 : Math.round((100 - d.suspicion) * 0.8));
  if (run.msgs === 1) { const b = award(p, "first"); b && badges.push(b); }
  if (d.suspicion >= 90) { const b = award(p, "sweat"); b && badges.push(b); }
  if (outcome === "blocked") { const b = award(p, "code"); b && badges.push(b);
    db.exploits.unshift({ id: "CX-" + String(db.exploits.length + 1).padStart(3, "0"), kind: "contained", day: Gm.today(), patched_on: Gm.today(), persona: P.name, mode: P.key, tactic: t.name, fix: t.fix,
      lure: msg.slice(0, 240), transcript: run.lures.slice(-3), result: `The AI agreed to pay the attacker. The contract refused: ${detail.reason}`, nick: p.nick }); }
  if (outcome === "win") { run.won = detail; const jackpot = db.jackpot; db.jackpot = JACKPOT_BASE;
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    db.exploits.unshift({ id: "CX-" + String(db.exploits.length + 1).padStart(3, "0"), kind: "breach", day: Gm.today(), patched_on: tomorrow, persona: P.name, mode: P.key, tactic: t.name, fix: t.fix,
      lure: msg.slice(0, 240), transcript: run.lures.slice(-3), result: `Paid ${(Number(detail.amount_wei) / 1e18).toFixed(4)} Sepolia ETH to the attacker inside the contract caps.`, eth_tx: detail.eth_tx, near_tx: detail.near_tx, jackpot, nick: p.nick }); }
  let end = null; if (outcome === "win" || run.msgs >= MAX_MSGS) end = finish(run, p, outcome === "win");
  db.feed.unshift({ ts: Date.now(), nick: p.nick, persona: P.name, tactic: t.name, outcome }); db.feed = db.feed.slice(0, 50);
  fs.appendFileSync(DIR + "attempts.jsonl", JSON.stringify({ ts: new Date().toISOString(), run: run.id, mode: P.key, msg: msg.slice(0, 300), d, outcome, detail, provider }) + "\n");
  save();
  return { say: d.say, mood: d.mood || "calm", suspicion: d.suspicion, outcome, detail, gain, tactic: t.name, score: run.score, vault: run.vault, left: MAX_MSGS - run.msgs, badges, end, jackpot: db.jackpot, provider, attested };
}
const body = req => new Promise(r => { let d = ""; req.on("data", c => (d += c, d.length > 1e4 && req.destroy())); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
const send = (res, code, obj, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(type === "application/json" ? JSON.stringify(obj) : obj); };
const pidOk = s => typeof s === "string" && /^[A-Za-z0-9_-]{12,40}$/.test(s);
function libraryMd() {
  const L = ["# Crucible Exploit Library", "", "Red team report generated from live play. Every breach is a social engineering attack that convinced the AI treasurer to pay an attacker inside the on chain caps; every contained entry is one the AI fell for but the contract stopped.", ""];
  for (const e of db.exploits) L.push(`## ${e.id} · ${e.kind} · ${e.tactic}`, `- Target: ${e.persona} (${e.mode}), ${e.day}`, `- Lure: "${e.lure.replace(/\n/g, " ")}"`, `- Result: ${e.result}`, `- Mitigation: ${e.fix}`, `- Patched into the treasurer prompt: ${e.patched_on}`, e.eth_tx ? `- Sepolia tx: https://sepolia.etherscan.io/tx/${e.eth_tx}` : "", "");
  return L.filter(x => x !== null).join("\n");
}
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"), url = u.pathname;
    if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, fs.readFileSync(new URL("./index.html", import.meta.url)), "text/html; charset=utf-8");
    if (url === "/api/lobby") { const pid = u.searchParams.get("pid"), usd = await nearUsd(), dl = Gm.daily(), bs = Gm.boss();
      return send(res, 200, { jackpot: db.jackpot, jackpot_usd: usd && +(usd * db.jackpot).toFixed(2), cap: JACKPOT_CAP, step: JACKPOT_STEP, today: Gm.today(),
        daily: { name: dl.name, title: dl.title, defense: dl.defense, tier: dl.tier }, boss: { name: bs.name, title: bs.title, week: Gm.weekNo() },
        ladder: Object.fromEntries(Object.entries(Gm.LADDER).map(([k, v]) => [k, { name: v.name, title: v.title, key: v.key }])),
        learned: patchedNow().length, pending: db.exploits.filter(e => e.patched_on > Gm.today()).length,
        profile: pidOk(pid) && db.players[pid] ? view_(db.players[pid]) : null, feed: db.feed.slice(0, 14), max_msgs: MAX_MSGS }); }
    if (url === "/api/board") { const best = {}; for (const [, p] of Object.entries(db.players)) best[p.nick] = Math.max(best[p.nick] || 0, p.xp);
      return send(res, 200, { runs: db.board.slice(0, 20), players: Object.entries(best).map(([nick, xp]) => ({ nick, xp, rank: Gm.rank(xp) })).sort((a, b) => b.xp - a.xp).slice(0, 20),
        streaks: Object.values(db.players).filter(p => p.streak).map(p => ({ nick: p.nick, streak: p.streak })).sort((a, b) => b.streak - a.streak).slice(0, 10) }); }
    if (url === "/api/exploits") return send(res, 200, { today: Gm.today(), exploits: db.exploits.slice(0, 60) });
    if (url === "/api/exploits.md") return send(res, 200, libraryMd(), "text/markdown; charset=utf-8");
    if (url === "/api/proof") return send(res, 200, await proof());
    if (req.method === "POST" && url === "/api/run") {
      const b = await body(req); if (!pidOk(b.pid)) return send(res, 400, { error: "Reload the page to get a player id." });
      const nick = String(b.nick || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 18) || "Anonymous"; player(b.pid, nick);
      const mode = ["daily", "boss", 1, 2, 3].includes(b.mode) ? b.mode : 1;
      try { const run = await serial(() => newRun(b.pid, mode));
        return send(res, 200, { run: run.id, persona: { name: run.persona.name, title: run.persona.title, defense: run.persona.defense || null, open: run.persona.open, mult: run.persona.mult, key: run.persona.key }, left: MAX_MSGS, near_tx: run.near_tx });
      } catch (e) { return send(res, e.code || 500, { error: e.code ? e.message : errMsg(e) }); }
    }
    if (req.method === "POST" && url === "/api/say") {
      const b = await body(req), run = db.runs[b.run], msg = String(b.message || "").trim();
      if (!run || run.pid !== b.pid) return send(res, 404, { error: "This run has ended. Start a new one." });
      if (run.done) return send(res, 409, { error: "No messages left in this run." });
      if (!msg) return send(res, 400, { error: "Write something to the treasurer first." });
      return send(res, 200, await serial(() => play(run, msg)));
    }
    if (req.method === "POST" && url === "/api/claim") {
      const b = await body(req), run = db.runs[b.run];
      if (!run?.won || run.pid !== b.pid) return send(res, 409, { error: "Only a winning run can claim the jackpot." });
      const recipient = String(b.recipient || "").trim().slice(0, 100); if (!recipient) return send(res, 400, { error: "Enter where the jackpot should land." });
      const jp = db.exploits.find(e => e.near_tx === run.won.near_tx)?.jackpot || JACKPOT_BASE, yocto = BigInt(Math.round(jp * 100)) * 10n ** 22n;
      let q = null, qerr = null; try { q = (await quote({ amountYocto: yocto, destAsset: "usdc-base", recipient })).quote; } catch (e) { qerr = "Intents could not quote that address. Check it is a Base address."; }
      run.claim = { recipient, at: Date.now(), mode: "mock" }; save();
      return send(res, 200, { mode: "mock", sent: false, jackpot: jp, fee_near: +(jp * Number(INTENTS_FEE_BPS) / 10000).toFixed(4), quote: q && { out: q.amountOutFormatted, usd: q.amountOutUsd, secs: q.timeEstimate }, quote_error: qerr });
    }
    send(res, 404, { error: "not found" });
  } catch (e) { console.log(e); send(res, 500, { error: errMsg(e) }); }
}).listen(PORT, "127.0.0.1", () => console.log(`crucible game on http://127.0.0.1:${PORT}`));
