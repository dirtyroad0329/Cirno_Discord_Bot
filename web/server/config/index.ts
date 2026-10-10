import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export interface BackendSettings { baseUrl: string; token: string; }
export interface WebConfig {
  enabled: boolean;
  webRoot: string;
  botRoot: string;
  host: string;
  port: number;
  publicOrigin: string;
  secureCookies: boolean;
  authDbPath: string;
  clientDist: string;
  musicApiUrl: string;
  musicApiToken: string;
  uploadUrl: string;
  apiTimeoutMs: number;
  mediaIdleTimeoutMs: number;
  mediaMaxConnections: number;
  mediaMaxPerUser: number;
  sseMaxConnections: number;
  sseMaxPerUser: number;
  sseRecheckMs: number;
  commandMaxPendingPerGuild: number;
  commandTimeoutMs: number;
  bodyLimit: number;
}
export class WebConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'WebConfigurationError'; }
}

export interface SupervisorConfig {
  stallMs: number;
  startupGraceMs: number;
  restartDelayMs: number;
  killGraceMs: number;
  maxRestartsPerHour: number;
}

export function loadSupervisorConfig(options: { webRoot?: string; env?: NodeJS.ProcessEnv } = {}): SupervisorConfig {
  const webRoot = options.webRoot ?? findWebRoot();
  const path = resolve(webRoot, '.env');
  const fileValues = existsSync(path) ? parse(readFileSync(path)) : {};
  const runtime = options.env ?? process.env;
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = (runtime[key] ?? fileValues[key] ?? String(fallback)).trim();
    const number = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < min || number > max) {
      throw new WebConfigurationError(`${key} 超出範圍。`);
    }
    return number;
  };
  return {
    stallMs: integer('WEB_SUPERVISOR_STALL_MS', 20000, 5000, 300000),
    startupGraceMs: integer('WEB_SUPERVISOR_STARTUP_GRACE_MS', 60000, 10000, 300000),
    restartDelayMs: integer('WEB_SUPERVISOR_RESTART_DELAY_MS', 2000, 100, 60000),
    killGraceMs: integer('WEB_SUPERVISOR_KILL_GRACE_MS', 5000, 1000, 30000),
    maxRestartsPerHour: integer('WEB_SUPERVISOR_MAX_RESTARTS_PER_HOUR', 5, 1, 60),
  };
}

/** Locate the website package from either source or compiled modules, independent of cwd. */
export function findWebRoot(from = import.meta.url): string {
  let directory = dirname(fileURLToPath(from));
  while (true) {
    const packagePath = resolve(directory, 'package.json');
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string };
      if (pkg.name === 'cirno-web') return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new WebConfigurationError('找不到 web/package.json。');
    directory = parent;
  }
}

export function normalizeLibraryUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.endsWith('/') ? raw : `${raw}/`); }
  catch { throw new WebConfigurationError('曲庫網址不是有效 HTTP(S) 網址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new WebConfigurationError('曲庫網址不可包含憑證、查詢參數或片段。');
  }
  return url.href;
}

function publicUrl(raw: string, name: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebConfigurationError(`${name} 不是有效網址。`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new WebConfigurationError(`${name} 必須是無憑證的 HTTP(S) 網址。`);
  }
  return url;
}

export function loadWebConfig(options: {
  webRoot?: string;
  env?: NodeJS.ProcessEnv;
  backend?: BackendSettings;
  requireBackend?: boolean;
} = {}): WebConfig {
  const webRoot = resolve(options.webRoot ?? findWebRoot());
  const path = resolve(webRoot, '.env');
  const fileValues = existsSync(path) ? parse(readFileSync(path)) : {};
  const runtime = options.env ?? process.env;
  // Parse into a private object: never override the Bot's process.env.
  const value = (key: string, fallback = '') => (runtime[key] ?? fileValues[key] ?? fallback).trim();
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = value(key, String(fallback));
    if (!/^\d+$/.test(raw)) throw new WebConfigurationError(`${key} 必須是整數。`);
    const result = Number(raw);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new WebConfigurationError(`${key} 超出範圍。`);
    return result;
  };
  const enabledValue = value('WEB_ENABLED', 'false');
  if (!['true', 'false'].includes(enabledValue)) throw new WebConfigurationError('WEB_ENABLED 必須是 true 或 false。');
  const host = value('WEB_HOST', '127.0.0.1');
  if (!host || /[\s\x00-\x1f]/.test(host)) throw new WebConfigurationError('WEB_HOST 無效。');
  const port = integer('WEB_PORT', 3100, 1, 65535);
  const website = publicUrl(value('WEB_PUBLIC_URL', `http://127.0.0.1:${port}`), 'WEB_PUBLIC_URL');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(website.hostname);
  if (website.protocol !== 'https:' && !loopback) throw new WebConfigurationError('正式網站必須使用 HTTPS；HTTP 僅限 localhost 開發。');
  const configuredApi = value('WEB_MUSIC_API_URL');
  const backendUrl = options.backend?.baseUrl ? normalizeLibraryUrl(options.backend.baseUrl) : '';
  const musicApiUrl = configuredApi ? normalizeLibraryUrl(configuredApi) : backendUrl;
  const musicApiToken = value('WEB_MUSIC_API_TOKEN') || options.backend?.token || '';
  if (backendUrl && musicApiUrl !== backendUrl) throw new WebConfigurationError('網站與 Bot 必須使用相同曲庫身份。');
  if (options.requireBackend && (!musicApiUrl || !musicApiToken)) throw new WebConfigurationError('請設定既有 Bot 曲庫連線或 WEB_MUSIC_API_URL／TOKEN。');
  const configuredUpload = value('WEB_UPLOAD_URL');
  const uploadUrl = configuredUpload ? publicUrl(configuredUpload, 'WEB_UPLOAD_URL').href : musicApiUrl ? new URL('admin', musicApiUrl).href : '';
  const configuredDb = value('WEB_AUTH_DB_PATH', './data/auth.sqlite');
  return {
    enabled: enabledValue === 'true', webRoot, botRoot: resolve(webRoot, '..'), host, port,
    publicOrigin: website.origin, secureCookies: website.protocol === 'https:',
    authDbPath: isAbsolute(configuredDb) ? configuredDb : resolve(webRoot, configuredDb),
    clientDist: resolve(webRoot, 'dist/client'), musicApiUrl, musicApiToken, uploadUrl,
    apiTimeoutMs: integer('WEB_API_TIMEOUT_MS', 8000, 100, 120000),
    mediaIdleTimeoutMs: integer('WEB_MEDIA_IDLE_TIMEOUT_MS', 30000, 1000, 300000),
    mediaMaxConnections: integer('WEB_MEDIA_MAX_CONNECTIONS', 16, 1, 256),
    mediaMaxPerUser: integer('WEB_MEDIA_MAX_PER_USER', 3, 1, 32),
    sseMaxConnections: integer('WEB_SSE_MAX_CONNECTIONS', 64, 1, 1024),
    sseMaxPerUser: integer('WEB_SSE_MAX_PER_USER', 3, 1, 16),
    sseRecheckMs: integer('WEB_SSE_RECHECK_MS', 2000, 250, 10000),
    commandMaxPendingPerGuild: integer('WEB_COMMAND_MAX_PENDING_PER_GUILD', 8, 1, 100),
    commandTimeoutMs: integer('WEB_COMMAND_TIMEOUT_MS', 30000, 1000, 120000),
    bodyLimit: 128 * 1024,
  };
}
