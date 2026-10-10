import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlayerCommand as BrowserCommand, CommandResult } from '../../contracts/index.js';
import type { PlayerCommand, PlaybackOperationContext, PlayerSnapshot, VoiceContext, MusicTrack } from '../../../dist/features/music/api.js';
import type { WebConfig } from '../config/index.js';
import type { MusicClient, PlaylistEntry, Song } from '../integrations/music.js';
import { authorizeWrite, requestCancellation, type AuthGuard, type SessionInspector } from '../http/guards.js';
import { object, uuid, WebError } from '../http/errors.js';

export interface MusicControlPort {
  voiceContexts(userId: string): VoiceContext[] | Promise<VoiceContext[]>;
  snapshot(userId: string, guildId: string): PlayerSnapshot | Promise<PlayerSnapshot>;
  execute(userId: string, guildId: string, command: PlayerCommand, context: PlaybackOperationContext): Promise<PlayerSnapshot>;
  subscribe(listener: (guildId: string) => void): () => void;
}
export type PlaylistResolver = (entries: PlaylistEntry[], signal: AbortSignal) => Promise<{ tracks: MusicTrack[]; unavailable: unknown[] }>;
const snowflake = { type: 'string', pattern: '^[0-9]{17,20}$' };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const common = { requestId: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' },
  sessionId: { anyOf: [{ type: 'string', minLength: 1, maxLength: 128 }, { type: 'null' }] }, generation: integer, queueRevision: integer };
const commandSchema = { oneOf: [
  object({ ...common, action: { const: 'enqueue' }, songIds: { type: 'array', minItems: 1, maxItems: 100, items: uuid },
    position: { enum: ['last', 'next'] } }, ['requestId', 'sessionId', 'action', 'songIds']),
  object({ ...common, action: { const: 'enqueue' }, playlistId: uuid, position: { enum: ['last', 'next'] } }, ['requestId', 'sessionId', 'action', 'playlistId']),
  object({ ...common, action: { enum: ['pause', 'resume', 'skip', 'previous', 'restart', 'shuffle', 'clear', 'stop'] } }, ['requestId', 'sessionId', 'action']),
  object({ ...common, action: { const: 'seek' }, seconds: { type: 'number', minimum: 0, maximum: 86400 } }, ['requestId', 'sessionId', 'action', 'seconds']),
  object({ ...common, action: { const: 'volume' }, percent: { type: 'integer', minimum: 0, maximum: 100 } }, ['requestId', 'sessionId', 'action', 'percent']),
  object({ ...common, action: { const: 'repeat' }, mode: { enum: ['off', 'one', 'all'] } }, ['requestId', 'sessionId', 'action', 'mode']),
  object({ ...common, action: { const: 'remove' }, position: { type: 'integer', minimum: 1, maximum: 500 } }, ['requestId', 'sessionId', 'action', 'position']),
  object({ ...common, action: { const: 'move' }, from: { type: 'integer', minimum: 1, maximum: 500 }, to: { type: 'integer', minimum: 1, maximum: 500 } }, ['requestId', 'sessionId', 'action', 'from', 'to']),
] };

const remoteTrack = (song: Song): MusicTrack => ({ source: 'remote', id: song.id, title: song.title,
  ...(song.artist ? { artist: song.artist } : {}), ...(song.durationSeconds ? { duration: song.durationSeconds } : {}),
  mimeType: song.mimeType, byteSize: song.byteSize, sha256: song.sha256 });

export function registerPlayback(app: FastifyInstance, music: MusicClient, bot: MusicControlPort,
  guard: AuthGuard, auth: SessionInspector, config: WebConfig, resolvePlaylist: PlaylistResolver): () => void {
  const requests = new Map<string, { fingerprint: string; expires: number; pending: boolean; result: Promise<CommandResult> }>();
  const guildPending = new Map<string, number>();
  const guildUrgent = new Map<string, number>();
  const commandControllers = new Set<AbortController>();
  const urgentControllers = new Set<AbortController>();
  const clients = new Set<() => void>();
  const userClients = new Map<string, number>();
  let closed = false;
  const prune = () => {
    const now = Date.now();
    for (const [key, entry] of requests) if (!entry.pending && entry.expires <= now) requests.delete(key);
  };
  app.get('/web/api/voice/contexts', async request => ({ items: await bot.voiceContexts((await guard.requireSession(request)).discordId) }));
  app.get<{ Params: { guildId: string } }>('/web/api/player/:guildId', { schema: { params: object({ guildId: snowflake }) } }, async request =>
    bot.snapshot((await guard.requireSession(request)).discordId, request.params.guildId));
  app.post<{ Params: { guildId: string }; Body: BrowserCommand }>('/web/api/player/:guildId/commands', {
    schema: { params: object({ guildId: snowflake }), body: commandSchema },
  }, async (request, reply) => {
    const session = await authorizeWrite(guard, request);
    if (request.raw.aborted || reply.raw.destroyed) throw new WebError(504, 'REQUEST_CANCELLED', '播放器請求已取消。');
    const sessionToken = guard.readToken(request);
    const guildId = request.params.guildId;
    // Reauthorize even duplicate requests: leaving a channel revokes access to cached state.
    await bot.snapshot(session.discordId, guildId);
    const key = `${session.discordId}:${guildId}:${request.body.requestId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(request.body)).digest('hex');
    prune();
    const old = requests.get(key);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new WebError(409, 'REQUEST_ID_CONFLICT', '同一 requestId 不可用於不同操作。');
      const result = await old.result;
      await guard.requireSession(request);
      // A deduplicated operation must never replay a previous channel's queue DTO.
      return { ...result, snapshot: await bot.snapshot(session.discordId, guildId) };
    }
    const urgent = request.body.action === 'stop' || request.body.action === 'skip';
    const pendingCounts = urgent ? guildUrgent : guildPending;
    const controllers = urgent ? urgentControllers : commandControllers;
    const pendingLimit = urgent ? 2 : config.commandMaxPendingPerGuild;
    if (closed || requests.size >= (urgent ? 1056 : 1024) || controllers.size >= (urgent ? 16 : 64) || (pendingCounts.get(guildId) ?? 0) >= pendingLimit) {
      throw new WebError(429, 'COMMAND_LIMIT', '播放器操作等待已達上限，請稍後重試。');
    }
    const controller = new AbortController();
    controllers.add(controller);
    pendingCounts.set(guildId, (pendingCounts.get(guildId) ?? 0) + 1);
    const cancellation = requestCancellation(request, reply);
    const signal = AbortSignal.any([controller.signal, cancellation.signal]);
    const expiresAt = Date.now() + config.commandTimeoutMs;
    const timer = setTimeout(() => controller.abort(), config.commandTimeoutMs);
    timer.unref();
    let checkingSession = false;
    const sessionRecheck = setInterval(() => {
      if (checkingSession || signal.aborted) return;
      checkingSession = true;
      void auth.authenticate(sessionToken ?? '', { touch: false }).then(current => {
        if (!current || current.scope !== 'full' || current.tokenHash !== session.tokenHash) controller.abort();
      }).catch(() => controller.abort()).finally(() => { checkingSession = false; });
    }, config.sseRecheckMs);
    sessionRecheck.unref();
    const entry = { fingerprint, expires: Date.now() + 5 * 60_000, pending: true, result: undefined as unknown as Promise<CommandResult> };
    const execute = async (): Promise<CommandResult> => {
      let command: PlayerCommand;
      let skipped = 0;
      if (request.body.action === 'enqueue') {
        let tracks: MusicTrack[];
        if (request.body.playlistId) {
          const playlist = await music.getPlaylist(session.discordId, request.body.playlistId, signal);
          const resolved = await resolvePlaylist(playlist.entries, signal);
          tracks = resolved.tracks;
          skipped = resolved.unavailable.length;
        } else {
          tracks = [];
          const ids = request.body.songIds!;
          for (let offset = 0; offset < ids.length; offset += 4) {
            const songs = await Promise.all(ids.slice(offset, offset + 4).map(id => music.song(id, signal)));
            tracks.push(...songs.map(remoteTrack));
          }
        }
        if (!tracks.length) throw new WebError(400, 'NO_PLAYABLE_TRACKS', '清單沒有此 Bot 可以播放的歌曲。');
        command = { action: 'enqueue', tracks, next: request.body.position === 'next' };
      } else {
        // Drop HTTP identity/request fields before crossing the neutral Bot boundary.
        const { requestId: _requestId, sessionId: _sessionId, generation: _generation, queueRevision: _queueRevision, ...action } = request.body;
        command = action as PlayerCommand;
      }
      // Metadata waits happen outside the guild queue; verify the website session once more afterwards.
      const current = await guard.requireSession(request);
      if (current.discordId !== session.discordId || current.tokenHash !== session.tokenHash) throw new WebError(401, 'UNAUTHORIZED', '登入已失效。');
      if (signal.aborted || expiresAt <= Date.now()) throw new WebError(504, 'REQUEST_EXPIRED', '操作已取消或逾時，請重新查看播放器。');
      const snapshot = await bot.execute(session.discordId, guildId, command, {
        sessionId: request.body.sessionId, generation: request.body.generation, queueRevision: request.body.queueRevision,
        expiresAt, signal,
      });
      return { snapshot, ...(skipped ? { skipped } : {}) };
    };
    entry.result = execute().finally(() => {
      entry.pending = false;
      entry.expires = Date.now() + 5 * 60_000;
      clearTimeout(timer);
      clearInterval(sessionRecheck);
      cancellation.dispose();
      controllers.delete(controller);
      const count = (pendingCounts.get(guildId) ?? 1) - 1;
      if (count) pendingCounts.set(guildId, count); else pendingCounts.delete(guildId);
    });
    requests.set(key, entry);
    return entry.result;
  });

  app.get<{ Params: { guildId: string } }>('/web/api/player/:guildId/events', { schema: { params: object({ guildId: snowflake }) } }, async (request, reply) => {
    const session = await guard.requireSession(request);
    const token = guard.readToken(request);
    if (!token) throw new WebError(401, 'UNAUTHORIZED', '請重新登入。');
    const guildId = request.params.guildId;
    await bot.snapshot(session.discordId, guildId);
    if (request.raw.aborted || reply.raw.destroyed) throw new WebError(504, 'REQUEST_CANCELLED', '同步請求已取消。');
    if (clients.size >= config.sseMaxConnections || (userClients.get(session.discordId) ?? 0) >= config.sseMaxPerUser) {
      throw new WebError(429, 'EVENT_LIMIT', '即時同步連線已達上限。');
    }
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'private, no-store',
      connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let stopped = false;
    let sequence = 0;
    let busy = false;
    let unsubscribe = () => {};
    let interval: ReturnType<typeof setInterval>;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      try { unsubscribe(); } catch { /* A subscriber cleanup cannot stop the shared Bot. */ }
      request.raw.off('aborted', cleanup);
      reply.raw.off('close', cleanup);
      clients.delete(cleanup);
      const count = (userClients.get(session.discordId) ?? 1) - 1;
      if (count > 0) userClients.set(session.discordId, count); else userClients.delete(session.discordId);
      reply.raw.end();
    };
    const unavailable = () => {
      if (!stopped && !reply.raw.destroyed && reply.raw.writableLength < 64 * 1024) {
        // A generic invalidation contains no voice/session data after access is lost.
        reply.raw.write('event: unavailable\ndata: {"code":"STATE_UNAVAILABLE"}\n\n');
      }
      cleanup();
    };
    clients.add(cleanup);
    userClients.set(session.discordId, (userClients.get(session.discordId) ?? 0) + 1);
    request.raw.once('aborted', cleanup);
    reply.raw.once('close', cleanup);
    const send = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const current = await auth.authenticate(token, { touch: false });
        if (!current || current.scope !== 'full' || current.discordId !== session.discordId) return unavailable();
        // snapshot checks Gateway + live voice membership on every send, including reconnect.
        const snapshot = await bot.snapshot(session.discordId, guildId);
        if (stopped) return;
        const frame = `id: ${++sequence}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
        if (Buffer.byteLength(frame) + reply.raw.writableLength > 64 * 1024 || reply.raw.writableNeedDrain) return cleanup();
        if (!reply.raw.write(frame)) cleanup();
      } catch { unavailable(); } finally { busy = false; }
    };
    try {
      unsubscribe = bot.subscribe(changedGuild => {
        if (changedGuild === guildId) void send().catch(cleanup);
      });
      interval = setInterval(() => { void send().catch(cleanup); }, config.sseRecheckMs);
      interval.unref();
      // Never replay Last-Event-ID from a previous voice channel or session.
      await send();
    } catch { cleanup(); }
  });
  return () => {
    closed = true;
    for (const cleanup of [...clients]) cleanup();
    for (const controller of commandControllers) controller.abort();
    for (const controller of urgentControllers) controller.abort();
    commandControllers.clear();
    urgentControllers.clear();
    requests.clear();
    guildPending.clear();
    guildUrgent.clear();
  };
}
