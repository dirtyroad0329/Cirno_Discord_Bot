<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import PlayerBar from './components/PlayerBar.vue';
import QueuePanel from './components/QueuePanel.vue';
import CatalogPage from './pages/CatalogPage.vue';
import PlaylistsPage from './pages/PlaylistsPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import { useCatalog, type Song } from './features/catalog';
import { usePlaylists, type Playlist } from './features/playlists';
import { useBrowserPlayer } from './features/browserPlayer';
import { useDiscordPlayer } from './features/discordPlayer';
import type { AuthUser } from './features/auth';

const props = defineProps<{ user: AuthUser; authBusy: boolean; authError: string }>();
const emit = defineEmits<{ logout: []; password: [current: string, next: string] }>();
const page = ref<'library' | 'search' | 'playlists' | 'settings'>('library');
const target = ref<'discord' | 'browser'>('discord');
const queueOpen = ref(false);
const toast = ref('');
const createRequested = ref(0);
const now = ref(Date.now());
const catalog = useCatalog();
const playlists = usePlaylists();
const browser = useBrowserPlayer();
const discord = useDiscordPlayer();
let tick: ReturnType<typeof setInterval> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const isDiscord = computed(() => target.value === 'discord');
const current = computed(() => isDiscord.value ? discord.snapshot.value?.current?.track : browser.current.value);
const playing = computed(() => isDiscord.value ? discord.snapshot.value?.status === 'playing' : !!browser.current.value && !browser.paused.value);
const busy = computed(() => isDiscord.value && discord.busy.value);
const canControl = computed(() => isDiscord.value ? discord.canControl.value : true);
const canCancel = computed(() => isDiscord.value ? !!discord.snapshot.value && (discord.snapshot.value.canControl || discord.snapshot.value.canPlay) : !!browser.current.value);
const canPlay = computed(() => isDiscord.value ? discord.canPlay.value : true);
const duration = computed(() => isDiscord.value ? discord.snapshot.value?.durationSeconds : browser.duration.value);
const position = computed(() => {
  if (!isDiscord.value) return browser.position.value;
  const state = discord.snapshot.value;
  if (!state) return 0;
  const observed = Date.parse(state.observedAt);
  const extra = state.status === 'playing' && Number.isFinite(observed) ? Math.max(0, (now.value - observed) / 1000) : 0;
  const elapsed = state.elapsedSeconds + extra;
  return state.durationSeconds ? Math.min(elapsed, state.durationSeconds) : elapsed;
});
const volume = computed(() => isDiscord.value ? discord.snapshot.value?.volume ?? 75 : browser.volume.value);
const repeat = computed(() => isDiscord.value ? discord.snapshot.value?.repeat ?? 'off' : browser.repeat.value);
const pending = computed(() => isDiscord.value
  ? (discord.snapshot.value?.pending ?? []).map((entry, index) => ({ key: `${discord.snapshot.value?.queueRevision}-${index}`, title: entry.track.title, artist: entry.track.artist }))
  : browser.pending.value);
const context = computed(() => discord.contexts.value.find(value => value.guildId === discord.guildId.value));
const playbackError = computed(() => isDiscord.value ? discord.error.value : browser.error.value);

function notify(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = ''; }, 5_000); }
function navigate(value: typeof page.value) { page.value = value; if (value === 'library' && catalog.query.value) catalog.search(''); }
async function playSong(song: Song) {
  if (!isDiscord.value) browser.playSong(song);
  else {
    const alreadyPlaying = !!discord.snapshot.value?.current;
    if (await discord.command('enqueue', { songIds: [song.id], position: 'last' })) notify(alreadyPlaying ? `「${song.title}」已加入待播佇列。` : `正在 Discord 播放「${song.title}」。`);
  }
}
async function enqueue(song: Song, where: 'last' | 'next') {
  if (!isDiscord.value) { if (!browser.enqueueSong(song, where)) return; }
  else if (!await discord.command('enqueue', { songIds: [song.id], position: where })) return;
  notify(where === 'next' ? '已加入下一首播放。' : '已加入待播佇列。');
}
async function playPlaylist(list: Playlist) {
  if (!isDiscord.value) { const skipped = browser.playPlaylist(list.entries); if (skipped) notify(`已略過 ${skipped} 首此瀏覽器無法播放的收藏。`); }
  else if (await discord.command('enqueue', { playlistId: list.id, position: 'last' })) notify('已將清單加入 Discord 待播佇列。');
}
async function addToPlaylist(song: Song, id: string) {
  const list = playlists.lists.value.find(value => value.id === id);
  if (!list) return;
  await playlists.add(list, song.id);
  if (!playlists.error.value) notify(`已收藏到「${list.name}」。`);
}
function setTarget(value: 'discord' | 'browser') {
  if (value === target.value) return;
  if (value === 'discord') { browser.pause(); browser.releaseMedia(); }
  else if (discord.snapshot.value?.current) notify('Discord 語音仍在播放；瀏覽器使用自己的佇列。');
  target.value = value;
}
function control(action: string, fields: Record<string, unknown> = {}) {
  if (isDiscord.value) { void discord.command(action, fields); return; }
  switch (action) {
    case 'pause': browser.pause(); break;
    case 'resume': void browser.play(); break;
    case 'skip': browser.next(); break;
    case 'previous': browser.previous(); break;
    case 'restart': browser.restart(); break;
    case 'stop': browser.stop(); break;
    case 'seek': browser.seek(Number(fields.seconds)); break;
    case 'volume': browser.setVolume(Number(fields.percent)); break;
    case 'repeat': browser.repeat.value = fields.mode as 'off' | 'one' | 'all'; break;
    case 'shuffle': browser.toggleShuffle(); break;
    case 'clear': browser.clear(); break;
  }
}
function cycleRepeat() { const modes = ['off', 'all', 'one'] as const; control('repeat', { mode: modes[(modes.indexOf(repeat.value) + 1) % modes.length] }); }
function moveQueue(from: number, to: number) { if (isDiscord.value) void discord.command('move', { from: from + 1, to: to + 1 }); else browser.move(from, to); }
function removeQueue(index: number) { if (isDiscord.value) void discord.command('remove', { position: index + 1 }); else browser.remove(index); }
function keyboard(event: KeyboardEvent) { if (event.key === '/' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)) { event.preventDefault(); page.value = 'search'; setTimeout(() => { document.querySelector<HTMLInputElement>('.search-field input')?.focus(); }, 0); } }
watch(() => playlists.selected.value?.id, id => { if (id) page.value = 'playlists'; });
onMounted(() => {
  void catalog.load(true); void playlists.refresh(); void discord.refreshContexts();
  queueOpen.value = window.innerWidth >= 1400;
  tick = setInterval(() => { now.value = Date.now(); }, 1_000);
  document.addEventListener('keydown', keyboard);
});
onBeforeUnmount(() => { clearInterval(tick); clearTimeout(toastTimer); catalog.dispose(); playlists.dispose(); browser.dispose(); discord.dispose(); document.removeEventListener('keydown', keyboard); });
</script>
<template>
  <div class="music-room" :class="{ 'queue-is-open': queueOpen }">
    <aside class="sidebar" aria-label="主要導覽"><a class="brand" href="/web/" @click.prevent="navigate('library')"><span class="brand-mark"><Icon name="snow" :size="25" /></span><span>CIRNO<span class="brand-sub">MUSIC ROOM</span></span></a><span class="nav-label">你的音樂室</span><nav><button :class="{ active: page === 'library' }" @click="navigate('library')"><Icon name="library" />曲庫<span class="nav-accent"></span></button><button :class="{ active: page === 'search' }" @click="navigate('search')"><Icon name="search" />搜尋</button><button :class="{ active: page === 'playlists' }" @click="navigate('playlists')"><Icon name="list" />我的清單</button></nav><div class="sidebar-playlist-heading"><span class="nav-label">你的播放清單</span><button class="icon-button" aria-label="建立播放清單" @click="page = 'playlists'; createRequested++"><Icon name="plus" :size="16" /></button></div><div class="sidebar-playlists"><button v-for="list in playlists.lists.value" :key="list.id" :class="{ active: page === 'playlists' && playlists.selected.value?.id === list.id }" @click="page = 'playlists'; playlists.open(list.id)"><span class="mini-cover"><Icon name="music" :size="14" /></span><span class="truncate">{{ list.name }}</span></button><p v-if="!playlists.lists.value.length" class="muted small">收藏第一份喜歡的旋律。</p></div><div class="sidebar-bottom"><div class="side-note"><Icon name="snow" :size="25" /><p>音樂沒有距離。<br /><span>與朋友共享每個節拍。</span></p></div><button class="settings-nav" :class="{ active: page === 'settings' }" @click="navigate('settings')"><Icon name="settings" />設定</button></div></aside>
    <div class="room-main"><header class="topbar"><div class="breadcrumb"><span>CIRNO</span><span>/</span>{{ page === 'library' ? '曲庫' : page === 'search' ? '搜尋' : page === 'playlists' ? '我的清單' : '設定' }}</div><div class="topbar-actions"><a class="upload-link" href="/web/upload"><Icon name="upload" :size="16" /><span>上傳歌曲</span></a><button class="profile-button" aria-label="開啟帳號設定" @click="navigate('settings')"><span class="avatar">{{ user.discordId.slice(-2) }}</span><span class="account-label">{{ user.discordId }}</span><Icon name="down" :size="12" /></button></div></header>
      <main class="room-content" id="main-content"><div class="device-toolbar"><div class="device-switch" role="group" aria-label="播放目標"><button :class="{ selected: isDiscord }" :aria-pressed="isDiscord" @click="setTarget('discord')"><Icon name="discord" :size="17" />Discord 語音<span class="recommended-label">主要</span></button><button :class="{ selected: !isDiscord }" :aria-pressed="!isDiscord" @click="setTarget('browser')"><Icon name="browser" :size="17" />此瀏覽器</button></div><div v-if="isDiscord" class="voice-status"><span class="live-dot" :class="{ offline: !discord.connected.value }"></span><label v-if="discord.contexts.value.length > 1"><span class="sr-only">選擇語音所在伺服器</span><select :value="discord.guildId.value" @change="discord.selectGuild(($event.target as HTMLSelectElement).value)"><option v-for="value in discord.contexts.value" :key="value.guildId" :value="value.guildId">{{ value.guildName }} · {{ value.channelName }}</option></select></label><span v-else>{{ context ? `${context.guildName} · ${context.channelName}` : '尚未加入語音頻道' }}</span><button class="icon-button" :disabled="discord.contextBusy.value" aria-label="重新整理語音狀態" @click="discord.refreshContexts()"><Icon name="refresh" :size="16" /></button></div></div>
        <p v-if="isDiscord && !discord.contexts.value.length && !discord.contextBusy.value && !discord.error.value" class="notice voice-notice"><Icon name="discord" :size="18" />請先加入一個 Cirno Bot 可見的 Discord 一般語音頻道，再重新整理語音狀態。</p><p v-if="isDiscord && discord.snapshot.value?.notice" class="notice" role="status">{{ discord.snapshot.value.notice }}</p><p v-if="playbackError" class="error" role="alert">{{ playbackError }}</p><p v-if="isDiscord && discord.notice.value" class="notice" role="status">{{ discord.notice.value }}</p><p v-if="page !== 'playlists' && playlists.error.value" class="error" role="alert">{{ playlists.error.value }}</p>
        <CatalogPage v-if="page === 'library' || page === 'search'" :songs="catalog.songs.value" :lists="playlists.lists.value" :query="catalog.query.value" :busy="catalog.busy.value" :error="catalog.error.value" :has-more="!!catalog.cursor.value" :search-mode="page === 'search'" :target="target" :can-play="canPlay" @search="catalog.search" @more="catalog.load()" @play="playSong" @enqueue="enqueue" @add="addToPlaylist" />
        <PlaylistsPage v-else-if="page === 'playlists'" :lists="playlists.lists.value" :selected="playlists.selected.value" :busy="playlists.busy.value" :error="playlists.error.value" :conflict="playlists.conflict.value" :target="target" :can-play="canPlay" :create-requested="createRequested" @open="playlists.open" @create="playlists.create" @rename="playlists.rename" @remove="playlists.remove" @play="playPlaylist" @move="(list, entry, index) => playlists.move(list, entry, index + 1)" @remove-entry="playlists.removeEntry" />
        <SettingsPage v-else :id="user.discordId" :busy="authBusy" :error="authError" @password="(currentPassword, next) => emit('password', currentPassword, next)" @logout="emit('logout')" />
      </main><nav class="mobile-nav" aria-label="手機導覽"><button :class="{ active: page === 'library' }" @click="navigate('library')"><Icon name="library" :size="19" /><span>曲庫</span></button><button :class="{ active: page === 'search' }" @click="navigate('search')"><Icon name="search" :size="19" /><span>搜尋</span></button><button :class="{ active: page === 'playlists' }" @click="navigate('playlists')"><Icon name="list" :size="19" /><span>清單</span></button><button :class="{ active: page === 'settings' }" @click="navigate('settings')"><Icon name="settings" :size="19" /><span>設定</span></button></nav>
    </div>
    <button v-if="queueOpen" class="queue-scrim" aria-label="關閉待播佇列" @click="queueOpen = false"></button>
    <QueuePanel :open="queueOpen" :title="current?.title" :artist="current?.artist" :pending="pending" :target="target" :can-control="canControl" :busy="busy" :playing="playing" @close="queueOpen = false" @clear="control('clear')" @remove="removeQueue" @move="moveQueue" />
    <PlayerBar :title="current?.title" :artist="current?.artist" :playing="playing" :loading="isDiscord ? discord.snapshot.value?.status === 'connecting' : browser.loading.value" :position="position" :duration="duration" :volume="volume" :repeat="repeat" :target="target" :can-control="canControl" :can-cancel="canCancel" :urgent-busy="isDiscord && discord.urgentBusy.value" :has-previous="isDiscord ? !!discord.snapshot.value?.historyCount || position > 0 : !!browser.current.value" :queue-count="pending.length" :queue-open="queueOpen" :busy="busy" :shuffled="!isDiscord && browser.shuffled.value" @toggle="control(playing ? 'pause' : 'resume')" @previous="control('previous')" @next="control('skip')" @restart="control('restart')" @stop="control('stop')" @seek="seconds => control('seek', { seconds })" @volume="percent => control('volume', { percent })" @repeat="cycleRepeat" @shuffle="control('shuffle')" @queue="queueOpen = !queueOpen" @target="setTarget" />
    <div v-if="toast" class="toast" role="status"><Icon name="check" :size="18" />{{ toast }}</div>
  </div>
</template>
