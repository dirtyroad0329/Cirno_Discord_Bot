import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFixture, ENTRY, GUILD, PLAYLIST, snapshot, SONG, song, USER } from './apiFixture.js';
import { MusicClient, parseSong } from '../server/integrations/music.js';
import { WebError } from '../server/http/errors.js';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { MusicQueue } from '../../dist/features/music/model/queue.js';
import { ConfigurationError } from '../../dist/shared/logging/operationErrors.js';

test('BFF protects catalogue, rejects song writes and rebuilds trusted owner/authorization headers', async () => {
  const fixture = await apiFixture();
  try {
    assert.equal((await fixture.app.inject('/web/api/songs')).statusCode, 401);
    const page = await fixture.app.inject({ url: '/web/api/songs?query=test&limit=1', headers: {
      ...fixture.headers, authorization: 'Bearer browser-secret', 'x-discord-user-id': '999999999999999999' } });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().items[0].durationSeconds, 120);
    assert.equal(fixture.calls.at(-1)!.url.searchParams.get('limit'), '25');
    assert.equal((fixture.calls.at(-1)!.init.headers as Record<string, string>).authorization, 'Bearer server-only-secret');
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await fixture.app.inject({ method, url: `/web/api/songs/${SONG}`, headers: fixture.headers, payload: {} });
      assert.equal(response.statusCode, 404);
    }
    const create = await fixture.app.inject({ method: 'POST', url: '/web/api/playlists', headers: {
      ...fixture.headers, 'x-discord-user-id': '999999999999999999' }, payload: { name: 'My playlist', songIds: [SONG] } });
    assert.equal(create.statusCode, 201);
    const call = fixture.calls.at(-1)!;
    assert.equal((call.init.headers as Record<string, string>)['x-discord-user-id'], USER);
    assert.deepEqual(JSON.parse(String(call.init.body)), { name: 'My playlist', tracks: [{
      source: 'remote', id: SONG, title: song.title, artist: song.artist, library: 'http://music.test/' }] });
    assert.equal(create.json().entries[0].browserPlayable, true);
    const before = fixture.calls.length;
    const injected = await fixture.app.inject({ method: 'POST', url: '/web/api/playlists', headers: fixture.headers,
      payload: { name: 'Fake', tracks: [{ source: 'local', id: '/private/music' }], songIds: [SONG] } });
    assert.equal(injected.statusCode, 400);
    assert.equal(fixture.calls.length, before);
    const csrf = await fixture.app.inject({ method: 'POST', url: '/web/api/playlists', headers: { cookie: fixture.headers.cookie, origin: 'https://evil.example' }, payload: { name: 'Denied' } });
    assert.equal(csrf.statusCode, 403);
  } finally { await fixture.close(); }
});

test('playlist presentation preserves unavailable legacy items and duplicates without adding writable metadata', () => {
  const music = new MusicClient({ baseUrl: 'http://music.test', token: 'secret' });
  const original = { id: PLAYLIST, ownerId: USER, name: 'Legacy', revision: 4, entries: [
    { entryId: ENTRY, source: 'local', id: 'old-local', title: 'Old local' },
    { entryId: ENTRY, source: 'remote', id: SONG, title: 'Other library', library: 'http://different.test/' },
    { entryId: ENTRY, source: 'remote', id: SONG, title: 'Current', library: 'http://music.test' },
    { entryId: ENTRY, source: 'remote', id: SONG, title: 'Duplicate', library: 'http://music.test/' },
  ] };
  const presented = music.playlist(original, USER);
  assert.deepEqual(presented.entries.map(entry => entry.browserPlayable), [false, false, true, true]);
  assert.deepEqual(presented.entries.map(({ browserPlayable: _, ...entry }) => entry), original.entries);
  assert.throws(() => music.playlist(original, '999999999999999999'), /清單資料無效/);
  music.dispose();
});

test('commands forward atomic guards, deduplicate requestId and reject altered retries', async () => {
  const seen: unknown[] = [];
  const fixture = await apiFixture({ bot: { execute: async (_user, _guild, command, context) => {
    seen.push({ command, context }); return snapshot();
  } } });
  try {
    const payload = { requestId: 'request-one', sessionId: 'session-one', generation: 5, queueRevision: 8, action: 'pause' };
    const request = { method: 'POST' as const, url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers, payload };
    assert.equal((await fixture.app.inject(request)).statusCode, 200);
    assert.equal((await fixture.app.inject(request)).statusCode, 200);
    assert.equal(seen.length, 1);
    const context = (seen[0] as { context: Record<string, unknown> }).context;
    assert.equal(context.sessionId, 'session-one');
    assert.equal(context.generation, 5);
    assert.equal(context.queueRevision, 8);
    assert.ok(context.signal instanceof AbortSignal);
    assert.equal((await fixture.app.inject({ ...request, payload: { ...payload, action: 'resume' } })).statusCode, 409);
    const invalid = await fixture.app.inject({ ...request, payload: { ...payload, requestId: 'unsafe', action: 'execute', url: 'http://evil.test' } });
    assert.equal(invalid.statusCode, 400);
  } finally { await fixture.close(); }
});

test('a deduplicated request returns the presently authorized channel instead of replaying its old queue', async () => {
  let current = snapshot();
  let executions = 0;
  const fixture = await apiFixture({ bot: { snapshot: () => current,
    execute: async () => { executions++; return current; } } });
  try {
    const request = { method: 'POST' as const, url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers,
      payload: { requestId: 'same-id-after-moving', sessionId: 'session-one', action: 'pause' } };
    assert.equal((await fixture.app.inject(request)).json().snapshot.channelId, current.channelId);
    current = { ...snapshot(), channelId: '423456789012345678', sessionId: null, current: null, status: 'idle' };
    const replay = await fixture.app.inject(request);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().snapshot.channelId, current.channelId);
    assert.equal(replay.json().snapshot.sessionId, null);
    assert.doesNotMatch(replay.body, /Trusted song|session-one/);
    assert.equal(executions, 1);
  } finally { await fixture.close(); }
});

test('existing Bot user errors retain actionable messages; configuration errors omit operator/private details', async () => {
  let permissions = false;
  const fixture = await apiFixture({ bot: { execute: async () => {
    if (permissions) throw new ConfigurationError('private path /database.sqlite token-secret');
    new MusicQueue().remove(1);
    return snapshot();
  } } });
  try {
    const request = { method: 'POST' as const, url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers,
      payload: { requestId: 'bad-queue-position', sessionId: 'session-one', queueRevision: 8, action: 'remove', position: 1 } };
    const userError = await fixture.app.inject(request);
    assert.equal(userError.statusCode, 400);
    assert.equal(userError.json().code, 'INVALID_COMMAND');
    assert.match(userError.json().error, /位置超出待播佇列範圍/);
    permissions = true;
    const configError = await fixture.app.inject({ ...request, payload: { ...request.payload, requestId: 'configuration-failure' } });
    assert.equal(configError.statusCode, 503);
    assert.doesNotMatch(configError.body, /private|database|token-secret/);
  } finally { await fixture.close(); }
});

test('upstream/body failures are isolated and never expose token/path details; conflicts remain 409', async () => {
  let fail = true;
  const fixture = await apiFixture({ fetch: async (_input, init) => {
    if (fail) throw new Error('server-only-secret /private/database.sqlite');
    if (init?.method === 'PATCH') return Response.json({ error: 'private backend details' }, { status: 409 });
    return Response.json({ items: [song], nextCursor: null });
  } });
  try {
    const unavailable = await fixture.app.inject({ url: '/web/api/songs', headers: fixture.headers });
    assert.equal(unavailable.statusCode, 502);
    assert.doesNotMatch(unavailable.body, /server-only-secret|private|sqlite/);
    const command = await fixture.app.inject({ method: 'POST', url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers,
      payload: { requestId: 'still-working', sessionId: 'session-one', generation: 5, action: 'pause' } });
    assert.equal(command.statusCode, 200);
    fail = false;
    const conflict = await fixture.app.inject({ method: 'PATCH', url: `/web/api/playlists/${PLAYLIST}`, headers: fixture.headers,
      payload: { revision: 4, name: 'Updated' } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, 'REVISION_CONFLICT');
    assert.doesNotMatch(conflict.body, /private backend/);
  } finally { await fixture.close(); }
});

test('pending website commands are bounded without releasing a still-running Bot operation', async () => {
  let resolve!: () => void;
  const blocked = new Promise<void>(done => { resolve = done; });
  let started!: () => void;
  const accepted = new Promise<void>(done => { started = done; });
  const fixture = await apiFixture({ env: { WEB_COMMAND_MAX_PENDING_PER_GUILD: '1' }, bot: {
    execute: async (_user, _guild, command) => {
      if (command.action === 'stop' || command.action === 'skip') return snapshot();
      started(); await blocked; return snapshot();
    },
  } });
  try {
    const request = { method: 'POST' as const, url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers,
      payload: { requestId: 'pending-one', sessionId: 'session-one', action: 'pause' } };
    const first = fixture.app.inject(request);
    await accepted;
    const second = await fixture.app.inject({ ...request, payload: { ...request.payload, requestId: 'pending-two' } });
    assert.equal(second.statusCode, 429);
    const stop = await fixture.app.inject({ ...request, payload: { ...request.payload, requestId: 'urgent-stop', action: 'stop' } });
    assert.equal(stop.statusCode, 200, 'Stop retains bounded emergency capacity while normal operations wait');
    resolve();
    assert.equal((await first).statusCode, 200);
    assert.equal((await fixture.app.inject({ ...request, payload: { ...request.payload, requestId: 'after-completion' } })).statusCode, 200);
  } finally { resolve(); await fixture.close(); }
});

test('music request timeout actually aborts upstream I/O', async () => {
  let aborted = false;
  const client = new MusicClient({ baseUrl: 'http://music.test/', token: 'secret', timeoutMs: 25,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
  await assert.rejects(client.songs(), /取消或逾時/);
  assert.equal(aborted, true);
  client.dispose();
});

test('website metadata cannot bypass the existing Bot maximum audio size contract', () => {
  assert.throws(() => parseSong({ ...song, byteSize: 268_435_457 }), /歌曲資料無效/);
});

test('metadata timeouts cancel before entering the shared Bot queue and leave subsequent controls usable', async () => {
  let aborted = false;
  const fixture = await apiFixture({ fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  try {
    const response = await fixture.app.inject({ method: 'POST', url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers,
      payload: { requestId: 'failed-metadata', sessionId: 'session-one', generation: 5, action: 'enqueue', songIds: [SONG] } });
    assert.equal(response.statusCode, 504);
    assert.equal(aborted, true);
    assert.equal(fixture.executions(), 0);
    const pause = await fixture.app.inject({ method: 'POST', url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers,
      payload: { requestId: 'usable-after-timeout', sessionId: 'session-one', action: 'pause' } });
    assert.equal(pause.statusCode, 200);
  } finally { await fixture.close(); }
});

test('session revocation cancels a website command waiting to execute without stopping shared playback', { timeout: 5000 }, async () => {
  let mutations = 0;
  let accepted!: () => void;
  const started = new Promise<void>(resolve => { accepted = resolve; });
  const fixture = await apiFixture({ bot: { execute: async (_user, _guild, command, context) => {
    if (command.action !== 'pause') return snapshot();
    accepted();
    await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true }));
    if (context.signal!.aborted) throw new WebError(504, 'REQUEST_EXPIRED', '操作已取消。');
    mutations++;
    return snapshot();
  } } });
  try {
    // Real HTTP owns an active socket while the queued operation waits. Injection
    // alone has no socket to keep Node 22 alive when production poll timers unref.
    const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const pending = fetch(`${origin}/web/api/player/${GUILD}/commands`, {
      method: 'POST', headers: { ...fixture.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'revoked-pending', sessionId: 'session-one', action: 'pause' }),
    });
    await started;
    await fixture.auth.logout(fixture.login.token);
    const response = await pending;
    assert.equal(response.status, 504);
    await response.arrayBuffer();
    assert.equal(mutations, 0);
    assert.equal(snapshot().status, 'playing');
  } finally { await fixture.close(); }
});

test('a client disconnected during authentication cannot later start Bot work', { timeout: 5000 }, async () => {
  const fixture = await apiFixture();
  const original = fixture.auth.authenticate.bind(fixture.auth);
  let authStarted!: () => void;
  const authenticating = new Promise<void>(resolve => { authStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let authenticationDone!: () => void;
  const completed = new Promise<void>(resolve => { authenticationDone = resolve; });
  fixture.auth.authenticate = async (...args) => {
    authStarted(); await gate;
    try { return await original(...args); } finally { authenticationDone(); }
  };
  let socketClosed!: () => void;
  const disconnected = new Promise<void>(resolve => { socketClosed = resolve; });
  fixture.app.server.once('request', (_request, response) => { response.once('close', () => socketClosed()); });
  const abort = new AbortController();
  try {
    const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const pending = fetch(`${origin}/web/api/player/${GUILD}/commands`, { method: 'POST', headers: {
      ...fixture.headers, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'late-disconnect', sessionId: 'session-one', action: 'pause' }),
      signal: abort.signal });
    const rejected = assert.rejects(pending);
    await authenticating;
    abort.abort();
    await rejected;
    await disconnected;
    release();
    await completed;
    await nextTurn();
    assert.equal(fixture.executions(), 0);
    assert.equal(fixture.calls.length, 0);
  } finally { release(); abort.abort(); fixture.auth.authenticate = original; await fixture.close(); }
});
