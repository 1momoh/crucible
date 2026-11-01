// Dev check: plays Vault Heist through the real web API with the starter options until Crucible opens (or tries run out).
const B = "http://127.0.0.1:8790", pid = "devtest-" + Date.now().toString(36);
const post = (u, b) => fetch(B + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
for (let k = 0; k < +(process.argv[2] || 4); k++) {
  const run = await post("/api/run", { pid, nick: process.argv[3] || "crucible-dev" }); if (run.error) { console.log(run.error); break; }
  const msg = run.starters[run.starters.length - 1];
  const r = await post("/api/submit", { pid, run: run.run, msg });
  console.log(JSON.stringify({ run: run.run, msg, outcome: r.outcome, say: r.say, reason: r.reason, detail: r.detail, model: r.model, attested: r.attested, chat_id: r.chat_id }));
  if (r.outcome === "win" || r.outcome === "broadcast-failed") break;
}
