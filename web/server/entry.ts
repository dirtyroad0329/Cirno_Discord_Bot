import { config as loadBotEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findWebRoot, WebConfigurationError } from './config/index.js';
import { startCombinedRuntime } from './runtime.js';

const webRoot = findWebRoot();
const botRoot = resolve(webRoot, '..');
// Existing logger and local audio paths expect the Bot root before any Bot import.
process.chdir(botRoot);
loadBotEnvironment({ path: resolve(botRoot, '.env'), quiet: true });

// This is process liveness, not website availability. A website-only failure
// must not cause the external supervisor to restart a healthy Bot.
const heartbeat = process.send ? setInterval(() => {
  if (process.connected) process.send?.({ type: 'cirno:heartbeat' }, () => {});
}, 1000) : null;
heartbeat?.unref();

const bootstrapUrl = pathToFileURL(resolve(botRoot, 'dist/app/bootstrap.js')).href;
const musicUrl = pathToFileURL(resolve(botRoot, 'dist/features/music/api.js')).href;
type BotModule = typeof import('../../dist/app/bootstrap.js');
type MusicModule = typeof import('../../dist/features/music/api.js');

const runtime = startCombinedRuntime({
  async startBot(signal) {
    const { startBot } = await import(bootstrapUrl) as BotModule;
    return startBot({ handleSignals: false, signal });
  },
  async startWebsite(bot, signal) {
    signal.throwIfAborted();
    const { loadWebConfig } = await import('./config/index.js');
    // Disabled mode needs neither website dependencies nor a music_server connection.
    if (!loadWebConfig({ webRoot }).enabled) return null;
    const { createMusicController } = await import(musicUrl) as MusicModule;
    const controller = createMusicController(bot.client);
    const config = loadWebConfig({ webRoot, backend: controller.backendSettings(), requireBackend: true });
    const [{ openAuthService }, { createWebApp }] = await Promise.all([
      import('./auth/service.js'), import('./app.js'),
    ]);
    signal.throwIfAborted();
    const auth = await openAuthService({ dbPath: config.authDbPath });
    let app: Awaited<ReturnType<typeof createWebApp>> | undefined;
    let disposePromise: Promise<void> | undefined;
    const dispose = () => disposePromise ??= (async () => {
      try { await app?.close(); } finally { await auth.close(); }
    })();
    try {
      signal.throwIfAborted();
      app = await createWebApp({ config, auth, bot: controller, logger: true });
      signal.throwIfAborted();
      await app.listen({ host: config.host, port: config.port });
      signal.throwIfAborted();
      console.info(`Cirno 網站已啟動：${config.publicOrigin}`);
      return { dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  },
  reportWebFailure(error) {
    // Messages from known configuration/auth errors are safe; never dump arbitrary causes.
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.error(`網站啟動失敗（${name}）；Bot 繼續運行。請檢查 web/.env、網站依賴與認證資料庫。`);
    if (error instanceof WebConfigurationError) console.error(error.message);
  },
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void runtime.stop().catch(() => {
    console.error('程序清理失敗；請檢查服務管理器與網站資源。');
    process.exitCode = 1;
  }).finally(() => {
    if (heartbeat) clearInterval(heartbeat);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try { await runtime.ready; }
catch {
  console.error('Bot 啟動失敗；請檢查根目錄 Bot 設定及建置產物。');
  process.exitCode = 1;
  stop();
}
