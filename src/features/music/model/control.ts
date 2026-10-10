import type { MusicTrack } from './track.js';
import type { RepeatMode } from './queue.js';
import { UserActionError } from '../../../shared/logging/operationErrors.js';

/** Preconditions refer to the state the caller actually observed, not a newly fetched version. */
export interface PlaybackOperationContext {
    sessionId: string | null;
    generation?: number;
    queueRevision?: number;
    expiresAt?: number;
    signal?: AbortSignal;
}

export type PlayerCommand =
    | { action: 'enqueue'; tracks: MusicTrack[]; next?: boolean }
    | { action: 'pause' | 'resume' | 'previous' | 'skip' | 'restart' | 'shuffle' | 'stop' }
    | { action: 'seek'; seconds: number }
    | { action: 'volume'; percent: number }
    | { action: 'repeat'; mode: RepeatMode }
    | { action: 'remove'; position: number }
    | { action: 'move'; from: number; to: number }
    | { action: 'clear' };

export interface PlaybackTrack {
    id: string;
    source: 'local' | 'remote';
    title: string;
    artist?: string;
    durationSeconds?: number;
}
export interface PlaybackEntry { track: PlaybackTrack; requestedBy: string; }
export interface VoiceContext {
    guildId: string;
    guildName: string;
    channelId: string;
    channelName: string;
    botChannelId: string | null;
}
export interface PlayerSnapshot {
    guildId: string;
    channelId: string;
    sessionId: string | null;
    generation: number;
    queueRevision: number;
    status: 'idle' | 'connecting' | 'playing' | 'paused' | 'ended';
    current: PlaybackEntry | null;
    pending: PlaybackEntry[];
    volume: number;
    repeat: RepeatMode;
    elapsedSeconds: number;
    durationSeconds?: number;
    observedAt: string;
    canControl: boolean;
    canPlay: boolean;
    historyCount: number;
    notice?: string;
}

export type PlaybackErrorCode = 'GATEWAY_UNAVAILABLE' | 'VOICE_REQUIRED' | 'FORBIDDEN'
    | 'STALE_SESSION' | 'STALE_TRACK' | 'STALE_QUEUE' | 'REQUEST_EXPIRED' | 'INVALID_COMMAND';

/** Domain error: HTTP and Discord boundaries decide how to present it. */
export class PlaybackOperationError extends UserActionError {
    constructor(readonly code: PlaybackErrorCode, message: string) { super(message); }
}

export function assertRequestActive(context?: PlaybackOperationContext): void {
    if (context && (context.signal?.aborted ||
        (context.expiresAt !== undefined && (!Number.isFinite(context.expiresAt) || context.expiresAt <= Date.now())))) {
        throw new PlaybackOperationError('REQUEST_EXPIRED', '操作已取消或逾時，請重新查看播放器後操作。');
    }
}
