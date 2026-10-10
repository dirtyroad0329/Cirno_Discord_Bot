import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMusicServerFixture } from '../integration/music-server-fixture.mjs';
import { startWebsiteFixture } from '../integration/website-fixture.mjs';

export const productionClient = fileURLToPath(new URL('../../dist/client/', import.meta.url));

/** This port replaces only Discord Gateway/audio. Website, auth, Server DB, HTTP and Nginx are real. */
export function controlledBot() {
  const guildId = '333456789012345678';
  const channelId = '433456789012345678';
  let inVoice = false, clock = Date.now(), holdNext = false, release;
  const listeners = new Set();
  const commands = [];
  let state = { guildId, channelId, sessionId: null, generation: 0, queueRevision: 0, status: 'idle',
    current: null, pending: [], volume: 75, repeat: 'off', elapsedSeconds: 0,
    canControl: true, canPlay: true, historyCount: 0, observedAt: new Date(clock).toISOString() };
  const snapshot = () => structuredClone(state);
  const changed = () => { state.observedAt = new Date(++clock).toISOString(); for (const listener of listeners) listener(guildId); };
  return {
    guildId, commands,
    get state() { return snapshot(); },
    setInVoice(value) { inVoice = value; changed(); },
    holdNextEnqueue() { holdNext = true; },
    external(patch) { Object.assign(state, patch); changed(); },
    async voiceContexts() { return inVoice ? [{ guildId, guildName: 'Cirno 測試伺服器', channelId,
      channelName: '音樂測試室', botChannelId: state.sessionId ? channelId : null }] : []; },
    async snapshot() { if (!inVoice) throw Object.assign(new Error('VOICE_REQUIRED'), { code: 'VOICE_REQUIRED' }); return snapshot(); },
    async execute(userId, _guildId, command) {
      commands.push({ userId, command: structuredClone(command) });
      if (command.action === 'enqueue') {
        const entries = command.tracks.map(track => ({ track: { ...track, durationSeconds: track.duration }, requestedBy: userId }));
        if (!state.current) {
          state.sessionId = randomUUID(); ++state.generation;
          state.current = entries.shift(); state.elapsedSeconds = 0; state.durationSeconds = state.current.track.durationSeconds;
        }
        state.pending.push(...entries); ++state.queueRevision;
        if (holdNext) {
          holdNext = false; state.status = 'connecting'; changed();
          await new Promise(resolve => { release = resolve; });
          return snapshot();
        }
        state.status = 'playing';
      } else if (command.action === 'stop') {
        state = { ...state, sessionId: null, generation: state.generation + 1, queueRevision: state.queueRevision + 1,
          status: 'idle', current: null, pending: [], elapsedSeconds: 0, durationSeconds: undefined };
        release?.(); release = undefined;
      } else if (command.action === 'pause') state.status = 'paused';
      else if (command.action === 'resume') state.status = 'playing';
      else if (command.action === 'seek') state.elapsedSeconds = command.seconds;
      else if (command.action === 'volume') state.volume = command.percent;
      else if (command.action === 'repeat') state.repeat = command.mode;
      else if (command.action === 'clear') { state.pending = []; ++state.queueRevision; }
      else if (command.action === 'skip') {
        state.current = state.pending.shift() ?? null; state.status = state.current ? 'playing' : 'ended';
        ++state.generation; ++state.queueRevision;
      }
      changed(); return snapshot();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { release?.(); listeners.clear(); },
  };
}

async function seedAudio(server) {
  const work = join(server.root, 'generated'); await mkdir(work);
  const formats = [
    { key: 'MP3', extension: 'mp3', mime: 'audio/mpeg', codec: ['-c:a', 'libmp3lame', '-b:a', '96k'] },
    { key: 'M4A AAC', extension: 'm4a', mime: 'audio/mp4', codec: ['-c:a', 'aac', '-b:a', '96k'] },
    { key: 'Ogg Opus', extension: 'ogg', mime: 'audio/ogg', codec: ['-c:a', 'libopus', '-b:a', '64k'] },
    { key: 'WebM Opus', extension: 'webm', mime: 'audio/webm', codec: ['-c:a', 'libopus', '-b:a', '64k'] },
    { key: 'WAV', extension: 'wav', mime: 'audio/wav', codec: ['-c:a', 'pcm_s16le'] },
    { key: 'FLAC', extension: 'flac', mime: 'audio/flac', codec: ['-c:a', 'flac'] },
  ];
  const samples = [];
  for (const format of formats) {
    const fileKey = `${randomUUID()}.${format.extension}`, path = join(server.audioRoot, fileKey);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'sine=frequency=440:duration=12:sample_rate=48000', ...format.codec, path], { timeout: 30000 });
    const bytes = await readFile(path); await chmod(path, 0o644);
    const song = await server.db.song.create({ data: { id: randomUUID(), fileKey,
      title: `Browser sample ${format.key}`, artist: 'Synthetic FFmpeg sine', durationSeconds: 12,
      mimeType: format.mime, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
    samples.push({ ...format, song });
  }
  // A valid database/catalog entry with undecodable bytes must produce a real media error.
  const badBytes = Buffer.from('This synthetic fixture is intentionally not an audio bitstream.');
  const fileKey = `${randomUUID()}.flac`;
  await writeFile(join(server.audioRoot, fileKey), badBytes); await chmod(join(server.audioRoot, fileKey), 0o644);
  const brokenSong = await server.db.song.create({ data: { id: randomUUID(), fileKey,
    title: 'Browser sample corrupt', artist: 'Synthetic negative case', durationSeconds: 12,
    mimeType: 'audio/flac', byteSize: badBytes.length, sha256: createHash('sha256').update(badBytes).digest('hex') } });
  for (let index = 0; index < 24; ++index) {
    const bytes = Buffer.from(server.songBytes); bytes.writeInt16LE(index + 300, 44);
    const fileKey = `${randomUUID()}.wav`;
    await writeFile(join(server.audioRoot, fileKey), bytes); await chmod(join(server.audioRoot, fileKey), 0o644);
    await server.db.song.create({ data: { id: randomUUID(), fileKey, title: `Page sample ${String(index).padStart(2, '0')}`,
      artist: 'Pagination fixture', durationSeconds: 1, mimeType: 'audio/wav', byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') } });
  }
  return { samples, brokenSong };
}

export async function startBrowserFixture() {
  // Deliberately require production Vite output, never run a dev server or silently build stale source.
  await readFile(join(productionClient, 'index.html'));
  const server = await startMusicServerFixture({ nginx: true });
  const bot = controlledBot(); let website;
  try {
    const media = await seedAudio(server);
    website = await startWebsiteFixture({ musicBase: server.base, bot, clientDist: productionClient,
      env: { WEB_SSE_RECHECK_MS: '250' } });
    return { server, website, bot, ...media, close: async () => {
      bot.close(); try { await website.close(); } finally { await server.close(); }
    } };
  } catch (error) { bot.close(); await website?.close(); await server.close(); throw error; }
}
