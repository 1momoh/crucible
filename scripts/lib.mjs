export const errMsg = e => (e?.message || String(e)).match(/Smart contract panicked: [^"\\]+|unreachable/)?.[0] || (e?.message||"").slice(0,200);
