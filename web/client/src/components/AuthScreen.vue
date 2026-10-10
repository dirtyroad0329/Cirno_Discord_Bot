<script setup lang="ts">
import { ref, watch } from 'vue';
import Icon from './Icon.vue';
const props = defineProps<{ busy: boolean; error: string; registering?: boolean; message?: string }>();
const emit = defineEmits<{ login: [id: string, password: string]; register: [id: string]; mode: [registering: boolean] }>();
const id = ref(''); const password = ref('');
watch(() => props.registering, () => { password.value = ''; });
function submit() {
  if (props.registering) emit('register', id.value.trim());
  else emit('login', id.value.trim(), password.value);
  password.value = '';
}
</script>
<template>
  <main class="auth-layout">
    <section class="auth-identity" aria-label="Cirno 音樂室">
      <a class="brand" href="/web/"><span class="brand-mark"><Icon name="snow" :size="25" /></span><span>CIRNO<span class="brand-sub">MUSIC ROOM</span></span></a>
      <div class="auth-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="ice-core"><Icon name="snow" :size="92" /></div><span class="star s1">✦</span><span class="star s2">✧</span><span class="star s3">✦</span></div>
      <div class="auth-copy"><p class="eyebrow">YOUR MUSIC, YOUR SPACE</p><h1>讓好音樂，<br />在這裡相遇。</h1><p>收藏喜歡的歌，與語音頻道的朋友一起聽。<br />你的 Cirno 音樂室，隨時準備播放。</p></div>
      <span class="auth-foot">CIRNO · CONNECTED THROUGH MUSIC</span>
    </section>
    <section class="auth-form-side">
      <form class="auth-form" @submit.prevent="submit">
        <span class="form-icon"><Icon name="music" :size="26" /></span>
        <p class="eyebrow">{{ registering ? 'REGISTER' : 'WELCOME BACK' }}</p>
        <h2>{{ registering ? '建立帳號' : '登入音樂室' }}</h2>
        <p class="muted">{{ registering ? '輸入 Discord 使用者 ID 建立網站帳號。' : '使用 Discord ID 與網站密碼登入。' }}</p>
        <p v-if="message" class="notice" role="status">{{ message }}</p>
        <label>Discord 使用者 ID<input v-model="id" name="discordId" autocomplete="username" inputmode="numeric" pattern="[0-9]{17,20}" placeholder="輸入 Discord 使用者 ID" :disabled="busy" required /></label>
        <label v-if="!registering">密碼<input v-model="password" name="password" type="password" autocomplete="current-password" placeholder="輸入密碼" :disabled="busy" required /></label>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary auth-submit" :disabled="busy" type="submit">{{ busy ? '處理中…' : registering ? '註冊' : '登入' }}<Icon name="arrow" /></button>
        <button class="text-button" type="button" :disabled="busy" @click="emit('mode', !registering)">{{ registering ? '返回登入' : '建立帳號' }}</button>
        <p class="auth-help"><span>這是網站帳號登入，不會連結或驗證 Discord 帳號。</span></p>
      </form>
    </section>
  </main>
</template>
