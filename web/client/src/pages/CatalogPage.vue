<script setup lang="ts">
import Icon from '../components/Icon.vue';
import type { Song } from '../features/catalog';
import type { PlaylistSummary } from '../features/playlists';
import { formatTime, fallbackArtist } from '../features/format';
defineProps<{ songs: Song[]; lists: PlaylistSummary[]; query: string; busy: boolean; error: string; hasMore: boolean; searchMode: boolean; target: 'discord' | 'browser'; canPlay: boolean }>();
const emit = defineEmits<{ search: [query: string]; more: []; play: [song: Song]; enqueue: [song: Song, position: 'last' | 'next']; add: [song: Song, listId: string]; create: [] }>();
function add(event: Event, song: Song) { const select = event.target as HTMLSelectElement; if (select.value) emit('add', song, select.value); select.value = ''; }
</script>
<template>
  <section class="catalog-page">
    <div class="section-heading"><div><p class="eyebrow">{{ searchMode || query ? 'FIND YOUR SOUND' : 'EXPLORE YOUR LIBRARY' }}</p><h2>{{ searchMode || query ? '搜尋歌曲' : '全部歌曲' }}<span class="count">{{ songs.length }}</span></h2><p class="muted small">已載入 {{ songs.length }} 首{{ query ? ` · 「${query}」的搜尋結果` : ' · 來自你的音樂曲庫' }}</p></div><span class="read-only-tag"><Icon name="lock" :size="13" />曲庫唯讀</span></div>
    <label class="search-field"><Icon name="search" :size="20" /><span class="sr-only">搜尋歌曲名稱或演出者</span><input :value="query" type="search" placeholder="搜尋歌曲名稱或演出者…" @input="emit('search', ($event.target as HTMLInputElement).value)" /><kbd>/</kbd></label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="song-table" role="table" aria-label="歌曲曲庫">
      <div class="song-row table-head" role="row"><span role="columnheader">#</span><span role="columnheader">歌曲</span><span class="artist-column" role="columnheader">演出者</span><span role="columnheader">時長</span><span class="sr-only" role="columnheader">操作</span></div>
      <div v-for="(song, index) in songs" :key="song.id" class="song-row" role="row">
        <div class="row-number" role="cell"><span>{{ String(index + 1).padStart(2, '0') }}</span><button class="icon-button row-play" :aria-label="`播放 ${song.title}`" :disabled="!canPlay" @click="emit('play', song)"><Icon name="play" :size="15" /></button></div>
        <div class="song-title-cell" role="cell"><span class="song-tile"><Icon name="music" :size="19" /></span><div class="truncate"><span class="song-name" :title="song.title">{{ song.title }}</span><span class="mobile-artist">{{ fallbackArtist(song.artist) }}</span></div></div>
        <span class="artist-column muted truncate" role="cell">{{ fallbackArtist(song.artist) }}</span><span class="duration" role="cell">{{ formatTime(song.durationSeconds) }}</span>
        <div class="row-actions" role="cell"><button class="icon-button" :disabled="!canPlay" :aria-label="`${song.title} 下一首播放`" title="下一首播放" @click="emit('enqueue', song, 'next')"><Icon name="next" :size="16" /></button><button class="icon-button" :disabled="!canPlay" :aria-label="`${song.title} 加入佇列`" title="加入佇列" @click="emit('enqueue', song, 'last')"><Icon name="plus" :size="17" /></button><label class="playlist-select"><Icon name="list" :size="18" /><span class="sr-only">{{ song.title }} 加入清單</span><select :aria-label="`${song.title} 加入清單`" :disabled="!lists.length" @change="add($event, song)"><option value="">加入清單</option><option v-for="list in lists" :key="list.id" :value="list.id">{{ list.name }}</option></select></label></div>
      </div>
    </div>
    <div v-if="!songs.length && !busy && !error" class="empty-state"><span class="empty-icon"><Icon :name="query ? 'search' : 'music'" :size="35" /></span><h3>{{ query ? '沒有找到這首歌' : '曲庫還沒有歌曲' }}</h3><p>{{ query ? '試試其他名稱或演出者。' : '前往上傳頁，為音樂室帶來第一首歌。' }}</p><a v-if="!query" class="secondary" href="/web/upload"><Icon name="upload" :size="17" />前往上傳頁</a></div>
    <div v-if="busy" class="inline-loading" role="status"><span class="loading-ring"></span>正在載入歌曲…</div>
    <div v-else-if="hasMore" class="load-more"><button class="secondary" @click="emit('more')">載入更多歌曲<Icon name="down" :size="16" /></button></div>
    <p v-else-if="songs.length" class="list-end">{{ query ? '已載入所有搜尋結果' : '已瀏覽至曲庫末尾' }}<span>·</span>{{ songs.length }} 首已載入</p>
  </section>
</template>
