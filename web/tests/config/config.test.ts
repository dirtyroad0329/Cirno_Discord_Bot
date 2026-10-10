import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadWebConfig, normalizeLibraryUrl } from '../../server/config/index.js';

test('website env is private, runtime overrides are typed, and DB paths are independent of cwd', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'cirno-web-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, '.env'), 'WEB_ENABLED=true\nWEB_PORT=3101\nWEB_AUTH_DB_PATH=./persist/auth.sqlite\nTOKEN=never-inject\nWEB_MUSIC_API_TOKEN=web-fixture\n');
  const originalToken = process.env.TOKEN;
  const config = loadWebConfig({ webRoot: root, env: { WEB_PORT: '3102' }, backend: { baseUrl: 'https://music.example/', token: 'bot-fixture' }, requireBackend: true });
  assert.equal(config.port, 3102);
  assert.equal(config.authDbPath, resolve(root, 'persist/auth.sqlite'));
  assert.equal(config.musicApiToken, 'web-fixture');
  assert.equal(config.musicApiUrl, 'https://music.example/');
  assert.equal(process.env.TOKEN, originalToken);
  assert.equal(config.enabled, true);
});

test('auth CLI config needs no Bot backend; full website rejects a different library identity', () => {
  const webRoot = resolve(tmpdir(), 'cirno-nonexistent-web-config');
  const config = loadWebConfig({ webRoot, env: {} });
  assert.equal(config.enabled, false);
  assert.equal(config.musicApiUrl, '');
  assert.throws(() => loadWebConfig({ webRoot, env: { WEB_MUSIC_API_URL: 'https://other.example' }, backend: { baseUrl: 'https://music.example', token: 'fixture' } }), /曲庫身份/);
  assert.equal(normalizeLibraryUrl('HTTPS://MUSIC.EXAMPLE:443'), 'https://music.example/');
  assert.throws(() => normalizeLibraryUrl('https://fixture:secret@music.example'), /憑證/);
});

test('public upload URLs and production cookies use explicit safe config', () => {
  const webRoot = resolve(tmpdir(), 'cirno-nonexistent-web-config');
  assert.throws(() => loadWebConfig({ webRoot, env: { WEB_PUBLIC_URL: 'http://public.example' } }), /HTTPS/);
  assert.throws(() => loadWebConfig({ webRoot, env: { WEB_UPLOAD_URL: 'https://admin.example?token=fixture' } }), /HTTP/);
  assert.throws(() => loadWebConfig({ webRoot, env: { WEB_PORT: '3100junk' } }), /整數/);
  const config = loadWebConfig({ webRoot, env: { WEB_PUBLIC_URL: 'https://cirno.example', WEB_UPLOAD_URL: 'https://admin.example/admin' } });
  assert.equal(config.secureCookies, true);
  assert.equal(config.uploadUrl, 'https://admin.example/admin');
});
