export interface BotLifecycle { stop(): void | Promise<void>; }
export interface WebsiteLifecycle { dispose(): Promise<void>; }

/** The composition owns shutdown; website failures never own the Bot's lifetime. */
export function startCombinedRuntime<B extends BotLifecycle>(dependencies: {
  startBot(signal: AbortSignal): Promise<B>;
  startWebsite(bot: B, signal: AbortSignal): Promise<WebsiteLifecycle | null>;
  reportWebFailure(error: unknown): void;
}) {
  const controller = new AbortController();
  const botStartup = new AbortController();
  let bot: B | undefined;
  let website: WebsiteLifecycle | null = null;
  let stopPromise: Promise<void> | undefined;
  const ready = (async () => {
    bot = await dependencies.startBot(botStartup.signal);
    if (controller.signal.aborted) return;
    try {
      website = await dependencies.startWebsite(bot, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) dependencies.reportWebFailure(error);
    }
  })();
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    controller.abort(new Error('程序正在停止。'));
    // Abort unresolved login immediately. Once ready, Bot stop belongs after
    // website disposal, so it must not share the website's cancellation signal.
    if (!bot) botStartup.abort(controller.signal.reason);
    stopPromise = (async () => {
      // Bootstrap owns cleanup when login fails. Once returned, we own its lifetime.
      try { await ready; } catch { /* ready preserves the startup error for its caller. */ }
      try { await website?.dispose(); }
      finally { await bot?.stop(); }
    })();
    return stopPromise;
  };
  return { ready, stop, signal: controller.signal };
}
