export { AuthError } from './errors.js';
export { AuthService, openAuthService, validateDiscordId } from './service.js';
export type { AuthOptions, AuthSession, AuthLogin, SessionScope } from './service.js';
export { createAuthHttp, AUTH_COOKIE } from './routes.js';
export type { AuthHttp, AuthHttpOptions } from './routes.js';
