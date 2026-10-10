import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, ChannelType, Events, Status } from 'discord.js';
import { createMusicController, PlaybackOperationError } from '../dist/features/music/api.js';
import { MusicPlayer } from '../dist/features/music/playback/player.js';
import logger from '../dist/shared/logging/logger.js';

const owner = '111111111111111111', guest = '222222222222222222', outsider = '333333333333333333';
let fixtureId = 0;
const track = id => ({ id, title: `Song ${id}`, artist: 'Artist', duration: 120,
    path: `/private/music/${id}.wav`, filename: `${id}.wav` });
const operation = snapshot => ({ sessionId: snapshot.sessionId, generation: snapshot.generation, queueRevision: snapshot.queueRevision });
const isError = code => error => error instanceof PlaybackOperationError && error.code === code;

function fixture(t) {
    const client = new EventEmitter(), player = new MusicPlayer();
    let ready = true;
    client.isReady = () => ready;
    client.user = { id: '999999999999999999' };
    client.ws = { shards: new Map([[0, { status: Status.Ready }]]) };
    const guild = {
        id: `controller-${++fixtureId}`, name: 'Guild', shardId: 0, available: true,
        voiceStates: { cache: new Collection() }, channels: { cache: new Collection() },
        members: { me: { voice: { channelId: null } }, cache: new Collection() }
    };
    const member = { displayName: 'Listener', user: { bot: false } };
    const channel = {
        id: 'voice', name: 'Music', type: ChannelType.GuildVoice, guild,
        members: new Collection([[owner, member]]), joinable: true, permissionsFor: () => ({ has: () => true })
    };
    const other = { ...channel, id: 'other', name: 'Other' };
    guild.channels.cache.set(channel.id, channel); guild.channels.cache.set(other.id, other);
    guild.voiceStates.cache.set(owner, { channelId: channel.id, channel, member });
    guild.voiceStates.cache.set(guest, { channelId: channel.id, channel, member: { ...member, displayName: 'Guest' } });
    guild.voiceStates.cache.set(outsider, { channelId: other.id, channel: other, member });
    client.guilds = { cache: new Collection([[guild.id, guild]]) };
    player.initialize(client);
    function attachAudio(session, offset = 0, paused = false) {
        session.player = { pause: () => true, unpause: () => true, stop() {}, removeAllListeners() {} };
        session.audio = { resource: { playbackDuration: 1000, volume: { setVolume() {} } }, dispose() {} };
        session.status = paused ? 'paused' : 'playing'; session.offset = offset;
    }
    const connect = t.mock.method(player, 'connect', async session => {
        session.queue.advance('finished'); session.generation++; session.hasConnected = true;
        attachAudio(session); session.panel.update();
    });
    t.mock.method(player.playback, 'playCurrent', async (session, offset = 0, paused = false) => {
        session.clearAudio(); session.generation++; attachAudio(session, offset, paused); session.panel.update();
    });
    const controller = createMusicController(client, player);
    t.after(() => player.shutdown());
    const start = ids => controller.execute(owner, guild.id, { action: 'enqueue', tracks: ids.map(track) }, { sessionId: null });
    return { client, player, guild, channel, other, controller, connect, start, setReady: value => { ready = value; } };
}

async function holdGuild(player, guildId, t) {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const running = player.tasks.run(guildId, () => {
        started(); return new Promise(resolve => { release = resolve; });
    });
    await ready;
    t.after(() => release());
    return { release, running };
}

test('a panel-free public start joins the live voice channel and later accepts the original Discord panel', async t => {
    const { controller, guild, player, start, connect } = fixture(t);
    assert.deepEqual(controller.voiceContexts(owner), [{ guildId: guild.id, guildName: 'Guild', channelId: 'voice', channelName: 'Music', botChannelId: null }]);
    const snapshot = await start(['a', 'b']);
    assert.equal(snapshot.status, 'playing'); assert.equal(snapshot.channelId, 'voice');
    assert.equal(connect.mock.callCount(), 1);
    const session = player.get(guild.id);
    assert.equal(session.panel.message, undefined);
    const text = { send: t.mock.fn(async () => ({ id: 'panel', url: 'https://discord.invalid/panel', edit: async () => {} })) };
    assert.equal(await player.panel(guild.id, text, owner), 'https://discord.invalid/panel');
    assert.equal(session.panel.message.id, 'panel'); assert.equal(text.send.mock.callCount(), 1);
    await player.control(guild.id, owner, 'pause', { sessionId: session.id, messageId: 'panel', generation: session.generation });
    assert.equal(controller.snapshot(owner, guild.id).status, 'paused');
    assert.equal(controller.voiceContexts(owner)[0].botChannelId, 'voice');
});

test('snapshots contain independent plain DTOs without local paths or remote audio credentials', async t => {
    const { controller, guild, player, start } = fixture(t);
    await start(['a', 'b']);
    const session = player.get(guild.id);
    session.queue.add({ track: { id: 'remote', source: 'remote', title: 'Remote', mimeType: 'audio/wav', byteSize: 123, sha256: 'hidden-hash' }, requestedBy: 'Guest' });
    const snapshot = controller.snapshot(owner, guild.id);
    const encoded = JSON.stringify(snapshot);
    for (const hidden of ['path', 'filename', 'private/music', 'sha256', 'hidden-hash', 'byteSize', 'mimeType', 'token', 'connection']) assert.equal(encoded.includes(hidden), false, hidden);
    assert.equal(snapshot.current.track.durationSeconds, 120);
    assert.deepEqual(snapshot.pending[1].track, { id: 'remote', source: 'remote', title: 'Remote' });
    snapshot.current.track.title = 'Changed'; snapshot.pending.splice(0); snapshot.volume = -1;
    assert.equal(session.queue.current.track.title, 'Song a'); assert.equal(session.queue.pending.length, 2); assert.equal(session.volume, 70);
    assert.equal(Object.getPrototypeOf(controller.snapshot(owner, guild.id)), Object.prototype);
});

test('every read and mutation requires reliable Gateway state and membership in the active voice channel', async t => {
    const { controller, guild, channel, player, start, setReady, client } = fixture(t);
    const current = await start(['a']);
    assert.throws(() => controller.snapshot(outsider, guild.id), isError('FORBIDDEN'));
    await assert.rejects(controller.execute(outsider, guild.id, { action: 'stop' }, operation(current)), isError('FORBIDDEN'));
    guild.voiceStates.cache.delete(owner);
    assert.throws(() => controller.snapshot(owner, guild.id), isError('VOICE_REQUIRED'));
    assert.deepEqual(controller.voiceContexts(owner), []);
    guild.voiceStates.cache.set(owner, { channelId: channel.id, channel });
    channel.type = ChannelType.GuildStageVoice;
    assert.deepEqual(controller.voiceContexts(owner), []);
    assert.throws(() => controller.snapshot(owner, guild.id), isError('VOICE_REQUIRED'));
    channel.type = ChannelType.GuildVoice;
    setReady(false);
    assert.throws(() => controller.voiceContexts(owner), isError('GATEWAY_UNAVAILABLE'));
    setReady(true); client.ws.shards.get(0).status = Status.Reconnecting;
    assert.throws(() => controller.snapshot(owner, guild.id), isError('GATEWAY_UNAVAILABLE'));
    client.ws.shards.get(0).status = Status.Ready; guild.available = false;
    assert.throws(() => controller.voiceContexts(owner), isError('GATEWAY_UNAVAILABLE'));
    assert.equal(player.get(guild.id).active, true);
});

test('idle snapshots report missing bot permissions and runtime command validation rejects incomplete contexts', async t => {
    const { controller, guild, channel } = fixture(t);
    channel.joinable = false;
    assert.equal(controller.snapshot(owner, guild.id).canPlay, false);
    assert.throws(() => controller.snapshot('123', guild.id), isError('FORBIDDEN'));
    await assert.rejects(controller.execute(owner, guild.id, { action: 'enqueue', tracks: [track('a')] }, undefined), isError('INVALID_COMMAND'));
    await assert.rejects(controller.execute(owner, guild.id, { action: 'unknown' }, { sessionId: null }), isError('INVALID_COMMAND'));
    await assert.rejects(controller.execute(owner, guild.id, { action: 'enqueue', tracks: [] }, { sessionId: null }), isError('INVALID_COMMAND'));
});

test('concurrent idle starts use one session and reject the caller that observed an obsolete idle state', async t => {
    const { controller, guild, player, connect, start } = fixture(t);
    const first = start(['a']), second = start(['b']);
    const rejected = assert.rejects(second, isError('STALE_SESSION'));
    await Promise.all([first, rejected]);
    assert.equal(connect.mock.callCount(), 1); assert.equal(player.get(guild.id).queue.current.track.id, 'a');
    assert.equal(controller.snapshot(owner, guild.id).pending.length, 0);
});

test('queued actions recheck voice membership, expiry and cancellation before changing shared state', async t => {
    const { controller, guild, channel, other, player, start } = fixture(t);
    const current = await start(['a', 'b']);
    const held = await holdGuild(player, guild.id, t);
    const moved = controller.execute(owner, guild.id, { action: 'volume', percent: 4 }, operation(current));
    const movedRejection = assert.rejects(moved, isError('FORBIDDEN'));
    guild.voiceStates.cache.set(owner, { channelId: other.id, channel: other });
    held.release(); await Promise.all([held.running, movedRejection]);
    guild.voiceStates.cache.set(owner, { channelId: channel.id, channel });
    const again = await holdGuild(player, guild.id, t), abort = new AbortController();
    const cancelled = controller.execute(owner, guild.id, { action: 'clear' }, { ...operation(current), signal: abort.signal });
    const expired = controller.execute(owner, guild.id, { action: 'volume', percent: 5 }, { ...operation(current), expiresAt: Date.now() + 50 });
    const failures = [assert.rejects(cancelled, isError('REQUEST_EXPIRED')), assert.rejects(expired, isError('REQUEST_EXPIRED'))];
    abort.abort();
    // Advance the wall clock only for the queued deadline check, without running new work.
    const now = Date.now; t.mock.method(Date, 'now', () => now() + 100);
    again.release(); await Promise.all([again.running, ...failures]);
    assert.equal(player.get(guild.id).volume, 70); assert.equal(player.get(guild.id).queue.pending.length, 1);
});

test('session, song and queue versions are checked atomically inside the guild task', async t => {
    const { controller, guild, player, start } = fixture(t);
    const first = await start(['a', 'b', 'c']);
    const removed = controller.execute(owner, guild.id, { action: 'remove', position: 1 }, operation(first));
    const stale = controller.execute(guest, guild.id, { action: 'move', from: 1, to: 2 }, operation(first));
    await Promise.all([removed, assert.rejects(stale, isError('STALE_QUEUE'))]);
    const held = await holdGuild(player, guild.id, t);
    const seek = controller.execute(owner, guild.id, { action: 'seek', seconds: 12 }, operation(first));
    const rejection = assert.rejects(seek, isError('STALE_TRACK'));
    player.get(guild.id).generation++;
    held.release(); await Promise.all([held.running, rejection]);
    await controller.execute(owner, guild.id, { action: 'stop' }, operation(controller.snapshot(owner, guild.id)));
    const replacement = await start(['new']);
    await assert.rejects(controller.execute(owner, guild.id, { action: 'stop' }, operation(first)), isError('STALE_SESSION'));
    assert.equal(player.get(guild.id).id, replacement.sessionId);
});

test('all public player controls operate the shared Discord session with idempotent pause and explicit repeat', async t => {
    const { controller, guild, player, start } = fixture(t);
    await start(['a', 'b', 'c']);
    const run = command => controller.execute(owner, guild.id, command, operation(controller.snapshot(owner, guild.id)));
    await run({ action: 'pause' }); await run({ action: 'pause' });
    assert.equal(controller.snapshot(owner, guild.id).status, 'paused');
    await run({ action: 'seek', seconds: 25 }); assert.equal(player.get(guild.id).offset, 25);
    await run({ action: 'restart' }); assert.equal(player.get(guild.id).offset, 0);
    await run({ action: 'resume' }); await run({ action: 'resume' });
    await run({ action: 'volume', percent: 31 }); assert.equal(player.get(guild.id).volume, 31);
    await run({ action: 'repeat', mode: 'one' }); assert.equal(player.get(guild.id).queue.repeat, 'one');
    await run({ action: 'skip' }); assert.equal(player.get(guild.id).queue.current.track.id, 'b');
    await run({ action: 'previous' }); assert.equal(player.get(guild.id).queue.current.track.id, 'a');
    await run({ action: 'shuffle' });
    await run({ action: 'enqueue', tracks: [track('d')], next: true });
    assert.equal(player.get(guild.id).queue.pending[0].track.id, 'd');
    await run({ action: 'move', from: 1, to: 2 }); assert.equal(player.get(guild.id).queue.pending[1].track.id, 'd');
    await run({ action: 'remove', position: 2 }); assert.equal(player.get(guild.id).queue.pending.length, 2);
    await run({ action: 'clear' }); assert.equal(player.get(guild.id).queue.pending.length, 0);
    const ended = await run({ action: 'stop' });
    assert.equal(ended.status, 'ended'); assert.equal(ended.notice, '已結束播放。'); assert.equal(ended.canControl, false);
    assert.equal(controller.snapshot(outsider, guild.id).notice, undefined);
});

test('old or unauthorized fast STOP and SKIP cannot abort a newer handshake or song', async t => {
    const { controller, guild, player, start } = fixture(t);
    const current = await start(['a', 'b']);
    const session = player.get(guild.id);
    const handshake = session.connectionController = new AbortController();
    await assert.rejects(controller.execute(owner, guild.id, { action: 'stop' }, { sessionId: 'old' }), isError('STALE_SESSION'));
    await assert.rejects(controller.execute(outsider, guild.id, { action: 'stop' }, operation(current)), isError('FORBIDDEN'));
    assert.equal(handshake.signal.aborted, false);
    let held;
    const ready = new Promise(resolve => { held = resolve; });
    const holding = player.tasks.run(guild.id, () => new Promise(resolve => {
        handshake.signal.addEventListener('abort', resolve, { once: true }); held();
    }));
    await ready;
    const ended = await controller.execute(owner, guild.id, { action: 'stop' }, operation(current));
    await holding; assert.equal(handshake.signal.aborted, true); assert.equal(ended.status, 'ended');
    const replacement = await start(['c', 'd']);
    const load = player.get(guild.id).loadController = new AbortController();
    await assert.rejects(controller.execute(owner, guild.id, { action: 'skip' }, { ...operation(replacement), generation: replacement.generation - 1 }), isError('STALE_TRACK'));
    assert.equal(load.signal.aborted, false);
    await controller.execute(owner, guild.id, { action: 'skip' }, operation(replacement));
    assert.equal(load.signal.reason, 'control'); assert.equal(player.get(guild.id).queue.current.track.id, 'd');
});

test('throwing, rejected and stalled observers cannot reject or hold shared playback tasks; unsubscribe cleans delivery', async t => {
    const { controller, guild, client, channel, start, player } = fixture(t);
    const errors = []; t.mock.method(logger, 'error', error => errors.push(error));
    const notices = [];
    const unsubscribe = controller.subscribe(id => notices.push(id));
    const stopThrow = controller.subscribe(() => { throw new Error('observer throw'); });
    const stopReject = controller.subscribe(async () => { throw new Error('observer reject'); });
    const stopStall = controller.subscribe(() => new Promise(() => {}));
    await start(['a']);
    await controller.execute(owner, guild.id, { action: 'volume', percent: 19 }, operation(controller.snapshot(owner, guild.id)));
    assert.equal(player.get(guild.id).volume, 19); assert.ok(errors.length >= 2);
    const before = notices.length;
    client.emit(Events.VoiceStateUpdate, { guild, channelId: channel.id }, { guild, id: guest, channelId: channel.id });
    assert.equal(notices.length, before + 1);
    unsubscribe(); unsubscribe(); stopThrow(); stopReject(); stopStall();
    await controller.execute(owner, guild.id, { action: 'volume', percent: 20 }, operation(controller.snapshot(owner, guild.id)));
    assert.equal(notices.length, before + 1);
});
