import { computed, ref } from 'vue';
import { api, ApiError, errorMessage, type ApiClient } from '../api/client';
import type { VoiceContext, PlayerSnapshot, CommandResult } from '../../../contracts/index';
export type { VoiceContext, PlayerSnapshot } from '../../../contracts/index';
type EventPort = Pick<EventSource, 'addEventListener' | 'close' | 'onerror' | 'onopen'>;

/** A single guild snapshot/subscription owner. Commands are never automatically retried. */
export function useDiscordPlayer(client: ApiClient = api, makeEvents: (url: string) => EventPort = url => new EventSource(url)) {
  const contexts = ref<VoiceContext[]>([]);
  const guildId = ref('');
  const snapshot = ref<PlayerSnapshot | null>(null);
  const busy = ref(false);
  const urgentBusy = ref(false);
  const contextBusy = ref(false);
  const connected = ref(false);
  const error = ref('');
  const notice = ref('');
  let events: EventPort | undefined;
  let epoch = 0;
  let request: AbortController | undefined;
  let closed = false;
  let snapshotVersion = 0;
  let contextVersion = 0;
  const writes = new Set<AbortController>();
  const canControl = computed(() => !!snapshot.value?.canControl);
  const canPlay = computed(() => !!snapshot.value?.canPlay && !busy.value);
  function accept(value: PlayerSnapshot, own: number, source: 'http' | 'event' = 'http', beforeVersion = snapshotVersion) {
    if (own !== epoch || closed || value.guildId !== guildId.value) return;
    const previous = snapshot.value;
    if (previous) {
      const incomingTime = Date.parse(value.observedAt);
      const previousTime = Date.parse(previous.observedAt);
      if (incomingTime < previousTime) return;
      if (value.sessionId === previous.sessionId && (value.generation < previous.generation || value.queueRevision < previous.queueRevision)) return;
      // An older HTTP request cannot resurrect a stopped session when timestamps tie.
      if (source === 'http' && beforeVersion !== snapshotVersion && incomingTime <= previousTime) return;
    }
    snapshot.value = value;
    ++snapshotVersion;
  }
  async function refreshContexts() {
    const currentVersion = ++contextVersion;
    contextBusy.value = true; error.value = '';
    try {
      const result = await client.request<{ items: VoiceContext[] }>('/voice/contexts');
      if (closed || currentVersion !== contextVersion) return;
      contexts.value = result.items;
      await selectGuild(result.items.some(context => context.guildId === guildId.value) ? guildId.value : result.items[0]?.guildId ?? '');
    } catch (failure) {
      if (!closed && currentVersion === contextVersion) { error.value = errorMessage(failure); contexts.value = []; await selectGuild(''); }
    } finally { if (currentVersion === contextVersion) contextBusy.value = false; }
  }
  async function selectGuild(value: string) {
    const own = ++epoch;
    guildId.value = value; snapshot.value = null; connected.value = false;
    request?.abort(); events?.close(); events = undefined;
    if (!value || closed) return;
    await refresh();
    if (own !== epoch || closed || !snapshot.value) return;
    events = makeEvents(`/web/api/player/${encodeURIComponent(value)}/events`);
    events.addEventListener('snapshot', (event: Event) => {
      try { accept(JSON.parse((event as MessageEvent<string>).data) as PlayerSnapshot, own, 'event'); }
      catch { error.value = '播放器同步資料無法讀取，請重新整理語音狀態。'; }
    });
    events.addEventListener('unavailable', () => {
      if (own !== epoch) return;
      snapshot.value = null; connected.value = false; events?.close(); events = undefined;
      notice.value = '語音或登入狀態已變更，正在重新取得可用頻道。';
      void refreshContexts();
    });
    events.onerror = () => { if (own === epoch) { connected.value = false; void refresh(); } };
    events.onopen = () => { if (own === epoch) connected.value = true; };
  }
  async function refresh() {
    if (!guildId.value || closed) return;
    const own = epoch;
    const version = snapshotVersion;
    request?.abort(); request = new AbortController();
    const signal = request.signal;
    try { accept(await client.request<PlayerSnapshot>(`/player/${encodeURIComponent(guildId.value)}`, { signal }), own, 'http', version); }
    catch (failure) { if (own === epoch && !signal.aborted) { snapshot.value = null; error.value = errorMessage(failure); } }
  }
  async function command(action: string, fields: Record<string, unknown> = {}) {
    const urgent = action === 'stop' || action === 'skip';
    if ((urgent ? urgentBusy.value : busy.value) || !guildId.value || closed) return false;
    if (urgent) urgentBusy.value = true;
    else busy.value = true;
    error.value = ''; notice.value = '';
    const own = epoch;
    const controller = new AbortController(); writes.add(controller);
    try {
      // The pending enqueue may have created a connecting session after the last GET.
      if (urgent && busy.value) await refresh();
      if (own !== epoch || closed || !snapshot.value) return false;
      const before = snapshot.value;
      const version = snapshotVersion;
      const context = { requestId: globalThis.crypto.randomUUID(), sessionId: before.sessionId, generation: before.generation, queueRevision: before.queueRevision };
      const result = await client.request<CommandResult>(`/player/${encodeURIComponent(guildId.value)}/commands`, { method: 'POST', signal: controller.signal, body: { ...fields, ...context, action } });
      accept(result.snapshot, own, 'http', version);
      if (own === epoch && result.skipped) {
        const count = result.skipped;
        if (count) notice.value = `已略過 ${count} 首此 Bot 無法播放的收藏。`;
      }
      return true;
    } catch (failure) {
      if (own === epoch && !closed && !controller.signal.aborted) {
        error.value = failure instanceof ApiError && failure.status === 409
          ? '播放器已被其他操作更新。已重新取得狀態，請檢查後再操作。' : errorMessage(failure);
        // A timeout may still have executed the command; refresh, do not resend.
        await refresh();
      }
      return false;
    } finally { writes.delete(controller); if (urgent) urgentBusy.value = false; else busy.value = false; }
  }
  function dispose() { closed = true; ++epoch; request?.abort(); for (const write of writes) write.abort(); events?.close(); events = undefined; snapshot.value = null; }
  return { contexts, guildId, snapshot, busy, urgentBusy, contextBusy, connected, error, notice, canControl, canPlay,
    refreshContexts, selectGuild, refresh, command, dispose };
}
