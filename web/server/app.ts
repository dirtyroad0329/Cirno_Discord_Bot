import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { AuthError, createAuthHttp, type AuthService } from './auth/index.js';
import type { WebConfig } from './config/index.js';
import { registerAudio } from './catalog/audio.js';
import { registerCatalog } from './catalog/routes.js';
import { registerPlaylists } from './playlists/routes.js';
import { registerPlayback, type MusicControlPort, type PlaylistResolver } from './playback/routes.js';
import { MusicClient } from './integrations/music.js';
import { WebError } from './http/errors.js';

export interface WebAppOptions {
  config: WebConfig;
  auth: AuthService;
  bot: MusicControlPort;
  fetch?: typeof fetch;
  resolvePlaylist?: PlaylistResolver;
  logger?: boolean;
}
const playbackStatus: Record<string, number> = {
  GATEWAY_UNAVAILABLE: 503, VOICE_REQUIRED: 403, FORBIDDEN: 403,
  STALE_SESSION: 409, STALE_TRACK: 409, STALE_QUEUE: 409, REQUEST_EXPIRED: 504, INVALID_COMMAND: 400,
};

/** The composition owner owns Bot/auth lifetimes. Closing this app closes website resources only. */
export async function createWebApp(options: WebAppOptions): Promise<FastifyInstance> {
  const { config, auth, bot } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: config.bodyLimit,
    requestTimeout: 30_000, connectionTimeout: 15_000, maxRequestsPerSocket: 1000,
    ajv: { customOptions: { removeAdditional: false } } });
  const music = new MusicClient({ baseUrl: config.musicApiUrl, token: config.musicApiToken,
    timeoutMs: config.apiTimeoutMs, fetch: options.fetch });
  const guard = createAuthHttp(auth, { publicOrigin: config.publicOrigin, secureCookies: config.secureCookies });
  const dispose: Array<() => void> = [() => music.dispose()];
  app.setErrorHandler((error, request, reply) => {
    reply.header('cache-control', 'no-store');
    if (error instanceof WebError || error instanceof AuthError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    const known = error as { code?: string; message?: string; statusCode?: number; name?: string; validation?: unknown };
    const code = known.code;
    if (code && playbackStatus[code]) return reply.code(playbackStatus[code]).send({ error: known.message ?? '播放器操作失敗。', code });
    if (known.name === 'UserActionError') {
      return reply.code(400).send({ error: known.message ?? '播放器操作無效。', code: 'INVALID_COMMAND' });
    }
    if (known.name === 'ConfigurationError') {
      const guidance = known.message?.startsWith('Bot 需要') ? known.message : 'Bot 的播放設定或語音權限需要管理者檢查。';
      return reply.code(503).send({ error: guidance, code: 'BOT_CONFIGURATION' });
    }
    if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: '請求欄位無效。', code: 'INVALID_REQUEST' });
    if (known.statusCode && known.statusCode >= 400 && known.statusCode < 500) {
      return reply.code(known.statusCode).send({ error: '請求無效。', code: 'INVALID_REQUEST' });
    }
    // Avoid logging SQL, upstream bodies, cookie/header data, or credential-bearing error objects.
    request.log.error({ requestId: request.id, errorType: known.name ?? 'Unknown' }, 'Website request failed');
    return reply.code(500).send({ error: '網站暫時無法完成操作，請稍後重試。', code: 'INTERNAL_ERROR' });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (request.url.startsWith('/web/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
  const cleanup = () => {
    for (const release of dispose.splice(0).reverse()) {
      try { release(); } catch { /* One website cleanup cannot prevent the rest or stop Bot. */ }
    }
  };
  // Close active SSE/media before Fastify waits for sockets to close.
  app.addHook('preClose', async () => cleanup());
  app.addHook('onClose', async () => cleanup());
  try {
    await guard.registerRoutes(app);
    registerCatalog(app, music, guard);
    registerPlaylists(app, music, guard);
    dispose.push(registerAudio(app, music, guard, auth, config));
    const resolvePlaylist: PlaylistResolver = options.resolvePlaylist ?? (async (entries, signal) => {
      const moduleUrl = pathToFileURL(resolvePath(config.botRoot, 'dist/features/playlists/api.js')).href;
      const { resolvePlaylist: resolve } = await import(moduleUrl) as typeof import('../../dist/features/playlists/api.js');
      return resolve(entries, { signal });
    });
    dispose.push(registerPlayback(app, music, bot, guard, auth, config, resolvePlaylist));
    app.get('/web/upload', async (request, reply) => {
      await guard.requireSession(request);
      return reply.redirect(config.uploadUrl);
    });
    app.get('/web/api/health', async () => ({ status: 'ok' }));
    app.get('/', async (_request, reply) => reply.redirect('/web/'));
    app.get('/web', async (_request, reply) => reply.redirect('/web/'));
    if (existsSync(config.clientDist)) {
      await app.register(fastifyStatic, { root: config.clientDist, prefix: '/web/', index: ['index.html'],
        dotfiles: 'deny', cacheControl: true, maxAge: '1h' });
    }
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '找不到此網頁或 API。', code: 'NOT_FOUND' }));
    await app.ready();
    return app;
  } catch (error) {
    cleanup();
    await app.close().catch(() => {});
    throw error;
  }
}
export const buildWebApp = createWebApp;
