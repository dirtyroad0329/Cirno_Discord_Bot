import { UserActionError } from '../../../shared/logging/operationErrors.js';
import { AudioPlayerStatus, createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';
import type { MusicSession } from './session.js';
import { loadTrackAudio, type AudioLoader } from './source.js';
import { logOperationError } from '../../../shared/logging/logOperationError.js';

interface PlaybackEvents {
    end(session: MusicSession, notice: string): void;
    scheduleAdvance(session: MusicSession, token: number, reason: 'finished' | 'error', error?: Error): void;
}
export class PlaybackEngine {
    constructor(private readonly events: PlaybackEvents, private readonly loadAudio: AudioLoader = loadTrackAudio,
        private readonly loadTimeoutMs = 60_000) {
        if (!Number.isFinite(loadTimeoutMs) || loadTimeoutMs <= 0) throw new RangeError('Audio loading timeout must be positive.');
    }
    async advance(session: MusicSession, reason: 'finished' | 'skip' | 'error'): Promise<void> {
        if (!session.active) return;
        const previous = session.queue.current;
        const playedMs = session.audio?.resource.playbackDuration ?? 0;
        // A decoder that produces no audio is a failed track, not a repeatable completion.
        if (reason === 'finished' && previous && playedMs === 0) reason = 'error';
        if (reason === 'error') {
            session.failures++;
            session.notice = `無法播放「${previous?.track.title ?? '此歌曲'}」，已略過。`;
        } else if (reason === 'finished') session.failures = 0;
        if (session.failures >= 3) { this.events.end(session, '連續三首無法播放，請檢查音檔。'); return; }
        const entry = session.queue.advance(reason);
        if (!entry) { this.events.end(session, reason === 'error' ? session.notice! : '播放清單已結束。'); return; }
        await this.playCurrent(session);
    }
    async playCurrent(session: MusicSession, offset = 0, paused = false): Promise<void> {
        const entry = session.queue.current;
        if (!session.active || !entry) return;
        const token = ++session.generation;
        session.clearAudio();
        session.offset = offset;
        session.status = 'connecting';
        session.panel.update();
        try {
            const loading = new AbortController();
            session.loadController = loading;
            // An idle timeout alone lets a slow drip occupy the guild queue forever.
            // Abort actual I/O and wait for its cleanup, rather than releasing the task early.
            const timeout = setTimeout(() => loading.abort(new Error('音訊載入超過 60 秒，已取消。')), this.loadTimeoutMs).unref();
            let audio: Awaited<ReturnType<AudioLoader>>;
            try {
                audio = await this.loadAudio(entry.track, session.volume,
                    error => this.events.scheduleAdvance(session, token, 'error', error), loading, offset);
            } finally { clearTimeout(timeout); }
            if (loading.signal.aborted) { audio.dispose(); loading.signal.throwIfAborted(); }
            if (session.loadController === loading) session.loadController = undefined;
            if (!session.active || session.generation !== token) { audio.dispose(); return; }
            session.audio = audio;
            this.attachPlayer(session, token, paused);
        } catch (error) {
            if (!session.active || session.generation !== token || session.loadController?.signal.reason === 'control') return;
            logOperationError(error);
            await this.advance(session, 'error');
        }
    }
    async control(session: MusicSession, action: string, value?: number | string): Promise<void> {
        switch (action) {
            case 'skip': await this.advance(session, 'skip'); break;
            case 'pause': this.setPaused(session, session.status !== 'paused'); break;
            case 'pauseOnly': this.setPaused(session, true); break;
            case 'resume': this.setPaused(session, false); break;
            case 'previous':
                session.queue.previous(); session.failures = 0; session.notice = undefined;
                await this.playCurrent(session); break;
            case 'restart':
            case 'seek': {
                const offset = action === 'restart' ? 0 : Number(value);
                const duration = session.queue.current?.track.duration;
                if (!Number.isFinite(offset) || offset < 0 || (offset > 0 && (!duration || offset >= duration))) {
                    throw new UserActionError('請輸入小於歌曲總長的秒數；總長未知的歌曲只能從頭播放。');
                }
                const paused = session.status === 'paused';
                session.failures = 0; session.notice = undefined;
                await this.playCurrent(session, offset, paused); break;
            }
            case 'volume': {
                const volume = Number(value);
                if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new UserActionError('音量須介於 0–100。');
                session.volume = volume; session.audio?.resource.volume?.setVolume(volume / 100); break;
            }
            case 'repeatMode':
                if (value !== 'off' && value !== 'one' && value !== 'all') throw new UserActionError('無效的循環模式。');
                session.queue.repeat = value; break;
            case 'repeat': session.queue.cycleRepeat(); break;
            case 'shuffle': session.queue.shuffle(); break;
            case 'up': case 'down':
                session.volume = Math.max(0, Math.min(100, session.volume + (action === 'up' ? 10 : -10)));
                session.audio?.resource.volume?.setVolume(session.volume / 100); break;
            default: throw new Error('未知的播放器操作。');
        }
    }
    setPaused(session: MusicSession, paused: boolean): void {
        if (paused && session.status === 'paused' || !paused && session.status === 'playing') return;
        if (paused && session.status !== 'playing' || !paused && session.status !== 'paused') throw new UserActionError('歌曲仍在載入中，請稍後再試。');
        if (paused ? !session.player?.pause() : !session.player?.unpause()) throw new UserActionError('目前無法變更播放狀態。');
        session.status = paused ? 'paused' : 'playing';
        clearTimeout(session.pauseTimer); session.pauseTimer = undefined;
        if (paused) session.pauseTimer = setTimeout(() => {
            if (session.active && session.status === 'paused') this.events.end(session, '暫停已達 10 分鐘，播放結束。');
        }, 600_000).unref();
    }
    private attachPlayer(session: MusicSession, token: number, paused: boolean): void {
        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
        session.player = player;
        player.once(AudioPlayerStatus.Idle, () => this.events.scheduleAdvance(session, token, 'finished'));
        player.on('error', error => this.events.scheduleAdvance(session, token, 'error', error));
        const watchBuffering = () => {
            clearTimeout(session.bufferingTimer);
            session.bufferingTimer = setTimeout(() => this.events.scheduleAdvance(session, token, 'error', new Error('Audio buffering timed out')), 20_000).unref();
        };
        player.on(AudioPlayerStatus.Buffering, () => {
            if (!session.active || session.generation !== token) return;
            session.status = 'connecting'; session.panel.update();
            watchBuffering();
        });
        let pauseOnReady = paused;
        player.on(AudioPlayerStatus.Playing, () => {
            if (!session.active || session.generation !== token) return;
            clearTimeout(session.bufferingTimer); session.bufferingTimer = undefined;
            session.status = 'playing';
            if (pauseOnReady) { pauseOnReady = false; this.setPaused(session, true); }
            session.panel.update();
        });
        session.connection!.subscribe(player);
        watchBuffering();
        player.play(session.audio!.resource);
    }
}
