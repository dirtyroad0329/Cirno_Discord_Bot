import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthSession } from '../auth/index.js';

export type WebsiteSession = AuthSession;
export interface AuthGuard {
  requireSession(request: FastifyRequest, options?: { allowPasswordChange?: boolean }): Promise<WebsiteSession>;
  requireWrite(request: FastifyRequest, session: WebsiteSession): void | Promise<void>;
  readToken(request: FastifyRequest): string | null | undefined;
}
export interface SessionInspector { authenticate(token: string, options?: { touch?: boolean }): Promise<WebsiteSession | null>; }

export function requestCancellation(request: FastifyRequest, reply: FastifyReply): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const aborted = () => controller.abort();
  const closed = () => { if (!reply.raw.writableFinished) controller.abort(); };
  request.raw.once('aborted', aborted);
  reply.raw.once('close', closed);
  // Authentication may have awaited SQLite after the disconnect event already fired.
  if (request.raw.aborted || reply.raw.destroyed) controller.abort();
  return { signal: controller.signal, dispose() {
    request.raw.off('aborted', aborted);
    reply.raw.off('close', closed);
  } };
}

export async function authorizeWrite(guard: AuthGuard, request: FastifyRequest): Promise<WebsiteSession> {
  const session = await guard.requireSession(request);
  await guard.requireWrite(request, session);
  return session;
}
