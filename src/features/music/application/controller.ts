import { ChannelType, Status, type Client, type Guild, type VoiceChannel } from 'discord.js';
import { remoteMusicApiSettings } from '../../../shared/http/musicApi.js';
import { isRemoteTrack } from '../model/track.js';
import type { QueueEntry } from '../model/queue.js';
import {
    assertRequestActive, PlaybackOperationError, type PlaybackOperationContext,
    type PlayerCommand, type PlayerSnapshot, type PlaybackEntry, type VoiceContext
} from '../model/control.js';
import { assertVoicePlaybackPermissions } from '../playback/permissions.js';
import { musicPlayer, type MusicPlayer, type PlaybackTaskOptions } from '../playback/player.js';

/** An application boundary usable without a Discord text panel or an HTTP framework. */
export interface MusicController {
    voiceContexts(userId: string): VoiceContext[];
    snapshot(userId: string, guildId: string): PlayerSnapshot;
    execute(userId: string, guildId: string, command: PlayerCommand, context: PlaybackOperationContext): Promise<PlayerSnapshot>;
    subscribe(listener: (guildId: string) => void | Promise<void>): () => void;
    /** Trusted server configuration; never include this value in a player snapshot. */
    backendSettings(): { baseUrl: string; token: string };
}

function entryDto(entry: QueueEntry): PlaybackEntry {
    const { track } = entry;
    return {
        track: {
            id: track.id, source: isRemoteTrack(track) ? 'remote' : 'local', title: track.title,
            ...(track.artist ? { artist: track.artist } : {}),
            ...(track.duration !== undefined ? { durationSeconds: track.duration } : {})
        },
        requestedBy: entry.requestedBy
    };
}

export function createMusicController(client: Client, player: MusicPlayer = musicPlayer): MusicController {
    function ready(guild?: Guild): void {
        // A single shard can reconnect while the client's overall status remains Ready.
        const shard = guild && client.ws.shards.get(guild.shardId);
        if (!client.isReady() || !player.available || guild?.available === false ||
            shard && shard.status !== Status.Ready) {
            throw new PlaybackOperationError('GATEWAY_UNAVAILABLE', 'Discord 連線暫時無法確認語音狀態，請稍後再試。');
        }
    }
    function userIdValid(userId: string): void {
        if (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) {
            throw new PlaybackOperationError('FORBIDDEN', 'Discord 使用者 ID 無效。');
        }
    }
    function voiceChannel(guild: Guild, userId: string): VoiceChannel {
        ready(guild);
        const voice = guild.voiceStates.cache.get(userId);
        const channel = voice?.channel ?? (voice?.channelId ? guild.channels.cache.get(voice.channelId) : undefined);
        if (!channel || channel.type !== ChannelType.GuildVoice) {
            throw new PlaybackOperationError('VOICE_REQUIRED', '請先加入此伺服器的任一語音頻道。');
        }
        return channel as VoiceChannel;
    }
    function access(userId: string, guildId: string): VoiceChannel {
        userIdValid(userId); ready();
        const guild = client.guilds.cache.get(guildId);
        if (!guild) throw new PlaybackOperationError('FORBIDDEN', '無法存取此 Discord 伺服器。');
        const channel = voiceChannel(guild, userId);
        const session = player.get(guildId);
        if (session?.active && session.channel.id !== channel.id) {
            throw new PlaybackOperationError('FORBIDDEN', `請先加入 <#${session.channel.id}>，才能控制播放器。`);
        }
        return channel;
    }
    function snapshot(userId: string, guildId: string): PlayerSnapshot {
        const channel = access(userId, guildId);
        const session = player.get(guildId);
        const observedAt = new Date().toISOString();
        if (!session?.active) {
            let canPlay = true;
            try { assertVoicePlaybackPermissions(channel, userId); } catch { canPlay = false; }
            const notice = player.lastNotice(guildId, channel.id);
            return {
                guildId, channelId: channel.id, sessionId: null, generation: 0, queueRevision: 0,
                status: notice ? 'ended' : 'idle', current: null, pending: [], volume: 70, repeat: 'off',
                elapsedSeconds: 0, observedAt, canControl: false, canPlay, historyCount: 0,
                ...(notice ? { notice } : {})
            };
        }
        const current = session.queue.current;
        return {
            guildId, channelId: channel.id, sessionId: session.id, generation: session.generation,
            queueRevision: session.queue.revision, status: session.status,
            current: current ? entryDto(current) : null, pending: session.queue.pending.map(entryDto),
            volume: session.volume, repeat: session.queue.repeat,
            elapsedSeconds: session.view().elapsed,
            ...(current?.track.duration !== undefined ? { durationSeconds: current.track.duration } : {}),
            observedAt, canControl: true, canPlay: true, historyCount: session.queue.history.length,
            ...(session.notice ? { notice: session.notice } : {})
        };
    }
    async function execute(userId: string, guildId: string, command: PlayerCommand, context: PlaybackOperationContext): Promise<PlayerSnapshot> {
        if (!context || typeof context !== 'object' ||
            context.sessionId !== null && (typeof context.sessionId !== 'string' || !context.sessionId)) {
            throw new PlaybackOperationError('INVALID_COMMAND', '請提供目前播放器的工作階段。');
        }
        assertRequestActive(context);
        const channel = access(userId, guildId);
        const options: PlaybackTaskOptions = {
            context,
            authorize: () => {
                // Cache entries may change while metadata resolves or a guild task waits.
                const current = access(userId, guildId);
                if (current.id !== channel.id) throw new PlaybackOperationError('FORBIDDEN', '語音頻道已變更，請重新查看播放器。');
            }
        };
        if (!command || typeof command !== 'object') throw new PlaybackOperationError('INVALID_COMMAND', '無效的播放器操作。');
        switch (command.action) {
            case 'enqueue': {
                if (!Array.isArray(command.tracks) || command.tracks.length < 1 || command.tracks.length > 100) {
                    throw new PlaybackOperationError('INVALID_COMMAND', '一次請加入 1–100 首歌曲。');
                }
                const member = channel.guild.voiceStates.cache.get(userId)?.member ?? channel.guild.members.cache.get(userId);
                const requestedBy = (member?.displayName ?? userId).slice(0, 128);
                await player.enqueueMany(channel, undefined, userId, requestedBy, command.tracks, command.next === true, options);
                break;
            }
            case 'remove': case 'move': case 'clear': {
                if (typeof context.sessionId !== 'string' || !Number.isInteger(context.queueRevision) || context.queueRevision! < 0) {
                    throw new PlaybackOperationError('INVALID_COMMAND', '請提供目前佇列的版本。');
                }
                await player.editQueue(guildId, userId, context.sessionId, context.queueRevision!, command.action,
                    command.action === 'remove' ? command.position : command.action === 'move' ? command.from : undefined,
                    command.action === 'move' ? command.to : undefined, options);
                break;
            }
            case 'pause': case 'resume': case 'previous': case 'skip': case 'restart':
            case 'shuffle': case 'stop': case 'seek': case 'volume': case 'repeat':
                await player.control(guildId, userId,
                    command.action === 'pause' ? 'pauseOnly' : command.action === 'repeat' ? 'repeatMode' : command.action,
                    undefined, command.action === 'seek' ? command.seconds : command.action === 'volume' ? command.percent :
                        command.action === 'repeat' ? command.mode : undefined, options);
                break;
            default: throw new PlaybackOperationError('INVALID_COMMAND', '無效的播放器操作。');
        }
        return snapshot(userId, guildId);
    }
    return {
        voiceContexts(userId) {
            userIdValid(userId); ready();
            const result: VoiceContext[] = [];
            for (const guild of client.guilds.cache.values()) {
                if (!guild.voiceStates.cache.get(userId)?.channelId) continue;
                ready(guild);
                const voice = guild.voiceStates.cache.get(userId)!;
                const channel = voice.channel ?? guild.channels.cache.get(voice.channelId!);
                if (channel?.type !== ChannelType.GuildVoice) continue;
                result.push({
                    guildId: guild.id, guildName: guild.name, channelId: channel.id, channelName: channel.name,
                    botChannelId: player.get(guild.id)?.channel.id ?? guild.members.me?.voice.channelId ?? null
                });
            }
            return result;
        },
        snapshot, execute, subscribe: listener => player.subscribe(listener),
        backendSettings() {
            const { base, token } = remoteMusicApiSettings();
            return { baseUrl: base.href, token };
        }
    };
}
