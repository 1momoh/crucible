import { KeyPair } from "near-api-js";
import fs from "fs";
const id = process.argv[2];
const kp = KeyPair.fromRandom("ed25519");
const r = await fetch("https://helper.testnet.near.org/account",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({newAccountId:id,newAccountPublicKey:kp.getPublicKey().toString()})});
console.log("helper status", r.status, (await r.text()).slice(0,200));
if (r.ok){ fs.mkdirSync("/root/.crucible",{recursive:true,mode:0o700}); fs.writeFileSync(`/root/.crucible/${id}.json`,JSON.stringify({account_id:id,public_key:kp.getPublicKey().toString(),private_key:kp.toString()}),{mode:0o600}); console.log("key saved (not printed)"); }
