import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getRemoteSong } from '../dist/features/music/api.js';
import { resolvePlaylist } from '../dist/features/playlists/api.js';
import logger from '../dist/shared/logging/logger.js';

const ids = Array.from({ length: 8 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);

async function fixture(t, status = 200) {
    let began, closed;
    const started = new Promise(resolve => { began = resolve; });
    const disconnected = new Promise(resolve => { closed = resolve; });
    const requests = [];
    const server = createServer((request, response) => {
        requests.push(request.url); response.on('close', closed);
        if (status === 429) response.writeHead(429, { 'Retry-After': '3' }).end();
        else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); }
        began();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const saved = [process.env.REMOTE_MUSIC_API_URL, process.env.REMOTE_MUSIC_API_TOKEN];
    process.env.REMOTE_MUSIC_API_URL = `http://127.0.0.1:${server.address().port}/`;
    process.env.REMOTE_MUSIC_API_TOKEN = 'cancel-fixture';
    const errors = []; t.mock.method(logger, 'error', error => errors.push(error));
    t.after(async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        ['REMOTE_MUSIC_API_URL', 'REMOTE_MUSIC_API_TOKEN'].forEach((key, index) => {
            if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
        });
    });
    return { started, disconnected, requests, errors, saved: ids.map(id => ({ source: 'remote', id, title: id, library: process.env.REMOTE_MUSIC_API_URL })) };
}

test('metadata cancellation aborts an actual fetch body read and releases its connection', async t => {
    const { started, disconnected, requests } = await fixture(t);
    const controller = new AbortController();
    const result = getRemoteSong(ids[0], { signal: controller.signal });
    const rejected = assert.rejects(result, error => error.name === 'AbortError');
    await started; controller.abort();
    await Promise.all([rejected, disconnected]);
    assert.equal(requests.length, 1);
});

test('playlist cancellation stops active reads and scheduled workers rather than returning unavailable entries', async t => {
    const { started, disconnected, requests, errors, saved } = await fixture(t);
    const controller = new AbortController();
    const result = resolvePlaylist(saved, { signal: controller.signal });
    const rejected = assert.rejects(result, error => error.name === 'AbortError');
    await started; controller.abort();
    await Promise.all([rejected, disconnected]);
    assert.equal(requests.length, 1); assert.equal(errors.length, 0);
    assert.equal(saved.length, 8);
});

test('playlist cancellation interrupts a Retry-After delay without issuing retries', async t => {
    const { started, requests, saved, errors } = await fixture(t, 429);
    const controller = new AbortController();
    const result = resolvePlaylist(saved.slice(0, 1), { signal: controller.signal });
    const rejected = assert.rejects(result, error => error.name === 'AbortError');
    await started; controller.abort(); await rejected;
    assert.equal(requests.length, 1); assert.equal(errors.length, 0);
});

test('an already cancelled playlist performs no metadata I/O', async t => {
    const { requests, saved } = await fixture(t);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolvePlaylist(saved, { signal: controller.signal }), error => error.name === 'AbortError');
    await assert.rejects(getRemoteSong(ids[0], { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(requests.length, 0);
});
