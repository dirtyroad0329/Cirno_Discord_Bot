import { createHash, randomBytes } from 'node:crypto';
import { AuthError, invalidCredentials } from './errors.js';
import { ScryptPasswords, validateNewPassword, validatePasswordInput, type PasswordHasher } from './password.js';
import { AuthDatabase, type SqlConnection } from './storage/sqlite.js';

export type SessionScope = 'full' | 'password_change';
export interface AuthSession {
  discordId: string;
  scope: SessionScope;
  csrfToken: string;
  tokenHash: string;
  credentialVersion: number;
  expiresAt: number;
}
export interface AuthLogin {
  token: string;
  csrfToken: string;
  user: { discordId: string; mustChangePassword: boolean };
  scope: SessionScope;
  expiresAt: number;
}
export interface AuthOptions {
  dbPath: string;
  sessionMaxAgeMs?: number;
  sessionIdleMs?: number;
  hashConcurrency?: number;
  hashQueueLimit?: number;
  /** Dependency injection allows deterministic expiry/concurrent hash tests. */
  passwords?: PasswordHasher;
  now?: () => number;
}
interface UserRow {
  discord_id: string;
  password_hash: string;
  must_change_password: number;
  credential_version: number;
  disabled_at: number | null;
}
interface SessionRow {
  token_hash: string;
  user_id: string;
  csrf_token: string;
  scope: SessionScope;
  credential_version: number;
  expires_at: number;
  last_seen_at: number;
}

const DAY = 24 * 60 * 60 * 1000;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export function validateDiscordId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length < 17 || id.length > 20 || /[^0-9]/.test(id)) {
    throw new AuthError('INVALID_DISCORD_ID', 'Discord ID 必須是 17–20 位數字字串。');
  }
}

export class AuthService {
  private readonly now: () => number;
  private readonly maxAge: number;
  private readonly idle: number;
  private constructor(
    private readonly database: AuthDatabase,
    private readonly passwords: PasswordHasher,
    private readonly dummyHash: string,
    options: AuthOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.maxAge = options.sessionMaxAgeMs ?? 7 * DAY;
    this.idle = options.sessionIdleMs ?? DAY;
    for (const value of [this.maxAge, this.idle]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid authentication lifetime');
    }
  }

  static async open(options: AuthOptions): Promise<AuthService> {
    const database = await AuthDatabase.open(options.dbPath);
    try {
      const passwords = options.passwords ?? new ScryptPasswords(options.hashConcurrency, options.hashQueueLimit);
      const dummy = await passwords.hash(randomBytes(32).toString('base64url'));
      return new AuthService(database, passwords, dummy, options);
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  private user(id: string): Promise<UserRow | undefined> {
    return this.database.serialized((connection) => connection.get<UserRow>(
      'SELECT discord_id, password_hash, must_change_password, credential_version, disabled_at FROM WebUser WHERE discord_id = ?', [id]));
  }

  async createUser(discordId: string): Promise<void> {
    validateDiscordId(discordId);
    const passwordHash = await this.passwords.hash('piyan');
    const now = this.now();
    try {
      await this.database.transaction((connection) => connection.run(
        `INSERT INTO WebUser (discord_id, password_hash, must_change_password, credential_version, created_at, password_updated_at)
         VALUES (?, ?, 0, 1, ?, ?)`, [discordId, passwordHash, now, now]));
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT') {
        throw new AuthError('USER_EXISTS', '此網站帳號已存在。', 409);
      }
      throw error;
    }
  }

  async login(discordId: string, password: string): Promise<AuthLogin> {
    // Invalid account shapes share the same response as unknown accounts.
    try { validateDiscordId(discordId); validatePasswordInput(password); }
    catch { throw invalidCredentials(); }
    const observed = await this.user(discordId);
    const verified = await this.passwords.verify(password, observed?.password_hash ?? this.dummyHash);
    if (!verified || !observed || observed.disabled_at !== null) throw invalidCredentials();
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const result = await this.database.transaction(async (connection) => {
      const current = await connection.get<UserRow>('SELECT * FROM WebUser WHERE discord_id = ?', [discordId]);
      // Hashing ran outside the transaction. Reject credentials reset/disabled in
      // the meantime instead of minting a session with the old password.
      if (!current || current.disabled_at !== null || current.credential_version !== observed.credential_version) {
        throw invalidCredentials();
      }
      const now = this.now();
      const scope: SessionScope = 'full';
      const expiresAt = now + this.maxAge;
      await connection.run(
        `INSERT INTO WebSession (token_hash, user_id, csrf_token, scope, credential_version, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [hashToken(token), discordId, csrfToken, scope, current.credential_version, now, expiresAt, now]);
      await connection.run(`DELETE FROM WebSession WHERE token_hash IN (
        SELECT token_hash FROM WebSession WHERE expires_at < ? OR revoked_at < ? LIMIT 100
      )`, [now - DAY, now - DAY]);
      return { expiresAt, scope, mustChangePassword: false };
    });
    return { token, csrfToken, user: { discordId, mustChangePassword: result.mustChangePassword },
      scope: result.scope, expiresAt: result.expiresAt };
  }

  async authenticate(token: string, options: { touch?: boolean } = {}): Promise<AuthSession | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = hashToken(token);
    return this.database.serialized(async (connection) => {
      const now = this.now();
      const row = await this.validSession(connection, tokenHash, now);
      if (!row) return null;
      if (options.touch !== false && now - row.last_seen_at >= 30_000) {
        const update = await connection.run(`UPDATE WebSession SET last_seen_at = ? WHERE token_hash = ?
          AND revoked_at IS NULL AND credential_version = (
            SELECT credential_version FROM WebUser WHERE discord_id = WebSession.user_id AND disabled_at IS NULL
          )`, [now, tokenHash]);
        if (update.changes !== 1) return null;
      }
      return { discordId: row.user_id, scope: row.scope, csrfToken: row.csrf_token,
        tokenHash, credentialVersion: row.credential_version, expiresAt: row.expires_at };
    });
  }

  private validSession(connection: SqlConnection, tokenHash: string, now: number): Promise<SessionRow | undefined> {
    return connection.get<SessionRow>(`SELECT s.* FROM WebSession s JOIN WebUser u ON u.discord_id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND u.disabled_at IS NULL
      AND s.credential_version = u.credential_version AND s.expires_at > ? AND s.last_seen_at > ?
      AND s.scope = 'full'`, [tokenHash, now, now - this.idle]);
  }

  async logout(token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    await this.database.serialized((connection) => connection.run(
      'UPDATE WebSession SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [this.now(), hashToken(token)]));
  }

  async changePassword(session: AuthSession, currentPassword: string, newPassword: string): Promise<void> {
    validatePasswordInput(currentPassword);
    validateNewPassword(newPassword);
    const observed = await this.user(session.discordId);
    if (!observed || observed.disabled_at !== null || observed.credential_version !== session.credentialVersion ||
      !await this.passwords.verify(currentPassword, observed.password_hash)) throw invalidCredentials();
    const hash = await this.passwords.hash(newPassword);
    await this.database.transaction(async (connection) => {
      const currentSession = await this.validSession(connection, session.tokenHash, this.now());
      if (!currentSession || currentSession.user_id !== session.discordId ||
        currentSession.credential_version !== session.credentialVersion) {
        throw new AuthError('SESSION_EXPIRED', '登入已失效，請重新登入。', 401);
      }
      await this.replaceCredential(connection, session.discordId, observed.credential_version, hash);
    });
  }

  async resetPassword(discordId: string): Promise<string> {
    validateDiscordId(discordId);
    const observed = await this.user(discordId);
    if (!observed) throw new AuthError('USER_NOT_FOUND', '找不到網站帳號。', 404);
    const temporaryPassword = randomBytes(18).toString('hex');
    const hash = await this.passwords.hash(temporaryPassword);
    await this.database.transaction((connection) =>
      this.replaceCredential(connection, discordId, observed.credential_version, hash));
    return temporaryPassword;
  }

  private async replaceCredential(connection: SqlConnection, id: string, version: number,
    hash: string): Promise<void> {
    const now = this.now();
    const update = await connection.run(`UPDATE WebUser SET password_hash = ?, must_change_password = 0,
      credential_version = credential_version + 1, password_updated_at = ?
      WHERE discord_id = ? AND credential_version = ?`, [hash, now, id, version]);
    if (update.changes !== 1) throw new AuthError('CREDENTIAL_CHANGED', '帳號已被其他操作更新，請重新操作。', 409);
    await connection.run('UPDATE WebSession SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, id]);
  }

  async setDisabled(discordId: string, disabled: boolean): Promise<void> {
    validateDiscordId(discordId);
    await this.database.transaction(async (connection) => {
      const now = this.now();
      const update = await connection.run(`UPDATE WebUser SET disabled_at = ?,
        credential_version = credential_version + 1 WHERE discord_id = ?`, [disabled ? now : null, discordId]);
      if (update.changes !== 1) throw new AuthError('USER_NOT_FOUND', '找不到網站帳號。', 404);
      await connection.run('UPDATE WebSession SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, discordId]);
    });
  }

  backup(destination: string): Promise<void> { return this.database.backup(destination); }
  close(): Promise<void> { return this.database.close(); }
}

export const openAuthService = (options: AuthOptions) => AuthService.open(options);
