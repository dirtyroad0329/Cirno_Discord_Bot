export class WebError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export const uuid = { type: 'string', pattern: uuidPattern };
export const revision = { type: 'integer', minimum: 1, maximum: 2_147_483_647 };
export function object(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required };
}

/** Upstream errors never echo bodies containing credentials or private paths. */
export function upstreamError(status: number): WebError {
  if (status === 409) return new WebError(409, 'REVISION_CONFLICT', '清單已被其他操作更新，請重新載入後再確認。');
  if (status === 404) return new WebError(404, 'NOT_FOUND', '歌曲或播放清單不存在。');
  if (status === 400) return new WebError(400, 'INVALID_OPERATION', '操作資料無效或超出播放清單限制。');
  if (status === 429) return new WebError(429, 'UPSTREAM_BUSY', '曲庫目前忙碌，請稍後重試。');
  return new WebError(502, 'MUSIC_UNAVAILABLE', '曲庫目前無法使用，請稍後重試。');
}
