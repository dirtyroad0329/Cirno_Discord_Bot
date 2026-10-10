import { UserActionError, ConfigurationError } from '../../../shared/logging/operationErrors.js';
import { PermissionFlagsBits, type VoiceChannel, type GuildTextBasedChannel } from 'discord.js';

export function assertVoicePlaybackPermissions(channel: VoiceChannel, userId: string): void {
    if (channel.guild.voiceStates.cache.get(userId)?.channelId !== channel.id) throw new UserActionError('請先加入語音頻道再點歌。');
    const me = channel.guild.members.me;
    if (!me || !channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]) || !channel.joinable) {
        throw new ConfigurationError('Bot 需要查看、連線及說話權限，且語音頻道需有可用位置。');
    }
}

export function assertPlaybackPermissions(channel: VoiceChannel, textChannel: GuildTextBasedChannel | undefined, userId: string): void {
    assertVoicePlaybackPermissions(channel, userId);
    if (!textChannel) return;
    const me = channel.guild.members.me!;
    const sendPermission = textChannel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    if (!textChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.EmbedLinks])) {
        throw new ConfigurationError('Bot 需要此文字頻道的查看、傳送訊息及嵌入連結權限。');
    }
}
