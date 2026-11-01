// Deploy the game contract to the testnet dev account (testnet only) and init it.
import { connect, keyStores, KeyPair } from "near-api-js";
import fs from "fs";
const file = fs.readdirSync("/root/.crucible").find(f=>f.endsWith(".testnet.json"));
const cred = JSON.parse(fs.readFileSync("/root/.crucible/"+file));
if (!cred.account_id.endsWith(".testnet")) throw new Error("testnet only");
const ks = new keyStores.InMemoryKeyStore(); await ks.setKey("testnet", cred.account_id, KeyPair.fromString(cred.private_key));
const near = await connect({ networkId:"testnet", nodeUrl:"https://rpc.testnet.near.org", keyStore: ks });
const a = await near.account(cred.account_id);
console.log("balance before", (await a.getAccountBalance()).available);
const d = await a.deployContract(fs.readFileSync("../contract/target/wasm32-unknown-unknown/release/crucible_game.wasm"));
console.log("deploy tx", d.transaction.hash);
const i = await a.functionCall({contractId:a.accountId, methodName:"new", args:{owner:a.accountId, agent:a.accountId, mpc:"v1.signer-prod.testnet", cooldown_secs:120}, gas:100000000000000n});
console.log("init tx", i.transaction.hash);
console.log("state", JSON.stringify(await a.viewFunction({contractId:a.accountId, methodName:"get_state", args:{}})));
