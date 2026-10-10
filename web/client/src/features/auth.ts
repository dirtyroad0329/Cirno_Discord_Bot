import { ref } from 'vue';
import { api, ApiError, errorMessage, type ApiClient } from '../api/client';
import type { AuthState, WebUser } from '../../../contracts/index';

export type AuthUser = WebUser;
type AuthResponse = Pick<AuthState, 'user' | 'csrfToken'>;

export function useAuth(client: ApiClient = api) {
  const user = ref<AuthUser | null>(null);
  const loading = ref(true);
  const busy = ref(false);
  const error = ref('');
  client.setUnauthorizedHandler(() => {
    user.value = null; client.setCsrfToken(undefined);
    error.value = '登入已過期或被撤銷，請重新登入。';
  });
  function accept(response: AuthResponse) {
    user.value = response.user;
    client.setCsrfToken(response.csrfToken);
  }
  async function restore() {
    loading.value = true;
    try { accept(await client.request<AuthResponse>('/auth/me')); }
    catch (failure) { user.value = null; if (!(failure instanceof ApiError && failure.status === 401)) error.value = errorMessage(failure); }
    finally { loading.value = false; }
  }
  async function login(discordId: string, password: string) {
    busy.value = true; error.value = '';
    try { accept(await client.request<AuthResponse>('/auth/login', { method: 'POST', body: { discordId, password } })); return true; }
    catch (failure) { error.value = errorMessage(failure); return false; }
    finally { busy.value = false; }
  }
  async function register(discordId: string) {
    busy.value = true; error.value = '';
    try {
      await client.request<{ success: true }>('/auth/register', { method: 'POST', body: { discordId } });
      return true;
    } catch (failure) { error.value = errorMessage(failure); return false; }
    finally { busy.value = false; }
  }
  async function changePassword(currentPassword: string, newPassword: string) {
    busy.value = true; error.value = '';
    try {
      await client.request('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      user.value = null; client.setCsrfToken(undefined);
      return true;
    } catch (failure) { error.value = errorMessage(failure); return false; }
    finally { busy.value = false; }
  }
  async function logout() {
    busy.value = true; error.value = '';
    try { await client.request('/auth/logout', { method: 'POST' }); user.value = null; client.setCsrfToken(undefined); return true; }
    catch (failure) { error.value = errorMessage(failure); return false; }
    finally { busy.value = false; }
  }
  return { user, loading, busy, error, restore, login, register, changePassword, logout };
}
