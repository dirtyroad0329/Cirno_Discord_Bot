<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AuthScreen from './components/AuthScreen.vue';
import MusicRoom from './MusicRoom.vue';
import { useAuth } from './features/auth';

const auth = useAuth();
const message = ref('');
const registering = ref(false);
onMounted(() => { void auth.restore(); });
async function changePassword(current: string, next: string) {
  if (await auth.changePassword(current, next)) message.value = '密碼已更新，所有舊工作階段已登出。請使用新密碼登入。';
}
async function login(id: string, password: string) { if (await auth.login(id, password)) message.value = ''; }
async function register(id: string) {
  if (await auth.register(id)) {
    registering.value = false;
    message.value = '帳號已建立，請登入。';
  }
}
function switchMode(mode: boolean) {
  registering.value = mode;
  message.value = '';
  auth.error.value = '';
}
</script>
<template>
  <div v-if="auth.loading.value" class="app-loading" role="status"><span class="loading-ring"></span>正在開啟音樂室…</div>
  <AuthScreen v-else-if="!auth.user.value" :busy="auth.busy.value" :error="auth.error.value" :registering="registering" :message="message" @login="login" @register="register" @mode="switchMode" />
  <MusicRoom v-else :key="auth.user.value.discordId" :user="auth.user.value" :auth-busy="auth.busy.value" :auth-error="auth.error.value" @logout="auth.logout" @password="changePassword" />
</template>
