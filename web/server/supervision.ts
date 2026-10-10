import type { ChildProcess } from 'node:child_process';
import type { SupervisorConfig } from './config/index.js';

/** Run outside the Bot process so a blocked event loop cannot block its watchdog. */
export function superviseProcess(options: SupervisorConfig & {
  spawnChild(): ChildProcess;
  terminate(child: ChildProcess, signal: NodeJS.Signals): void;
  report(event: 'started' | 'stalled' | 'exited' | 'budget-exhausted'): void;
}) {
  let child: ChildProcess | undefined;
  let stopped = false;
  let terminating = false;
  let startedAt = 0;
  let heartbeatAt = 0;
  let checkTimer: ReturnType<typeof setInterval> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let stopResolve: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  const restarts: number[] = [];
  let doneResolve!: (reason: 'stopped' | 'budget-exhausted') => void;
  const done = new Promise<'stopped' | 'budget-exhausted'>(resolve => { doneResolve = resolve; });

  function clearTimers() {
    if (checkTimer) clearInterval(checkTimer);
    if (killTimer) clearTimeout(killTimer);
    checkTimer = undefined;
    killTimer = undefined;
  }
  function terminate() {
    if (!child || terminating) return;
    terminating = true;
    const current = child;
    options.terminate(current, 'SIGTERM');
    killTimer = setTimeout(() => {
      if (child === current) options.terminate(current, 'SIGKILL');
    }, options.killGraceMs);
  }
  function start() {
    if (stopped) return;
    startedAt = Date.now();
    heartbeatAt = 0;
    terminating = false;
    try { child = options.spawnChild(); }
    catch { handleExit(); return; }
    const current = child;
    options.report('started');
    current.on('message', message => {
      if (child === current && message && typeof message === 'object' &&
          (message as { type?: unknown }).type === 'cirno:heartbeat') heartbeatAt = Date.now();
    });
    current.once('error', () => {
      if (child === current && !current.pid) handleExit();
    });
    // close follows exit after the IPC channel and output descriptors have closed.
    current.once('close', () => { if (child === current) handleExit(); });
    checkTimer = setInterval(() => {
      if (terminating || !child) return;
      const now = Date.now();
      if (heartbeatAt ? now - heartbeatAt > options.stallMs : now - startedAt > options.startupGraceMs) {
        options.report('stalled');
        terminate();
      }
    }, Math.max(10, Math.min(1000, Math.floor(options.stallMs / 4))));
  }
  function handleExit() {
    clearTimers();
    child = undefined;
    terminating = false;
    if (stopped) {
      stopResolve?.();
      doneResolve('stopped');
      return;
    }
    options.report('exited');
    const now = Date.now();
    while (restarts.length && restarts[0]! < now - 3600000) restarts.shift();
    if (restarts.length >= options.maxRestartsPerHour) {
      stopped = true;
      options.report('budget-exhausted');
      doneResolve('budget-exhausted');
      return;
    }
    restarts.push(now);
    restartTimer = setTimeout(() => { restartTimer = undefined; start(); }, options.restartDelayMs);
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;
    stopPromise = new Promise(resolve => {
      stopResolve = resolve;
      if (child) terminate();
      else { clearTimers(); resolve(); doneResolve('stopped'); }
    });
    return stopPromise;
  }
  start();
  return { stop, done };
}
