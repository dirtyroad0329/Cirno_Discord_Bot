import type { RemoteTrack } from '../model/track.js';
import { remoteMusicApiSettings } from '../../../shared/http/musicApi.js';
import { UserActionError, ConfigurationError } from '../../../shared/logging/operationErrors.js';
import { setTimeout as delay } from 'node:timers/promises';
export type { RemoteTrack } from '../model/track.js';

export interface RemotePage { items: RemoteTrack[]; nextCursor?: string; }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const MAX_AUDIO_BYTES = 268_435_456;
export const isRemoteId = (value: string): boolean => UUID.test(value);

export function remoteLibraryKey(): string { return remoteMusicApiSettings().base.href; }

function url(path: string, query?: URLSearchParams): URL {
    const { base } = remoteMusicApiSettings();
    const result = new URL(path, base);
    if (query) result.search = query.toString();
    return result;
}

function parseTrack(value: unknown): RemoteTrack {
    if (!value || typeof value !== 'object') throw new Error('遠端曲庫回傳無效歌曲資料。');
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.title !== 'string' ||
        typeof item.mimeType !== 'string' || !item.mimeType.startsWith('audio/') ||
        typeof item.byteSize !== 'number' || !Number.isSafeInteger(item.byteSize) || item.byteSize <= 0 || item.byteSize > MAX_AUDIO_BYTES ||
        typeof item.sha256 !== 'string' || !HASH.test(item.sha256) ||
        (item.artist !== null && item.artist !== undefined && typeof item.artist !== 'string') ||
        (item.durationSeconds !== null && item.durationSeconds !== undefined &&
            (typeof item.durationSeconds !== 'number' || !Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0))) {
        throw new Error('遠端曲庫回傳無效歌曲資料。');
    }
    return { source: 'remote', id: item.id, title: item.title, artist: item.artist || undefined,
        duration: item.durationSeconds || undefined, mimeType: item.mimeType, byteSize: item.byteSize, sha256: item.sha256 };
}

async function request(path: string, query?: URLSearchParams, timeoutMs = 8000, externalSignal?: AbortSignal): Promise<Response> {
    const { token } = remoteMusicApiSettings();
    let response: Response;
    externalSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    try {
        for (let attempt = 0; ; attempt++) {
            response = await fetch(url(path, query), { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' });
            if (response.status !== 429 || attempt >= 2) break;
            const retryAfter = response.headers.get('retry-after');
            const seconds = retryAfter ? Number(retryAfter) : NaN;
            const requested = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 1000;
            await response.body?.cancel();
            await delay(Math.min(3000, Math.max(1000, requested || 1000)), undefined, { signal });
        }
    } catch {
        externalSignal?.throwIfAborted();
        throw new Error('無法連線至遠端曲庫。');
    }
    if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 && path !== 'v1/songs') throw new UserActionError('遠端歌曲已移除，請重新開啟曲庫。');
        if (response.status === 401) throw new Error('遠端曲庫驗證失敗，請檢查 API token。');
        throw new Error(`遠端曲庫暫時無法使用（HTTP ${response.status}）。`);
    }
    return response;
}

export async function searchRemoteSongs(query = '', cursor?: string, limit = 25, timeoutMs = 8000): Promise<RemotePage> {
    if (cursor && !UUID.test(cursor)) throw new UserActionError('遠端曲庫游標無效。');
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(25, limit))) });
    if (query.trim()) params.set('query', query.trim().slice(0, 200));
    if (cursor) params.set('cursor', cursor);
    const response = await request('v1/songs', params, timeoutMs);
    const body = await response.json() as { items?: unknown; nextCursor?: unknown };
    if (!Array.isArray(body.items) || body.items.length > 25 ||
        (body.nextCursor !== null && body.nextCursor !== undefined && (typeof body.nextCursor !== 'string' || !UUID.test(body.nextCursor)))) {
        throw new Error('遠端曲庫回傳無效的搜尋結果。');
    }
    return { items: body.items.map(parseTrack), nextCursor: body.nextCursor || undefined };
}

export async function getRemoteSong(id: string, options?: { signal?: AbortSignal }): Promise<RemoteTrack> {
    if (!UUID.test(id)) throw new UserActionError('遠端歌曲 ID 無效。');
    const response = await request(`v1/songs/${id}`, undefined, 8000, options?.signal);
    return parseTrack(await response.json());
}

export async function openRemoteAudio(id: string, controller: AbortController): Promise<Response> {
    if (!UUID.test(id)) throw new UserActionError('遠端歌曲 ID 無效。');
    const { token } = remoteMusicApiSettings();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(url(`v1/songs/${id}/audio`), {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal, redirect: 'error'
        });
        if (response.status !== 200 || !response.body) {
            await response.body?.cancel();
            if (response.status === 404) throw new UserActionError('遠端音檔已移除。');
            throw new Error(`遠端音檔無法讀取（HTTP ${response.status}）。`);
        }
        return response;
    } catch (error) {
        if (controller.signal.aborted) throw new Error('遠端音檔連線逾時。');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export function remoteMusicMode(): 'stream' | 'download' {
    const mode = process.env.REMOTE_MUSIC_MODE?.trim() || 'stream';
    if (mode !== 'stream' && mode !== 'download') throw new ConfigurationError('REMOTE_MUSIC_MODE 只能是 stream 或 download。');
    return mode;
}
