import { Readable, Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { ReadableStream } from 'node:stream/web';
import type { MusicClient } from '../integrations/music.js';
import type { AuthGuard, SessionInspector } from '../http/guards.js';
import { object, upstreamError, uuid, WebError } from '../http/errors.js';

interface MediaOptions {
  apiTimeoutMs: number; mediaIdleTimeoutMs: number; mediaMaxConnections: number; mediaMaxPerUser: number;
  sseRecheckMs: number;
}
const responseHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'] as const;
const conditionalHeaders = ['if-range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since'] as const;

export function registerAudio(app: FastifyInstance, music: MusicClient, guard: AuthGuard,
  auth: SessionInspector, options: MediaOptions): () => void {
  const active = new Set<AbortController>();
  const perUser = new Map<string, number>();
  app.route<{ Params: { id: string } }>({ method: ['GET', 'HEAD'], url: '/web/api/songs/:id/audio',
    schema: { params: object({ id: uuid }) },
    async handler(request, reply) {
      const session = await guard.requireSession(request);
      if (request.raw.aborted || reply.raw.destroyed) throw new WebError(504, 'REQUEST_CANCELLED', '音訊請求已取消。');
      const token = guard.readToken(request);
      if (!token) throw new WebError(401, 'UNAUTHORIZED', '請重新登入。');
      if (active.size >= options.mediaMaxConnections || (perUser.get(session.discordId) ?? 0) >= options.mediaMaxPerUser) {
        throw new WebError(429, 'MEDIA_LIMIT', '音訊連線已達上限，請停止其他播放後再試。');
      }
      const headers: Record<string, string> = { ...music.headers(), 'accept-encoding': 'identity' };
      const range = request.headers.range;
      if (range !== undefined) {
        if (typeof range !== 'string' || range.length > 100 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
          throw new WebError(400, 'INVALID_RANGE', '僅支援單一音訊 byte range。');
        }
        headers.range = range;
      }
      for (const header of conditionalHeaders) {
        const value = request.headers[header];
        if (value !== undefined) {
          if (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value)) {
            throw new WebError(400, 'INVALID_CONDITION', '音訊請求標頭無效。');
          }
          headers[header] = value;
        }
      }
      const controller = new AbortController();
      active.add(controller);
      perUser.set(session.discordId, (perUser.get(session.discordId) ?? 0) + 1);
      let stream: Readable | undefined;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let handshake: ReturnType<typeof setTimeout> | undefined;
      let recheck: ReturnType<typeof setInterval> | undefined;
      let disposed = false;
      let checking = false;
      const abort = () => { controller.abort(); stream?.destroy(); };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (idle) clearTimeout(idle);
        if (handshake) clearTimeout(handshake);
        if (recheck) clearInterval(recheck);
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
        reply.raw.off('finish', dispose);
        active.delete(controller);
        const count = (perUser.get(session.discordId) ?? 1) - 1;
        if (count > 0) perUser.set(session.discordId, count); else perUser.delete(session.discordId);
      };
      const refreshIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(abort, options.mediaIdleTimeoutMs);
        idle.unref();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      reply.raw.once('finish', dispose);
      controller.signal.addEventListener('abort', () => { stream?.destroy(); dispose(); }, { once: true });
      handshake = setTimeout(abort, options.apiTimeoutMs);
      try {
        const response = await music.fetch(music.url(`v1/songs/${request.params.id}/audio`), {
          method: request.method, headers, signal: controller.signal, redirect: 'error',
        });
        clearTimeout(handshake);
        if (![200, 206, 304, 412, 416].includes(response.status)) {
          await response.body?.cancel();
          throw upstreamError(response.status);
        }
        if (response.headers.has('x-accel-redirect') || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
          await response.body?.cancel();
          throw new WebError(502, 'INVALID_AUDIO_ORIGIN', '音訊入口設定錯誤，必須使用曲庫 Nginx 入口。');
        }
        if ((response.status === 200 || response.status === 206) && !response.headers.get('content-type')?.startsWith('audio/')) {
          await response.body?.cancel();
          throw new WebError(502, 'INVALID_AUDIO_ORIGIN', '曲庫未提供有效的音訊內容。');
        }
        const current = await auth.authenticate(token, { touch: false });
        if (!current || current.scope !== 'full' || current.discordId !== session.discordId) {
          await response.body?.cancel();
          throw new WebError(401, 'UNAUTHORIZED', '登入已失效，請重新登入。');
        }
        reply.code(response.status);
        for (const header of responseHeaders) {
          const value = response.headers.get(header);
          if (value !== null) reply.header(header, value);
        }
        reply.header('cache-control', 'private, no-store');
        if (request.method === 'HEAD' || response.status === 304 || response.status === 412 || response.status === 416) {
          await response.body?.cancel();
          // Error pages are not audio and may contain upstream details. An empty GET body needs its own length.
          if (request.method !== 'HEAD' && (response.status === 412 || response.status === 416)) reply.header('content-length', '0');
          dispose();
          return reply.send();
        }
        if (!response.body) throw new WebError(502, 'INVALID_AUDIO_ORIGIN', '曲庫未提供音訊內容。');
        refreshIdle();
        const source = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
        const activity = new Transform({ transform(chunk, _encoding, done) { refreshIdle(); done(null, chunk); } });
        source.on('error', error => activity.destroy(error));
        activity.on('close', () => { source.destroy(); controller.abort(); dispose(); });
        stream = source.pipe(activity);
        recheck = setInterval(() => {
          if (checking || disposed) return;
          checking = true;
          void auth.authenticate(token, { touch: false }).then(current => {
            if (!current || current.scope !== 'full' || current.discordId !== session.discordId) abort();
          }).catch(abort).finally(() => { checking = false; });
        }, options.sseRecheckMs);
        recheck.unref();
        return reply.send(stream);
      } catch (error) {
        const wasAborted = controller.signal.aborted;
        abort();
        if (error instanceof WebError) throw error;
        throw new WebError(wasAborted ? 504 : 502, 'AUDIO_UNAVAILABLE', '音訊載入失敗或逾時。');
      }
    },
  });
  return () => { for (const controller of active) controller.abort(); active.clear(); perUser.clear(); };
}
