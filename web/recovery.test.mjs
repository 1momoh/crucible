import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverIntent } from './recovery.mjs';
test('lost submission response recovers by ref without rebroadcast', async () => {
 const intent = JSON.parse(JSON.stringify({run:'run1',to:'a.testnet',status:'submitting'}));
 for (const status of ['Pending','Paid','Failed']) {
 const p = await recoverIntent(intent, async (method,args) => { assert.equal(method,'get_payment_by_ref'); assert.equal(args.game_ref,'run1'); return {id:3,to:'a.testnet',game_ref:'run1',amount:'500',status}; });
 assert.equal(p.status,status); assert.equal(p.payout_id,3);
 }
});
test('missing, mismatched and unavailable records preserve ambiguity', async () => {
 const i={run:'r',to:'a.testnet'};
 assert.equal(await recoverIntent(i,async()=>null),null);
 assert.equal(await recoverIntent(i,async()=>({to:'b.testnet',game_ref:'r'})),null);
 await assert.rejects(recoverIntent(i,async()=>{throw Error('offline')}));
});

test('persist intent before broadcasting and preserve it after an RPC error', async () => {
 const { submitIntent } = await import('./recovery.mjs');
 const intents={}; let disk, broadcasts=0;
 await assert.rejects(submitIntent(intents,'r','a.testnet',()=>{disk=JSON.parse(JSON.stringify(intents))},async()=>{
  broadcasts++; assert.equal(disk.r.status,'submitting'); assert.equal(disk.r.to,'a.testnet'); throw Error('response lost');
 }));
 assert.equal(disk.r.run,'r');
 await assert.rejects(submitIntent(intents,'r','a.testnet',()=>{},async()=>{broadcasts++}));
 assert.equal(broadcasts,1);
});
test('failed durable write prevents broadcast; transaction hash persists on success', async () => {
 const { submitIntent } = await import('./recovery.mjs'); let calls=0;
 await assert.rejects(submitIntent({},'r','a.testnet',()=>{throw Error('disk full')},async()=>{calls++}));
 assert.equal(calls,0);
 const intents={};let snapshot;
 await submitIntent(intents,'s','a.testnet',()=>{snapshot=JSON.parse(JSON.stringify(intents))},async()=>({transaction:{hash:'tx'}}));
 assert.equal(snapshot.s.tx,'tx');
});

test('executed failures resolve the intent; uncertain errors retain it', async () => {
 const { submitIntent } = await import('./recovery.mjs');
 for (const broadcast of [
  async()=>({transaction:{hash:'rejected'},status:{Failure:{ActionError:{}}}}),
  async()=>{throw Object.assign(Error('Smart contract panicked: paused'),{context:{transactionHash:'rejected'}})},
 ]) {
  const intents={}; let snapshot;
  await assert.rejects(submitIntent(intents,'r','a.testnet',()=>{snapshot=structuredClone(intents)},broadcast),e=>e.definitiveFailure===true);
  assert.equal(intents.r,undefined); assert.equal(snapshot.r,undefined);
 }
 const intents={};
 await assert.rejects(submitIntent(intents,'r','a.testnet',()=>{},async()=>{throw Object.assign(Error('timeout'),{context:{transactionHash:'uncertain'}})}));
 assert.equal(intents.r.status,'submitting');
});
