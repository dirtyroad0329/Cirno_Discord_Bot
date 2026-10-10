<script setup lang="ts">
import { ref } from 'vue';
import Icon from '../components/Icon.vue';
defineProps<{ id: string; busy: boolean; error: string }>();
const emit = defineEmits<{ password: [current: string, next: string]; logout: [] }>();
const current = ref(''); const next = ref(''); const confirm = ref(''); const validation = ref('');
function submit() {
  validation.value = '';
  if (!/^[A-Za-z0-9]{4,1024}$/.test(next.value)) { validation.value = '新密碼請使用英文字母或數字，至少 4 個字元。'; return; }
  if (next.value !== confirm.value) { validation.value = '兩次新密碼不相同。'; return; }
  emit('password', current.value, next.value); current.value = ''; next.value = ''; confirm.value = '';
}
</script>
<template>
  <section class="settings-page"><div class="section-heading"><div><p class="eyebrow">YOUR MUSIC ROOM</p><h1>帳號設定</h1><p class="muted">管理網站帳號與登入密碼。</p></div></div>
    <div class="settings-card"><span class="settings-card-icon"><Icon name="discord" :size="24" /></span><div><h3>Discord 使用者 ID</h3><p class="account-id">{{ id }}</p><p class="muted small">這是清單與語音操作使用的網站帳號識別值。本站不連結或驗證 Discord 帳號。</p></div></div>
    <form class="settings-card password-card" @submit.prevent="submit"><div class="settings-card-title"><Icon name="lock" :size="23" /><h3>修改密碼</h3></div><p class="muted">新密碼僅限英文字母與數字，至少 4 個字元。修改後，所有網站工作階段會登出。</p><label>目前密碼<input v-model="current" type="password" autocomplete="current-password" required /></label><label>新密碼<input v-model="next" type="password" autocomplete="new-password" pattern="[A-Za-z0-9]{4,1024}" minlength="4" maxlength="1024" required /></label><label>再次輸入新密碼<input v-model="confirm" type="password" autocomplete="new-password" pattern="[A-Za-z0-9]{4,1024}" minlength="4" maxlength="1024" required /></label><p v-if="error || validation" class="error" role="alert">{{ validation || error }}</p><button class="primary" type="submit" :disabled="busy">{{ busy ? '儲存中…' : '更新密碼' }}<Icon name="arrow" :size="17" /></button></form>
    <button class="secondary" :disabled="busy" @click="emit('logout')"><Icon name="logout" :size="17" />登出這個音樂室</button>
  </section>
</template>
