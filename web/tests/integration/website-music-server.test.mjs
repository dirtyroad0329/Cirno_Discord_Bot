import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startMusicServerFixture, apiToken, ownerA, ownerB } from './music-server-fixture.mjs';
import { startWebsiteFixture } from './website-fixture.mjs';

test('real website auth and unchanged music_server share playlists with the existing Bot client', { timeout: 60000 }, async t => {
  const music = await startMusicServerFixture();
  const site = await startWebsiteFixture({ musicBase: music.base });
  const original = await (await music.request(`v1/playlists/${music.existingPlaylist.id}`)).json();
  const { connectDatabase } = await import(pathToFileURL(join(music.apiRoot, 'dist/infrastructure/database.js')));
  const { buildApp } = await import(pathToFileURL(join(music.apiRoot, 'dist/app.js')));
  const botDb = await connectDatabase(music.databaseUrl);
  const botApi = buildApp({ db: botDb, token: apiToken, audioRoot: music.audioRoot });
  const botBase = `${await botApi.listen({ host: '127.0.0.1', port: 0 })}/`;
  const previousUrl = process.env.REMOTE_MUSIC_API_URL, previousToken = process.env.REMOTE_MUSIC_API_TOKEN;
  process.env.REMOTE_MUSIC_API_URL = botBase; process.env.REMOTE_MUSIC_API_TOKEN = apiToken;
  const { RemotePlaylistStore } = await import('../../../dist/features/playlists/remoteStore.js');
  const { PlaylistHttpClient } = await import('../../../dist/features/playlists/client.js');
  const botResponses = [];
  const botStore = new RemotePlaylistStore(new PlaylistHttpClient(async (url, options) => {
    const response = await fetch(url, options); botResponses.push(response.status); return response;
  }));
  let alice, bob, playlist;
  const passwordA = 'Ab12', passwordB = 'CD34';
  try {
    await t.test('public ID-only registration immediately permits music access; password changes remain protected', async () => {
      assert.equal((await site.request('/web/api/songs')).status, 401);
      for (const discordId of [ownerA, ownerB]) {
        const created = await site.request('/web/api/auth/register', { method: 'POST', body: { discordId } });
        assert.equal(created.status, 201); assert.deepEqual(await created.json(), { success: true });
        assert.equal(created.headers.get('set-cookie'), null, 'Registration does not silently sign in.');
      }
      const login = await site.login(ownerA, 'piyan');
      assert.equal(login.response.status, 200, JSON.stringify(login.state));
      assert.equal(login.state.scope, 'full'); assert.equal(login.state.user.mustChangePassword, false);
      assert.equal(login.state.token, undefined); assert.match(login.response.headers.get('set-cookie'), /HttpOnly/);
      assert.equal(login.response.headers.get('cache-control'), 'no-store');
      const songs = await site.request('/web/api/songs', { session: login.session });
      assert.equal(songs.status, 200); assert.ok((await songs.json()).items.length > 0);
      const originalLists = await site.request('/web/api/playlists', { session: login.session });
      assert.equal(originalLists.status, 200);
      assert.equal((await originalLists.json()).items[0].ownerId, ownerA, 'Initial login can read existing own music data.');
      const blocked = await site.request('/web/api/auth/password', { method: 'POST', session: login.session,
        headers: { 'x-csrf-token': 'forged' }, body: { currentPassword: 'piyan', newPassword: passwordA } });
      assert.equal(blocked.status, 403);
      const changed = await site.request('/web/api/auth/password', { method: 'POST', session: login.session,
        body: { currentPassword: 'piyan', newPassword: passwordA } });
      assert.equal(changed.status, 200);
      assert.equal((await site.request('/web/api/auth/me', { session: login.session })).status, 401);
      const normal = await site.login(ownerA, passwordA);
      assert.equal(normal.response.status, 200); assert.equal(normal.state.scope, 'full'); alice = normal.session;
      const second = await site.login(ownerB, 'piyan');
      assert.equal(second.response.status, 200);
      assert.equal((await site.request('/web/api/auth/password', { method: 'POST', session: second.session,
        body: { currentPassword: 'piyan', newPassword: passwordB } })).status, 200);
      const normalB = await site.login(ownerB, passwordB); assert.equal(normalB.response.status, 200); bob = normalB.session;
    });

    await t.test('session identity defeats forged owner headers and keeps existing mixed references intact', async () => {
      const mine = await site.request('/web/api/playlists', { session: alice,
        headers: { 'x-discord-user-id': ownerB, authorization: 'Bearer browser-forgery' } });
      assert.equal(mine.status, 200); const list = await mine.json();
      assert.equal(list.items.length, 1); const saved = list.items[0];
      assert.equal(saved.ownerId, ownerA); assert.equal(saved.revision, original.revision);
      assert.deepEqual(saved.entries.map(({ browserPlayable, ...entry }) => entry), original.entries);
      assert.deepEqual(saved.entries.map(entry => entry.browserPlayable), [true, false, false]);
      assert.equal((await site.request(`/web/api/playlists/${saved.id}`, { session: bob,
        headers: { 'x-discord-user-id': ownerA } })).status, 404);
      assert.deepEqual((await (await site.request('/web/api/playlists', { session: bob })).json()).items, []);
      assert.equal((await site.request('/web/api/playlists', { method: 'POST', session: bob,
        body: { name: 'forged owner', ownerId: ownerA } })).status, 400);
      assert.equal((await site.request('/web/api/playlists', { method: 'POST', session: alice,
        headers: { origin: 'https://attacker.example' }, body: { name: 'cross site' } })).status, 403);
      for (const [method, path] of [['POST', '/web/api/songs'], ['PATCH', `/web/api/songs/${music.song.id}`],
        ['DELETE', `/web/api/songs/${music.song.id}`], ['POST', '/v1/songs']]) {
        assert.equal((await site.request(path, { method, session: alice, body: {} })).status, 404);
      }
      const upload = await site.request('/web/upload', { session: alice });
      assert.equal(upload.status, 302); assert.equal(upload.headers.get('location'), new URL('admin', music.base).href);
      for (const path of ['/web/private-auth.sqlite', '/web/data/auth.sqlite', '/web/server/auth/service.ts', '/web/.env']) {
        assert.ok([403, 404].includes((await site.request(path)).status), 'Private files must not be served.');
      }
    });

    await t.test('website resolves real metadata and stable duplicate entries through playlist CRUD', async () => {
      const created = await site.request('/web/api/playlists', { method: 'POST', session: alice,
        body: { name: 'Website created', songIds: [music.song.id, music.song.id, music.secondSong.id] } });
      assert.equal(created.status, 201); playlist = await created.json();
      assert.equal(playlist.entries.length, 3); assert.notEqual(playlist.entries[0].entryId, playlist.entries[1].entryId);
      assert.equal(playlist.entries[0].title, music.song.title); assert.equal(playlist.entries[0].library, music.base);
      assert.equal(playlist.entries[2].artist, undefined);
      assert.equal(playlist.entries.every(entry => entry.browserPlayable), true);
      const oldRevision = playlist.revision, movedId = playlist.entries[2].entryId;
      const moved = await site.request(`/web/api/playlists/${playlist.id}/entries/${movedId}`, { method: 'PATCH', session: alice,
        body: { revision: oldRevision, position: 1 } });
      assert.equal(moved.status, 200); playlist = await moved.json(); assert.equal(playlist.entries[0].entryId, movedId);
      assert.equal((await site.request(`/web/api/playlists/${playlist.id}`, { method: 'DELETE', session: alice,
        body: { revision: oldRevision } })).status, 409);
      assert.deepEqual(await botStore.get(ownerA, playlist.id),
        Object.fromEntries(Object.entries(playlist).map(([key, value]) => [key, key === 'entries' ? value.map(({ browserPlayable, ...entry }) => entry) : value])));
      const renamed = await site.request(`/web/api/playlists/${playlist.id}`, { method: 'PATCH', session: alice,
        body: { name: 'Shared with Discord', revision: playlist.revision } });
      assert.equal(renamed.status, 200); playlist = await renamed.json();
      const removed = await site.request(`/web/api/playlists/${playlist.id}/entries/${playlist.entries[0].entryId}`, { method: 'DELETE', session: alice,
        body: { revision: playlist.revision } });
      assert.equal(removed.status, 200); playlist = await removed.json();
    });

    await t.test('website versus actual Bot client races separate SQLite connections without partial writes', async () => {
      const revision = playlist.revision, count = playlist.entries.length;
      botResponses.length = 0;
      const remote = { source: 'remote', id: music.song.id, title: music.song.title, library: music.base };
      const [web, bot] = await Promise.all([
        site.request(`/web/api/playlists/${playlist.id}/entries`, { method: 'POST', session: alice,
          body: { songIds: [music.secondSong.id, music.secondSong.id], revision } }),
        botStore.add(ownerA, playlist.id, [remote, remote], revision).then(value => ({ value }), error => ({ error })),
      ]);
      assert.deepEqual([web.status, ...botResponses].sort(), [200, 409]);
      if (web.status === 409) assert.ok(bot.value); else assert.ok(bot.error);
      await web.body?.cancel();
      playlist = await (await site.request(`/web/api/playlists/${playlist.id}`, { session: alice })).json();
      assert.equal(playlist.revision, revision + 1); assert.equal(playlist.entries.length, count + 2);
      const beforeFailure = await botStore.get(ownerA, playlist.id);
      const stale = await site.request(`/web/api/playlists/${playlist.id}/entries`, { method: 'POST', session: alice,
        body: { songIds: [music.song.id], revision } });
      assert.equal(stale.status, 409); assert.deepEqual(await botStore.get(ownerA, playlist.id), beforeFailure);
    });

    await t.test('website restart retains hashed-account sessions and music data; logout/disable revoke locally', async () => {
      await site.restart();
      const me = await site.request('/web/api/auth/me', { session: alice }); assert.equal(me.status, 200);
      assert.equal((await me.json()).user.discordId, ownerA);
      assert.equal((await site.request(`/web/api/playlists/${playlist.id}`, { session: alice })).status, 200);
      const deleted = await site.request(`/web/api/playlists/${playlist.id}`, { method: 'DELETE', session: alice,
        body: { revision: playlist.revision } });
      assert.equal(deleted.status, 204);
      assert.deepEqual(await (await music.request(`v1/playlists/${original.id}`)).json(), original);
      assert.deepEqual(await music.db.song.findMany({ orderBy: { id: 'asc' } }), music.initialSongs);
      await site.auth.setDisabled(ownerB, true);
      assert.equal((await site.request('/web/api/auth/me', { session: bob })).status, 401);
      assert.equal((await site.request('/web/api/auth/logout', { method: 'POST', session: alice })).status, 200);
      assert.equal((await site.request('/web/api/auth/me', { session: alice })).status, 401);
      assert.deepEqual(await (await music.request(`v1/playlists/${original.id}`)).json(), original);
    });
  } finally {
    if (previousUrl === undefined) delete process.env.REMOTE_MUSIC_API_URL; else process.env.REMOTE_MUSIC_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.REMOTE_MUSIC_API_TOKEN; else process.env.REMOTE_MUSIC_API_TOKEN = previousToken;
    await botApi.close(); await botDb.$disconnect(); await site.close(); await music.close();
  }
});
