import { ref } from 'vue';
import { api, errorMessage, type ApiClient } from '../api/client';
import type { Song, SongPage } from '../../../contracts/index';
export type { Song, SongPage } from '../../../contracts/index';

/** One owner for query/cursor state; abort and epoch guard cover ignored cancellation. */
export function useCatalog(client: ApiClient = api) {
  const songs = ref<Song[]>([]);
  const query = ref('');
  const cursor = ref<string | null>(null);
  const busy = ref(false);
  const error = ref('');
  let controller: AbortController | undefined;
  let epoch = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  async function load(reset = false) {
    if (!reset && (busy.value || !cursor.value)) return;
    controller?.abort();
    const current = ++epoch;
    controller = new AbortController();
    const signal = controller.signal;
    busy.value = true; error.value = '';
    if (reset) { songs.value = []; cursor.value = null; }
    const params = new URLSearchParams({ limit: '25', query: query.value.trim() });
    if (!reset && cursor.value) params.set('cursor', cursor.value);
    try {
      const result = await client.request<SongPage>(`/songs?${params}`, { signal });
      if (current !== epoch) return;
      const existing = new Set(songs.value.map(song => song.id));
      songs.value.push(...result.items.filter(song => !existing.has(song.id)));
      cursor.value = result.nextCursor ?? null;
    } catch (failure) { if (current === epoch && !signal.aborted) error.value = errorMessage(failure); }
    finally { if (current === epoch) busy.value = false; }
  }
  function search(value: string) {
    query.value = value;
    clearTimeout(debounce);
    // Invalidate the old response immediately, before the debounce fires.
    controller?.abort(); ++epoch;
    songs.value = []; cursor.value = null; busy.value = true;
    debounce = setTimeout(() => { void load(true); }, 250);
  }
  function dispose() { clearTimeout(debounce); controller?.abort(); ++epoch; busy.value = false; }
  return { songs, query, cursor, busy, error, load, search, dispose };
}
