import test from 'node:test';
import assert from 'node:assert/strict';
import { startCombinedRuntime } from '../../server/runtime.js';

test('website startup failure leaves the healthy Bot alive, then full stop disposes it once', async () => {
  let stopped = 0;
  const failures: unknown[] = [];
  const runtime = startCombinedRuntime({
    async startBot() { return { stop() { stopped++; } }; },
    async startWebsite() { throw new Error('listener failed'); },
    reportWebFailure(error) { failures.push(error); },
  });
  await runtime.ready;
  assert.equal(stopped, 0);
  assert.equal(failures.length, 1);
  const stop = runtime.stop();
  assert.equal(runtime.stop(), stop);
  await stop;
  assert.equal(stopped, 1);
});

test('web cleanup failure still stops the Bot and does not repeat either cleanup', async () => {
  const calls: string[] = [];
  const runtime = startCombinedRuntime({
    async startBot() { return { stop() { calls.push('bot'); } }; },
    async startWebsite() { return { async dispose() { calls.push('web'); throw new Error('cleanup failed'); } }; },
    reportWebFailure() { assert.fail('no startup error'); },
  });
  await runtime.ready;
  await assert.rejects(runtime.stop(), /cleanup failed/);
  await assert.rejects(runtime.stop(), /cleanup failed/);
  assert.deepEqual(calls, ['web', 'bot']);
});

test('stop during delayed bootstrap passes cancellation and never starts the website', async () => {
  let stopCount = 0;
  let signal: AbortSignal | undefined;
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const runtime = startCombinedRuntime({
    async startBot(value) { signal = value; await wait; return { stop() { stopCount++; } }; },
    async startWebsite() { assert.fail('web must not start after abort'); },
    reportWebFailure() { assert.fail('abort is not a web failure'); },
  });
  const stopped = runtime.stop();
  assert.equal(signal?.aborted, true);
  finish();
  await stopped;
  assert.equal(stopCount, 1);
});

test('stop while website starts waits for its acquired resources and closes web before Bot', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const runtime = startCombinedRuntime({
    async startBot() { return { stop() { calls.push('bot'); } }; },
    async startWebsite() { started(); await waiting; return { async dispose() { calls.push('web'); } }; },
    reportWebFailure() { assert.fail('no startup error'); },
  });
  await admitted;
  const stopping = runtime.stop();
  finish();
  await stopping;
  assert.deepEqual(calls, ['web', 'bot']);
});

test('ready Bot startup signal is not aborted before website cleanup', async () => {
  const calls: string[] = [];
  let botSignal!: AbortSignal;
  const runtime = startCombinedRuntime({
    async startBot(signal) {
      botSignal = signal;
      signal.addEventListener('abort', () => { calls.push('early-bot-stop'); });
      return { stop() { calls.push('bot'); } };
    },
    async startWebsite() {
      return { async dispose() { assert.equal(botSignal.aborted, false); calls.push('web'); } };
    },
    reportWebFailure() { assert.fail('no startup error'); },
  });
  await runtime.ready;
  await runtime.stop();
  assert.deepEqual(calls, ['web', 'bot']);
});
