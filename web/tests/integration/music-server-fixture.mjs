import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const ownerA = '123456789012345678';
export const ownerB = '223456789012345678';
export const apiToken = 'integration-only-music-api-token-012345678901234567890';

const defaultApiRoot = fileURLToPath(new URL('../../../../music_server/api/', import.meta.url));

export function fixtureWave(seconds = 1) {
  const dataLength = seconds * 16000;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function docker(args) {
  // The local managed daemon is selected explicitly; registry/proxy defaults are preserved.
  const env = { ...process.env };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  return execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  }).trim();
}

/** Real server code, real migrations and a private temporary SQLite; no production configuration. */
export async function startMusicServerFixture({ nginx = false } = {}) {
  const apiRoot = resolve(process.env.MUSIC_SERVER_API_ROOT || defaultApiRoot);
  let serverModule, databaseModule;
  try {
    [serverModule, databaseModule] = await Promise.all([
      import(pathToFileURL(join(apiRoot, 'dist/app.js'))),
      import(pathToFileURL(join(apiRoot, 'dist/infrastructure/database.js'))),
    ]);
  } catch (cause) {
    throw new Error('Build music_server/api first (npm run db:generate && npm run build), or set MUSIC_SERVER_API_ROOT.', { cause });
  }
  const root = await mkdtemp(join(tmpdir(), 'cirno-web-integration-'));
  const audioRoot = join(root, 'audio');
  const databaseUrl = `file:${join(root, 'music.sqlite')}?connection_limit=1&socket_timeout=5`;
  const fixture = { root, apiRoot, audioRoot, databaseUrl, db: undefined, app: undefined, base: '', apiBase: '', container: undefined };
  fixture.headers = owner => ({ authorization: `Bearer ${apiToken}`, 'x-discord-user-id': owner,
    'content-type': 'application/json' });
  fixture.request = (path, { owner = ownerA, body, headers = {}, ...options } = {}) => fetch(new URL(path, fixture.apiBase), {
    ...options, headers: { ...fixture.headers(owner), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: options.signal || AbortSignal.timeout(15000),
  });
  fixture.restart = async () => {
    const port = Number(new URL(fixture.apiBase).port);
    await fixture.app.close(); await fixture.db.$disconnect();
    fixture.db = await databaseModule.connectDatabase(databaseUrl);
    fixture.app = serverModule.buildApp({ db: fixture.db, token: apiToken, audioRoot });
    await fixture.app.listen({ host: '0.0.0.0', port });
  };
  fixture.close = async () => {
    const failures = [];
    if (fixture.container) {
      try { docker(['rm', '-f', fixture.container]); } catch (error) { failures.push(error); }
      fixture.container = undefined;
    }
    for (const cleanup of [() => fixture.app?.close(), () => fixture.db?.$disconnect(), () => rm(root, { recursive: true, force: true })]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Integration fixture cleanup failed');
  };
  try {
    await mkdir(audioRoot);
    // Only synthetic music data lives here; the Nginx worker must traverse this bind mount.
    if (nginx) { await chmod(root, 0o755); await chmod(audioRoot, 0o755); }
    execFileSync(process.execPath, [join(apiRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: apiRoot, env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: 'info' }, stdio: 'pipe', timeout: 60000,
    });
    fixture.db = await databaseModule.connectDatabase(databaseUrl);
    fixture.app = serverModule.buildApp({ db: fixture.db, token: apiToken, audioRoot });
    fixture.apiBase = `${await fixture.app.listen({ host: '0.0.0.0', port: 0 })}/`;
    fixture.base = fixture.apiBase;
    if (nginx) {
      const nginxRoot = resolve(apiRoot, '../nginx');
      fixture.container = `cirno-web-audio-${process.pid}-${randomUUID().slice(0, 8)}`;
      const apiPort = new URL(fixture.apiBase).port;
      docker(['run', '-d', '--name', fixture.container, '--add-host', 'host.docker.internal:host-gateway',
        '-p', '127.0.0.1::80', '-e', `API_UPSTREAM=host.docker.internal:${apiPort}`,
        '-e', 'AUDIO_ROOT=/fixture/audio', '-e', 'SERVER_NAME=',
        '-v', `${root}:/fixture:ro`, '-v', `${nginxRoot}:/opt/music-nginx:ro`,
        '-v', `${nginxRoot}/nginx.conf:/etc/nginx/nginx.conf:ro`,
        '-v', `${nginxRoot}/locations.conf:/etc/nginx/snippets/music-locations.conf:ro`,
        '-v', `${nginxRoot}/docker-start.sh:/docker-entrypoint.d/25-music-config.sh:ro`,
        'nginx:1.30-alpine']);
      const port = JSON.parse(docker(['inspect', fixture.container]))[0].NetworkSettings.Ports['80/tcp'][0].HostPort;
      fixture.base = `http://127.0.0.1:${port}/`;
      let healthy = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const response = await fetch(new URL('health', fixture.base), { signal: AbortSignal.timeout(1000) });
          healthy = response.status === 200; await response.body?.cancel();
          if (healthy) break;
        } catch { /* The existing Nginx entrypoint needs time to create its configuration. */ }
        await delay(100);
      }
      assert.ok(healthy, 'The actual music_server Nginx must reach its real Fastify API.');
      docker(['exec', fixture.container, 'nginx', '-t']);
    }
    fixture.songBytes = fixtureWave();
    fixture.song = await fixture.db.song.create({ data: {
      id: randomUUID(), fileKey: `${randomUUID()}.wav`, title: '整合測試 中文歌曲', artist: 'Cirno fixture',
      durationSeconds: 1, mimeType: 'audio/wav', byteSize: fixture.songBytes.length,
      sha256: createHash('sha256').update(fixture.songBytes).digest('hex'),
    } });
    await writeFile(join(audioRoot, fixture.song.fileKey), fixture.songBytes);
    if (nginx) await chmod(join(audioRoot, fixture.song.fileKey), 0o644);
    const secondBytes = Buffer.from(fixture.songBytes); secondBytes.writeInt16LE(17, 44);
    fixture.secondSong = await fixture.db.song.create({ data: {
      id: randomUUID(), fileKey: `${randomUUID()}.wav`, title: '第二首 中文測試', artist: null,
      durationSeconds: null, mimeType: 'audio/wav', byteSize: secondBytes.length,
      sha256: createHash('sha256').update(secondBytes).digest('hex'),
    } });
    await writeFile(join(audioRoot, fixture.secondSong.fileKey), secondBytes);
    if (nginx) await chmod(join(audioRoot, fixture.secondSong.fileKey), 0o644);
    fixture.existingPlaylist = await fixture.db.playlist.create({ data: {
      id: randomUUID(), ownerId: ownerA, name: '既有混合收藏', nameKey: '既有混合收藏', revision: 7,
      entries: { create: [
        { entryId: randomUUID(), position: 0, source: 'remote', trackId: fixture.song.id, title: '既有標題', artist: '收藏標籤', library: fixture.base },
        { entryId: randomUUID(), position: 1, source: 'local', trackId: 'existing-local-track', title: '本機收藏' },
        { entryId: randomUUID(), position: 2, source: 'remote', trackId: randomUUID(), title: '其他曲庫收藏', library: 'https://other-library.example/' },
      ] },
    }, include: { entries: { orderBy: { position: 'asc' } } } });
    fixture.initialSongs = await fixture.db.song.findMany({ orderBy: { id: 'asc' } });
    return fixture;
  } catch (error) {
    await fixture.close().catch(cleanupError => { error.cleanupError = cleanupError; });
    throw error;
  }
}
