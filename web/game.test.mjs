import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('AI concurrency slot covers body reading and releases after body errors', async () => {
  const source = fs.readFileSync(new URL('./game.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function cloudFetch(');
  const end = source.indexOf('// Ledger', start);
  let finishBody;
  const context = {
    Date, Error, JSON, budget: {}, active: 0, concurrent: 1, daily: 100,
    budgetFile: '/unused', path: { dirname: () => '/unused' },
    fs: { mkdirSync() {}, writeFileSync() {}, renameSync() {} },
    fetch: async () => ({ ok: true, status: 200,
      text: () => new Promise((resolve, reject) => { finishBody = { resolve, reject }; }) }),
  };
  const cloudFetch = new Function(...Object.keys(context), source.slice(start, end) + "return cloudFetch;")(...Object.values(context));
  const first = cloudFetch('unused');
  await Promise.resolve();
  await assert.rejects(cloudFetch('unused'), /Guard busy/);
  finishBody.resolve('{"ok":true}');
  assert.equal((await (await first).json()).ok, true);
  const second = cloudFetch('unused');
  await Promise.resolve();
  finishBody.reject(Error('body interrupted'));
  await assert.rejects(second, /body interrupted/);
  const third = cloudFetch('unused');
  await Promise.resolve();
  finishBody.resolve('{}');
  await third;
});
