import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startMusicServerFixture, apiToken, ownerA, ownerB } from './music-server-fixture.mjs';

test('unchanged music_server remains the shared song and playlist authority', { timeout: 60000 }, async t => {
  const fixture = await startMusicServerFixture();
  const { connectDatabase } = await import(pathToFileURL(join(fixture.apiRoot, 'dist/infrastructure/database.js')));
  const { buildApp } = await import(pathToFileURL(join(fixture.apiRoot, 'dist/app.js')));
  const secondDb = await connectDatabase(fixture.databaseUrl);
  const secondApp = buildApp({ db: secondDb, token: apiToken, audioRoot: fixture.audioRoot });
  const secondBase = `${await secondApp.listen({ host: '127.0.0.1', port: 0 })}/`;
  const original = (await (await fixture.request(`v1/playlists/${fixture.existingPlaylist.id}`)).json());
  let playlist;
  const remote = { source: 'remote', id: fixture.song.id, title: fixture.song.title, artist: fixture.song.artist, library: fixture.base };
  try {
    await t.test('catalog pagination and metadata keep public fields and exact UTF-8 search', async () => {
      const unauthorized = await fetch(new URL('v1/songs', fixture.apiBase));
      assert.equal(unauthorized.status, 401); await unauthorized.body?.cancel();
      const response = await fixture.request('v1/songs?query=' + encodeURIComponent('中文') + '&limit=1');
      assert.equal(response.status, 200);
      const first = await response.json();
      assert.equal(first.items.length, 1); assert.match(first.nextCursor, /^[0-9a-f-]{36}$/i);
      const next = await (await fixture.request(`v1/songs?query=${encodeURIComponent('中文')}&limit=1&cursor=${first.nextCursor}`)).json();
      assert.equal(next.items.length, 1); assert.equal(next.nextCursor, null);
      assert.notEqual(first.items[0].id, next.items[0].id);
      const song = await (await fixture.request(`v1/songs/${fixture.song.id}`)).json();
      assert.deepEqual(Object.keys(song).sort(), ['artist', 'byteSize', 'durationSeconds', 'id', 'mimeType', 'sha256', 'title', 'updatedAt'].sort());
      assert.equal(song.title, fixture.song.title); assert.equal(song.durationSeconds, 1);
      assert.equal(song.fileKey, undefined);
      assert.equal((await fixture.request('v1/songs?limit=26')).status, 400);
      const audio = await fixture.request(`v1/songs/${fixture.song.id}/audio`);
      assert.equal(audio.headers.get('x-accel-redirect'), `/protected-audio/${fixture.song.fileKey}`);
      assert.equal((await audio.arrayBuffer()).byteLength, 0, 'Fastify itself does not deliver audio bytes.');
    });

    await t.test('existing mixed-source playlist reads preserve IDs, labels, positions and revision', async () => {
      assert.equal(original.id, fixture.existingPlaylist.id); assert.equal(original.revision, 7);
      assert.deepEqual(original.entries.map(entry => entry.entryId), fixture.existingPlaylist.entries.map(entry => entry.entryId));
      assert.deepEqual(original.entries.map(entry => entry.source), ['remote', 'local', 'remote']);
      assert.equal(original.entries[0].title, '既有標題');
      assert.equal(original.entries[2].library, 'https://other-library.example/');
      assert.equal((await fixture.request(`v1/playlists/${original.id}`, { owner: ownerB })).status, 404);
      const foreign = await (await fixture.request('v1/playlists', { owner: ownerB })).json();
      assert.deepEqual(foreign.items, []);
    });

    await t.test('duplicate entries support CRUD and stale deletion rejects without side effects', async () => {
      const created = await fixture.request('v1/playlists', { method: 'POST', body: { name: 'Web/Discord shared test', tracks: [remote, remote] } });
      assert.equal(created.status, 201); playlist = await created.json();
      assert.equal(playlist.revision, 1);
      const ids = playlist.entries.map(entry => entry.entryId);
      assert.notEqual(ids[0], ids[1]);
      const moved = await fixture.request(`v1/playlists/${playlist.id}/entries/${ids[1]}`, { method: 'PATCH', body: { position: 1, revision: 1 } });
      assert.equal(moved.status, 200); playlist = await moved.json();
      assert.deepEqual(playlist.entries.map(entry => entry.entryId), [ids[1], ids[0]]);
      const staleDelete = await fixture.request(`v1/playlists/${playlist.id}`, { method: 'DELETE', body: { revision: 1 } });
      assert.equal(staleDelete.status, 409);
      const retained = await (await fixture.request(`v1/playlists/${playlist.id}`)).json();
      assert.deepEqual(retained, playlist);
      const rename = await fixture.request(`v1/playlists/${playlist.id}`, { method: 'PATCH', body: { name: 'Changed from Web', revision: playlist.revision } });
      assert.equal(rename.status, 200); playlist = await rename.json();
      assert.equal(playlist.name, 'Changed from Web');
      const remove = await fixture.request(`v1/playlists/${playlist.id}/entries/${ids[0]}`, { method: 'DELETE', body: { revision: playlist.revision } });
      assert.equal(remove.status, 200); playlist = await remove.json();
      assert.deepEqual(playlist.entries.map(entry => entry.entryId), [ids[1]]);
    });

    await t.test('two independent HTTP applications and SQLite clients race one stale revision atomically', async () => {
      const version = playlist.revision, beforeEntries = playlist.entries.length;
      const request = base => fetch(new URL(`v1/playlists/${playlist.id}/entries`, base), {
        method: 'POST', headers: fixture.headers(ownerA), body: JSON.stringify({ tracks: [remote, remote], revision: version }),
        signal: AbortSignal.timeout(15000),
      });
      const responses = await Promise.all([request(fixture.apiBase), request(secondBase)]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
      await Promise.all(responses.map(response => response.arrayBuffer()));
      playlist = await (await fixture.request(`v1/playlists/${playlist.id}`)).json();
      assert.equal(playlist.revision, version + 1);
      assert.equal(playlist.entries.length, beforeEntries + 2, 'The losing transaction must not append either entry.');
      const stale = await fixture.request(`v1/playlists/${playlist.id}/entries`, { method: 'POST', body: { tracks: [remote], revision: version } });
      assert.equal(stale.status, 409);
      assert.deepEqual(await (await fixture.request(`v1/playlists/${playlist.id}`)).json(), playlist);
    });

    await t.test('reopening the server preserves both old and new data; deletion cascades only owned entries', async () => {
      await fixture.restart();
      assert.deepEqual(await (await fixture.request(`v1/playlists/${original.id}`)).json(), original);
      assert.deepEqual(await (await fixture.request(`v1/playlists/${playlist.id}`)).json(), playlist);
      const removed = await fixture.request(`v1/playlists/${playlist.id}`, { method: 'DELETE', body: { revision: playlist.revision } });
      assert.equal(removed.status, 204); assert.equal(await removed.text(), '');
      assert.equal(await fixture.db.playlistEntry.count({ where: { playlistId: playlist.id } }), 0);
      assert.deepEqual(await fixture.db.song.findMany({ orderBy: { id: 'asc' } }), fixture.initialSongs);
      assert.deepEqual(await (await fixture.request(`v1/playlists/${original.id}`)).json(), original);
    });
  } finally {
    await secondApp.close(); await secondDb.$disconnect(); await fixture.close();
  }
});
