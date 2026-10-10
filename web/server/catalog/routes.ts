import type { FastifyInstance } from 'fastify';
import type { MusicClient } from '../integrations/music.js';
import { requestCancellation, type AuthGuard } from '../http/guards.js';
import { object, uuid } from '../http/errors.js';

export function registerCatalog(app: FastifyInstance, music: MusicClient, guard: AuthGuard): void {
  app.get<{ Querystring: { query?: string; cursor?: string; limit?: number } }>('/web/api/songs', {
    schema: { querystring: object({ query: { type: 'string', maxLength: 200 }, cursor: uuid,
      limit: { type: 'integer', minimum: 1, maximum: 25 } }, []) },
  }, async (request, reply) => {
    await guard.requireSession(request);
    const cancellation = requestCancellation(request, reply);
    try { return await music.songs(request.query.query, request.query.cursor, cancellation.signal); }
    finally { cancellation.dispose(); }
  });
  app.get<{ Params: { id: string } }>('/web/api/songs/:id', { schema: { params: object({ id: uuid }) } }, async (request, reply) => {
    await guard.requireSession(request);
    const cancellation = requestCancellation(request, reply);
    try { return await music.song(request.params.id, cancellation.signal); }
    finally { cancellation.dispose(); }
  });
}
