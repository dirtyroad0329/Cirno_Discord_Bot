import { musicLibrary, getRemoteSong, remoteLibraryKey, isRemoteTrack, type MusicTrack } from '../music/api.js';
import type { SavedTrack } from './model.js';
import { logOperationError } from '../../shared/logging/logOperationError.js';
import { setTimeout as delay } from 'node:timers/promises';

export function saveTrack(track: MusicTrack): SavedTrack {
    return { source: isRemoteTrack(track) ? 'remote' : 'local', id: track.id, title: track.title.slice(0, 500), artist: track.artist?.slice(0, 500),
        ...(isRemoteTrack(track) ? { library: remoteLibraryKey() } : {}) };
}
export async function resolvePlaylist(tracks: SavedTrack[], options?: { signal?: AbortSignal }): Promise<{ tracks: MusicTrack[]; unavailable: SavedTrack[] }> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    // Local availability must not prevent independent remote entries from resolving.
    const localLibraryReady = tracks.some(track => track.source === 'local')
        ? musicLibrary.load().then(() => true, error => { logOperationError(error); return false; })
        : Promise.resolve(false);
    const resolved: Array<MusicTrack | undefined> = new Array(tracks.length);
    let cursor = 0;
    const metadata = new Map<string, Promise<MusicTrack>>();
    const loggedFailures = new Set<unknown>();
    let nextRequestAt = 0;
    function remoteTrack(id: string): Promise<MusicTrack> {
        let pending = metadata.get(id);
        if (!pending) {
            const wait = Math.max(0, nextRequestAt - Date.now());
            nextRequestAt = Date.now() + wait + 125; // Stay below the default 10 requests/s proxy limit.
            pending = delay(wait, undefined, { signal }).then(() => getRemoteSong(id, { signal }));
            metadata.set(id, pending);
        }
        return pending;
    }
    // Bound remote requests while preserving playlist order and duplicate entries.
    await Promise.all(Array.from({ length: Math.min(4, tracks.length) }, async () => {
        while (cursor < tracks.length) {
            signal?.throwIfAborted();
            const index = cursor++;
            const reference = tracks[index];
            try {
                if (reference.source === 'remote') {
                    if (reference.library !== remoteLibraryKey()) continue;
                    resolved[index] = await remoteTrack(reference.id);
                } else if (await localLibraryReady) {
                    signal?.throwIfAborted();
                    const track = musicLibrary.get(reference.id);
                    if (track) { await musicLibrary.playablePath(track); resolved[index] = track; }
                }
            } catch (error) {
                signal?.throwIfAborted();
                // Keep unavailable entries saved, but do not hide transport/internal failures.
                if (!loggedFailures.has(error)) { loggedFailures.add(error); logOperationError(error); }
            }
        }
    }));
    signal?.throwIfAborted();
    return { tracks: resolved.filter((t): t is MusicTrack => !!t), unavailable: tracks.filter((_, i) => !resolved[i]) };
}
