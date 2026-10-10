import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';
import { loadCommands, registerGlobalCommands } from './commandLoader.js';
import { registerInteractions } from './interactions.js';
import { registerReload } from './reload.js';
import { registerMentions } from '../features/assistant/presentation/mentions.js';
import { registerVoiceEntrancePlayer } from '../features/voice/entrancePlayer.js';
import { musicPlayer } from '../features/music/playback/player.js';
import logger from '../shared/logging/logger.js';

export async function startBot(options: { handleSignals?: boolean; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const config = { token: process.env.TOKEN ?? '', clientId: process.env.CLIENT_ID ?? '', testerId: process.env.TESTER_ID ?? '' };
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    client.commands = new Collection();
    const cleanup = [registerVoiceEntrancePlayer(client), registerInteractions(client), registerReload(client, config), registerMentions(client)];
    musicPlayer.initialize(client);
    const onReady = (ready: Client<true>) => logger.info(`Ready! Logged in as ${ready.user.tag}`);
    client.once(Events.ClientReady, onReady);
    let stopped = false;
    let rejectStartup: ((reason: unknown) => void) | undefined;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        options.signal?.removeEventListener('abort', stop);
        client.off(Events.ClientReady, onReady);
        process.off('SIGTERM', stop); process.off('SIGINT', stop);
        // A failed feature cleanup must not leave the shared player or Gateway alive.
        for (const dispose of [...cleanup, () => musicPlayer.shutdown(),
            () => { void client.destroy().catch(error => logger.error(error)); }]) {
            try { dispose(); }
            catch (error) { logger.error(error); }
        }
        rejectStartup?.(options.signal?.aborted ? options.signal.reason : new Error('Bot startup stopped.'));
    };
    const interrupted = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.handleSignals !== false) {
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
    }
    const ensureRunning = () => {
        options.signal?.throwIfAborted();
        if (stopped) throw new Error('Bot startup stopped.');
    };
    const startup = async () => {
        ensureRunning();
        try {
            const commands = await loadCommands(client);
            ensureRunning();
            await registerGlobalCommands(config.token, config.clientId, commands);
        } catch (error) { if (!stopped) logger.error(error); }
        ensureRunning();
        await client.login(config.token);
        ensureRunning();
    };
    try {
        // Login itself has no AbortSignal API. Destroy immediately, and prevent its
        // late completion from publishing a stopped Client as successful startup.
        await Promise.race([startup(), interrupted]);
    }
    catch (error) { stop(); throw error; }
    finally { rejectStartup = undefined; }
    return { client, stop };
}
