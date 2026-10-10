import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebApp } from '../server/app.js';
import { openAuthService } from '../server/auth/index.js';
import { loadWebConfig } from '../server/config/index.js';
import type { MusicControlPort } from '../server/playback/routes.js';
import type { PlayerSnapshot } from '../contracts/index.js';

export const USER = '123456789012345678';
export const GUILD = '223456789012345678';
export const CHANNEL = '323456789012345678';
export const SONG = '11111111-1111-4111-8111-111111111111';
export const PLAYLIST = '22222222-2222-4222-8222-222222222222';
export const ENTRY = '33333333-3333-4333-8333-333333333333';
export const song = { id: SONG, title: 'Trusted song', artist: 'Trusted artist', durationSeconds: 120,
  mimeType: 'audio/mpeg', byteSize: 8, sha256: 'a'.repeat(64), updatedAt: '2026-10-10T00:00:00.000Z' };
export const snapshot = (): PlayerSnapshot => ({ guildId: GUILD, channelId: CHANNEL, sessionId: 'session-one',
  generation: 5, queueRevision: 8, status: 'playing', current: { track: { id: SONG, source: 'remote', title: song.title }, requestedBy: USER },
  pending: [], volume: 0.8, repeat: 'off', elapsedSeconds: 2, observedAt: new Date().toISOString(),
  canControl: true, canPlay: true, historyCount: 0 });

export async function apiFixture(options: { fetch?: typeof fetch; bot?: Partial<MusicControlPort>; env?: NodeJS.ProcessEnv } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'cirno-web-api-'));
  const config = loadWebConfig({ webRoot: temporary, env: { WEB_ENABLED: 'true', WEB_API_TIMEOUT_MS: '100',
    WEB_SSE_RECHECK_MS: '250', ...options.env }, backend: { baseUrl: 'http://music.test/', token: 'server-only-secret' } });
  // API tests isolate transport/authorization; auth tests exercise the real production scrypt implementation.
  const auth = await openAuthService({ dbPath: config.authDbPath,
    passwords: { hash: async value => `test:${value}`, verify: async (value, stored) => stored === `test:${value}` } });
  await auth.createUser(USER);
  const login = await auth.login(USER, 'piyan');
  const headers = { cookie: `cirno_web_session=${login.token}`, origin: config.publicOrigin, 'x-csrf-token': login.csrfToken };
  const observers = new Set<(guildId: string) => void>();
  let executions = 0;
  const bot: MusicControlPort = {
    voiceContexts: () => [{ guildId: GUILD, guildName: 'Guild', channelId: CHANNEL, channelName: 'Music', botChannelId: CHANNEL }],
    snapshot: () => snapshot(),
    execute: async () => { executions++; return snapshot(); },
    subscribe: listener => { observers.add(listener); return () => { observers.delete(listener); }; },
    ...options.bot,
  };
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const defaultFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    if (url.pathname === '/v1/songs') return Response.json({ items: [song], nextCursor: null });
    if (url.pathname === `/v1/songs/${SONG}`) return Response.json(song);
    if (url.pathname === `/v1/songs/${SONG}/audio`) return new Response(init?.method === 'HEAD' ? null : Buffer.from('abcdefgh'), {
      headers: { 'content-type': 'audio/mpeg', 'content-length': '8', 'accept-ranges': 'bytes', etag: '"song-etag"' } });
    if (url.pathname === '/v1/playlists' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json({ id: PLAYLIST, ownerId: USER, name: body.name, revision: 1,
        entries: (body.tracks ?? []).map((track: object) => ({ ...track, entryId: ENTRY })) }, { status: 201 });
    }
    return Response.json({ items: [] });
  };
  const app = await createWebApp({ config, auth, bot, fetch: options.fetch ?? defaultFetch,
    resolvePlaylist: async () => ({ tracks: [], unavailable: [] }) });
  return { app, auth, config, headers, login, calls, bot, observers, executions: () => executions,
    async close() { await app.close(); await auth.close(); await rm(temporary, { recursive: true, force: true }); } };
}
