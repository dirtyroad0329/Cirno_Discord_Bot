import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAuthService } from '../../server/auth/index.ts';
import { createWebApp } from '../../server/app.ts';
import { loadWebConfig } from '../../server/config/index.ts';
import { apiToken } from './music-server-fixture.mjs';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const unavailableBot = {
  async voiceContexts() { return []; },
  async snapshot() { throw Object.assign(new Error('No Discord Gateway in integration fixture'), { code: 'VOICE_REQUIRED' }); },
  async execute() { throw new Error('Discord playback is covered by its separate control integration.'); },
  subscribe() { return () => {}; },
};

/** Real website Fastify, password hashing and a separate SQLite; only the Bot is replaced. */
export async function startWebsiteFixture({ musicBase, env = {}, authOptions = {}, bot = unavailableBot, clientDist, resolvePlaylist }) {
  const root = await mkdtemp(join(tmpdir(), 'cirno-web-auth-integration-'));
  const port = await availablePort();
  await mkdir(join(root, 'dist/client'), { recursive: true });
  await writeFile(join(root, 'dist/client/index.html'), '<!doctype html><title>Public fixture page</title>');
  const config = loadWebConfig({ webRoot: root, env: {
    WEB_ENABLED: 'true', WEB_PORT: String(port), WEB_PUBLIC_URL: `http://127.0.0.1:${port}`,
    WEB_AUTH_DB_PATH: join(root, 'private-auth.sqlite'), WEB_MUSIC_API_URL: musicBase,
    WEB_MUSIC_API_TOKEN: apiToken, ...env,
  }, requireBackend: true });
  if (clientDist) config.clientDist = clientDist;
  const fixture = { root, config, auth: undefined, app: undefined, base: config.publicOrigin };
  fixture.request = (path, { session, headers = {}, body, ...options } = {}) => fetch(new URL(path, fixture.base), {
    ...options, headers: { origin: config.publicOrigin,
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: options.redirect ?? 'manual',
    signal: options.signal ?? AbortSignal.timeout(15000),
  });
  fixture.login = async (discordId, password) => {
    const response = await fixture.request('/web/api/auth/login', { method: 'POST', body: { discordId, password } });
    const state = await response.json();
    return { response, state, session: { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0], csrfToken: state.csrfToken } };
  };
  fixture.restart = async () => {
    await fixture.app?.close(); await fixture.auth?.close();
    fixture.auth = await openAuthService({ dbPath: config.authDbPath, ...authOptions });
    fixture.app = await createWebApp({ config, auth: fixture.auth, bot, ...(resolvePlaylist ? { resolvePlaylist } : {}) });
    await fixture.app.listen({ host: '127.0.0.1', port });
  };
  fixture.close = async () => {
    try { await fixture.app?.close(); }
    finally { try { await fixture.auth?.close(); } finally { await rm(root, { recursive: true, force: true }); } }
  };
  try { await fixture.restart(); return fixture; }
  catch (error) { await fixture.close().catch(() => {}); throw error; }
}
