import { loadAccount } from "./lib.mjs"; import fs from "fs";
const a = await loadAccount();
const d = await a.deployContract(fs.readFileSync("../contract/target/near/crucible_game.wasm"));
console.log("redeploy tx", d.transaction.hash);
console.log(JSON.stringify(await a.viewFunction({contractId:a.accountId,methodName:"get_state",args:{}})));
