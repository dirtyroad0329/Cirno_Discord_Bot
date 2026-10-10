import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';

let state;
class FakeClient extends EventEmitter {
    constructor(options) { super(); state.client = this; state.clientOptions = options; }
    async login(token) {
        const current = state;
        current.loginTokens.push(token);
        current.loginStarted?.();
        if (current.loginGate) await current.loginGate;
        if (current.loginError) throw current.loginError;
        current.loginCompleted = true;
    }
    async destroy() { state.destroyCalls++; }
}
const register = name => () => {
    state.registered.push(name);
    return () => {
        state.disposed.push(name);
        if (state.cleanupError?.name === name) throw state.cleanupError.error;
    };
};
mock.module('discord.js', { namedExports: { Client: FakeClient, Collection: Map,
    Events: { ClientReady: 'ready' }, GatewayIntentBits: {
        Guilds: 1, GuildVoiceStates: 2, GuildMessages: 4, MessageContent: 8
    } } });
mock.module('../dist/app/commandLoader.js', { namedExports: {
    loadCommands: async client => {
        const current = state; current.loadedClient = client;
        if (current.loadCommandsGate) await current.loadCommandsGate;
        return ['command'];
    },
    registerGlobalCommands: async (...args) => { state.registration = args; }
} });
mock.module('../dist/app/interactions.js', { namedExports: { registerInteractions: register('interactions') } });
mock.module('../dist/app/reload.js', { namedExports: { registerReload: register('reload') } });
mock.module('../dist/features/assistant/presentation/mentions.js', { namedExports: { registerMentions: register('mentions') } });
mock.module('../dist/features/voice/entrancePlayer.js', { namedExports: { registerVoiceEntrancePlayer: register('voice') } });
mock.module('../dist/features/music/playback/player.js', { namedExports: { musicPlayer: {
    initialize: client => { state.initializedClient = client; },
    shutdown: () => { state.shutdownCalls++; }
} } });
mock.module('../dist/shared/logging/logger.js', { defaultExport: {
    info: () => {}, error: error => { state.errors.push(error); }
} });
const { startBot } = await import('../dist/app/bootstrap.js');

function reset() {
    state = { registered: [], disposed: [], loginTokens: [], destroyCalls: 0, shutdownCalls: 0, errors: [] };
    return state;
}
function signalListeners() {
    return { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
}
function assertStopped(current) {
    assert.deepEqual(current.disposed, ['voice', 'interactions', 'reload', 'mentions']);
    assert.equal(current.shutdownCalls, 1);
    assert.equal(current.destroyCalls, 1);
    assert.equal(current.client.listenerCount('ready'), 0);
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('default startup owns both signals and a signal or repeated stop cleans up once', async t => {
    const current = reset();
    const before = signalListeners();
    const bot = await startBot(); t.after(bot.stop);
    assert.equal(bot.client, current.client);
    assert.equal(current.initializedClient, bot.client);
    assert.equal(current.loadedClient, bot.client);
    assert.ok(bot.client.commands instanceof Map);
    assert.deepEqual(current.registered, ['voice', 'interactions', 'reload', 'mentions']);
    const after = signalListeners();
    assert.equal(after.term.length, before.term.length + 1);
    assert.equal(after.int.length, before.int.length + 1);
    assert.equal(after.term.at(-1), bot.stop);
    assert.equal(after.int.at(-1), bot.stop);
    // Invoke only our signal callback; never send a signal to the test runner.
    after.term.at(-1)(); bot.stop(); bot.stop();
    assertStopped(current);
    assert.deepEqual(signalListeners(), before);
});

test('external lifecycle ownership does not register or remove the host signal handlers', async t => {
    const current = reset();
    const owner = () => {};
    process.once('SIGTERM', owner); process.once('SIGINT', owner);
    t.after(() => { process.off('SIGTERM', owner); process.off('SIGINT', owner); });
    const before = signalListeners();
    const bot = await startBot({ handleSignals: false }); t.after(bot.stop);
    assert.deepEqual(signalListeners(), before);
    bot.stop(); bot.stop();
    assertStopped(current);
    assert.deepEqual(signalListeners(), before);
});

test('failed login releases features, player and client and removes default signal handlers', async () => {
    const current = reset();
    current.loginError = new Error('simulated login failure');
    const before = signalListeners();
    await assert.rejects(startBot(), error => error === current.loginError);
    assertStopped(current);
    assert.deepEqual(signalListeners(), before);
});

test('failed login with external lifecycle ownership leaves host signal handlers alone', async t => {
    const current = reset();
    current.loginError = new Error('simulated login failure');
    const owner = () => {};
    process.once('SIGTERM', owner); process.once('SIGINT', owner);
    t.after(() => { process.off('SIGTERM', owner); process.off('SIGINT', owner); });
    const before = signalListeners();
    await assert.rejects(startBot({ handleSignals: false }), error => error === current.loginError);
    assertStopped(current);
    assert.deepEqual(signalListeners(), before);
});

test('a throwing feature disposer is logged and does not skip the remaining shutdown', async t => {
    const current = reset();
    current.cleanupError = { name: 'voice', error: new Error('simulated feature cleanup failure') };
    const bot = await startBot({ handleSignals: false }); t.after(bot.stop);
    bot.stop(); bot.stop();
    assertStopped(current);
    assert.deepEqual(current.errors, [current.cleanupError.error]);
});

test('a pre-aborted external startup never allocates a client or logs in', async () => {
    const current = reset();
    const controller = new AbortController();
    const reason = new Error('already stopping'); controller.abort(reason);
    const before = signalListeners();
    await assert.rejects(startBot({ handleSignals: false, signal: controller.signal }), error => error === reason);
    assert.equal(current.client, undefined);
    assert.deepEqual(current.registered, []);
    assert.deepEqual(current.loginTokens, []);
    assert.equal(current.shutdownCalls, 0);
    assert.equal(current.destroyCalls, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(signalListeners(), before);
});

test('abort while commands load cleans up immediately and never starts a late login', async () => {
    const current = reset();
    const loading = deferred(); current.loadCommandsGate = loading.promise;
    const controller = new AbortController();
    const reason = new Error('stop before login');
    const before = signalListeners();
    const startup = startBot({ handleSignals: false, signal: controller.signal });
    const rejected = assert.rejects(startup, error => error === reason);
    controller.abort(reason); await rejected;
    assertStopped(current);
    assert.deepEqual(current.loginTokens, []);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    loading.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(current.loginTokens, []);
    assert.equal(current.registration, undefined);
    assert.deepEqual(current.errors, []);
    assert.deepEqual(signalListeners(), before);
});

test('abort during login rejects immediately and late login completion cannot revive startup', async () => {
    const current = reset();
    const login = deferred(), started = deferred();
    current.loginGate = login.promise; current.loginStarted = started.resolve;
    const controller = new AbortController();
    const reason = new Error('stop during login');
    const before = signalListeners();
    const startup = startBot({ handleSignals: false, signal: controller.signal });
    await started.promise;
    const rejected = assert.rejects(startup, error => error === reason);
    controller.abort(reason); await rejected;
    assertStopped(current);
    assert.equal(current.loginCompleted, undefined);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    login.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(current.loginCompleted, true);
    assertStopped(current);
    assert.deepEqual(current.errors, []);
    assert.deepEqual(signalListeners(), before);
});

test('the lifecycle signal stops a successful startup once and removes its listener', async t => {
    const current = reset();
    const controller = new AbortController();
    const bot = await startBot({ handleSignals: false, signal: controller.signal }); t.after(bot.stop);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort(); bot.stop();
    assertStopped(current);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
