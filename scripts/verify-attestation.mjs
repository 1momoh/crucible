// Read-only receipt retrieval, not cryptographic attestation verification.
import { randomBytes, createHash } from 'node:crypto';
import { NEAR_MODEL } from '../agent/orchestrator.mjs';
const url = new URL('https://cloud-api.near.ai/v1/attestation/report');
url.search = new URLSearchParams({model:NEAR_MODEL,signing_algo:'ecdsa',nonce:randomBytes(32).toString('hex')});
try {
 const response = await fetch(url,{signal:AbortSignal.timeout(15000)});
 const body = await response.text();
 let json=false;try{JSON.parse(body);json=true}catch{}
 console.log(JSON.stringify({provider:'NEAR AI Cloud',model:NEAR_MODEL,http_status:response.status,report_received:response.ok&&json,sha256:createHash('sha256').update(body).digest('hex'),verification:'Not verified: report retrieval does not validate signatures, measurements, or request binding.'},null,2));
 if(!response.ok||!json)process.exitCode=1;
} catch { console.log('Attestation endpoint unavailable. Verification: not verified.');process.exitCode=1; }
