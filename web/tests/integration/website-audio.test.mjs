import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startMusicServerFixture, apiToken, ownerA } from './music-server-fixture.mjs';
import { startWebsiteFixture } from './website-fixture.mjs';

async function registerAndLogin(site) {
  const created = await site.request('/web/api/auth/register', { method: 'POST', body: { discordId: ownerA } });
  assert.equal(created.status, 201); assert.deepEqual(await created.json(), { success: true });
  const normal = await site.login(ownerA, 'piyan'); assert.equal(normal.response.status, 200);
  assert.equal(normal.state.scope, 'full');
  return { session: normal.session, password: 'piyan' };
}

test('website media proxy preserves real music_server Nginx audio and single Range HTTP semantics', { timeout: 60000 }, async t => {
  const music = await startMusicServerFixture({ nginx: true });
  const site = await startWebsiteFixture({ musicBase: music.base });
  try {
    const { session } = await registerAndLogin(site);
    const path = `/web/api/songs/${music.song.id}/audio`;
    let etag, lastModified;
    await t.test('authorized full bytes and HEAD preserve length/MIME without exposing internal headers', async () => {
      assert.equal((await site.request(path)).status, 401);
      const full = await site.request(path, { session, headers: { authorization: 'Bearer untrusted-browser-key' } });
      assert.equal(full.status, 200);
      assert.equal(Number(full.headers.get('content-length')), music.songBytes.length);
      assert.match(full.headers.get('content-type'), /^audio\/wav/);
      assert.equal(full.headers.get('accept-ranges'), 'bytes');
      assert.match(full.headers.get('cache-control'), /private.*no-store/);
      assert.equal(full.headers.get('x-accel-redirect'), null); assert.equal(full.headers.get('set-cookie'), null);
      const bytes = Buffer.from(await full.arrayBuffer());
      assert.deepEqual(bytes, music.songBytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), music.song.sha256);
      etag = full.headers.get('etag'); lastModified = full.headers.get('last-modified');
      assert.ok(etag); assert.ok(lastModified);
      const head = await site.request(path, { method: 'HEAD', session });
      assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      const inaccessible = await fetch(new URL(`protected-audio/${music.song.fileKey}`, music.base));
      assert.equal(inaccessible.status, 404); await inaccessible.body?.cancel();
    });
    await t.test('206 exact and suffix ranges, If-Range fallback and 304 stay consistent', async () => {
      const range = await site.request(path, { session, headers: { range: 'bytes=0-43', 'if-range': etag } });
      assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 0-43/${music.songBytes.length}`);
      assert.equal(Number(range.headers.get('content-length')), 44);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), music.songBytes.subarray(0, 44));
      const suffix = await site.request(path, { session, headers: { range: 'bytes=-8' } });
      assert.equal(suffix.status, 206); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), music.songBytes.subarray(-8));
      const fallback = await site.request(path, { session, headers: { range: 'bytes=0-43', 'if-range': '"stale-etag"' } });
      assert.equal(fallback.status, 200); assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), music.songBytes);
      const unchanged = await site.request(path, { session, headers: { 'if-none-match': etag } });
      assert.equal(unchanged.status, 304); assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
      const rangedHead = await site.request(path, { method: 'HEAD', session, headers: { range: 'bytes=0-43' } });
      assert.ok([200, 206].includes(rangedHead.status));
      assert.equal((await rangedHead.arrayBuffer()).byteLength, 0);
    });
    await t.test('416 remains readable and malformed multi-range is rejected by website', async () => {
      const outOfBounds = await site.request(path, { session, headers: { range: 'bytes=999999999-' } });
      assert.equal(outOfBounds.status, 416);
      assert.equal(outOfBounds.headers.get('content-range'), `bytes */${music.songBytes.length}`);
      const body = await outOfBounds.arrayBuffer();
      const length = outOfBounds.headers.get('content-length');
      if (length !== null) assert.equal(Number(length), body.byteLength, 'A bodyless 416 must not retain the upstream HTML body length.');
      const malformed = await site.request(path, { session, headers: { range: 'bytes=0-1,3-4' } });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await music.db.song.findMany({ orderBy: { id: 'asc' } }), music.initialSongs);
    });
  } finally { await site.close(); await music.close(); }
});

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.ok(predicate(), message);
}

/** A controllable real HTTP origin makes cancellation observable; it is not the Nginx-byte test above. */
async function slowAudioOrigin() {
  const stats = { started: 0, active: 0, aborted: 0, authorized: 0 };
  const sockets = new Set();
  const origin = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${apiToken}`) { response.writeHead(401); response.end(); return; }
    stats.authorized++;
    response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': 2 * 1024 * 1024,
      'accept-ranges': 'bytes', 'set-cookie': 'upstream-private=must-not-leak', 'x-private-path': '/private/audio.wav' });
    if (request.method === 'HEAD') { response.end(); return; }
    stats.started++; stats.active++;
    let sent = 0;
    const timer = setInterval(() => {
      const chunk = Buffer.alloc(4096, 3);
      response.write(chunk); sent += chunk.length;
      if (sent >= 2 * 1024 * 1024) response.end();
    }, 15);
    response.once('close', () => {
      clearInterval(timer); stats.active--;
      if (!response.writableEnded) stats.aborted++;
    });
  });
  origin.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { origin.once('error', reject); origin.listen(0, '127.0.0.1', resolve); });
  return { stats, base: `http://127.0.0.1:${origin.address().port}/`, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => origin.close(error => error ? reject(error) : resolve()));
  } };
}

test('real HTTP media cancellation, session revocation and website disposal close upstream work', { timeout: 30000 }, async t => {
  const upstream = await slowAudioOrigin();
  const site = await startWebsiteFixture({ musicBase: upstream.base,
    env: { WEB_MEDIA_MAX_PER_USER: '1', WEB_SSE_RECHECK_MS: '250' } });
  try {
    let { session } = await registerAndLogin(site);
    const path = '/web/api/songs/00000000-0000-4000-8000-000000000001/audio';
    await t.test('aborting the browser request aborts upstream and releases the media slot', async () => {
      const controller = new AbortController();
      const response = await site.request(path, { session, signal: controller.signal });
      assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('x-private-path'), null);
      const reader = response.body.getReader(); const first = await reader.read(); assert.ok(first.value.length > 0);
      const limited = await site.request(path, { session }); assert.equal(limited.status, 429); await limited.body?.cancel();
      controller.abort(); await reader.cancel().catch(() => {});
      await waitUntil(() => upstream.stats.aborted >= 1 && upstream.stats.active === 0, 'Browser abort must close the actual upstream response.');
      const head = await site.request(path, { method: 'HEAD', session }); assert.equal(head.status, 200);
      assert.equal(upstream.stats.started, 1, 'The rejected extra request must not reach the origin.');
    });
    await t.test('logout terminates an already streaming response at the session recheck', async () => {
      const response = await site.request(path, { session });
      const reader = response.body.getReader(); assert.ok((await reader.read()).value.length > 0);
      const logout = await site.request('/web/api/auth/logout', { method: 'POST', session }); assert.equal(logout.status, 200);
      const finish = async () => { while (!(await reader.read()).done) {} };
      await assert.rejects(finish());
      await waitUntil(() => upstream.stats.aborted >= 2 && upstream.stats.active === 0, 'Revocation must terminate the upstream audio request.');
      assert.equal((await site.request(path, { session })).status, 401);
      const normal = await site.login(ownerA, 'piyan'); assert.equal(normal.response.status, 200); session = normal.session;
    });
    await t.test('closing only the website drains its active media connections', async () => {
      const response = await site.request(path, { session });
      const reader = response.body.getReader(); assert.ok((await reader.read()).value.length > 0);
      await site.app.close();
      await reader.cancel().catch(() => {});
      await waitUntil(() => upstream.stats.aborted >= 3 && upstream.stats.active === 0, 'Website disposal must not leave an upstream stream/timer alive.');
      assert.equal(upstream.stats.authorized >= 4, true);
    });
  } finally { await site.close(); await upstream.close(); }
});
