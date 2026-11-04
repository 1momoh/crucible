// Never rebroadcast an ambiguous submission. The contract reference is authoritative.
export async function recoverIntent(intent, view) {
  const p = await view('get_payment_by_ref', { game_ref: intent.run });
  if (!p || p.to !== intent.to || p.game_ref !== intent.run) return null;
  return { payout_id: p.id, to: p.to, amount: p.amount, status: p.status, near_tx: intent.tx || null };
}

export async function submitIntent(intents, run, to, persist, broadcast) {
  if (intents[run]) throw new Error('Payout already submitted; awaiting reconciliation.');
  intents[run] = {run,to,status:'submitting',ts:Date.now()};
  persist(); // A persistence error must prevent broadcast.
  let result;
  try {
    result = await broadcast();
    if (result.status?.Failure) {
      throw Object.assign(new Error('Transaction executed with failure'), {
        definitiveFailure: true, context: { transactionHash: result.transaction?.hash },
      });
    }
  } catch (error) {
    // Execution errors with a transaction hash prove rejection. Timeouts, RPC
    // failures and lost responses must remain durable for reconciliation.
    if (error.definitiveFailure || (error.context?.transactionHash &&
        (['ActionError', 'FunctionCallError', 'FunctionCallExecutionError', 'GuestPanic', 'HostError', 'ExecutionError'].includes(error.type) ||
         /Smart contract panicked:/.test(error.message || '')))) {
      error.definitiveFailure = true;
      delete intents[run];
      persist();
    }
    throw error;
  }
  intents[run].tx = result.transaction.hash;
  persist();
  return result;
}
