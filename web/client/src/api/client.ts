export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };

/** This client owns cookie/CSRF transport; feature modules never store credentials. */
export function createApiClient(fetcher: typeof fetch = fetch) {
  let csrfToken = '';
  let unauthorized: (() => void) | undefined;
  const setCsrfToken = (token: string | undefined) => { csrfToken = token ?? ''; };
  const setUnauthorizedHandler = (handler: () => void) => { unauthorized = handler; };
  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException('請求逾時，請重新取得狀態後再試。', 'TimeoutError')), 25_000);
    try {
      const method = options.method ?? 'GET';
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
      const response = await fetcher(`/web/api${path}`, {
        method, headers, credentials: 'same-origin', signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
      if (!response.ok) {
        if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') unauthorized?.();
        const detail = data?.error;
        throw new ApiError((typeof detail === 'string' ? detail : detail?.message) ?? data?.message ?? `操作失敗（${response.status}）`, response.status, detail?.code ?? data?.code);
      }
      return data as T;
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) throw new ApiError('連線逾時。操作可能已執行，請重新取得狀態後再試。', 408, 'TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  return { request, setCsrfToken, setUnauthorizedHandler };
}

export const api = createApiClient();
export type ApiClient = ReturnType<typeof createApiClient>;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失敗，請稍後再試。';
