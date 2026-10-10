import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { MusicClient } from '../integrations/music.js';
import { authorizeWrite, requestCancellation, type AuthGuard } from '../http/guards.js';
import { object, revision, uuid } from '../http/errors.js';

const songIds = { type: 'array', minItems: 1, maxItems: 100, items: uuid };
const name = { type: 'string', minLength: 1, maxLength: 60 };
type Id = { id: string };
type Entry = Id & { entryId: string };
type Version = { revision: number };
async function cancellable<T>(request: FastifyRequest, reply: FastifyReply, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const cancellation = requestCancellation(request, reply);
  try { return await operation(cancellation.signal); } finally { cancellation.dispose(); }
}

export function registerPlaylists(app: FastifyInstance, music: MusicClient, guard: AuthGuard): void {
  app.get('/web/api/playlists', async (request, reply) => {
    const session = await guard.requireSession(request);
    return cancellable(request, reply, signal => music.listPlaylists(session.discordId, signal));
  });
  app.get<{ Params: Id }>('/web/api/playlists/:id', { schema: { params: object({ id: uuid }) } }, async (request, reply) => {
    const session = await guard.requireSession(request);
    return cancellable(request, reply, signal => music.getPlaylist(session.discordId, request.params.id, signal));
  });
  app.post<{ Body: { name: string; songIds?: string[] } }>('/web/api/playlists', {
    schema: { body: object({ name, songIds }, ['name']) },
  }, async (request, reply) => {
    const session = await authorizeWrite(guard, request);
    const cancellation = requestCancellation(request, reply);
    try {
      const tracks = request.body.songIds ? await music.storedTracks(request.body.songIds, cancellation.signal) : undefined;
      await guard.requireSession(request);
      const result = await music.mutatePlaylist(session.discordId, '', 'POST', { name: request.body.name, ...(tracks ? { tracks } : {}) }, cancellation.signal);
      return reply.code(201).send(result);
    } finally { cancellation.dispose(); }
  });
  app.patch<{ Params: Id; Body: Version & { name: string } }>('/web/api/playlists/:id', {
    schema: { params: object({ id: uuid }), body: object({ revision, name }) },
  }, async (request, reply) => {
    const session = await authorizeWrite(guard, request);
    return cancellable(request, reply, signal => music.mutatePlaylist(session.discordId, `/${request.params.id}`, 'PATCH', request.body, signal));
  });
  app.delete<{ Params: Id; Body: Version }>('/web/api/playlists/:id', {
    schema: { params: object({ id: uuid }), body: object({ revision }) },
  }, async (request, reply) => {
    const session = await authorizeWrite(guard, request);
    await cancellable(request, reply, signal => music.mutatePlaylist(session.discordId, `/${request.params.id}`, 'DELETE', request.body, signal));
    return reply.code(204).send();
  });
  app.post<{ Params: Id; Body: Version & { songIds: string[] } }>('/web/api/playlists/:id/entries', {
    schema: { params: object({ id: uuid }), body: object({ revision, songIds }) },
  }, async (request, reply) => {
    const session = await authorizeWrite(guard, request);
    const cancellation = requestCancellation(request, reply);
    try {
      const tracks = await music.storedTracks(request.body.songIds, cancellation.signal);
      await guard.requireSession(request);
      return await music.mutatePlaylist(session.discordId, `/${request.params.id}/entries`, 'POST', { revision: request.body.revision, tracks }, cancellation.signal);
    } finally { cancellation.dispose(); }
  });
  app.delete<{ Params: Entry; Body: Version }>('/web/api/playlists/:id/entries/:entryId', {
    schema: { params: object({ id: uuid, entryId: uuid }), body: object({ revision }) },
  }, async (request, reply) => {
    const session = await authorizeWrite(guard, request);
    return cancellable(request, reply, signal => music.mutatePlaylist(session.discordId,
      `/${request.params.id}/entries/${request.params.entryId}`, 'DELETE', request.body, signal));
  });
  app.patch<{ Params: Entry; Body: Version & { position: number } }>('/web/api/playlists/:id/entries/:entryId', {
    schema: { params: object({ id: uuid, entryId: uuid }), body: object({ revision, position: { type: 'integer', minimum: 1, maximum: 100 } }) },
  }, async (request, reply) => {
    const session = await authorizeWrite(guard, request);
    return cancellable(request, reply, signal => music.mutatePlaylist(session.discordId,
      `/${request.params.id}/entries/${request.params.entryId}`, 'PATCH', request.body, signal));
  });
}
