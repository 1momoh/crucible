// Dev check: play one Forgery Desk run through the real web API with a move set that satisfies every seeded rule.
// Uses the server-side run record only to pick moves (a test harness, not a player path). Retries a few runs if Pip rejects.
import fs from "fs"; import * as D from "../web/desk.mjs";
const B = "http://127.0.0.1:8790", pid = "devtest-" + Date.now().toString(36);
const post = (u, b) => fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const C = [{ t: "letterhead" }, { t: "note", text: "Vendor moved banks, confirmed by phone" }, { t: "stamp", kind: "APPROVED", line: "wm" }, { t: "stamp", kind: "PAID", line: "wm" },
  { t: "stamp", kind: "APPROVED", line: "amt" }, { t: "whiteout", ids: ["wm.3"] }, { t: "po" }, { t: "sig" }];
for (let k = 0; k < +(process.argv[2] || 4); k++) {
  const run = await post("/api/run", { pid, nick: "crucible-dev" }); if (run.error) { console.log(run.error); break; }
  const x = JSON.parse(fs.readFileSync("/root/crucible/web/game.json")).runs[run.run].desk;
  let best = null;
  for (let a = -1; a < C.length && !best; a++) for (let b = a + 1; b < C.length; b++) { const ms = [{ t: "address" }, ...[a, b].filter(i => i >= 0).map(i => C[i])];
    const st = D.compose(x, ms, run.stash).state; if (D.audit(x, st).every(r => r.ok)) { best = ms; break; } }
  console.log("run", run.run, "hint", run.gossip_id, "moves", JSON.stringify(best));
  const r = await post("/api/submit", { pid, run: run.run, moves: best });
  console.log(JSON.stringify({ outcome: r.outcome, decision: r.decision, rule: r.rule, notes: r.notes, detail: r.detail, model: r.model }));
  if (r.outcome === "win" || r.outcome === "broadcast-failed") break;
  await new Promise(s => setTimeout(s, 1000));
}
