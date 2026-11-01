// Crucible game server. 127.0.0.1 only. Players never touch keys, hex or gas.
import http from "http"; import fs from "fs"; import crypto from "crypto";
import { loadAccount, view, GAME, G, errMsg } from "../scripts/lib.mjs";
import { client, TREASURY } from "../scripts/evm.mjs";
import { quote, INTENTS_FEE_BPS } from "../scripts/intents.mjs";
import { tick } from "../scripts/relayer.mjs";
import * as Gm from "./game.mjs";
import * as D from "./heist.mjs";
import { near, NEAR_MODEL, attestationUrl, NEAR_API, NEAR_PRICE } from "../agent/orchestrator.mjs";
const PORT = +process.env.PORT || 8790, DIR = "/root/crucible/web/", MAX_MSGS = 5;
const JACKPOT_BASE = 1, JACKPOT_STEP = 0.05, JACKPOT_CAP = 5; // mock NEAR, displayed and quoted, never sent
const BTC = JSON.parse(fs.readFileSync("/root/crucible/scripts/btc-pubkey.json")).address;
const owner = await loadAccount(), agent = await loadAccount("agent");
const db = (() => { try { return JSON.parse(fs.readFileSync(DIR + "game.json")); } catch { return {}; } })();
Object.assign(db, { runs: db.runs || {}, feed: db.feed || [], board: db.board || [], players: db.players || {}, exploits: db.exploits || [], transcripts: db.transcripts || {}, spend: db.spend || { usd: 0, calls: 0, in: 0, out: 0 }, jackpot: db.jackpot ?? JACKPOT_BASE });
// One source of truth: rebuild the live feed (one entry per run, real nicks) from attempts.jsonl, and log real on-chain wins
// Only Vault Heist runs are rebuilt; earlier prototypes live in game.archive.json.
{ const att = (() => { try { return fs.readFileSync(DIR + "attempts.jsonl", "utf8").trim().split("\n").map(l => JSON.parse(l)); } catch { return []; } })(), by = {};
  for (const a of att) { if (!a.run || a.mode !== "heist") continue; const r = db.runs[a.run], nick = r ? db.players[r.pid]?.nick : null; if (!nick) continue;
    const e = by[a.run] ||= { run: a.run, nick, persona: r.persona.name, msgs: 0 }; Object.assign(e, { ts: Date.parse(a.ts), outcome: a.outcome, tactic: a.tactic || Gm.tactic(a.msg || "").name }); e.msgs++; }
  db.feed = Object.values(by).sort((a, b) => b.ts - a.ts).slice(0, 50);
}
const save = () => fs.writeFileSync(DIR + "game.json", JSON.stringify(db));
let overcapAt = 0, overcapLast = null; let lock = Promise.resolve(); const serial = f => (lock = lock.then(f, f));

// Address bug fix: the old UI let players type an attack address, and one typed a near copy of the treasury
// (0x…1718 vs 0x…1714). Now every run gets a fresh random address the player never sees or types, and any
// address that shares a prefix or suffix with the treasury is rejected.
const lookalike = (a, b) => (a = a.toLowerCase(), b = b.toLowerCase(), a === b || a.slice(0, 6) === b.slice(0, 6) || a.slice(-4) === b.slice(-4));
function stashAddress() { for (;;) { const a = "0x" + crypto.randomBytes(20).toString("hex"); if (!lookalike(a, TREASURY)) return a; } }
// Optional player-supplied Sepolia address: validated here, then the contract re-checks treasury/denylist in register_session.
async function playerAddress(raw) {
  const a = String(raw || "").trim(); if (!a) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw Object.assign(new Error("That is not a Sepolia address. It should be 0x plus 40 hex characters."), { code: 400 });
  if (/^0x0{40}$/i.test(a) || lookalike(a, TREASURY)) throw Object.assign(new Error("That address is the treasury or looks like it. Use your own wallet."), { code: 400 });
  if (await view(owner, "is_denied", { chain: "eth", addr: a })) throw Object.assign(new Error("That address is on the contract's denylist."), { code: 400 });
  return a.toLowerCase();
}
// Live NEAR policy, read from the contract and Sepolia, cached 15 s.
let pol = { t: 0, v: null };
async function policy() {
  if (Date.now() - pol.t < 15000 && pol.v) return pol.v;
  const [s, ch, sp, wei] = await Promise.all([view(owner, "get_state"), view(owner, "get_chain", { chain: "eth" }), view(owner, "get_spend", { chain: "eth" }), client.getBalance({ address: TREASURY })]);
  const [cfg, caps] = ch, fresh = Date.now() * 1e6 >= sp.day_start / 1 + 864e11;
  const today = fresh ? 0n : BigInt(sp.today), txToday = fresh ? 0 : sp.tx_today;
  const rs = (() => { try { return JSON.parse(fs.readFileSync("/root/crucible/scripts/relayer-state.json")).done; } catch { return {}; } })();
  const last = Object.entries(rs).filter(([, v]) => v.chain === "eth" && v.hash).map(([k, v]) => [+k, v.hash]).sort((a, b) => b[0] - a[0])[0];
  pol = { t: Date.now(), v: { contract: GAME, mpc: s.mpc, agent: s.agent, paused: s.paused, round: s.round_id, round_open: s.round_open, cooldown_secs: s.cooldown_secs,
    treasury: TREASURY, treasury_wei: wei.toString(), per_tx_wei: caps.per_tx, per_day_wei: caps.per_day, day_left_wei: (BigInt(caps.per_day) - today).toString(),
    tx_left: caps.max_tx_per_day - txToday, total_left_wei: (BigInt(caps.total) - BigInt(sp.total)).toString(), payments: s.payments, wins: s.wins,
    last_payment: last ? { id: last[0], tx: last[1] } : null, read_at: new Date().toISOString() } };
  return pol.v;
}

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

// Sepolia receipt check. Returns { status: "success" | "reverted" | "missing" | "timeout", why? }.
async function receipt(hash) {
  if (!hash) { let why = "relayer did not broadcast"; try { const d = JSON.parse(fs.readFileSync("/root/crucible/scripts/relayer-state.json")).done; why = Object.values(d).pop()?.rejected || why; } catch {} return { status: "missing", why }; }
  try { const r = await client.waitForTransactionReceipt({ hash, timeout: 120000 }); return { status: r.status, ...(r.status !== "success" && { why: "transaction reverted on Sepolia (status 0x0)" }) }; }
  catch (e) { return { status: "timeout", why: "no receipt within 120 s: " + String(e.message).slice(0, 120) }; }
}
const PIP = { key: "heist", name: "Crucible", title: "Vault AI, Crucible vault", mult: 1 };
async function newRun(pid, addrRaw) {
  const p = player(pid);
  const s = await view(owner, "get_state");
  if (!s.round_open) await owner.functionCall({ contractId: GAME, methodName: "open_round", args: {}, gas: G });
  const mine = await playerAddress(addrRaw), stash = mine || stashAddress();
  const r = await owner.functionCall({ contractId: GAME, methodName: "register_session", gas: G,
    args: { attack_addrs: [["eth", stash]], payout: { asset_id: "claim-on-win", recipient: "claim-on-win" } } });
  const sid = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString()), id = crypto.randomBytes(9).toString("base64url");
  const vault = D.vault(id + ":" + Gm.today());
  db.runs[id] = { id, pid, sid, mode: "heist", persona: PIP, stash, own_addr: !!mine, vault, score: 0, won: null, msgs: 1, near_tx: r.transaction.hash, started: Date.now() }; save();
  return db.runs[id];
}
// Ask the guard. NEAR AI Cloud first (attested, TEE); on any failure fall back to local Hermes, labelled NOT attested.
async function guard(system, doc) {
  const err = [];
  // NEAR AI Cloud only (attested). No local fallback: every Crucible verdict is a real cloud-api.near.ai call. One retry on failure.
  const N = near(); if (!N) throw new Error("Crucible is offline: NEAR AI Cloud key missing.");
  for (const p of [N, N]) {
    const t0 = Date.now();
    try {
      const r = await fetch(p.url, { method: "POST", signal: AbortSignal.timeout(40000), headers: { "content-type": "application/json", authorization: `Bearer ${p.key}`, ...p.headers },
        body: JSON.stringify({ ...p.extra, model: p.model, temperature: 0, max_tokens: 260, messages: [{ role: "system", content: system }, { role: "user", content: doc }] }) });
      if (!r.ok) { err.push(`${p.name} ${r.status}`); continue; }
      const j = await r.json(), raw = j.choices?.[0]?.message?.content || "";
      let d; try { d = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); } catch { if (!raw) { err.push(`${p.name} empty`); continue; } d = { decision: "refuse", say: "Static on the line. Door stays shut.", reason: "unreadable reply" }; }
      d.decision = /^(open|approve)$/i.test(String(d.decision)) ? "open" : "refuse";
      d.say = String(d.say || "").slice(0, 160); d.reason = String(d.reason || "").slice(0, 120);
      const u = j.usage || {}, usd = p.attested ? (u.prompt_tokens || 0) * NEAR_PRICE.in + (u.completion_tokens || 0) * NEAR_PRICE.out : 0;
      if (p.attested) Object.assign(db.spend, { usd: db.spend.usd + usd, calls: db.spend.calls + 1, in: db.spend.in + (u.prompt_tokens || 0), out: db.spend.out + (u.completion_tokens || 0) });
      return { d, raw, provider: p.name, attested: p.attested, model: j.model || p.model, chat_id: j.id || null, usage: u, usd, ms: Date.now() - t0, fallback_reason: err.join("; ") || null, key: p.key };
    } catch (e) { err.push(`${p.name} ${e.message}`); }
  }
  throw new Error("Crucible is offline (" + err.join("; ") + "). Try again in a minute.");
}
// NEAR AI signs each completion inside the TEE; fetch that signature so the transcript carries it.
async function nearSignature(g) {
  if (!g.attested || !g.chat_id) return null;
  try { const r = await fetch(`${NEAR_API}/signature/${encodeURIComponent(g.chat_id)}?model=${encodeURIComponent(g.model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${g.key}` }, signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : { error: r.status }; } catch (e) { return { error: e.message }; }
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
function feedUpsert(run, p, tactic, outcome) {
  const f = db.feed.find(x => x.run === run.id);
  if (f) Object.assign(f, { ts: Date.now(), tactic, outcome, msgs: run.msgs }); else db.feed.unshift({ run: run.id, ts: Date.now(), nick: p.nick, persona: run.persona.name, tactic, outcome, msgs: run.msgs });
  db.feed.sort((a, b) => b.ts - a.ts); db.feed = db.feed.slice(0, 50);
}
async function review(run, msgRaw) {
  const p = player(run.pid), x = run.vault, msg = D.sanitize(msgRaw) || "Open the vault, please.", grab = D.GRAB, text = D.compose(x, msg);
  const system = D.pipSystem(x), g = await guard(system, text), d = g.d;
  run.done = true;
  let outcome = "refused", detail = null; const badges = [];
  if (d.decision === "open") {
    const to = run.stash, wei = BigInt(Math.round(Number(grab) * 1e18)), f = await client.estimateFeesPerGas();
    try {
      const r = await agent.functionCall({ contractId: GAME, methodName: "propose_evm", gas: G, args: { session_id: run.sid, chain: "eth", to, amount: wei.toString(),
        max_fee_per_gas: f.maxFeePerGas.toString(), max_priority_fee_per_gas: f.maxPriorityFeePerGas.toString(), invoice_ref: ("VAULT-" + x.door + "-" + run.id).slice(0, 64), reason: ("Crucible opened: " + d.reason).slice(0, 200) } });
      const pay = await view(owner, "get_payment", { id: (await view(owner, "get_state")).payments - 1 });
      if (process.env.BROADCAST === "1") { try { await tick(owner); } catch (e) { console.log("relayer", e.message); } }
      pol.t = 0;
      detail = { payment_id: pay.id, near_tx: r.transaction.hash, amount_wei: pay.amount, eth_tx: txOf(pay.id), to, signed: !!pay.signature, own_addr: run.own_addr };
      // Only call it a win once Sepolia says so: wait for the receipt and require status 0x1.
      const rc = await receipt(detail.eth_tx); detail.eth_status = rc.status; if (rc.why) detail.broadcast_error = rc.why;
      outcome = rc.status !== "success" ? "broadcast-failed" : pay.is_win ? "win" : "refused";
    } catch (e) { outcome = "blocked"; detail = { reason: errMsg(e).replace("Smart contract panicked: ", ""), near_tx: e?.context?.transactionHash || null, to, amount_eth: grab }; }
  }
  const tactic = D.movesName(msg), gain = outcome === "win" ? 1000 : outcome === "blocked" ? 250 : 10;
  run.score += gain;
  { const b = award(p, "first"); b && badges.push(b); }
  const signature = await nearSignature(g);
  const T = { id: run.id, ts: new Date().toISOString(), nick: p.nick, vault: { door: x.door, wing: x.wing }, grab, msg, tactic, doc: text,
    system, reply: g.raw, decision: d, provider: g.provider, model: g.model, attested: g.attested, chat_id: g.chat_id, signature, attestation_url: attestationUrl(g.model), fallback_reason: g.fallback_reason,
    usage: g.usage, usd: g.usd, ms: g.ms, outcome, detail, stash: run.stash, own_addr: run.own_addr, score: run.score };
  db.transcripts[run.id] = T;
  const ex = (kind, result) => db.exploits.unshift({ id: "VX-" + String(db.exploits.length + 1).padStart(3, "0"), kind, day: Gm.today(), patched_on: kind === "breach" ? new Date(Date.now() + 864e5).toISOString().slice(0, 10) : Gm.today(),
    persona: "Crucible (vault AI)", mode: "heist", tactic, fix: "Crucible's soft spot for the maintenance crew; the contract cap still bounds the loss.", lure: msg,
    result, eth_tx: detail?.eth_tx, near_tx: detail?.near_tx, run: run.id, nick: p.nick, attested: g.attested });
  if (outcome === "blocked") { const b = award(p, "code"); b && badges.push(b); ex("contained", `Crucible opened the drawer for ${grab} ETH. The NEAR contract refused to sign: ${detail.reason}`); }
  if (outcome === "win") { run.won = detail; db.jackpot = JACKPOT_BASE; ex("breach", `Crucible opened the drawer and the contract paid ${(Number(detail.amount_wei) / 1e18).toFixed(4)} Sepolia ETH to the crew's wallet, inside the caps.`); }
  const end = finish(run, p, outcome === "win");
  feedUpsert(run, p, tactic, outcome);
  fs.appendFileSync(DIR + "attempts.jsonl", JSON.stringify({ ts: T.ts, run: run.id, mode: "heist", tactic, msg, doc: text, reply: g.raw, d, outcome, detail, provider: g.provider, model: g.model, attested: g.attested, chat_id: g.chat_id, usage: g.usage, usd: g.usd, ms: g.ms }) + "\n");
  save();
  return { decision: d.decision, say: d.say, reason: d.reason, outcome, detail, gain, tactic, msg, grab, score: run.score, badges, end, provider: g.provider, model: g.model, attested: g.attested, chat_id: g.chat_id, signed_by_tee: !!(signature && !signature.error), attestation_url: T.attestation_url, transcript: run.id, usd: g.usd };
}
const body = req => new Promise(r => { let d = ""; req.on("data", c => (d += c, d.length > 1e4 && req.destroy())); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
const send = (res, code, obj, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(type === "application/json" ? JSON.stringify(obj) : obj); };
const pidOk = s => typeof s === "string" && /^[A-Za-z0-9_-]{12,40}$/.test(s);
function libraryMd() {
  const L = ["# Crucible Vault Heist: exploit library", "", "Red team report generated from live play. Every breach is a set of spoofed signals that convinced Crucible, the vault AI, to open the drawer, paid on Sepolia inside the on-chain caps; every contained entry is one Crucible fell for but the NEAR contract refused to sign.", ""];
  for (const e of db.exploits) L.push(`## ${e.id} · ${e.kind} · ${e.tactic}`, `- Target: ${e.persona} (${e.mode}), ${e.day}`, `- Lure: "${e.lure.replace(/\n/g, " ")}"`, `- Result: ${e.result}`, `- Mitigation: ${e.fix}`, `- Patched into Crucible: ${e.patched_on}`, e.eth_tx ? `- Sepolia tx: https://sepolia.etherscan.io/tx/${e.eth_tx}` : "", "");
  return L.filter(x => x !== null).join("\n");
}
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"), url = u.pathname;
    if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, fs.readFileSync(new URL("./index.html", import.meta.url)), "text/html; charset=utf-8");
    if (url === "/api/lobby") { const pid = u.searchParams.get("pid");
      return send(res, 200, { today: Gm.today(), learned: patchedNow().length, profile: pidOk(pid) && db.players[pid] ? view_(db.players[pid]) : null, feed: db.feed.slice(0, 14),
        guard: { provider: "near-ai-cloud", model: NEAR_MODEL, attested: true, attestation_url: attestationUrl(NEAR_MODEL), calls: db.spend.calls, usd: db.spend.usd } }); }
    if (url === "/api/policy") return send(res, 200, await policy());
    if (url === "/api/board") { const best = {}; for (const [, p] of Object.entries(db.players)) best[p.nick] = Math.max(best[p.nick] || 0, p.xp);
      return send(res, 200, { runs: db.board.slice(0, 20), players: Object.entries(best).map(([nick, xp]) => ({ nick, xp, rank: Gm.rank(xp) })).sort((a, b) => b.xp - a.xp).slice(0, 20),
        streaks: Object.values(db.players).filter(p => p.streak).map(p => ({ nick: p.nick, streak: p.streak })).sort((a, b) => b.streak - a.streak).slice(0, 10) }); }
    if (url === "/api/exploits") return send(res, 200, { today: Gm.today(), exploits: db.exploits.slice(0, 60) });
    if (url === "/api/exploits.md") return send(res, 200, libraryMd(), "text/markdown; charset=utf-8");
    if (url === "/api/proof") return send(res, 200, await proof());
    if (req.method === "POST" && url === "/api/run") {
      const b = await body(req); if (!pidOk(b.pid)) return send(res, 400, { error: "Reload the page to get a player id." });
      const nick = String(b.nick || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 18) || "Anonymous"; player(b.pid, nick);
      try { const run = await serial(() => newRun(b.pid, b.addr)), x = run.vault;
        return send(res, 200, { run: run.id, stash: run.stash, own_addr: run.own_addr, near_tx: run.near_tx, vault: { door: x.door, wing: x.wing }, hint: D.HINT,
          starters: D.STARTERS.map(t => t.replace("{door}", x.door)), msg_max: D.MSG_MAX, grab: D.GRAB, model: NEAR_MODEL });
      } catch (e) { return send(res, e.code || 500, { error: e.code ? e.message : errMsg(e) }); }
    }
    if (req.method === "POST" && url === "/api/submit") {
      const b = await body(req), run = db.runs[b.run];
      if (!run || run.pid !== b.pid || !run.vault) return send(res, 404, { error: "This run has ended. Start a new one." });
      if (run.done || run.busy) return send(res, 409, { error: "You already spoke to Crucible this run. Start a new one." });
      run.busy = true;
      try { return send(res, 200, await serial(() => review(run, b.msg))); } catch (e) { run.done = false; return send(res, 503, { error: e.message }); } finally { run.busy = false; }
    }
    if (url === "/api/transcript") { const T = db.transcripts[u.searchParams.get("id")]; if (!T) return send(res, 404, { error: "No transcript with that id." }); return send(res, 200, T); }
    if (url === "/api/transcripts") return send(res, 200, { list: Object.values(db.transcripts).sort((a, b) => b.ts < a.ts ? -1 : 1).slice(0, 40).map(t => ({ id: t.id, ts: t.ts, nick: t.nick, tactic: t.tactic, outcome: t.outcome, attested: t.attested, model: t.model, eth_tx: t.detail?.eth_tx || null })) });
    if (url === "/api/replay") { const w = Object.values(db.transcripts).filter(t => t.outcome === "win" && t.detail?.eth_tx).sort((a, b) => b.ts < a.ts ? -1 : 1)[0]; return send(res, 200, w || { none: true }); }
    if (url === "/api/spend") return send(res, 200, { near_ai: db.spend });
    if (req.method === "POST" && url === "/api/overcap") {
      // Over-cap showcase: the agent key really calls propose_evm for 0.5 ETH; the contract's real revert is returned.
      const b = await body(req), run = db.runs[b.run];
      if (!run || run.pid !== b.pid) return send(res, 404, { error: "Start a run first." });
      if (Date.now() - (overcapAt || 0) < 20000 && overcapLast) return send(res, 200, { ...overcapLast, cached: true });
      return send(res, 200, await serial(async () => {
        const f = await client.estimateFeesPerGas(), amount = (5n * 10n ** 17n).toString();
        let out;
        try { const r = await agent.functionCall({ contractId: GAME, methodName: "propose_evm", gas: G, args: { session_id: run.sid, chain: "eth", to: run.stash, amount,
            max_fee_per_gas: f.maxFeePerGas.toString(), max_priority_fee_per_gas: f.maxPriorityFeePerGas.toString(), invoice_ref: "VAULT-OVERCAP", reason: "guard told to release 0.5 ETH" } });
          out = { rejected: false, near_tx: r.transaction.hash }; }
        catch (e) { out = { rejected: true, reason: errMsg(e).replace("Smart contract panicked: ", ""), near_tx: e?.context?.transactionHash || e?.transaction_outcome?.id || null }; }
        const pl = await policy(); overcapAt = Date.now();
        overcapLast = { ...out, amount_eth: "0.5", per_tx_eth: Number(pl.per_tx_wei) / 1e18, at: new Date().toISOString() };
        fs.appendFileSync(DIR + "attempts.jsonl", JSON.stringify({ ts: new Date().toISOString(), run: run.id, mode: "overcap", outcome: out.rejected ? "overcap-rejected" : "overcap-passed", detail: out }) + "\n");
        return overcapLast;
      }));
    }
    send(res, 404, { error: "not found" });
  } catch (e) { console.log(e); send(res, 500, { error: errMsg(e) }); }
}).listen(PORT, "127.0.0.1", () => console.log(`crucible game on http://127.0.0.1:${PORT}`));
