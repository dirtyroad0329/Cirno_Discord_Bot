import { computed, ref } from 'vue';
import { errorMessage } from '../api/client';
import type { Song } from './catalog';
import type { PlaylistEntry } from './playlists';

export type BrowserTrack = { id: string; title: string; artist?: string | null; durationSeconds?: number | null; key: string };
export type RepeatMode = 'off' | 'one' | 'all';
type AudioPort = Pick<HTMLAudioElement, 'src' | 'volume' | 'currentTime' | 'duration' | 'paused' | 'play' | 'pause' | 'load' | 'addEventListener' | 'removeEventListener' | 'removeAttribute'>;

/** The page owns this element, history and queue; none of them mirror Bot state. */
export function useBrowserPlayer(createAudio: () => AudioPort = () => new Audio()) {
  const current = ref<BrowserTrack | null>(null);
  const pending = ref<BrowserTrack[]>([]);
  const history = ref<BrowserTrack[]>([]);
  const paused = ref(true);
  const loading = ref(false);
  const position = ref(0);
  const duration = ref<number | null>(null);
  const volume = ref(75);
  const repeat = ref<RepeatMode>('off');
  const shuffled = ref(false);
  const error = ref('');
  let audio: AudioPort | undefined;
  let disposed = false;
  let playEpoch = 0;
  let mediaEnabled = true;
  const handlers: Array<[string, EventListener]> = [];
  const media = () => typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  const canSeek = computed(() => duration.value != null && duration.value > 0);
  function wire() {
    if (audio) return audio;
    audio = createAudio();
    audio.volume = volume.value / 100;
    const listen = (event: string, action: () => void) => {
      const callback: EventListener = () => { if (!disposed) action(); };
      handlers.push([event, callback]); audio!.addEventListener(event, callback);
    };
    listen('timeupdate', () => { position.value = Number.isFinite(audio!.currentTime) ? audio!.currentTime : 0; });
    listen('loadedmetadata', () => { duration.value = Number.isFinite(audio!.duration) && audio!.duration > 0 ? audio!.duration : null; loading.value = false; });
    listen('playing', () => { paused.value = false; loading.value = false; syncMedia(); });
    listen('pause', () => { paused.value = true; syncMedia(); });
    listen('waiting', () => { loading.value = true; });
    listen('ended', () => {
      if (repeat.value === 'one') { audio!.currentTime = 0; void play(); }
      else next();
    });
    listen('error', () => {
      error.value = '這首歌曲暫時無法在此瀏覽器播放。請確認連線，或切換到 Discord 語音播放。';
      loading.value = false; paused.value = true;
    });
    return audio;
  }
  function syncMedia() {
    if (!mediaEnabled) return;
    const session = media();
    if (!session) return;
    if (!current.value) { clearMedia(); return; }
    try {
      session.playbackState = current.value ? (paused.value ? 'paused' : 'playing') : 'none';
      if (current.value && typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({ title: current.value.title, artist: current.value.artist ?? '' });
      for (const [name, callback] of [
        ['play', () => { void play(); }], ['pause', pause], ['previoustrack', previous], ['nexttrack', next],
        ['seekto', (details: MediaSessionActionDetails) => { if (details.seekTime != null) seek(details.seekTime); }],
        ['seekbackward', (details: MediaSessionActionDetails) => seek(position.value - (details.seekOffset ?? 10))],
        ['seekforward', (details: MediaSessionActionDetails) => seek(position.value + (details.seekOffset ?? 10))],
        ['stop', stop],
      ] as Array<[MediaSessionAction, MediaSessionActionHandler]>) {
        try { session.setActionHandler(name, callback); } catch { /* Some browsers support only a subset. */ }
      }
    } catch { /* Media Session is optional; HTMLAudio remains the source of truth. */ }
  }
  function clearMedia() {
    const session = media();
    if (!session) return;
    for (const name of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward', 'stop'] as MediaSessionAction[]) {
      try { session.setActionHandler(name, null); } catch { /* Optional browser feature. */ }
    }
    session.metadata = null; session.playbackState = 'none';
  }
  async function play() {
    if (!current.value || disposed) return;
    mediaEnabled = true;
    const own = ++playEpoch;
    error.value = '';
    try { await wire().play(); }
    catch (failure) {
      if (own !== playEpoch || disposed) return;
      error.value = failure instanceof DOMException && failure.name === 'NotAllowedError'
        ? '瀏覽器需要您的操作才能播放，請再按一次播放。' : errorMessage(failure);
      loading.value = false; paused.value = true;
    }
  }
  function start(track: BrowserTrack, remember = true) {
    if (disposed) return;
    ++playEpoch;
    if (current.value && remember) { history.value.push(current.value); if (history.value.length > 100) history.value.shift(); }
    current.value = track;
    position.value = 0; duration.value = track.durationSeconds ?? null; loading.value = true;
    const element = wire();
    element.pause();
    element.src = `/web/api/songs/${encodeURIComponent(track.id)}/audio`;
    element.load();
    // This call remains in the user's click stack when selecting a song.
    void play(); syncMedia();
  }
  const makeTrack = (value: Pick<Song, 'id' | 'title' | 'artist'> & { durationSeconds?: number | null }): BrowserTrack => ({ ...value, key: globalThis.crypto.randomUUID() });
  function playSong(song: Song) { pending.value = []; history.value = []; start(makeTrack(song), false); }
  function enqueueSong(song: Song, where: 'last' | 'next' = 'last') {
    if (pending.value.length >= 100) { error.value = '瀏覽器待播佇列最多 100 首，請先移除部分歌曲。'; return false; }
    const track = makeTrack(song);
    if (!current.value) start(track, false);
    else if (where === 'next') pending.value.unshift(track);
    else pending.value.push(track);
    return true;
  }
  function playPlaylist(entries: PlaylistEntry[]) {
    const playable = entries.filter(entry => entry.browserPlayable);
    if (!playable.length) { error.value = '此清單沒有可由目前曲庫在瀏覽器播放的歌曲。'; return 0; }
    const tracks = playable.map(entry => makeTrack(entry));
    const first = tracks.shift()!;
    pending.value = tracks; history.value = [];
    start(first, false);
    return entries.length - playable.length;
  }
  function next() {
    if (!pending.value.length && repeat.value === 'all' && current.value) {
      pending.value = [...history.value, current.value]; history.value = []; current.value = null;
      if (shuffled.value) shuffleQueue();
    }
    if (!pending.value.length) { pause(); loading.value = false; syncMedia(); return; }
    const [track] = pending.value.splice(0, 1);
    start(track!);
  }
  function previous() {
    if (position.value > 3 || !history.value.length) { seek(0); return; }
    const track = history.value.pop()!;
    if (current.value) pending.value.unshift(current.value);
    start(track, false);
  }
  function pause() { ++playEpoch; audio?.pause(); paused.value = true; syncMedia(); }
  function seek(seconds: number) {
    if (!audio || !canSeek.value) return;
    audio.currentTime = Math.max(0, Math.min(seconds, duration.value!)); position.value = audio.currentTime;
  }
  function setVolume(percent: number) { volume.value = Math.max(0, Math.min(100, percent)); if (audio) audio.volume = volume.value / 100; }
  function shuffleQueue() {
    for (let index = pending.value.length - 1; index > 0; index--) {
      const to = Math.floor(Math.random() * (index + 1));
      [pending.value[index], pending.value[to]] = [pending.value[to]!, pending.value[index]!];
    }
  }
  function toggleShuffle() { shuffled.value = !shuffled.value; if (shuffled.value) shuffleQueue(); }
  function move(from: number, to: number) {
    if (from < 0 || from >= pending.value.length || to < 0 || to >= pending.value.length) return;
    const [track] = pending.value.splice(from, 1); pending.value.splice(to, 0, track!);
  }
  function stop() {
    ++playEpoch; audio?.pause(); audio?.removeAttribute('src'); audio?.load();
    current.value = null; pending.value = []; history.value = []; position.value = 0; duration.value = null;
    paused.value = true; loading.value = false; clearMedia();
  }
  function dispose() {
    stop(); disposed = true;
    for (const [event, handler] of handlers) audio?.removeEventListener(event, handler);
    handlers.length = 0; audio = undefined;
  }
  return { current, pending, history, paused, loading, position, duration, volume, repeat, shuffled, error, canSeek,
    play, pause, next, previous, seek, setVolume, playSong, enqueueSong, playPlaylist, move, toggleShuffle,
    remove: (index: number) => { pending.value.splice(index, 1); }, clear: () => { pending.value = []; },
    restart: () => { seek(0); void play(); }, stop, dispose, releaseMedia: () => { mediaEnabled = false; clearMedia(); } };
}
