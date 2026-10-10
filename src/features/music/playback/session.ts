import { randomUUID } from 'node:crypto';
import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { VoiceChannel } from 'discord.js';
import { MusicQueue } from '../model/queue.js';
import type { SessionPanel, MusicPanelState } from '../model/panel.js';
import type { VoiceLease } from '../../voice/sessionManager.js';
import type { createLocalAudio } from '../audio/localAudio.js';

export class MusicSession {
    readonly id = randomUUID().slice(0, 12);
    readonly queue = new MusicQueue();
    readonly panel: SessionPanel;
    status: MusicPanelState['status'] = 'connecting';
    volume = 70;
    offset = 0;
    generation = 0;
    failures = 0;
    notice?: string;
    connection?: VoiceConnection;
    player?: AudioPlayer;
    audio?: ReturnType<typeof createLocalAudio>;
    progressTimer?: NodeJS.Timeout;
    emptyTimer?: NodeJS.Timeout;
    pauseTimer?: NodeJS.Timeout;
    bufferingTimer?: NodeJS.Timeout;
    loadController?: AbortController;
    connectionController?: AbortController;
    recovering = false;
    hasConnected = false;
    constructor(readonly channel: VoiceChannel, readonly lease: VoiceLease,
        createPanel: (view: () => MusicPanelState) => SessionPanel, onChange?: () => void) {
        this.panel = createPanel(() => this.view());
        if (onChange) {
            const update = this.panel.update.bind(this.panel);
            this.panel.update = (immediate?: boolean) => {
                update(immediate);
                onChange();
            };
        }
    }
    get active(): boolean { return this.lease.active && this.status !== 'ended'; }
    view(): MusicPanelState {
        return {
            id: this.id, generation: this.generation, channelId: this.channel.id,
            queue: this.queue, status: this.status, volume: this.volume,
            elapsed: this.offset + (this.audio?.resource.playbackDuration ?? 0) / 1000, notice: this.notice
        };
    }
    clearAudio(): void {
        clearTimeout(this.bufferingTimer); this.bufferingTimer = undefined;
        clearTimeout(this.pauseTimer); this.pauseTimer = undefined;
        this.loadController?.abort(); this.loadController = undefined;
        // Remove listeners before stop(), which emits Idle synchronously.
        this.player?.removeAllListeners();
        this.player?.stop(true); this.player = undefined;
        this.audio?.dispose(); this.audio = undefined;
    }
}
