import { ref } from 'vue';
import { api, ApiError, errorMessage, type ApiClient } from '../api/client';
import type { Playlist, PlaylistEntry } from '../../../contracts/index';
export type { Playlist, PlaylistEntry } from '../../../contracts/index';
export type PlaylistSummary = Playlist;

export function usePlaylists(client: ApiClient = api) {
  const lists = ref<PlaylistSummary[]>([]);
  const selected = ref<Playlist | null>(null);
  const busy = ref(false);
  const error = ref('');
  const conflict = ref(false);
  let epoch = 0;
  async function refresh() {
    try {
      const response = await client.request<{ items: PlaylistSummary[] }>('/playlists');
      lists.value = response.items;
    } catch (failure) { error.value = errorMessage(failure); }
  }
  async function open(id: string) {
    const own = ++epoch;
    busy.value = true; error.value = ''; conflict.value = false;
    try {
      const value = await client.request<Playlist>(`/playlists/${encodeURIComponent(id)}`);
      if (own === epoch) selected.value = value;
    } catch (failure) { if (own === epoch) { selected.value = null; error.value = errorMessage(failure); } }
    finally { if (own === epoch) busy.value = false; }
  }
  async function write<T>(path: string, method: string, body: unknown, updating?: string, skipDetail = false) {
    if (busy.value) return undefined;
    busy.value = true; error.value = ''; conflict.value = false;
    const own = epoch;
    try {
      const result = await client.request<T>(path, { method, body });
      if (updating && !skipDetail && selected.value?.id === updating) {
        const detail = await client.request<Playlist>(`/playlists/${encodeURIComponent(updating)}`);
        if (own === epoch && selected.value?.id === updating) selected.value = detail;
      }
      await refresh();
      return result;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        conflict.value = true;
        error.value = '清單已被其他操作更新。已載入最新內容，請檢查後重新操作；刪除需要重新確認。';
        if (updating) {
          try {
            const detail = await client.request<Playlist>(`/playlists/${encodeURIComponent(updating)}`);
            if (own === epoch && selected.value?.id === updating) selected.value = detail;
          } catch { if (own === epoch && selected.value?.id === updating) selected.value = null; }
        }
        await refresh();
      } else error.value = errorMessage(failure);
      return undefined;
    } finally { busy.value = false; }
  }
  async function create(name: string) {
    const created = await write<Playlist>('/playlists', 'POST', { name });
    if (created) selected.value = created;
    return !!created;
  }
  const rename = (list: Playlist, name: string) => write(`/playlists/${encodeURIComponent(list.id)}`, 'PATCH', { revision: list.revision, name }, list.id);
  async function remove(list: Playlist) {
    await write(`/playlists/${encodeURIComponent(list.id)}`, 'DELETE', { revision: list.revision }, list.id, true);
    // DELETE may return no body: use the error state to determine success.
    if (!error.value) { if (selected.value?.id === list.id) selected.value = null; return true; }
    return false;
  }
  const add = (list: PlaylistSummary, songId: string) => write(`/playlists/${encodeURIComponent(list.id)}/entries`, 'POST', { revision: list.revision, songIds: [songId] }, list.id);
  const removeEntry = (list: Playlist, entry: PlaylistEntry) => write(`/playlists/${encodeURIComponent(list.id)}/entries/${encodeURIComponent(entry.entryId)}`, 'DELETE', { revision: list.revision }, list.id);
  const move = (list: Playlist, entry: PlaylistEntry, position: number) => write(`/playlists/${encodeURIComponent(list.id)}/entries/${encodeURIComponent(entry.entryId)}`, 'PATCH', { revision: list.revision, position }, list.id);
  function dispose() { ++epoch; selected.value = null; lists.value = []; }
  return { lists, selected, busy, error, conflict, refresh, open, create, rename, remove, add, removeEntry, move, dispose };
}
