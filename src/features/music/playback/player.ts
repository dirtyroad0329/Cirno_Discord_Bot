import { UserActionError, ConfigurationError } from '../../../shared/logging/operationErrors.js';
import { entersState, joinVoiceChannel, VoiceConnectionStatus, type DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { Events, type Client, type GuildTextBasedChannel, type VoiceChannel } from 'discord.js';
import type { MusicTrack } from '../model/track.js';
import { GuildTasks } from '../../../shared/async/guildTasks.js';
import { MusicPanel, renderMusicPanel } from '../presentation/panel.js';
import { voiceSessions } from '../../voice/sessionManager.js';
import { MusicSession } from './session.js';
import { PlaybackEngine } from './engine.js';
import { assertPlaybackPermissions } from './permissions.js';
import logger from '../../../shared/logging/logger.js';
import { logInteractionError } from '../../../shared/discord/interactionErrors.js';
import { assertRequestActive, PlaybackOperationError, type PlaybackOperationContext } from '../model/control.js';

export interface PlaybackTaskOptions {
    context?: PlaybackOperationContext;
    /** Rechecks the caller's live access at execution time, without owning HTTP/authentication. */
    authorize?: () => void;
}

export class MusicPlayer {
    private sessions = new Map<string, MusicSession>();
    private tasks = new GuildTasks();
    private voiceCleanup?: () => void;
    private stopped = false;
    private lifecycle = 0;
    private observers = new Set<(guildId: string) => unknown>();
    private notices = new Map<string, { channelId: string; text: string }>();
    readonly playback = new PlaybackEngine({
        end: (session, notice) => this.end(session, notice),
        scheduleAdvance: (session, token, reason, error) => this.scheduleAdvance(session, token, reason, error)
    });
    get(guildId: string): MusicSession | undefined { return this.sessions.get(guildId); }
    get available(): boolean { return !this.stopped; }
    lastNotice(guildId: string, channelId: string): string | undefined {
        const notice = this.notices.get(guildId);
        return notice?.channelId === channelId ? notice.text : undefined;
    }
    subscribe(observer: (guildId: string) => unknown): () => void {
        this.observers.add(observer);
        return () => { this.observers.delete(observer); };
    }
    private publish(guildId: string): void {
        for (const observer of [...this.observers]) {
            try {
                // Observers may fail, but must never block guild work on a slow client.
                void Promise.resolve(observer(guildId)).catch(error => logInteractionError(error));
            } catch (error) { logInteractionError(error); }
        }
    }
    initialize(client: Client): void {
        if (this.voiceCleanup) return;
        this.stopped = false;
        const listener = (oldState: import('discord.js').VoiceState, newState: import('discord.js').VoiceState) => {
            const session = this.get(newState.guild.id);
            if (!session) { this.publish(newState.guild.id); return; }
            if (session.hasConnected && newState.id === client.user?.id && oldState.channelId === session.channel.id && newState.channelId !== session.channel.id) {
                this.end(session, 'Bot 已離開原語音頻道。');
            } else this.checkEmpty(session);
            this.publish(newState.guild.id);
        };
        client.on(Events.VoiceStateUpdate, listener);
        this.voiceCleanup = () => { client.off(Events.VoiceStateUpdate, listener); };
    }
    shutdown(): void {
        if (this.stopped) return;
        // Invalidate pending work before releasing sessions; a restart cannot revive it.
        this.stopped = true; this.lifecycle++;
        this.voiceCleanup?.(); this.voiceCleanup = undefined;
        for (const session of [...this.sessions.values()]) this.end(session, 'Bot 已停止，播放結束。');
    }
    private async runTask<T>(guildId: string, task: () => Promise<T> | T, options?: PlaybackTaskOptions): Promise<T> {
        const lifecycle = this.lifecycle;
        if (this.stopped) throw new UserActionError('播放器已停止或重新啟動，請重新操作。');
        assertRequestActive(options?.context);
        return this.tasks.run(guildId, () => {
            if (this.stopped || this.lifecycle !== lifecycle) throw new UserActionError('播放器已停止或重新啟動，請重新操作。');
            assertRequestActive(options?.context);
            options?.authorize?.();
            return task();
        });
    }
    private assertContext(session: MusicSession | undefined, context?: PlaybackOperationContext, songSpecific = false): void {
        assertRequestActive(context);
        if (!context) return;
        if ((session?.id ?? null) !== context.sessionId || session && !session.active) {
            throw new PlaybackOperationError('STALE_SESSION', '播放工作階段已變更，請重新查看播放器。');
        }
        if (songSpecific && (!Number.isInteger(context.generation) || context.generation !== session?.generation)) {
            throw new PlaybackOperationError('STALE_TRACK', '歌曲已切換，請使用更新後的播放器。');
        }
    }
    private checkEmpty(session: MusicSession): void {
        if (!session.active) return;
        if (session.channel.members.some(member => !member.user.bot)) {
            clearTimeout(session.emptyTimer); session.emptyTimer = undefined;
        } else if (!session.emptyTimer) {
            session.emptyTimer = setTimeout(() => {
                if (session.active && !session.channel.members.some(member => !member.user.bot)) this.end(session, '頻道已無真人 60 秒，播放結束。');
            }, 60_000).unref();
        }
    }
    assertListener(session: MusicSession, userId: string): void {
        if (session.channel.guild.voiceStates.cache.get(userId)?.channelId !== session.channel.id) {
            throw new UserActionError(`請先加入 <#${session.channel.id}>，才能控制播放器。`);
        }
    }
    assertPanel(guildId: string, sessionId: string, messageId: string): MusicSession {
        const session = this.get(guildId);
        if (!session?.active || session.id !== sessionId || session.panel.message?.id !== messageId) {
            throw new UserActionError('此面板已失效，請使用 /music panel 或 /music play。');
        }
        return session;
    }
    async enqueue(channel: VoiceChannel, textChannel: GuildTextBasedChannel, userId: string, requestedBy: string, track: MusicTrack): Promise<MusicSession> {
        return this.enqueueMany(channel, textChannel, userId, requestedBy, [track]);
    }
    async enqueueMany(channel: VoiceChannel, textChannel: GuildTextBasedChannel | undefined, userId: string, requestedBy: string, tracks: MusicTrack[], next = false, options?: PlaybackTaskOptions): Promise<MusicSession> {
        if (!tracks.length || tracks.length > 100) throw new UserActionError('一次請加入 1–100 首歌曲。');
        return this.runTask(channel.guild.id, async () => {
            let session = this.get(channel.guild.id);
            this.assertContext(session, options?.context);
            if (session) {
                this.assertListener(session, userId);
                session.queue.addMany(tracks.map(track => ({ track, requestedBy })), next);
                session.panel.update();
                return session;
            }
            assertPlaybackPermissions(channel, textChannel, userId);
            const lease = voiceSessions.acquire(channel.guild.id, 'music')!;
            session = new MusicSession(channel, lease, view => new MusicPanel(view, logInteractionError), () => this.publish(channel.guild.id));
            const current = session;
            this.notices.delete(channel.guild.id);
            this.sessions.set(channel.guild.id, current);
            lease.onDispose(() => this.dispose(current));
            current.queue.addMany(tracks.map(track => ({ track, requestedBy })));
            current.panel.update();
            try {
                if (textChannel) current.panel.attach(await textChannel.send(renderMusicPanel(current.view())));
                if (!current.active) throw new UserActionError('播放已結束，請重新點歌。');
                await this.connect(session);
                return current;
            } catch (error) {
                if (!current.active) throw new UserActionError('播放已結束，請重新點歌。');
                this.end(current, '無法開始播放，請確認音檔與語音權限。');
                if (error instanceof UserActionError || error instanceof ConfigurationError) throw error;
                logInteractionError(error);
                // The underlying failure was logged above; report guidance without a second ERROR.
                throw new UserActionError('無法開始播放，請確認音檔與語音權限後重試。');
            }
        }, options);
    }
    private async connect(session: MusicSession): Promise<void> {
        const controller = session.connectionController = new AbortController();
        const connection = joinVoiceChannel({
            channelId: session.channel.id, guildId: session.channel.guild.id,
            adapterCreator: session.channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
            selfDeaf: true, selfMute: false
        });
        session.connection = connection;
        connection.on('error', error => { logger.error(error); this.end(session, '語音連線發生錯誤。'); });
        connection.on(VoiceConnectionStatus.Disconnected, () => { void this.recover(session); });
        connection.on(VoiceConnectionStatus.Destroyed, () => {
            if (session.active) this.end(session, '語音連線已關閉。');
        });
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
        } finally { if (session.connectionController === controller) session.connectionController = undefined; }
        if (!session.active) throw new UserActionError('播放已結束，請重新點歌。');
        if (connection.joinConfig.channelId !== session.channel.id) throw new UserActionError('Bot 已被移動至其他語音頻道。');
        session.hasConnected = true;
        session.progressTimer = setInterval(() => {
            if (session.status === 'playing') session.panel.update();
        }, 15_000).unref();
        this.checkEmpty(session);
        await this.playback.advance(session, 'finished');
        if (!session.active) throw new UserActionError('音檔無法播放，請選擇其他歌曲。');
    }
    private async recover(session: MusicSession): Promise<void> {
        if (!session.active || session.recovering || !session.connection) return;
        session.recovering = true;
        try { await entersState(session.connection, VoiceConnectionStatus.Ready, 20_000); }
        catch { if (session.active) this.end(session, '語音連線逾時，播放結束。'); }
        finally { session.recovering = false; }
    }
    private scheduleAdvance(session: MusicSession, token: number, reason: 'finished' | 'error', error?: Error): void {
        if (error) logInteractionError(error);
        void this.tasks.run(session.channel.guild.id, async () => {
            if (session.active && session.generation === token) await this.playback.advance(session, reason);
        }).catch(error => { logger.error(error); this.end(session, '播放器發生錯誤。'); });
    }
    async control(guildId: string, userId: string, action: string, panel?: { sessionId: string; messageId: string; generation: number }, value?: number | string, options?: PlaybackTaskOptions): Promise<void> {
        const loading = this.get(guildId);
        const songSpecific = ['skip', 'previous', 'restart', 'seek'].includes(action);
        // Validate fast cancellation before touching a controller owned by a newer session/song.
        if (options) {
            assertRequestActive(options.context);
            options.authorize?.();
            this.assertContext(loading, options.context, songSpecific);
        }
        // Initial handshake occupies the guild queue; an authorized STOP must release it immediately.
        if (!this.stopped && action === 'stop' && loading?.active && loading.connectionController &&
            loading.channel.guild.voiceStates.cache.get(userId)?.channelId === loading.channel.id &&
            (!panel || (panel.sessionId === loading.id && panel.messageId === loading.panel.message?.id))) {
            this.end(loading, '已結束播放。');
            return;
        }
        if ((action === 'stop' || action === 'skip') && loading?.active &&
            loading.channel.guild.voiceStates.cache.get(userId)?.channelId === loading.channel.id &&
            (!panel || (panel.sessionId === loading.id && panel.messageId === loading.panel.message?.id &&
                (action !== 'skip' || panel.generation === loading.generation)))) loading.loadController?.abort('control');
        return this.runTask(guildId, async () => {
            const session = panel ? this.assertPanel(guildId, panel.sessionId, panel.messageId) : this.get(guildId);
            this.assertContext(session, options?.context, songSpecific);
            if (!session?.active) throw new UserActionError('目前沒有手動播放中的音樂。');
            this.assertListener(session, userId);
            if (panel && ['skip', 'pause', 'previous', 'restart'].includes(action) && panel.generation !== session.generation) throw new UserActionError('歌曲已切換，請使用更新後的面板。');
            if (action === 'stop') { this.end(session, '已結束播放。'); return; }
            await this.playback.control(session, action, value);
            session.panel.update();
        }, options);
    }
    async editQueue(guildId: string, userId: string, sessionId: string, revision: number, action: 'remove' | 'move' | 'clear', from?: number, to?: number, options?: PlaybackTaskOptions): Promise<void> {
        return this.runTask(guildId, () => {
            const session = this.get(guildId);
            this.assertContext(session, options?.context);
            if (!session?.active || session.id !== sessionId) throw new UserActionError('播放已結束，請重新開啟佇列。');
            this.assertListener(session, userId);
            if (session.queue.revision !== revision) {
                if (options?.context) throw new PlaybackOperationError('STALE_QUEUE', '佇列剛剛已變更，請重新查看後操作。');
                throw new UserActionError('佇列剛剛已變更，請重新查看後操作。');
            }
            if (action === 'remove') session.queue.remove(from!);
            else if (action === 'move') session.queue.move(from!, to!);
            else session.queue.clearPending();
            session.panel.update();
        }, options);
    }
    async panel(guildId: string, textChannel: GuildTextBasedChannel, userId: string): Promise<string> {
        return this.runTask(guildId, async () => {
            const session = this.get(guildId);
            if (!session?.active) throw new UserActionError('目前沒有手動播放中的音樂。');
            if (session.panel.message) {
                try { await session.panel.message.fetch(); return session.panel.message.url; }
                catch (error) { if ((error as { code?: number }).code !== 10008) throw error; }
            }
            this.assertListener(session, userId);
            const message = await textChannel.send(renderMusicPanel(session.view()));
            session.panel.attach(message);
            session.panel.update(true);
            return message.url;
        });
    }
    end(session: MusicSession, notice: string): void {
        if (!session.active) return;
        session.notice = notice;
        session.lease.release();
    }
    private dispose(session: MusicSession): void {
        session.status = 'ended'; session.generation++;
        this.notices.set(session.channel.guild.id, { channelId: session.channel.id, text: session.notice ?? '播放已結束。' });
        while (this.notices.size > 1000) this.notices.delete(this.notices.keys().next().value!);
        if (this.get(session.channel.guild.id) === session) this.sessions.delete(session.channel.guild.id);
        clearInterval(session.progressTimer); clearTimeout(session.emptyTimer);
        session.connectionController?.abort(); session.connectionController = undefined;
        session.clearAudio(); session.queue.clear();
        if (session.connection && session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
        session.panel.update(true);
    }
}
export const musicPlayer = new MusicPlayer();
