<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import type { Playlist, PlaylistEntry, PlaylistSummary } from '../features/playlists';
import { fallbackArtist } from '../features/format';
const props = defineProps<{ lists: PlaylistSummary[]; selected: Playlist | null; busy: boolean; error: string; conflict: boolean; target: 'discord' | 'browser'; canPlay: boolean; createRequested?: number }>();
const emit = defineEmits<{ open: [id: string]; create: [name: string]; rename: [list: Playlist, name: string]; remove: [list: Playlist]; play: [list: Playlist]; move: [list: Playlist, entry: PlaylistEntry, position: number]; removeEntry: [list: Playlist, entry: PlaylistEntry] }>();
const dialog = ref<HTMLDialogElement>();
const mode = ref<'create' | 'rename' | 'delete'>('create');
const name = ref('');
const captured = ref<Playlist | null>(null);
let dragFrom: number | null = null;
async function show(type: 'create' | 'rename' | 'delete') {
  mode.value = type; name.value = type === 'rename' ? props.selected?.name ?? '' : '';
  captured.value = props.selected ? { ...props.selected, entries: [...props.selected.entries] } : null;
  await nextTick(); dialog.value?.showModal();
}
function submit() {
  const value = name.value.trim();
  if (mode.value === 'create') emit('create', value);
  else if (mode.value === 'rename' && captured.value) emit('rename', captured.value, value);
  else if (mode.value === 'delete' && captured.value) emit('remove', captured.value);
  dialog.value?.close();
}
function drop(to: number) { if (props.selected && dragFrom !== null && dragFrom !== to) emit('move', props.selected, props.selected.entries[dragFrom]!, to); dragFrom = null; }
watch(() => props.createRequested, value => { if (value) void show('create'); }, { immediate: true });
</script>
<template>
  <section class="playlists-page">
    <div class="section-heading"><div><p class="eyebrow">COLLECT WHAT YOU LOVE</p><h1>我的播放清單</h1><p class="muted">把喜歡的旋律，整理成你的日常。</p></div><button class="primary" :disabled="busy || lists.length >= 20" @click="show('create')"><Icon name="plus" :size="17" />建立清單</button></div>
    <p v-if="error" :class="conflict ? 'notice' : 'error'" role="alert">{{ error }}</p>
    <div class="playlist-cards"><button v-for="(list, index) in lists" :key="list.id" class="playlist-card" :class="{ selected: selected?.id === list.id }" @click="emit('open', list.id)"><span class="playlist-cover" :class="`tone-${index % 4}`"><Icon name="music" :size="34" /><span class="cover-lines"></span></span><span class="playlist-card-name">{{ list.name }}</span><span class="muted small">{{ list.entries.length }} 首歌曲</span></button><button v-if="lists.length < 20" class="playlist-card create-card" :disabled="busy" @click="show('create')"><span class="playlist-cover"><Icon name="plus" :size="29" /></span><span class="playlist-card-name">新的播放清單</span><span class="muted small">建立你的收藏</span></button></div>
    <p class="muted small">{{ lists.length }}/20 份清單 · 每份最多 100 首 · 可重複收藏同一首歌</p>
    <div v-if="selected" class="playlist-detail">
      <div class="section-heading"><div><p class="eyebrow">YOUR PLAYLIST</p><h2>{{ selected.name }}<span class="count">{{ selected.entries.length }}</span></h2><p class="muted small">版本 {{ selected.revision }}<span v-if="target === 'browser' && selected.entries.some(entry => !entry.browserPlayable)"> · 瀏覽器會略過無法播放的收藏</span></p></div><div class="detail-actions"><button class="primary" :disabled="busy || !canPlay || !selected.entries.length" @click="emit('play', selected)"><Icon name="play" :size="16" />播放全部</button><button class="icon-button outlined" :disabled="busy" aria-label="重新命名清單" @click="show('rename')"><Icon name="edit" /></button><button class="icon-button outlined danger" :disabled="busy" aria-label="刪除清單" @click="show('delete')"><Icon name="trash" /></button></div></div>
      <ol class="playlist-entries"><li v-for="(entry, index) in selected.entries" :key="entry.entryId" class="playlist-entry" draggable="true" @dragstart="dragFrom = index" @dragend="dragFrom = null" @dragover.prevent @drop.prevent="drop(index)"><span class="entry-index">{{ String(index + 1).padStart(2, '0') }}</span><span class="song-tile"><Icon name="music" :size="18" /></span><div class="entry-title truncate"><strong>{{ entry.title }}</strong><span class="muted small">{{ fallbackArtist(entry.artist) }}<span v-if="!entry.browserPlayable" class="compatibility"> · 此瀏覽器無法播放</span></span></div><div class="entry-actions"><button class="icon-button" :disabled="busy || index === 0" :aria-label="`${entry.title} 上移`" @click="emit('move', selected, entry, index - 1)"><Icon name="up" :size="16" /></button><button class="icon-button" :disabled="busy || index === selected.entries.length - 1" :aria-label="`${entry.title} 下移`" @click="emit('move', selected, entry, index + 1)"><Icon name="down" :size="16" /></button><button class="icon-button danger" :disabled="busy" :aria-label="`移除收藏 ${entry.title}`" @click="emit('removeEntry', selected, entry)"><Icon name="close" :size="17" /></button></div></li></ol>
      <div v-if="!selected.entries.length" class="empty-state compact"><Icon name="list" :size="31" /><h3>清單準備好了</h3><p>前往曲庫，將喜歡的歌曲加入這份清單。</p></div>
    </div>
    <dialog ref="dialog" class="modal"><form @submit.prevent="submit"><button class="icon-button modal-close" type="button" aria-label="關閉對話框" @click="dialog?.close()"><Icon name="close" /></button><span class="form-icon"><Icon :name="mode === 'delete' ? 'trash' : 'list'" :size="26" /></span><h2>{{ mode === 'create' ? '建立播放清單' : mode === 'rename' ? '重新命名清單' : '刪除這份清單？' }}</h2><p v-if="mode === 'delete'" class="muted">將刪除「{{ captured?.name }}」及其中的收藏，曲庫歌曲不會被刪除。</p><label v-else>清單名稱<input v-model="name" autofocus required maxlength="80" placeholder="例如：今晚的背景音樂" /></label><div class="modal-actions"><button class="secondary" type="button" @click="dialog?.close()">取消</button><button :class="mode === 'delete' ? 'danger-button' : 'primary'" :disabled="busy" type="submit">{{ mode === 'delete' ? '確認刪除' : '儲存' }}</button></div></form></dialog>
  </section>
</template>
