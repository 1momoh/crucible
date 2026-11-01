// Testnet e2e: caps -> round -> session -> propose_payment (contract calls MPC) -> signature stored; then an over-cap call must fail.
import { connect, keyStores, KeyPair } from "near-api-js";
import { keccak256, toHex } from "viem";
import fs from "fs";
const file = fs.readdirSync("/root/.crucible").find(f=>f.endsWith(".testnet.json"));
const cred = JSON.parse(fs.readFileSync("/root/.crucible/"+file));
const ks = new keyStores.InMemoryKeyStore(); await ks.setKey("testnet", cred.account_id, KeyPair.fromString(cred.private_key));
const near = await connect({ networkId:"testnet", nodeUrl:"https://rpc.testnet.near.org", keyStore: ks });
const a = await near.account(cred.account_id); const C=a.accountId; const G=300000000000000n;
const call=(m,args,dep=0n)=>a.functionCall({contractId:C,methodName:m,args,gas:G,attachedDeposit:dep});
const st = await a.viewFunction({contractId:C,methodName:"get_state",args:{}});
if(!st.round_open){
 await call("set_caps",{chain:"eth",caps:{per_tx:10000000000000000,per_day:30000000000000000,total:50000000000000000,max_tx_per_day:3}});
 await call("add_vendor",{chain:"eth",addr:"0x1111111111111111111111111111111111111111"});
 await call("open_round",{});
}
const s = await call("register_session",{attack_addrs:[["eth","0x2222222222222222222222222222222222222222"]],payout:{asset_id:"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",recipient:"0x2222222222222222222222222222222222222222"}});
const sid = JSON.parse(Buffer.from(s.status.SuccessValue,"base64").toString()); console.log("session", sid, "tx", s.transaction.hash);
const payload = keccak256(toHex("crucible e2e vendor invoice INV-1 "+Date.now())).slice(2);
const p = await call("propose_payment",{session_id:sid,chain:"eth",to:"0x1111111111111111111111111111111111111111",amount:5000000000000000,invoice_ref:"INV-1",reason:"approved vendor invoice",payload_hex:payload,path:"ethereum-1"});
console.log("propose_payment tx", p.transaction.hash, "result", Buffer.from(p.status.SuccessValue??"","base64").toString());
console.log("payment", JSON.stringify(await a.viewFunction({contractId:C,methodName:"get_payment",args:{id:0}})).slice(0,400));
try { await call("propose_payment",{session_id:sid,chain:"eth",to:"0x1111111111111111111111111111111111111111",amount:20000000000000000,invoice_ref:"INV-2",reason:"x",payload_hex:payload,path:"ethereum-1"}); console.log("UNEXPECTED: over-cap passed"); }
catch(e){ console.log("over-cap rejected:", (e.message||"").match(/cooldown|per-tx cap|Smart contract panicked: [^"]+/)?.[0]); }
