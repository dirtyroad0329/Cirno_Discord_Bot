import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../../client/src/api/client';
import { useCatalog } from '../../client/src/features/catalog';
import { usePlaylists } from '../../client/src/features/playlists';
import { useDiscordPlayer } from '../../client/src/features/discordPlayer';
import { useBrowserPlayer } from '../../client/src/features/browserPlayer';
import { useAuth } from '../../client/src/features/auth';
import type { PlayerSnapshot, Song, Playlist } from '../../contracts/index';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const song = (id: string): Song => ({ id, title: `Song ${id}`, artist: 'Artist', durationSeconds: 90, mimeType: 'audio/mpeg', byteSize: 100, sha256: 'hash' });

test('API client uses opaque cookies and CSRF, and understands public string errors', async () => {
  let options: RequestInit | undefined;
  const client = createApiClient(async (_url, init) => { options = init; return json({ error: '清單已更新', code: 'CONFLICT' }, 409); });
  client.setCsrfToken('public-csrf');
  await assert.rejects(client.request('/playlists/a', { method: 'PATCH', body: { revision: 3 } }), /清單已更新/);
  assert.equal(options?.credentials, 'same-origin');
  assert.equal((options?.headers as Record<string, string>)['X-CSRF-Token'], 'public-csrf');
  assert.equal(options?.body, '{"revision":3}');
});

test('initial unauthenticated me is normal; protected 401 releases account', async () => {
  const client = createApiClient(async url => String(url).endsWith('/auth/login')
    ? json({ user: { discordId: '123456789012345678', mustChangePassword: false }, csrfToken: 'csrf', scope: 'full', expiresAt: 1000 })
    : json({ error: 'Expired' }, 401));
  const auth = useAuth(client);
  await auth.restore(); assert.equal(auth.error.value, ''); assert.equal(auth.user.value, null);
  await auth.login('123456789012345678', 'example-password');
  assert.equal(auth.user.value?.discordId, '123456789012345678');
  await assert.rejects(client.request('/songs'));
  assert.equal(auth.user.value, null); assert.match(auth.error.value, /重新登入/);
});

test('registration posts only the account ID and preserves retry after failure without logging in', async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  const requests: { url: string; method?: string; body: unknown }[] = [];
  const client = createApiClient(async (url, init) => {
    requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    return requests.length === 1 ? first.promise : second.promise;
  });
  const auth = useAuth(client);
  const failed = auth.register('123456789012345678');
  assert.equal(auth.busy.value, true);
  first.resolve(json({ error: '帳號已存在。', code: 'ACCOUNT_EXISTS' }, 409));
  assert.equal(await failed, false);
  assert.equal(auth.busy.value, false); assert.equal(auth.error.value, '帳號已存在。');
  assert.equal(auth.user.value, null);
  const retry = auth.register('223456789012345678');
  assert.equal(auth.busy.value, true); assert.equal(auth.error.value, '');
  second.resolve(json({ success: true }, 201));
  assert.equal(await retry, true);
  assert.equal(auth.busy.value, false); assert.equal(auth.user.value, null);
  assert.deepEqual(requests, [
    { url: '/web/api/auth/register', method: 'POST', body: { discordId: '123456789012345678' } },
    { url: '/web/api/auth/register', method: 'POST', body: { discordId: '223456789012345678' } },
  ]);
});

test('password changes accept existing punctuation and clear login credentials after voluntary change', async () => {
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const client = createApiClient(async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).endsWith('/auth/login')) return json({ user: { discordId: '123456789012345678', mustChangePassword: false }, csrfToken: 'current-csrf' });
    return json({ success: true });
  });
  const auth = useAuth(client);
  assert.equal(await auth.login('123456789012345678', 'existing-password!'), true);
  assert.equal(await auth.changePassword('existing-password!', 'Ab12'), true);
  assert.equal(auth.user.value, null);
  await client.request('/auth/register', { method: 'POST', body: { discordId: '223456789012345678' } });
  assert.deepEqual(requests[0]?.body, { discordId: '123456789012345678', password: 'existing-password!' });
  assert.deepEqual(requests[1]?.body, { currentPassword: 'existing-password!', newPassword: 'Ab12' });
  assert.equal(requests[1]?.headers['X-CSRF-Token'], 'current-csrf');
  assert.equal(requests[2]?.headers['X-CSRF-Token'], undefined);
});

test('logout clears the current account and its CSRF credentials', async () => {
  const headers: Record<string, string>[] = [];
  const client = createApiClient(async (url, init) => {
    headers.push(init?.headers as Record<string, string>);
    return String(url).endsWith('/auth/login')
      ? json({ user: { discordId: '123456789012345678', mustChangePassword: false }, csrfToken: 'login-csrf' })
      : json({ success: true });
  });
  const auth = useAuth(client);
  await auth.login('123456789012345678', 'existing-password!');
  assert.equal(await auth.logout(), true);
  assert.equal(auth.user.value, null);
  await client.request('/auth/register', { method: 'POST', body: { discordId: '223456789012345678' } });
  assert.equal(headers[1]?.['X-CSRF-Token'], 'login-csrf');
  assert.equal(headers[2]?.['X-CSRF-Token'], undefined);
});

test('catalog ignores a late query even when its transport ignores abort', async () => {
  const first = deferred<Response>(); const second = deferred<Response>(); let calls = 0;
  const client = createApiClient(async () => (++calls === 1 ? first.promise : second.promise));
  const catalog = useCatalog(client);
  const old = catalog.load(true);
  catalog.query.value = 'new'; const fresh = catalog.load(true);
  second.resolve(json({ items: [song('new')], nextCursor: 'cursor' })); await fresh;
  first.resolve(json({ items: [song('old')], nextCursor: 'obsolete' })); await old;
  assert.deepEqual(catalog.songs.value.map(item => item.id), ['new']); assert.equal(catalog.cursor.value, 'cursor');
  catalog.dispose();
});

test('catalog disposal prevents an in-flight response from repopulating the page', async () => {
  const pending = deferred<Response>();
  const catalog = useCatalog(createApiClient(async () => pending.promise));
  const task = catalog.load(true); catalog.dispose();
  pending.resolve(json({ items: [song('late')], nextCursor: null })); await task;
  assert.equal(catalog.songs.value.length, 0); assert.equal(catalog.busy.value, false);
});

test('playlist delete conflict refreshes revision and requires a new explicit delete', async () => {
  const original: Playlist = { id: 'list', ownerId: '123456789012345678', name: 'List', revision: 1, entries: [] };
  const newer = { ...original, revision: 2, name: 'Updated elsewhere' };
  let mutations = 0; let removed = false;
  const client = createApiClient(async (url, init) => {
    if (init?.method === 'DELETE') {
      mutations++;
      const body = JSON.parse(String(init.body));
      if (body.revision === 1) return json({ error: 'Changed', code: 'CONFLICT' }, 409);
      removed = true; return new Response(null, { status: 204 });
    }
    if (String(url).endsWith('/playlists/list')) return json(newer);
    return json({ items: removed ? [] : [newer] });
  });
  const state = usePlaylists(client); state.selected.value = original;
  assert.equal(await state.remove(original), false);
  assert.equal(mutations, 1); assert.equal(state.conflict.value, true); assert.equal(state.selected.value?.revision, 2);
  assert.equal(await state.remove(state.selected.value!), true);
  assert.equal(mutations, 2); assert.equal(state.selected.value, null); assert.deepEqual(state.lists.value, []);
});

class MockAudio extends EventTarget {
  src = ''; volume = 1; currentTime = 0; duration = 90; paused = true;
  pauseCount = 0; playCount = 0; removed = false;
  listeners = new Set<EventListenerOrEventListenerObject>();
  nextPlay: Promise<void> | undefined;
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) { if (callback) this.listeners.add(callback); super.addEventListener(type, callback, options); }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) { if (callback) this.listeners.delete(callback); super.removeEventListener(type, callback, options); }
  play() { this.playCount++; this.paused = false; this.dispatchEvent(new Event('playing')); return this.nextPlay ?? Promise.resolve(); }
  pause() { this.pauseCount++; this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { if (this.src) this.dispatchEvent(new Event('loadedmetadata')); }
  removeAttribute(name: string) { if (name === 'src') { this.src = ''; this.removed = true; } }
}

test('browser next with empty queue pauses the actual audio, and disposal removes listeners', () => {
  const audio = new MockAudio(); const player = useBrowserPlayer(() => audio);
  player.playSong(song('one')); assert.equal(audio.paused, false);
  player.next(); assert.equal(audio.paused, true); assert.equal(player.paused.value, true);
  assert.ok(audio.listeners.size > 0); player.dispose();
  assert.equal(audio.listeners.size, 0); assert.equal(audio.src, ''); assert.equal(player.current.value, null);
});

test('browser playlist preserves duplicate entries and skips unsupported sources', () => {
  const player = useBrowserPlayer(() => new MockAudio());
  const skipped = player.playPlaylist([
    { entryId: 'a', id: 'same', source: 'remote', title: 'Same', browserPlayable: true },
    { entryId: 'b', id: 'same', source: 'remote', title: 'Same', browserPlayable: true },
    { entryId: 'c', id: 'local', source: 'local', title: 'Local', browserPlayable: false },
  ]);
  assert.equal(skipped, 1); assert.equal(player.pending.value.length, 1);
  assert.equal(player.current.value?.id, player.pending.value[0]?.id);
  assert.notEqual(player.current.value?.key, player.pending.value[0]?.key);
  player.dispose();
});

test('late rejected play does not overwrite a subsequent browser song', async () => {
  const old = deferred<void>(); const audio = new MockAudio(); audio.nextPlay = old.promise;
  const player = useBrowserPlayer(() => audio); player.playSong(song('old'));
  audio.nextPlay = undefined; player.playSong(song('new'));
  old.reject(new Error('old request failed')); await Promise.resolve(); await Promise.resolve();
  assert.equal(player.current.value?.id, 'new'); assert.equal(player.error.value, ''); player.dispose();
});

class MockEvents extends EventTarget {
  onerror: EventSource['onerror'] = null; onopen: EventSource['onopen'] = null; closed = false;
  close() { this.closed = true; }
  emit(value: PlayerSnapshot) { this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(value) })); }
}
const snapshot = (partial: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
  guildId: 'guild', channelId: 'voice', sessionId: 'session', generation: 1, queueRevision: 1, status: 'playing',
  current: { track: { source: 'remote', id: 'one', title: 'One' }, requestedBy: 'user' }, pending: [],
  volume: 75, repeat: 'off', elapsedSeconds: 1, observedAt: '2026-10-10T00:00:00.000Z', canControl: true, canPlay: true, historyCount: 0, ...partial,
});

test('late GET cannot overwrite a newer SSE generation; subscription closes on disposal', async () => {
  const events = new MockEvents(); let delayed: ReturnType<typeof deferred<Response>> | undefined;
  const client = createApiClient(async () => delayed ? delayed.promise : json(snapshot()));
  const player = useDiscordPlayer(client, () => events);
  await player.selectGuild('guild'); delayed = deferred<Response>();
  const task = player.refresh();
  events.emit(snapshot({ generation: 2, queueRevision: 2, observedAt: '2026-10-10T00:00:01.000Z' }));
  delayed.resolve(json(snapshot())); await task;
  assert.equal(player.snapshot.value?.generation, 2);
  player.dispose(); assert.equal(events.closed, true); assert.equal(player.snapshot.value, null);
});

test('STOP runs while enqueue is pending and a late enqueue response cannot resurrect session', async () => {
  const events = new MockEvents(); const enqueue = deferred<Response>();
  let state = snapshot({ sessionId: null, generation: 0, queueRevision: 0, status: 'idle', current: null, canControl: false });
  const actions: string[] = []; let stopSession: string | null = null;
  const client = createApiClient(async (_url, init) => {
    if (init?.method !== 'POST') return json(state);
    const command = JSON.parse(String(init.body)); actions.push(command.action);
    if (command.action === 'enqueue') { state = snapshot({ status: 'connecting', current: null, observedAt: '2026-10-10T00:00:01.000Z' }); events.emit(state); return enqueue.promise; }
    stopSession = command.sessionId;
    state = snapshot({ sessionId: null, status: 'idle', current: null, generation: 0, queueRevision: 0, canControl: false, observedAt: '2026-10-10T00:00:02.000Z' });
    events.emit(state); return json({ snapshot: state });
  });
  const player = useDiscordPlayer(client, () => events); await player.selectGuild('guild');
  const task = player.command('enqueue', { songIds: ['one'] }); assert.equal(player.busy.value, true);
  assert.equal(await player.command('stop'), true); assert.equal(stopSession, 'session');
  enqueue.resolve(json({ snapshot: snapshot({ status: 'connecting', observedAt: '2026-10-10T00:00:01.000Z' }) })); await task;
  assert.deepEqual(actions, ['enqueue', 'stop']); assert.equal(player.snapshot.value?.sessionId, null); assert.equal(player.snapshot.value?.status, 'idle'); player.dispose();
});
