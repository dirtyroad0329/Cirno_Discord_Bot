/** Append migrations; never rewrite a deployed migration or drop account data. */
export const authMigrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE WebUser (
        discord_id TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
        created_at INTEGER NOT NULL,
        password_updated_at INTEGER NOT NULL
      );
      CREATE TABLE WebSession (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES WebUser(discord_id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('full', 'password_change')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX WebSession_user ON WebSession(user_id);
      CREATE INDEX WebSession_expiry ON WebSession(expires_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE WebUser ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE WebUser ADD COLUMN disabled_at INTEGER;
      ALTER TABLE WebSession ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 3,
    sql: `
      UPDATE WebUser SET must_change_password = 0 WHERE must_change_password = 1;
      UPDATE WebSession SET scope = 'full' WHERE scope = 'password_change';
    `,
  },
] as const;
