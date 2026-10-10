import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFixture, GUILD, snapshot } from './apiFixture.js';
import { WebError } from '../server/http/errors.js';

async function readUntilClosed(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return Buffer.concat(chunks).toString('utf8');
    chunks.push(chunk.value);
  }
}

test('SSE authorizes every emission and reconnect; leaving voice stops snapshots without replay', { timeout: 5000 }, async () => {
  let permitted = true;
  const fixture = await apiFixture({ bot: { snapshot: () => {
    if (!permitted) throw new WebError(403, 'VOICE_REQUIRED', '請加入語音頻道。');
    return snapshot();
  } } });
  const abort = new AbortController();
  try {
    const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/web/api/player/${GUILD}/events`, { headers: fixture.headers, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = Buffer.from((await reader.read()).value!).toString('utf8');
    assert.match(first, /event: snapshot/);
    assert.match(first, /id: 1/);
    assert.doesNotMatch(first, /tokenHash|csrfToken|server-only-secret/);
    permitted = false;
    for (const observer of fixture.observers) observer(GUILD);
    const remainder = await readUntilClosed(reader);
    assert.match(remainder, /event: unavailable/);
    assert.doesNotMatch(remainder, /event: snapshot/);
    assert.equal(fixture.observers.size, 0);
    const reconnect = await fetch(`${origin}/web/api/player/${GUILD}/events`, {
      headers: { ...fixture.headers, 'last-event-id': '1' }, signal: abort.signal });
    assert.equal(reconnect.status, 403);
    assert.doesNotMatch(await reconnect.text(), /Trusted song|session-one/);
    // No Bot shutdown is involved in loss of website voice access.
    permitted = true;
    const command = await fixture.app.inject({ method: 'POST', url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers,
      payload: { requestId: 'after-sse-loss', sessionId: 'session-one', action: 'pause' } });
    assert.equal(command.statusCode, 200);
  } finally { abort.abort(); await fixture.close(); }
});

test('SSE rechecks revoked sessions and independently bounds/cleans each website connection', { timeout: 5000 }, async () => {
  const fixture = await apiFixture({ env: { WEB_SSE_MAX_PER_USER: '1' } });
  const abort = new AbortController();
  try {
    const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/web/api/player/${GUILD}/events`, { headers: fixture.headers, signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    const extra = await fetch(`${origin}/web/api/player/${GUILD}/events`, { headers: fixture.headers, signal: abort.signal });
    assert.equal(extra.status, 429);
    await extra.body!.cancel();
    await fixture.auth.logout(fixture.login.token);
    const remainder = await readUntilClosed(reader);
    assert.match(remainder, /event: unavailable/);
    assert.doesNotMatch(remainder, /event: snapshot/);
    assert.equal(fixture.observers.size, 0);
    assert.equal((await fixture.app.inject({ url: `/web/api/player/${GUILD}`, headers: fixture.headers })).statusCode, 401);
  } finally { abort.abort(); await fixture.close(); }
});

test('closing website clears active SSE and leaves its separately owned auth service open', { timeout: 5000 }, async () => {
  const fixture = await apiFixture();
  const abort = new AbortController();
  try {
    const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/web/api/player/${GUILD}/events`, { headers: fixture.headers, signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    const closed = readUntilClosed(reader);
    await fixture.app.close();
    assert.equal(await closed, '');
    assert.equal(fixture.observers.size, 0);
    assert.ok(await fixture.auth.authenticate(fixture.login.token));
  } finally { abort.abort(); await fixture.close(); }
});

test('observer setup failure affects only its SSE client and not subsequent Bot controls', { timeout: 5000 }, async () => {
  const fixture = await apiFixture({ bot: { subscribe: () => { throw new Error('observer failed'); } } });
  const abort = new AbortController();
  try {
    const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/web/api/player/${GUILD}/events`, { headers: fixture.headers, signal: abort.signal });
    assert.equal(await response.text(), '');
    const command = await fixture.app.inject({ method: 'POST', url: `/web/api/player/${GUILD}/commands`, headers: fixture.headers,
      payload: { requestId: 'after-observer-failure', sessionId: 'session-one', action: 'pause' } });
    assert.equal(command.statusCode, 200);
  } finally { abort.abort(); await fixture.close(); }
});
