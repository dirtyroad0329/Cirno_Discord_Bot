import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseProcess } from '../../server/supervision.js';

const limits = { stallMs: 200, startupGraceMs: 1200, restartDelayMs: 20, killGraceMs: 100, maxRestartsPerHour: 2 };
const healthy = "setInterval(()=>process.send({type:'cirno:heartbeat'}),40);";
function child(code: string) { return spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); }
const terminate = (process: ReturnType<typeof child>, signal: NodeJS.Signals) => { process.kill(signal); };

test('website-only failures retain process heartbeats and do not restart the healthy Bot process', async t => {
  let spawned = 0;
  const events: string[] = [];
  const supervisor = superviseProcess({ ...limits, terminate, report: event => events.push(event), spawnChild() {
    spawned++;
    return child(`${healthy} Promise.reject(new Error('handled web failure')).catch(()=>{});`);
  } });
  t.after(() => supervisor.stop());
  await delay(600);
  assert.equal(spawned, 1);
  assert.deepEqual(events, ['started']);
  const stopping = supervisor.stop();
  assert.equal(supervisor.stop(), stopping);
  await stopping;
  assert.equal(await supervisor.done, 'stopped');
});

test('external watchdog detects a real blocked event loop, waits for exit, and restarts only one child', async t => {
  let spawned = 0;
  const events: string[] = [];
  const supervisor = superviseProcess({ ...limits, terminate, report: event => events.push(event), spawnChild() {
    spawned++;
    return child(spawned === 1 ? `${healthy} setTimeout(()=>{while(true){}},80);` : healthy);
  } });
  t.after(() => supervisor.stop());
  for (let i = 0; i < 100 && spawned < 2; i++) await delay(20);
  assert.equal(spawned, 2);
  await delay(350);
  assert.equal(spawned, 2);
  assert.equal(events.filter(event => event === 'stalled').length, 1);
  await supervisor.stop();
});

test('uncaught child errors exhaust a bounded restart budget rather than loop forever', async () => {
  let spawned = 0;
  const supervisor = superviseProcess({ ...limits, terminate, report() {}, spawnChild() {
    spawned++;
    return child("throw new Error('synthetic fatal error');");
  } });
  assert.equal(await supervisor.done, 'budget-exhausted');
  assert.equal(spawned, 3);
  await supervisor.stop();
});
