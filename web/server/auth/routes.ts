import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from './errors.js';
import type { AuthService, AuthSession } from './service.js';

export const AUTH_COOKIE = 'cirno_web_session';
export interface AuthHttpOptions { publicOrigin: string; secureCookies: boolean }

interface Attempt { count: number; expiresAt: number; failures: number; retryAt: number }
/** In-memory login protection is process-local and bounded. Account credentials
 * and revocation remain in SQLite so another CLI/process cannot bypass them. */
class LoginLimiter {
  private readonly entries = new Map<string, Attempt>();

  check(keys: string[]): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    if (this.entries.size >= 5000 && keys.some((key) => !this.entries.has(key))) {
      throw new AuthError('AUTH_BUSY', '登入服務忙碌，請稍後再試。', 503);
    }
    for (const key of keys) {
      const entry = this.entries.get(key);
      const limit = key.startsWith('ip:') ? 30 : 8;
      if (entry && (entry.count >= limit || entry.retryAt > now)) {
        throw new AuthError('LOGIN_RATE_LIMIT', '登入嘗試過於頻繁，請稍後再試。', 429);
      }
    }
    for (const key of keys) {
      const entry = this.entries.get(key) ?? { count: 0, expiresAt: now + 60_000, failures: 0, retryAt: 0 };
      entry.count++;
      this.entries.set(key, entry);
    }
  }

  failure(keys: string[]): void {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) {
        entry.failures++;
        entry.retryAt = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(entry.failures - 1, 6));
      }
    }
  }
}

/** Public registration has independent account/IP limits and a global ceiling.
 * All counters expire and have a fixed maximum, including rejected attempts. */
class RegistrationLimiter {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  check(ip: string, discordId: string): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    const limits: Array<[string, number]> = [['global', 60], [`ip:${ip}`, 10], [`id:${discordId}`, 3]];
    if (this.entries.size + limits.filter(([key]) => !this.entries.has(key)).length > 5000) {
      throw new AuthError('AUTH_BUSY', '註冊服務忙碌，請稍後再試。', 503);
    }
    for (const [key, limit] of limits) {
      if ((this.entries.get(key)?.count ?? 0) >= limit) {
        throw new AuthError('REGISTER_RATE_LIMIT', '註冊嘗試過於頻繁，請稍後再試。', 429);
      }
    }
    for (const [key] of limits) {
      const entry = this.entries.get(key) ?? { count: 0, expiresAt: now + 60_000 };
      entry.count++;
      this.entries.set(key, entry);
    }
  }
}

export function createAuthHttp(auth: AuthService, options: AuthHttpOptions) {
  const publicOrigin = new URL(options.publicOrigin).origin;
  const limiter = new LoginLimiter();
  const registrationLimiter = new RegistrationLimiter();

  function readToken(request: FastifyRequest): string {
    const matches = (request.headers.cookie ?? '').split(';')
      .map((value) => value.trim()).filter((value) => value.startsWith(`${AUTH_COOKIE}=`));
    // Ambiguous duplicate cookies are rejected rather than choosing one by order.
    return matches.length === 1 ? matches[0]!.slice(AUTH_COOKIE.length + 1) : '';
  }

  function requireOrigin(request: FastifyRequest): void {
    if (request.headers.origin !== publicOrigin || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new AuthError('ORIGIN_REJECTED', '請從網站本身發出此操作。', 403);
    }
  }

  async function requireSession(request: FastifyRequest): Promise<AuthSession> {
    const session = await auth.authenticate(readToken(request));
    if (!session) throw new AuthError('AUTH_REQUIRED', '請先登入。', 401);
    return session;
  }

  function requireWrite(request: FastifyRequest, session: AuthSession): void {
    requireOrigin(request);
    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || supplied.length !== session.csrfToken.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken))) {
      throw new AuthError('CSRF_REJECTED', '操作驗證已失效，請重新整理頁面。', 403);
    }
  }

  function cookie(token: string, maxAge: number): string {
    return `${AUTH_COOKIE}=${token}; Path=/web; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${options.secureCookies ? '; Secure' : ''}`;
  }

  async function registerRoutes(app: FastifyInstance): Promise<void> {
    const noStore = async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
    };
    app.post<{ Body: { discordId: string } }>('/web/api/auth/register', {
      onRequest: noStore,
      bodyLimit: 1024,
      // Validate before AJV coercion/removal, including when this module is used
      // by a host Fastify app with different default AJV options.
      preValidation: async (request) => {
        requireOrigin(request);
        const body = request.body as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !('discordId' in body) || typeof body.discordId !== 'string') {
          throw new AuthError('INVALID_REGISTRATION', '註冊僅接受 Discord ID。');
        }
      },
      schema: { body: { type: 'object', required: ['discordId'], additionalProperties: false,
        properties: { discordId: { type: 'string', pattern: '^\\d{17,20}$', maxLength: 20 } } } },
    }, async (request, reply) => {
      registrationLimiter.check(request.ip, request.body.discordId);
      await auth.createUser(request.body.discordId);
      reply.code(201);
      return { success: true };
    });
    app.post<{ Body: { discordId?: unknown; password?: unknown } }>('/web/api/auth/login', {
      onRequest: noStore,
      bodyLimit: 8192,
      schema: { body: { type: 'object', required: ['discordId', 'password'], additionalProperties: false,
        properties: { discordId: { type: 'string', maxLength: 20 }, password: { type: 'string', maxLength: 1024 } } } },
    }, async (request, reply) => {
      requireOrigin(request);
      const keys = [`ip:${request.ip}`, `id:${String(request.body.discordId).slice(0, 32)}`];
      limiter.check(keys);
      let result;
      try {
        result = await auth.login(request.body.discordId as string, request.body.password as string);
      } catch (error) {
        if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') limiter.failure(keys);
        throw error;
      }
      reply.header('Set-Cookie', cookie(result.token, Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000))));
      return { user: result.user, csrfToken: result.csrfToken, scope: result.scope, expiresAt: result.expiresAt };
    });
    app.get('/web/api/auth/me', { onRequest: noStore }, async (request) => {
      const session = await requireSession(request);
      return { user: { discordId: session.discordId, mustChangePassword: false },
        csrfToken: session.csrfToken, scope: session.scope, expiresAt: session.expiresAt };
    });
    app.post<{ Body: { currentPassword: string; newPassword: string } }>('/web/api/auth/password', {
      onRequest: noStore,
      bodyLimit: 8192,
      schema: { body: { type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false,
        properties: { currentPassword: { type: 'string', maxLength: 1024 }, newPassword: { type: 'string', maxLength: 1024 } } } },
    }, async (request, reply) => {
      const session = await requireSession(request);
      requireWrite(request, session);
      await auth.changePassword(session, request.body.currentPassword, request.body.newPassword);
      reply.header('Set-Cookie', cookie('', 0));
      return { success: true, requireLogin: true };
    });
    app.post('/web/api/auth/logout', { onRequest: noStore }, async (request, reply) => {
      const session = await requireSession(request);
      requireWrite(request, session);
      await auth.logout(readToken(request));
      reply.header('Set-Cookie', cookie('', 0));
      return { success: true };
    });
  }

  return { registerRoutes, requireSession, requireWrite, readToken };
}

export type AuthHttp = ReturnType<typeof createAuthHttp>;
