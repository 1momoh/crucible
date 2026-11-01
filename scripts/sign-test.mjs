// Derive a Sepolia address from v1.signer-prod.testnet and do a real MPC sign request, then verify by ecrecover.
import { connect, keyStores, KeyPair } from "near-api-js";
import { keccak256, toHex, recoverAddress, serializeSignature } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import fs from "fs";
const file = fs.readdirSync("/root/.crucible").find(f=>f.endsWith(".testnet.json"));
const cred = JSON.parse(fs.readFileSync("/root/.crucible/"+file));
const ks = new keyStores.InMemoryKeyStore(); await ks.setKey("testnet", cred.account_id, KeyPair.fromString(cred.private_key));
const near = await connect({ networkId:"testnet", nodeUrl:"https://rpc.testnet.near.org", keyStore: ks });
const acct = await near.account(cred.account_id);
const MPC="v1.signer-prod.testnet", path="ethereum-1";
const pk = await acct.viewFunction({contractId:MPC, methodName:"derived_public_key", args:{path, predecessor:cred.account_id, domain_id:0}});
console.log("account", cred.account_id, "derived pk", pk);
const bs58 = (await import("bs58")).default;
const raw = bs58.decode(pk.split(":")[1]); // 64 bytes uncompressed w/o prefix
const addr = publicKeyToAddress(toHex(new Uint8Array([4,...raw])));
console.log("Sepolia address", addr);
const hash = keccak256(toHex("crucible sign test "+new Date().toISOString()));
const t0=Date.now();
const res = await acct.functionCall({contractId:MPC, methodName:"sign", args:{request:{payload_v2:{Ecdsa:hash.slice(2)}, path, domain_id:0}}, gas:300000000000000n, attachedDeposit:1n});
console.log("sign tx", res.transaction.hash, "latency_ms", Date.now()-t0);
const sv = res.status.SuccessValue; const sig = JSON.parse(Buffer.from(sv,"base64").toString());
const r="0x"+sig.big_r.affine_point.slice(2), s="0x"+sig.s.scalar;
const rec = await recoverAddress({hash, signature: serializeSignature({r,s,yParity:sig.recovery_id})});
console.log("recovered", rec, "match", rec.toLowerCase()===addr.toLowerCase());
fs.writeFileSync("/root/crucible/scripts/sign-test-result.json", JSON.stringify({account:cred.account_id,path,derived_pk:pk,sepolia_address:addr,payload:hash,tx:res.transaction.hash,recovered:rec},null,2));
