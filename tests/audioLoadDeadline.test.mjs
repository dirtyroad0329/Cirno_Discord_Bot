import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MusicPlayer } from '../dist/features/music/playback/player.js';
import { PlaybackEngine } from '../dist/features/music/playback/engine.js';
import { MusicSession } from '../dist/features/music/playback/session.js';
import { VoiceSessionManager } from '../dist/features/voice/sessionManager.js';
import { createRemoteDownloadedAudio } from '../dist/features/music/audio/remoteAudio.js';
import logger from '../dist/shared/logging/logger.js';

test('a real slow drip is aborted by the total loading budget and the guild task waits for file cleanup', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cirno-load-deadline-'));
    let began, closed, chunks = 0;
    const started = new Promise(resolve => { began = resolve; });
    const disconnected = new Promise(resolve => { closed = resolve; });
    const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': '5000' });
        response.write(Buffer.alloc(10)); chunks++;
        const drip = setInterval(() => { chunks++; response.write(Buffer.alloc(10)); }, 60);
        response.on('close', () => { clearInterval(drip); closed(); });
        began();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const keys = ['REMOTE_MUSIC_API_URL', 'REMOTE_MUSIC_API_TOKEN', 'REMOTE_MUSIC_CACHE_DIRECTORY'];
    const saved = keys.map(key => process.env[key]);
    process.env.REMOTE_MUSIC_API_URL = `http://127.0.0.1:${server.address().port}/`;
    process.env.REMOTE_MUSIC_API_TOKEN = 'deadline-fixture'; process.env.REMOTE_MUSIC_CACHE_DIRECTORY = directory;
    t.after(async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
        await rm(directory, { recursive: true, force: true });
    });
    const errors = []; t.mock.method(logger, 'error', error => errors.push(error));
    const player = new MusicPlayer();
    const channel = { id: 'voice', guild: { id: 'deadline-guild', voiceStates: { cache: new Map([['user', { channelId: 'voice' }]]) } } };
    const session = new MusicSession(channel, new VoiceSessionManager().acquire(channel.guild.id, 'music'), () => ({ update() {}, attach() {} }));
    const track = { source: 'remote', id: '00000000-0000-4000-8000-000000000001', title: 'Slow MP4', mimeType: 'audio/mp4', byteSize: 5000, sha256: 'a'.repeat(64) };
    session.queue.add({ track, requestedBy: 'User' });
    player.sessions.set(channel.guild.id, session); session.lease.onDispose(() => player.dispose(session));
    let loadSignal;
    player.playback = new PlaybackEngine({ end: (current, notice) => player.end(current, notice), scheduleAdvance() {} },
        (...args) => { loadSignal = args[3].signal; return createRemoteDownloadedAudio(...args); }, 500);
    t.after(() => player.shutdown());
    const loading = player.tasks.run(channel.guild.id, () => player.playback.advance(session, 'finished'));
    await started;
    let followingRan = false;
    const following = player.tasks.run(channel.guild.id, async () => {
        followingRan = true;
        // This proves task release waited for actual aborted pipeline and temporary-file cleanup.
        assert.deepEqual(await readdir(directory), []);
    });
    assert.equal(followingRan, false);
    await Promise.all([loading, following, disconnected]);
    assert.ok(chunks >= 2, 'The server kept sending inside the 15-second idle budget.');
    assert.equal(loadSignal.aborted, true); assert.equal(followingRan, true);
    assert.equal(session.active, false); assert.equal(errors.length, 1);
    assert.match(errors[0].message, /abort/i);
});

test('the loading budget is cleared after a stream becomes playable and does not cancel ongoing playback', async t => {
    const channel = { id: 'voice', guild: { id: 'stream-deadline-guild' } };
    const session = new MusicSession(channel, new VoiceSessionManager().acquire(channel.guild.id, 'music'), () => ({ update() {}, attach() {} }));
    session.queue.add({ track: { id: 'a', title: 'A' }, requestedBy: 'User' }); session.queue.advance('finished');
    let signal, disposed = 0;
    const engine = new PlaybackEngine({ end() {}, scheduleAdvance() {} }, async (_track, _volume, _error, controller) => {
        signal = controller.signal; return { resource: {}, dispose() { disposed++; controller.abort(); } };
    }, 10);
    t.mock.method(engine, 'attachPlayer', () => { session.status = 'playing'; });
    t.after(() => { session.clearAudio(); session.lease.release(); });
    await engine.playCurrent(session); await delay(35);
    assert.equal(session.status, 'playing'); assert.equal(signal.aborted, false); assert.equal(disposed, 0);
});
