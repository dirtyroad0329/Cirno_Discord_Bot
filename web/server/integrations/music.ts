import { WebError, upstreamError, uuidPattern } from '../http/errors.js';

export interface Song {
  id: string; title: string; artist: string | null; durationSeconds: number | null;
  mimeType: string; byteSize: number; sha256: string; updatedAt: string;
}
export interface PlaylistEntry {
  entryId: string; source: 'local' | 'remote'; id: string; title: string;
  artist?: string; library?: string; browserPlayable: boolean;
}
export interface Playlist { id: string; ownerId: string; name: string; revision: number; entries: PlaylistEntry[]; }
export interface StoredTrack { source: 'remote'; id: string; title: string; artist?: string; library: string; }
export interface MusicClientOptions { baseUrl: string | URL; token: string; timeoutMs?: number; fetch?: typeof fetch; }
const idRegex = new RegExp(uuidPattern);
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export function normalizeLibrary(value: string | URL): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new WebError(500, 'INVALID_MUSIC_CONFIG', '曲庫網址設定無效。');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳資料無效。');
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳資料無效。');
  return value;
}
function id(value: unknown): string {
  const result = string(value, 128);
  if (!idRegex.test(result)) throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳資料無效。');
  return result;
}
export function parseSong(value: unknown): Song {
  const item = record(value);
  if (typeof item.byteSize !== 'number' || !Number.isSafeInteger(item.byteSize) || item.byteSize < 1 || item.byteSize > 268_435_456 ||
      typeof item.durationSeconds !== 'number' && item.durationSeconds !== null ||
      typeof item.durationSeconds === 'number' && (!Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0)) {
    throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳歌曲資料無效。');
  }
  const mimeType = string(item.mimeType, 120);
  const sha256 = string(item.sha256, 64);
  if (!mimeType.startsWith('audio/') || !/^[0-9a-f]{64}$/i.test(sha256)) throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳歌曲資料無效。');
  return { id: id(item.id), title: string(item.title, 500), artist: item.artist === null ? null : string(item.artist, 500),
    durationSeconds: item.durationSeconds as number | null, mimeType, byteSize: item.byteSize,
    sha256, updatedAt: string(item.updatedAt, 80) };
}

export class MusicClient {
  readonly library: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  readonly fetch: typeof fetch;
  private readonly active = new Set<AbortController>();
  private readonly lifecycle = new AbortController();
  private nextMetadataAt = 0;
  constructor(options: MusicClientOptions) {
    this.library = normalizeLibrary(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  url(path: string): URL { return new URL(path, this.library); }
  headers(owner?: string): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...(owner ? { 'x-discord-user-id': owner } : {}) };
  }
  dispose(): void { this.lifecycle.abort(); for (const controller of this.active) controller.abort(); this.active.clear(); }
  async request(path: string, options: { method?: string; owner?: string; body?: unknown; query?: URLSearchParams; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.active.size >= 64) throw new WebError(503, 'MUSIC_BUSY', '曲庫查詢等待已達上限，請稍後重試。');
    const controller = new AbortController();
    this.active.add(controller);
    const signal = AbortSignal.any([controller.signal, this.lifecycle.signal, ...(options.signal ? [options.signal] : [])]);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = this.url(path);
    if (options.query) url.search = options.query.toString();
    try {
      if (signal.aborted) throw new WebError(504, 'MUSIC_TIMEOUT', '曲庫請求已取消或逾時。');
      const response = await this.fetch(url, { method: options.method ?? 'GET', headers: {
        ...this.headers(options.owner), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw upstreamError(response.status); }
      if (response.status === 204) { await response.body?.cancel(); return undefined; }
      const reader = response.body?.getReader();
      if (!reader) throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳資料無效。');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_JSON_BYTES) { controller.abort(); throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫資料超出限制。'); }
        chunks.push(chunk.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳資料無效。'); }
    } catch (error) {
      if (error instanceof WebError) throw error;
      if (signal.aborted) throw new WebError(504, 'MUSIC_TIMEOUT', '曲庫請求已取消或逾時。');
      throw new WebError(502, 'MUSIC_UNAVAILABLE', '曲庫目前無法使用，請稍後重試。');
    } finally { clearTimeout(timeout); this.active.delete(controller); }
  }
  async songs(query = '', cursor?: string, signal?: AbortSignal): Promise<{ items: Song[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ limit: '25' });
    if (query.trim()) params.set('query', query.trim());
    if (cursor) params.set('cursor', cursor);
    const page = record(await this.request('v1/songs', { query: params, signal }));
    if (!Array.isArray(page.items) || page.items.length > 25 || page.nextCursor !== null && !idRegex.test(String(page.nextCursor))) {
      throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳搜尋資料無效。');
    }
    return { items: page.items.map(parseSong), nextCursor: page.nextCursor as string | null };
  }
  async song(songId: string, signal?: AbortSignal): Promise<Song> {
    const effectiveSignal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    if (effectiveSignal.aborted) throw new WebError(504, 'MUSIC_TIMEOUT', '曲庫請求已取消或逾時。');
    // The existing Nginx API defaults to 10 requests/s. Bound metadata starts without blocking Bot.
    const wait = Math.max(0, this.nextMetadataAt - Date.now());
    if (wait > 8000) throw new WebError(503, 'MUSIC_BUSY', '歌曲查詢等待已達上限，請稍後重試。');
    this.nextMetadataAt = Date.now() + wait + 125;
    if (wait) {
      const { setTimeout: delay } = await import('node:timers/promises');
      try { await delay(wait, undefined, { signal: effectiveSignal }); }
      catch { throw new WebError(504, 'MUSIC_TIMEOUT', '曲庫請求已取消或逾時。'); }
    }
    const song = parseSong(await this.request(`v1/songs/${songId}`, { signal: effectiveSignal }));
    if (song.id !== songId) throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳歌曲資料不一致。');
    return song;
  }
  playlist(value: unknown, owner: string): Playlist {
    const item = record(value);
    if (item.ownerId !== owner || typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
        !Array.isArray(item.entries) || item.entries.length > 100) throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳清單資料無效。');
    return { id: id(item.id), ownerId: owner, name: string(item.name, 60), revision: item.revision,
      entries: item.entries.map(value => {
        const entry = record(value);
        if (entry.source !== 'local' && entry.source !== 'remote') throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳清單資料無效。');
        const library = entry.library === undefined ? undefined : string(entry.library, 2048);
        let browserPlayable = false;
        if (entry.source === 'remote' && library) {
          try { browserPlayable = normalizeLibrary(library) === this.library && idRegex.test(String(entry.id)); } catch { /* Preserve unsupported legacy entries. */ }
        }
        return { entryId: id(entry.entryId), source: entry.source, id: string(entry.id, 128), title: string(entry.title, 500),
          ...(entry.artist === undefined ? {} : { artist: string(entry.artist, 500) }), ...(library ? { library } : {}), browserPlayable };
      }) };
  }
  async listPlaylists(owner: string, signal?: AbortSignal): Promise<{ items: Playlist[] }> {
    const result = record(await this.request('v1/playlists', { owner, signal }));
    if (!Array.isArray(result.items) || result.items.length > 20) throw new WebError(502, 'INVALID_MUSIC_RESPONSE', '曲庫回傳清單資料無效。');
    return { items: result.items.map(item => this.playlist(item, owner)) };
  }
  async getPlaylist(owner: string, playlistId: string, signal?: AbortSignal): Promise<Playlist> {
    return this.playlist(await this.request(`v1/playlists/${playlistId}`, { owner, signal }), owner);
  }
  async mutatePlaylist(owner: string, path: string, method: string, body: unknown, signal?: AbortSignal): Promise<Playlist | undefined> {
    const result = await this.request(`v1/playlists${path}`, { owner, method, body, signal });
    return result === undefined ? undefined : this.playlist(result, owner);
  }
  async storedTracks(songIds: string[], signal?: AbortSignal): Promise<StoredTrack[]> {
    const tracks: StoredTrack[] = [];
    // Small bounded batches avoid exhausting the shared event loop / connection pool.
    for (let offset = 0; offset < songIds.length; offset += 4) {
      const songs = await Promise.all(songIds.slice(offset, offset + 4).map(songId => this.song(songId, signal)));
      tracks.push(...songs.map(song => ({ source: 'remote' as const, id: song.id, title: song.title,
        ...(song.artist ? { artist: song.artist } : {}), library: this.library })));
    }
    return tracks;
  }
}
