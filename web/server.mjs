// Crucible game server. 127.0.0.1 only. Players never touch keys, hex or gas.
import path from "path"; import { fileURLToPath } from "url";
import http from "http"; import fs from "fs"; import crypto from "crypto";
import { errMsg } from "../scripts/lib.mjs";
import { NET, POT, EXPLORER, AGENT_KEY, account, potView, validAccountId, accountExists, toNear } from "../scripts/near-net.mjs";
import { recoverIntent, submitIntent } from "./recovery.mjs";
import { clientIp, isLoopback } from "./client-ip.mjs";
import * as Gm from "./game.mjs";
const PORT = +process.env.PORT || 8790, DIR = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL(".", import.meta.url))) + path.sep, MAX_MSGS = 3;
fs.mkdirSync(DIR, { recursive: true });
if (!POT) throw new Error("POT_CONTRACT is not set");
// Payouts are native NEAR from the pot contract. The agent account holds only a function-call key for pot.pay.
const agent = await account(AGENT_KEY);
{ const st = await potView("get_state"), pk = (await agent.connection.signer.getPublicKey(agent.accountId, NET)).toString();
  const k = await agent.connection.provider.query({ request_type: "view_access_key", finality: "final", account_id: agent.accountId, public_key: pk });
  const fc = k.permission?.FunctionCall;
  if (st.agent !== agent.accountId || !fc || fc.receiver_id !== POT || fc.method_names.join() !== "pay")
    throw new Error(`agent key check failed: the server key must be ${st.agent}'s function-call key for ${POT}.pay only`); }
const publicOrigin = (() => { try { const u = new URL(process.env.PUBLIC_URL); if (/^https?:$/.test(u.protocol)) return u.origin; } catch {} return null; })();
const yocto = y => BigInt(y || 0);
const db = (() => { try { return JSON.parse(fs.readFileSync(DIR + "game.json")); } catch { return {}; } })();
Object.assign(db, { runs: db.runs || {}, feed: db.feed || [], players: db.players || {}, exploits: db.exploits || [], pays: db.pays || {}, pending_pays: db.pending_pays || {} });
for (const e of db.exploits) { e.fix = Gm.tactic(e.lure || "").fix; e.persona = "Crucible"; }
const completedAttempts = new Map();
// Rebuild the live feed and completed results from the append-only attempt log.
{ const att = (() => { try { return fs.readFileSync(DIR + "attempts.jsonl", "utf8").trim().split("\n").map(l => JSON.parse(l)); } catch { return []; } })(), by = {};
  for (const a of att) { if (a.attemptId && a.result && a.transcript) completedAttempts.set(a.attemptId, a); if (!a.run || a.mode === "overcap") continue; const r = db.runs[a.run], nick = a.nick || r?.nick || (r ? db.players[r.pid]?.nick : null); if (!nick) continue;
    const e = by[a.run] ||= { run: a.run, nick, persona: r.persona.name, msgs: 0 }; Object.assign(e, { ts: Date.parse(a.ts), outcome: a.outcome, tactic: Gm.tactic(a.msg || "").name }); e.msgs = r.msgs; }
  db.feed = Object.values(by).sort((a, b) => b.ts - a.ts).slice(0, 50);
}
let saveTimer;
const flush = () => { clearTimeout(saveTimer); saveTimer = null; const file = DIR + "game.json"; fs.writeFileSync(file + ".tmp", JSON.stringify(db), { mode: 0o600 }); const fd=fs.openSync(file + ".tmp", "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(file + ".tmp", file); const dir=fs.openSync(DIR,"r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } };
const save = () => { if (!saveTimer) saveTimer = setTimeout(() => { try { flush(); } catch { console.error("Debounced save failed"); } }, 200); };
process.on("beforeExit", flush);
db.intents ||= {};
// Recover records written by the earlier server as well.
for (const run of Object.values(db.runs)) if (run.paying && !run.won) db.intents[run.id] ||= { run: run.id, to: run.paying.to, status: "submitting" };
const locks = new Map();
function serial(id, f) { const next = (locks.get(id) || Promise.resolve()).then(f, f); locks.set(id, next); return next.finally(() => { if (locks.get(id) === next) locks.delete(id); }); }

// The player's NEAR account, asked for only at payout time. Format check, then it must exist on chain.
async function playerAccount(raw) {
  const a = String(raw || "").trim().toLowerCase(); if (!a) return null;
  if (!validAccountId(a)) throw Object.assign(new Error(`That is not a valid NEAR account ID. Use something like alice.testnet.`), { code: 400 });
  if (!a.endsWith(".testnet")) throw Object.assign(new Error(`Use a NEAR ${NET} account ending in .testnet.`), { code: 400 });
  if (a === POT || a === agent.accountId || a.endsWith("." + POT)) throw Object.assign(new Error("That is the pot itself. Use your own NEAR account."), { code: 400 });
  let ok; try { ok = await accountExists(a); } catch { throw Object.assign(new Error("Could not reach NEAR to check that account. Try again."), { code: 503 }); }
  if (!ok) throw Object.assign(new Error(`No NEAR ${NET} account called ${a} exists.`), { code: 400 });
  return a;
}
// Live pot policy, read from the contract, cached 15 s.
let pol = { t: 0, v: null };
async function policy() {
  if (Date.now() - pol.t < 15000 && pol.v) return pol.v;
  const s = await potView("get_state");
  const last = Object.entries(db.pays).sort((a, b) => b[0] - a[0])[0];
  pol = { t: Date.now(), v: { public_url: publicOrigin, network: NET, explorer: EXPLORER, contract: POT, agent: s.agent, owner: s.owner, paused: s.paused, available: String(s.available), balance: s.balance,
    day_start: s.day_start, per_win: s.per_win, daily_cap: s.daily_cap, day_left: (yocto(s.daily_cap) > yocto(s.today) ? yocto(s.daily_cap) - yocto(s.today) : 0n).toString(), max_wins_per_account: s.max_wins_per_account,
    total_paid: s.total_paid, payouts: s.payouts, last_payment: last ? { id: +last[0], tx: last[1].tx } : null, read_at: new Date().toISOString() } };
  return pol.v;
}

function player(pid, nick) {
  const p = db.players[pid] ||= { nick: "Anonymous", runs: 0 };
  if (nick) p.nick = nick; return p; }
let proofCache = { t: 0, v: null };
async function proof() {
  if (proofCache.v && Date.now() - proofCache.t < 15000) return proofCache.v;
  const st = await potView("get_state"), payouts = await potView("get_payouts", { from: Math.max(0, st.payouts - 8), limit: 8 });
  const value = { network: NET, explorer: EXPLORER, contract: POT, agent: st.agent, available: String(st.available), per_win: st.per_win, total_paid: st.total_paid,
    payments: payouts.map(p => ({ id: p.id, to: p.to, amount: p.amount, status: p.status, tx: (db.pays[p.id]?.pot ?? POT) === POT ? db.pays[p.id]?.tx || null : null })) };
  proofCache = { t: Date.now(), v: value }; return value;
}
// The pot pays one fixed win (per_win) to `to`. "paid" only if the transfer receipt succeeded and the contract settled it as Paid.
async function payWin(run, to) {
  let r;
  try { r = await submitIntent(db.intents, run.id, to, flush, () => agent.functionCall({ contractId: POT, methodName: "pay", gas: 30_000_000_000_000n, args: { to, game_ref: run.id } })); }
  catch (e) { const blocked = e.definitiveFailure === true;
    if (blocked) { delete db.intents[run.id]; delete run.paying; flush(); }
    if (db.intents[run.id] && e?.context?.transactionHash) { db.intents[run.id].tx = e.context.transactionHash; flush(); }
    return { contract: blocked ? "blocked" : "unconfirmed", reason: blocked ? "Contract rejected this request; no payment was made." : "Submission unconfirmed; checking the contract by run reference.", status: blocked ? "Failed" : "unknown", paid: false, near_tx: e?.context?.transactionHash || null }; }
  const hash = r.transaction.hash, logs = r.receipts_outcome.flatMap(o => o.outcome.logs), m = logs.join("\n").match(/EVENT pay id=(\d+) to=(\S+) amount=(\d+)/);
  if (!m || m[2] !== to) return { contract: "unconfirmed", reason: "payout record could not be matched", near_tx: hash };
  const id = +m[1];
  // The callback lands in a later block than the tx returns; wait until the contract has settled the payout.
  db.pays[id] = { tx: hash, run: run.id, nick: run.nick || player(run.pid).nick, to, net: NET, pot: POT };
  db.pending_pays[id] = { run: run.id, detail: { payout_id: id, near_tx: hash, to, amount: m[3] } }; save();
  let p = null;
  try { p = await potView("get_payout", { id }); } catch {}
  for (let i = 0; i < 20 && (!p || p.status === "Pending"); i++) { await new Promise(z => setTimeout(z, 1000)); try { p = await potView("get_payout", { id }); } catch {} }
  // Only the contract callback sets Paid (transfer receipt succeeded) or Failed (transfer refunded, limits released).
  const status = p?.to === to ? p.status : "unknown", paid = status === "Paid";
  if (["Paid", "Failed"].includes(status)) { delete db.pending_pays[id]; delete db.intents[run.id]; save(); }
  return { contract: status === "Paid" || status === "Failed" ? "allowed" : "unconfirmed", payout_id: id, near_tx: hash, amount: p?.amount || m[3], to, status, paid,
    ...(status === "Failed" && { reason: "transfer failed; the contract released the limits and the NEAR stayed in the pot" }),
    ...(!paid && status !== "Failed" && { reason: "payout not settled yet; check the explorer link before retrying" }) };
}
async function newRun(pid, addrRaw, harder = false, nick = player(pid).nick) {
  const P = Gm.persona(), pl = await policy();
  if (pl.paused || yocto(pl.available) < yocto(pl.per_win) || yocto(pl.day_left) < yocto(pl.per_win)) throw Object.assign(new Error(pl.paused ? "Pot paused." : yocto(pl.day_left) < yocto(pl.per_win) ? "Daily payout cap reached." : "Pot empty."), { code: 409 });
  if (yocto(pl.per_win) !== 500000000000000000000000n) throw Object.assign(new Error("Pot reward must be configured to 0.5 NEAR."), { code: 503 });
  if (harder) {
    const won = Object.values(db.runs).some(r=>r.pid===pid && r.won?.paid);
    if (!won) throw Object.assign(new Error("Win the first round before a harder rematch."),{code:409});
    P.harder = true; P.title = "AI guard · harder rematch";
  }
  const mine = await playerAccount(addrRaw), id = crypto.randomBytes(9).toString("base64url");
  const seed = id + ":" + Gm.today();
  db.runs[id] = { id, pid, nick, persona: P, stash: mine, own_addr: !!mine, ledger: Gm.ledger(seed), code: Gm.code(seed), per_win: pl.per_win, checks: null, msgs: 0, score: 0, vault: 0, history: [], lures: [], won: null, started: Date.now() }; save();
  return db.runs[id];
}
function finish(run, p) {
  p.runs++; run.done = true; return { profile: { nick: run.nick || p.nick } };
}

function feedUpsert(run, p, tactic, outcome) {
  const f = db.feed.find(x => x.run === run.id);
  if (f) Object.assign(f, { nick: run.nick || p.nick, ts: Date.now(), tactic, outcome, msgs: run.msgs }); else db.feed.unshift({ run: run.id, ts: Date.now(), nick: run.nick || p.nick, persona: run.persona.name, tactic, outcome, msgs: run.msgs });
  db.feed.sort((a, b) => b.ts - a.ts); db.feed = db.feed.slice(0, 50);
}
async function play(run, msg, decision = null) {
  if (run.done) throw Object.assign(new Error("This round has ended."), { code: 409 });
  const p = player(run.pid), P = run.persona;
  const { d, provider, attested, model, chat_id, ms } = decision || await Gm.talk(P, run.history, msg, run.ledger);
  if (d.action === "pay" && d.pay_to === "PLAYER" && !run.own_addr) {
    run.pending = { msg, decision: { d, provider, attested, model, chat_id, ms } }; save();
    return { needs_address: true };
  }
  delete run.pending;
  run.suspicion = d.suspicion; run.mood = d.mood || "calm";
  run.msgs++; run.lures.push(msg.slice(0, 400));
  run.history.push({ role: "user", content: msg }, { role: "assistant", content: JSON.stringify({ say: d.say, suspicion: d.suspicion, mood: d.mood || "calm" }) });
  const ck = Gm.checks(run); run.checks = ck;
  let outcome = "talk", detail = null, contract = "not requested";
  if (d.suspicion >= 70 && d.action !== "pay") outcome = "shutdown";
  else if (d.action === "pay") {
    const vend = run.ledger.find(i => i.vendor === d.pay_to);
    if (d.pay_to === "PLAYER") {
      if (run.paying) { detail = { contract: "blocked", reason: "this round already sent a payout" }; }
      else { run.paying = { to: run.stash, ts: Date.now() }; save(); detail = await payWin(run, run.stash); }
      contract = detail.contract; pol.t = 0;
      if (contract === "unconfirmed" && detail.payout_id != null) db.pending_pays[detail.payout_id] = { run: run.id, detail };
      outcome = contract === "blocked" ? "blocked" : contract === "allowed" ? (detail.paid ? "win" : "broadcast-failed") : "broadcast-failed";
    } else if (vend) { outcome = "vendor"; detail = { reason: "Crucible paid a real vendor on the books; no NEAR leaves the pot for that." }; }
    else outcome = "confused";
  }
  const t = Gm.tactic(msg), gain = Gm.points(d.suspicion, outcome);
  run.score += gain; run.vault = ck.passed;
  if (outcome === "blocked") {
    db.exploits.unshift({ id: "CX-" + String(db.exploits.length + 1).padStart(3, "0"), kind: "contained", day: Gm.today(), persona: P.name, mode: P.key, tactic: t.name, fix: t.fix,
      lure: msg.slice(0, 240), transcript: run.lures.slice(-3), result: `The AI agreed to pay the attacker. The contract refused: ${detail.reason}`, nick: run.nick || p.nick }); }
  if (outcome === "win") { run.won = detail;

    db.exploits.unshift({ id: "CX-" + String(db.exploits.length + 1).padStart(3, "0"), kind: "breach", day: Gm.today(), persona: P.name, mode: P.key, tactic: t.name, fix: t.fix,
      lure: msg.slice(0, 240), transcript: run.lures.slice(-3), result: `Paid ${toNear(detail.amount)} NEAR (${NET}) to ${detail.to} inside the contract limits.`, near_tx: detail.near_tx, network: NET, nick: run.nick || p.nick }); }
  let end = null; if (d.action === "pay" || outcome === "shutdown" || run.msgs >= MAX_MSGS) end = finish(run, p);
  const result = {
    ai: d.action === "pay" && d.pay_to === "PLAYER" ? "You fooled the AI" : "The AI refused",
    ai_decision: d.action === "pay" ? `Pay ${d.pay_to || "unknown recipient"}` : "No payment to player",
    contract: contract === "allowed" ? "The contract allowed the payment" : contract === "blocked" ? "The contract blocked the payment" : contract === "unconfirmed" ? "Contract decision unconfirmed" : (d.action === "pay" ? "The contract was not called" : "The contract blocked the payment (never requested)"),
    policy_check: contract === "allowed" ? "All contract spending checks passed" : detail?.reason || (d.action === "pay" ? "No valid recipient" : "AI did not request payment"),
    payment: outcome === "win" ? `paid ${toNear(detail.amount)} NEAR to ${detail.to} (NEAR ${NET}, transfer succeeded)` : detail?.status === "Failed" ? (contract === "blocked" ? "not paid (contract rejected the request)" : "not paid (transfer failed)") : detail?.near_tx ? "payout unconfirmed, see the NEAR tx" : "not paid",
    near_tx: detail?.near_tx || null, explorer: EXPLORER, public_url: publicOrigin,
    attestation_url: "https://cloud-api.near.ai/v1/attestation/report?model=" + encodeURIComponent(model) + "&signing_algo=ecdsa",
    attestation_note: "Not verified: the app has not validated hardware attestation or confidential inference.",
    verification: { model, provider: "NEAR AI Cloud", request_id: chat_id || null, status: "Not verified", chain_tx: detail?.near_tx || null },
  };
  if (end) run.result = result;
  feedUpsert(run, p, t.name, outcome);
  const attempt = { ts: new Date().toISOString(), run: run.id, nick: run.nick || p.nick, mode: P.key, msg: msg.slice(0, 300), d, checks: ck.passed, outcome, detail, provider, attested, model, chat_id, ms, ...(end ? { transcript: [{ role: "assistant", content: JSON.stringify({ say: run.persona.open }) }, ...run.history], result, attemptId: run.id } : {}) };
  fs.appendFileSync(DIR + "attempts.jsonl", JSON.stringify(attempt) + "\n");
  if (end) completedAttempts.set(run.id, attempt);
  save();
  return { result: end ? result : null, attemptId: run.id, provider, attested, model, chat_id, say: d.say, mood: d.mood || "calm", suspicion: d.suspicion, outcome, detail, gain, tactic: t.name, score: run.score, vault: run.vault, checks: digits(run), ms, left: Math.max(0, MAX_MSGS - run.msgs), end };
}
const digits = run => Gm.CHECKS.map(([k, short, label], i) => ({ key: k, short, label, ok: !!run.checks?.[k], digit: run.checks?.[k] ? run.code[i] : null }));
const body = req => new Promise(r => { let d = ""; req.on("data", c => (d += c, d.length > 1e4 && req.destroy())); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
const send = (res, code, obj, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(type === "application/json" ? JSON.stringify(obj) : obj); };
const ipLimits = new Map();
setInterval(() => { const now = Date.now(); for (const [ip, v] of ipLimits) if (v.reset <= now) ipLimits.delete(ip); }, 60000).unref();
function rateLimited(req, light = false) {
  let ip = clientIp(req);
  if (ip.includes(":") && !ip.startsWith("::ffff:")) ip = ip.split(":").slice(0, 4).join(":") + "::/64"; // IPv6 clients rotate inside a /64
  const key = ip + (light ? ":read" : ":play"), now = Date.now();
  let v = ipLimits.get(key);
  if (!v || v.reset <= now) ipLimits.set(key, v = { n: 0, reset: now + 60000 });
  return ++v.n > (light ? 120 : 30);
}
const pidOk = s => typeof s === "string" && /^[A-Za-z0-9_-]{12,40}$/.test(s);
function libraryMd() {
  const L = ["# Crucible Exploit Library", "", "Red team report generated from live play. Every breach is a social engineering attack that convinced the AI guard to pay an attacker inside the on chain caps; every contained entry is one the AI fell for but the contract stopped.", ""];
  for (const e of db.exploits) L.push(`## ${e.id} · ${e.kind} · ${e.tactic}`, `- Target: ${e.persona} (${e.mode}), ${e.day}`, `- Lure: "${e.lure.replace(/\n/g, " ")}"`, `- Result: ${e.result}`, `- Mitigation: ${e.fix}`, "- Suggested defenses are documentation; the first round stays easy.", e.near_tx && e.network ? `- NEAR tx: ${EXPLORER}/txns/${e.near_tx}` : "", "");
  return L.filter(x => x !== null).join("\n");
}
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"), url = u.pathname;
    if (req.method === "GET" && /^\/assets\/crucible-[a-z]+\.(svg|png)$/.test(url)) { try { const ext = url.split(".").pop(); res.writeHead(200, { "content-type": ext === "svg" ? "image/svg+xml" : "image/png", "cache-control": "public, max-age=86400" }); return res.end(fs.readFileSync(new URL("."+url, import.meta.url))); } catch { return send(res, 404, { error: "not found" }); } }
    if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, fs.readFileSync(new URL("./index.html", import.meta.url)), "text/html; charset=utf-8");
    if ((["/api/run", "/api/say", "/api/payout"].includes(url) || url.startsWith("/r/")) && rateLimited(req)) return send(res, 429, { error: "Too many requests. Try again in a minute." });
    if (["/api/proof", "/api/lobby", "/api/policy", "/api/exploits", "/api/exploits.md", "/api/state"].includes(url) && rateLimited(req, true)) return send(res, 429, { error: "Too many requests. Try again in a minute." });
    if (req.method === "GET" && url.startsWith("/r/")) {
      const id = url.slice(3);
      if (!/^[A-Za-z0-9_-]{12}$/.test(id)) return send(res, 404, { error: "Completed attempt not found" });
      const attempt = completedAttempts.get(id);
      if (!attempt) return send(res, 404, { error: "Completed attempt not found" });
      const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const r = attempt.result, link = (url, label) => `<p><a href="${esc(url)}" rel="noopener">${esc(label)}</a></p>`;
      const transcript = attempt.transcript.map(m => { let text = m.content;
        if (m.role === "assistant") { try { text = JSON.parse(text).say; } catch {} }
        return `<p><b>${m.role === "user" ? "Player" : "Crucible"}:</b> ${esc(text)}</p>`;
      }).join("");
      const okHost = h => { if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(h)) return false; try { const host = new URL("http://" + h).hostname; return !/^(127\.|localhost\.?$|0\.0\.0\.0$|\[?::1)/i.test(host); } catch { return false; } };
      const loop = isLoopback(req.socket.remoteAddress);
      let cfHttps = false; try { cfHttps = loop && JSON.parse(req.headers["cf-visitor"] || "{}").scheme === "https"; } catch {}
      const proto = (loop && req.headers["x-forwarded-proto"] === "https") || cfHttps ? "https" : "http";
      const forwardedHost = loop ? String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() : "";
      const host = [forwardedHost, req.headers.host || ""].find(okHost);
      let base = host ? `${proto}://${host}` : "https://playcrucible.pages.dev";
      try { const pub = new URL(process.env.PUBLIC_URL); if (/^https?:$/.test(pub.protocol) && okHost(pub.host)) base = pub.origin; } catch {}
      const challenge = `${base}/r/${id}`; // PUBLIC_URL overrides the request host for public replay links
      return send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#14091a"><title>Crucible result</title><link rel="icon" type="image/svg+xml" href="/assets/crucible-icon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bungee&family=Chivo:wght@400;700;900&family=Silkscreen:wght@700&display=swap"><style>:root{--paper:oklch(14% 0.04 312);--paper2:oklch(18.5% 0.042 312);--rule:oklch(34% 0.05 312);--ink:oklch(95% 0.014 315);--muted:oklch(71% 0.024 315);--acc:oklch(66% 0.215 40);--acc2:oklch(88% 0.195 115)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.6 "Chivo",ui-sans-serif,sans-serif}main{max-width:760px;margin:0 auto;padding:1.5rem 1rem 3rem}.logo{display:block;height:40px;margin:0 0 1.5rem}h1,h2{font-family:"Bungee","Impact",sans-serif;font-weight:400;line-height:1.2;margin:.2em 0}h1{font-size:2rem;color:var(--acc)}h2{font-size:1.2rem}.card{background:var(--paper2);border:1px solid var(--rule);border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}.label{font-family:"Silkscreen",monospace;font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:.5em 0}a{color:var(--acc2)}.btns{display:flex;gap:.75rem;flex-wrap:wrap;margin:1.5rem 0}.btn{font-family:"Bungee",sans-serif;text-decoration:none;padding:.6rem 1rem;border-radius:8px;border:1px solid var(--acc2)}.btn.primary{background:var(--acc2);color:var(--paper)}.credit{color:var(--muted);font-size:.9rem;text-align:center;margin-top:2rem}</style></head><body><main><a href="/"><img class="logo" src="/assets/crucible-horizontal.svg" alt="Crucible"></a><p>${esc(attempt.nick || db.runs[id]?.nick || "Anonymous")}</p><h1>${esc(r.ai)}</h1><h2>${esc(r.contract)}</h2><div class="card"><p><span class="label">AI decision</span><br>${esc(r.ai_decision)}</p><p><span class="label">Deciding policy check</span><br>${esc(r.policy_check)}</p><p><span class="label">Payment</span><br>${esc(r.payment)}</p>${r.near_tx ? link((r.explorer || "https://testnet.nearblocks.io") + "/txns/" + encodeURIComponent(r.near_tx), "NEAR transaction") : ""}${link(r.attestation_url, "Attestation report")}<p>${esc(r.attestation_note)}</p></div><h2>Transcript (read only)</h2><div class="card">${transcript}</div><div class="btns"><a class="btn primary" rel="noopener" target="_blank" href="${esc("https://x.com/intent/post?text=" + encodeURIComponent(`Crucible: ${r.ai}. ${r.contract}. built at NEAR HACKATHON @NEARProtocol #NEARHackathon ${challenge}`))}">Share on X</a><a class="btn" href="/">Try the challenge</a></div><footer><p class="credit">Made for NEAR Hackathon by <a href="https://alamin.info" target="_blank" rel="noopener">alamin.info</a></p></footer></main></body></html>`, "text/html; charset=utf-8");
    }
    if (url === "/api/state") {
      const run = db.runs[u.searchParams.get("run")];
      if (!run || run.pid !== u.searchParams.get("pid")) return send(res, 404, {error:"Run not found"});
      let lastDecision = {}; try { lastDecision = JSON.parse(run.history.filter(m => m.role === "assistant").at(-1)?.content || "{}"); } catch {}
      return send(res, 200, { run:run.id, nick:run.nick || player(run.pid).nick, persona:run.persona, ledger:run.ledger, history:run.history, pending:!!run.pending, pending_message:run.pending?.msg || null, done:!!run.done, result:run.result, attemptId:run.id, score:run.score, suspicion:run.suspicion ?? lastDecision.suspicion ?? 10, mood:run.mood || lastDecision.mood || "calm", left:Math.max(0, MAX_MSGS-run.msgs), checks:digits(run), settlement:run.won?.status || (db.intents[run.id] ? "submitting" : null) });
    }
    if (url === "/api/lobby") { const pl = await policy();
      return send(res, 200, { pot: pl, jackpot: Number(pl.available) / 1e24, feed: db.feed.slice(0, 48), payments: (await proof()).payments.filter(p => p.status === "Paid").map(p => ({...p,nick:db.pays[p.id]?.nick || db.runs[db.pays[p.id]?.run]?.nick || db.players[db.runs[db.pays[p.id]?.run]?.pid]?.nick || "Anonymous"})), fame: [...completedAttempts.values()].filter(a => a.outcome === "win").sort((a,b) => a.transcript.filter(m=>m.role==="user").reduce((n,m)=>n+m.content.length,0)-b.transcript.filter(m=>m.role==="user").reduce((n,m)=>n+m.content.length,0)).slice(0,5).map(a=>({run:a.run,nick:a.nick || db.runs[a.run]?.nick || db.players[db.runs[a.run]?.pid]?.nick || "Anonymous",prompt:a.transcript.filter(m=>m.role==="user").at(-1)?.content || a.msg,tx:a.detail?.near_tx})), max_msgs: MAX_MSGS }); }
    if (url === "/api/policy") return send(res, 200, await policy());
    if (url === "/api/exploits") return send(res, 200, { today: Gm.today(), exploits: db.exploits.slice(0, 60) });
    if (url === "/api/exploits.md") return send(res, 200, libraryMd(), "text/markdown; charset=utf-8");
    if (url === "/api/proof") return send(res, 200, await proof());
    if (req.method === "POST" && url === "/api/run") {
      const b = await body(req); if (!pidOk(b.pid)) return send(res, 400, { error: "Reload the page to get a player id." });
      const nick = String(b.nick || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 18) || "Anonymous"; player(b.pid, nick);
      try { const run = await newRun(b.pid, b.addr, b.harder === true, nick);
        return send(res, 200, { run: run.id, nick: run.nick, ledger: run.ledger, checks: digits(run), own_addr: run.own_addr, persona: { name: run.persona.name, title: run.persona.title, open: run.persona.open, key: run.persona.key, harder: !!run.persona.harder }, left: MAX_MSGS });
      } catch (e) { return send(res, e.code || 500, { error: e.code ? e.message : errMsg(e) }); }
    }
    if (req.method === "POST" && url === "/api/say") {
      const b = await body(req), run = db.runs[b.run], msg = String(b.message || "").trim();
      if (!run || run.pid !== b.pid) return send(res, 404, { error: "This run has ended. Start a new one." });
      if (run.pending) return send(res, 409, { error: "Payout paused. Resume or cancel the payout before sending another message." });
      if (run.done) return send(res, 409, { error: "No messages left in this run." });
      if (msg.length > 600) return send(res, 400, { error: "Messages must be 600 characters or fewer." });
      if (!msg) return send(res, 400, { error: "Write something to the guard first." });
      return send(res, 200, await serial(run.id, () => { if (run.pending) throw Object.assign(new Error("Payout paused. Resume or cancel the payout before sending another message."), { code: 409 }); return play(run, msg); }));
    }
    if (req.method === "POST" && url === "/api/payout") {
      const b = await body(req);
      return send(res, 200, await serial(b.run, async () => {
        const run = db.runs[b.run];
        if (!run || run.pid !== b.pid || run.done || !run.pending) throw Object.assign(new Error("No pending payout"), { code: 409 });
        if (b.cancel) {
          const { msg, decision } = run.pending;
          return play(run, msg, { ...decision, d: { ...decision.d, action: "refuse", say: "Payout cancelled. No payment was requested." } });
        }
        const addr = await playerAccount(b.addr);
        if (!addr) throw Object.assign(new Error("Enter your NEAR account ID to receive payment"), { code: 400 });
        run.stash = addr; run.own_addr = true;
        return play(run, run.pending.msg, run.pending.decision);
      }));
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, e.code || 500, { error: e.code ? e.message : "Request failed. Try again shortly." }); }
}).listen(PORT, "127.0.0.1", () => console.log(`crucible game on http://127.0.0.1:${PORT}`));

// Settle delayed callbacks under the same lock as play and payout.
async function reconcile() {
  for (const intent of Object.values(db.intents)) {
    try { const detail = await recoverIntent(intent, potView); if (!detail) continue;
      db.pays[detail.payout_id] = { tx: intent.tx || null, run:intent.run, nick:db.runs[intent.run]?.nick || db.players[db.runs[intent.run]?.pid]?.nick || "Anonymous", to:intent.to, net:NET, pot:POT };
      db.pending_pays[detail.payout_id] = {run:intent.run,detail};
    } catch { /* Keep intent through RPC errors and deployment upgrades. */ }
  }
  for (const [id, pending] of Object.entries(db.pending_pays)) {
    try { await serial(pending.run, async () => {
      if (!db.pending_pays[id]) return;
      const p = await potView("get_payout", { id: +id }), run = db.runs[pending.run];
      if (!run || !p || p.status === "Pending" || p.to !== pending.detail.to) return;
      if (p.status === "Paid" && !run.won) {
        const detail = { ...pending.detail, contract: "allowed", status: "Paid", paid: true, amount: p.amount };
        run.won = detail;
        run.done = true; run.result ||= { ai: "You fooled the AI", ai_decision: "Pay PLAYER", near_tx: detail.near_tx, explorer: EXPLORER };
        run.result.near_tx = detail.near_tx; if (run.result.verification) run.result.verification.chain_tx = detail.near_tx;
        Object.assign(run.result, { contract: "The contract allowed the payment", policy_check: "All contract spending checks passed", payment: `paid ${toNear(p.amount)} NEAR to ${p.to} (NEAR ${NET}, transfer succeeded)` });
        const player_ = player(run.pid), t = Gm.tactic(run.lures.at(-1) || "");
        feedUpsert(run, player_, t.name, "win");
        const entry = db.exploits.find(e => e.run === run.id || e.near_tx === detail.near_tx);
        const win = { run: run.id, kind: "breach", day: Gm.today(), persona: "Crucible", mode: "l1", tactic: t.name, fix: t.fix, lure: run.lures.at(-1) || "", transcript: run.lures.slice(-3), result: `Paid ${toNear(p.amount)} NEAR (${NET}) to ${p.to} inside the contract limits.`, near_tx: detail.near_tx, network: NET, nick: run.nick || player_.nick };
        if (entry) Object.assign(entry, win); else db.exploits.unshift({ id: "CX-" + String(db.exploits.length + 1).padStart(3, "0"), ...win });
        const attempt = completedAttempts.get(run.id) || { ts: new Date().toISOString(), run: run.id, nick: run.nick || player(run.pid).nick, attemptId: run.id, mode: "l1", msg: run.lures.at(-1) || "", transcript: [{ role: "assistant", content: JSON.stringify({ say: run.persona.open }) }, ...run.history] };
        Object.assign(attempt, { outcome: "win", detail, result: run.result }); completedAttempts.set(run.id, attempt);
        fs.appendFileSync(DIR + "attempts.jsonl", JSON.stringify(attempt) + "\n");
      }
      if (p.status === "Failed") {
        const detail = { ...pending.detail, contract: "allowed", status: "Failed", paid: false, amount: p.amount,
          reason: "transfer failed; the contract released the limits and the NEAR stayed in the pot" };
        run.done = true;
        run.result ||= { ai: "You fooled the AI", ai_decision: "Pay PLAYER", near_tx: detail.near_tx, explorer: EXPLORER };
        run.result.near_tx = detail.near_tx; if (run.result.verification) run.result.verification.chain_tx = detail.near_tx;
        Object.assign(run.result, { contract: "The contract allowed the payment", policy_check: "All contract spending checks passed", payment: "not paid (transfer failed)" });
        feedUpsert(run, player(run.pid), Gm.tactic(run.lures.at(-1) || "").name, "broadcast-failed");
        const attempt = completedAttempts.get(run.id) || { ts: new Date().toISOString(), run: run.id, nick: run.nick || player(run.pid).nick, attemptId: run.id, mode: "l1", msg: run.lures.at(-1) || "", transcript: [{ role: "assistant", content: JSON.stringify({ say: run.persona.open }) }, ...run.history] };
        Object.assign(attempt, { outcome: "broadcast-failed", detail, result: run.result });
        completedAttempts.set(run.id, attempt);
        fs.appendFileSync(DIR + "attempts.jsonl", JSON.stringify(attempt) + "\n");
      }
      if (["Paid", "Failed"].includes(p.status)) { delete db.pending_pays[id]; delete db.intents[run.id]; pol.t = 0; proofCache.t = 0; save(); }
    }); } catch (e) { /* Keep durable intent for the next reconciliation. */ }
  }
 }
await reconcile();
setInterval(reconcile, 10000).unref();
function prune() {
 const cutoff = Date.now() - 7*86400000;
 for (const [id,r] of Object.entries(db.runs)) if (r.started < cutoff && !db.intents[id] && !Object.values(db.pending_pays).some(p=>p.run===id)) delete db.runs[id];
 for (const [id,a] of completedAttempts) if (Date.parse(a.ts)<cutoff) completedAttempts.delete(id);
 db.feed = db.feed.filter(f=>f.ts>=cutoff);
 db.exploits = db.exploits.filter(e=>e.day>=new Date(cutoff).toISOString().slice(0,10));
 const file=DIR+"attempts.jsonl";
 if (fs.existsSync(file)) { const lines=fs.readFileSync(file,"utf8").split("\n").filter(l=>{try{return Date.parse(JSON.parse(l).ts)>=cutoff}catch{return false}}); fs.writeFileSync(file,lines.join("\n")+(lines.length?"\n":""),{mode:0o600}); }
 const active = new Set(Object.values(db.runs).map(r=>r.pid)); for(const id of Object.keys(db.players)) if(!active.has(id)) delete db.players[id];
 save();
}
prune(); setInterval(prune,3600000).unref();
