<script setup lang="ts">
import Icon from './Icon.vue';
import { fallbackArtist } from '../features/format';
defineProps<{ open: boolean; title?: string; artist?: string | null; pending: Array<{ key: string; title: string; artist?: string | null }>; target: 'discord' | 'browser'; canControl: boolean; busy: boolean; playing: boolean }>();
const emit = defineEmits<{ close: []; remove: [index: number]; move: [from: number, to: number]; clear: [] }>();
let from: number | null = null;
function drop(to: number) { if (from !== null && from !== to) emit('move', from, to); from = null; }
</script>
<template>
  <aside class="queue-panel" :class="{ open }" aria-label="待播佇列" :inert="!open || undefined">
    <div class="queue-heading"><div><p class="eyebrow">UP NEXT</p><h2>待播佇列 <span class="count">{{ pending.length }}</span></h2></div><button class="icon-button" aria-label="關閉佇列" @click="emit('close')"><Icon name="close" :size="18" /></button></div>
    <div class="queue-device"><span class="live-dot"></span><Icon :name="target === 'discord' ? 'discord' : 'browser'" :size="16" />{{ target === 'discord' ? 'Discord 共用佇列' : '此瀏覽器的佇列' }}</div>
    <h3 class="queue-label">正在播放</h3>
    <div v-if="title" class="queue-current"><span class="song-tile"><Icon name="music" :size="22" /></span><div class="truncate"><strong>{{ title }}</strong><span class="muted small">{{ fallbackArtist(artist) }}</span></div><span v-if="playing" class="equalizer"><i></i><i></i><i></i></span><Icon v-else name="pause" :size="16" /></div>
    <div v-else class="queue-placeholder">還沒有正在播放的歌曲</div>
    <div class="queue-subheading"><h3 class="queue-label">接下來</h3><button class="text-button" :disabled="!pending.length || !canControl || busy" @click="emit('clear')">清空</button></div>
    <ol class="queue-items"><li v-for="(track, index) in pending" :key="track.key" class="queue-item" :draggable="canControl && !busy" @dragstart="from = index" @dragend="from = null" @dragover.prevent @drop.prevent="drop(index)"><span class="queue-index">{{ String(index + 1).padStart(2, '0') }}</span><div class="truncate"><strong>{{ track.title }}</strong><span>{{ fallbackArtist(track.artist) }}</span></div><div class="queue-item-actions"><button class="icon-button" :disabled="!canControl || busy || index === 0" :aria-label="`${track.title} 上移`" @click="emit('move', index, index - 1)"><Icon name="up" :size="14" /></button><button class="icon-button" :disabled="!canControl || busy || index === pending.length - 1" :aria-label="`${track.title} 下移`" @click="emit('move', index, index + 1)"><Icon name="down" :size="14" /></button><button class="icon-button" :disabled="!canControl || busy" :aria-label="`${track.title} 從待播移除`" @click="emit('remove', index)"><Icon name="close" :size="14" /></button></div></li></ol>
    <div v-if="!pending.length" class="queue-empty"><Icon name="queue" :size="32" /><p>給下一首留個位置</p><span>在曲庫按「＋」，將歌曲加入待播。</span></div>
    <p class="queue-foot"><Icon name="music" :size="13" />{{ target === 'discord' ? '與語音頻道的朋友共享音樂' : '僅保存在此頁面，關閉後清除' }}</p>
  </aside>
</template>
