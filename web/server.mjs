// Crucible player UI + API. Binds 127.0.0.1 only (not public yet).
import http from "http"; import fs from "fs";
import { loadAccount, view, GAME, G, errMsg } from "../scripts/lib.mjs";
import { client, TREASURY } from "../scripts/evm.mjs";
import { payout } from "../scripts/intents.mjs";
import { decide, act } from "../agent/orchestrator.mjs";
const PORT = +process.env.PORT || 8790, LOG = "/root/crucible/web/attempts.jsonl";
const BTC = JSON.parse(fs.readFileSync("/root/crucible/scripts/btc-pubkey.json")).address;
const owner = await loadAccount();
const attempts = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
let busy = Promise.resolve(); const serial = f => (busy = busy.then(f, f));
let cache = { t: 0 };
async function state() {
  if (Date.now() - cache.t < 8000) return cache.v;
  const [s, eth, btc, se, sb, wins, wei, utxos] = await Promise.all([view(owner, "get_state"), view(owner, "get_chain", { chain: "eth" }), view(owner, "get_chain", { chain: "btc" }),
    view(owner, "get_spend", { chain: "eth" }), view(owner, "get_spend", { chain: "btc" }), view(owner, "get_wins"), client.getBalance({ address: TREASURY }),
    fetch(`https://mempool.space/testnet4/api/address/${BTC}/utxo`).then(r => r.json()).catch(() => [])]);
  const payments = await view(owner, "get_payments", { from: Math.max(0, s.payments - 15), limit: 15 });
  cache = { t: Date.now(), v: { game: s, treasury: { eth: { address: TREASURY, wei: wei.toString() }, btc: { address: BTC, sats: utxos.reduce((a, u) => a + u.value, 0) } },
    caps: { eth: eth[1], btc: btc[1] }, spend: { eth: se, btc: sb }, wins, payments: payments.map(({ signature, unsigned_hex, payload_hex, ...p }) => ({ ...p, signed: !!signature })) } };
  return cache.v;
}
const body = req => new Promise(r => { let d = ""; req.on("data", c => (d += c, d.length > 1e4 && req.destroy())); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
const send = (res, code, obj, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(type === "application/json" ? JSON.stringify(obj) : obj); };
http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) return send(res, 200, fs.readFileSync(new URL("./index.html", import.meta.url)), "text/html");
    if (req.url === "/api/state") return send(res, 200, { ...(await state()), attempts: attempts.slice(-30).reverse() });
    if (req.method === "POST" && req.url === "/api/session") {
      const b = await body(req);
      if (!/^0x[0-9a-fA-F]{40}$/.test(b.attack_eth || "")) return send(res, 400, { error: "attack address must be a 0x… EVM address" });
      // Server sponsors gas so players never need a wallet.
      const r = await serial(() => owner.functionCall({ contractId: GAME, methodName: "register_session", gas: G,
        args: { attack_addrs: [["eth", b.attack_eth.toLowerCase()]], payout: { asset_id: String(b.payout_asset || "usdc-base").slice(0, 80), recipient: String(b.payout_recipient || b.attack_eth).slice(0, 100) } } }));
      const id = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString());
      return send(res, 200, { session_id: id, near_tx: r.transaction.hash });
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const b = await body(req); const msg = String(b.message || "").slice(0, 2000);
      if (!msg || typeof b.session_id !== "number") return send(res, 400, { error: "session_id and message required" });
      const out = await serial(async () => {
        const d = await decide(msg, (b.history || []).slice(-6).map(h => ({ role: h.role === "agent" ? "assistant" : "user", content: String(h.content).slice(0, 1000) })));
        const result = await act(b.session_id, d.decision, { live: process.env.LIVE !== "0" });
        let win = null;
        if (result.is_win) { cache.t = 0; const w = (await view(owner, "get_wins")).at(-1); win = { ...w, payout: await payout(w, 10n ** 24n) }; }
        const a = { ts: new Date().toISOString(), session_id: b.session_id, message: msg.slice(0, 300), provider: d.provider, decision: d.decision, result, win };
        attempts.push(a); fs.appendFileSync(LOG, JSON.stringify(a) + "\n"); cache.t = 0;
        return a;
      });
      return send(res, 200, out);
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: errMsg(e) }); }
}).listen(PORT, "127.0.0.1", () => console.log(`crucible web on http://127.0.0.1:${PORT}`));
