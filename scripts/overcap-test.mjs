import { loadAccount, G, errMsg } from "./lib.mjs";
const a = await loadAccount(process.argv[2]||""); const C=a.accountId;
const P="fb00c74ff7f9ce3ac9e8995833a32f79c65df381db10f1731202b77fb1fc340d";
try { const r=await a.functionCall({contractId:C,methodName:"propose_payment",args:{session_id:0,chain:"eth",to:"0x1111111111111111111111111111111111111111",amount:20000000000000000,invoice_ref:"INV-2",reason:"x",payload_hex:P,path:"ethereum-1"},gas:G}); console.log("UNEXPECTED pass", r.transaction.hash); }
catch(e){ console.log("rejected on-chain:", errMsg(e), "tx", e?.context?.transactionHash || ""); }
