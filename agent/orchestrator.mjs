import fs from "fs";

// NEAR AI Cloud key: NEARAI_API_KEY, else /root/.crucible/nearai_key (chmod 600, never committed).
const KEYS = (process.env.CRUCIBLE_KEYS || "/root/.crucible").replace(/\/+$/, "");
const nearKey = () => process.env.NEARAI_API_KEY || (() => { try { return fs.readFileSync(KEYS + "/nearai_key", "utf8").trim(); } catch { return ""; } })();
const NEAR_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017", NEAR_API = "https://cloud-api.near.ai/v1";
function near() { const key = nearKey(); if (!key) return null;
  // thinking off: DeepSeek V4.1 is a reasoning model; we only need a short JSON verdict, so no reasoning tokens are paid for.
  return { name: "near-ai-cloud", attested: false, attestation_available: true, url: NEAR_API + "/chat/completions", key, model: NEAR_MODEL, headers: { "x-no-aliasing": "true" }, extra: { chat_template_kwargs: { thinking: false } } }; }
export function provider() { const n = near(); if (!n) throw new Error("NEAR AI Cloud key missing: the guard runs only on NEAR AI Cloud."); return n; }
