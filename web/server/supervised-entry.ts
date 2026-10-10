import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSupervisorConfig } from './config/index.js';
import { superviseProcess } from './supervision.js';

const entry = fileURLToPath(new URL('./entry.js', import.meta.url));
const supervisor = superviseProcess({
  ...loadSupervisorConfig(),
  spawnChild() {
    return spawn(process.execPath, [entry], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'], detached: process.platform !== 'win32', env: process.env,
    });
  },
  terminate(child, signal) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal); // Include audio child processes in this program's process group.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  },
  report(event) {
    const messages = {
      started: '已啟動唯一 Bot＋網站程序。',
      stalled: '程序心跳逾時，將停止並重新啟動；語音播放會中斷。',
      exited: '程序已退出，準備依限頻規則重啟。',
      'budget-exhausted': '程序重啟次數超出每小時限制，停止重試；請檢查設定與故障原因。',
    };
    console.info(messages[event]);
  },
});
const stop = () => { void supervisor.stop().catch(() => { process.exitCode = 1; }); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const result = await supervisor.done;
process.off('SIGINT', stop);
process.off('SIGTERM', stop);
// EX_CONFIG-style exit lets the service manager avoid resetting our retry budget.
if (result === 'budget-exhausted') process.exitCode = 78;
