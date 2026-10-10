<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  music: 'M9 18V5l12-2v13M9 9l12-2M9 18a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3ZM21 16a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3Z',
  library: 'M4 4v16M9 4v16M14 4v16M18 4l4 15',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  list: 'M4 5h16M4 11h10M4 17h10M20 13v8M16 17h8',
  settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  play: 'M8 4l12 8-12 8Z', pause: 'M8 4v16M16 4v16',
  next: 'M5 4l11 8-11 8ZM19 4v16', previous: 'M19 4 8 12l11 8ZM5 4v16',
  queue: 'M3 5h18M3 11h18M3 17h11M18 15l4 3-4 3Z',
  volume: 'M3 9v6h4l5 4V5L7 9ZM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14',
  repeat: 'M18 3l4 4-4 4M22 7H7a4 4 0 0 0-4 4M6 21l-4-4 4-4M2 17h15a4 4 0 0 0 4-4',
  shuffle: 'M3 4h3l12 16h3M18 17l3 3-3 3M3 20h3L18 4h3M18 1l3 3-3 3',
  upload: 'M12 16V3M7 8l5-5 5 5M4 15v6h16v-6',
  arrow: 'M5 12h14M14 7l5 5-5 5', plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18', logout: 'M9 4H4v16h5M10 12h12M17 7l5 5-5 5',
  check: 'M4 12l5 5L20 6', up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6',
  trash: 'M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  edit: 'M4 16l12-12 4 4L8 20H4ZM13 7l4 4',
  discord: 'M7 5 3 7 2 17l5 2 1-2M17 5l4 2 1 10-5 2-1-2M7 5a18 18 0 0 1 10 0M5 16a16 16 0 0 0 14 0M8 11h.01M16 11h.01',
  browser: 'M3 4h18v13H3ZM8 21h8M12 17v4',
  snow: 'M12 2v20M3 7l18 10M3 17 21 7M9 4l3 3 3-3M9 20l3-3 3 3M3 10l4-1-1-4M21 14l-4 1 1 4M3 14l4 1-1 4M21 10l-4-1 1-4',
  refresh: 'M20 7V2l-4 4M20 7a8 8 0 1 0 0 10',
  lock: 'M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0v4M12 14v3',
  stop: 'M5 5h14v14H5Z', restart: 'M4 9V3M4 9h6M4 9a8 8 0 1 1 0 6',
};
</script>
<template><svg :width="size ?? 20" :height="size ?? 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] ?? paths.music" /></svg></template>
