import sqlite3 from 'sqlite3';
import { chmod, mkdir, stat, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuthError } from '../errors.js';
import { authMigrations } from '../migrations/schema.js';

type Parameter = string | number | null;
export interface SqlConnection {
  run(sql: string, parameters?: Parameter[]): Promise<{ changes: number; lastID: number }>;
  get<T>(sql: string, parameters?: Parameter[]): Promise<T | undefined>;
  all<T>(sql: string, parameters?: Parameter[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export class AuthDatabase implements SqlConnection {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closing = false;
  private closePromise?: Promise<void>;

  private constructor(private readonly connection: sqlite3.Database, readonly path: string) {}

  static async open(path: string): Promise<AuthDatabase> {
    path = resolve(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const existed = await stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const connection = await new Promise<sqlite3.Database>((resolveOpen, reject) => {
      const db = new sqlite3.Database(path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
        (error) => error ? reject(error) : resolveOpen(db));
    });
    const db = new AuthDatabase(connection, path);
    try {
      await chmod(path, 0o600);
      await db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      await db.exec('CREATE TABLE IF NOT EXISTS WebMigration (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
      const applied = await db.all<{ version: number }>('SELECT version FROM WebMigration ORDER BY version');
      const versions = new Set(applied.map((row) => row.version));
      if (applied.some((row) => !authMigrations.some((migration) => migration.version === row.version))) {
        throw new Error('Authentication database schema is newer than this application');
      }
      if (existed && authMigrations.some((migration) => !versions.has(migration.version))) {
        await db.backup(`${path}.migration-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);
      }
      await db.transaction(async (transaction) => {
        // A concurrent CLI may have migrated while this connection was backing up.
        const rows = await transaction.all<{ version: number }>('SELECT version FROM WebMigration');
        const current = new Set(rows.map((row) => row.version));
        for (const migration of authMigrations) {
          if (!current.has(migration.version)) {
            await transaction.exec(migration.sql);
            await transaction.run('INSERT INTO WebMigration (version, applied_at) VALUES (?, ?)',
              [migration.version, Date.now()]);
          }
        }
      });
      return db;
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  // These primitives are used only inside the serialized owner below.
  run(sql: string, parameters: Parameter[] = []): Promise<{ changes: number; lastID: number }> {
    return new Promise((resolveRun, reject) => this.connection.run(sql, parameters, function (error) {
      error ? reject(error) : resolveRun({ changes: this.changes, lastID: this.lastID });
    }));
  }

  get<T>(sql: string, parameters: Parameter[] = []): Promise<T | undefined> {
    return new Promise((resolveGet, reject) => this.connection.get(sql, parameters,
      (error, row) => error ? reject(error) : resolveGet(row as T | undefined)));
  }

  all<T>(sql: string, parameters: Parameter[] = []): Promise<T[]> {
    return new Promise((resolveAll, reject) => this.connection.all(sql, parameters,
      (error, rows) => error ? reject(error) : resolveAll(rows as T[])));
  }

  exec(sql: string): Promise<void> {
    return new Promise((resolveExec, reject) => this.connection.exec(sql,
      (error) => error ? reject(error) : resolveExec()));
  }

  serialized<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AuthError('AUTH_UNAVAILABLE', '登入服務暫時不可用。', 503));
    if (this.pending >= 64) return Promise.reject(new AuthError('AUTH_BUSY', '登入服務忙碌，請稍後再試。', 503));
    this.pending++;
    const result = this.tail.then(() => operation(this)).catch((error: unknown) => {
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string })?.code ?? '')) {
        throw new AuthError('AUTH_BUSY', '登入服務忙碌，請稍後再試。', 503);
      }
      throw error;
    });
    this.tail = result.catch(() => undefined).finally(() => { this.pending--; });
    return result;
  }

  transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
    return this.serialized(async (connection) => {
      await connection.run('BEGIN IMMEDIATE');
      try {
        const result = await operation(connection);
        await connection.run('COMMIT');
        return result;
      } catch (error) {
        await connection.run('ROLLBACK');
        throw error;
      }
    });
  }

  async backup(destination: string): Promise<void> {
    destination = resolve(destination);
    if (destination === this.path) throw new Error('Backup destination must differ from the live database');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    // SQLite permits VACUUM INTO an empty file. Reserve it exclusively with
    // restrictive permissions before copying credentials, including when the
    // operator chose an existing/shared parent directory.
    const reserved = await open(destination, 'wx', 0o600);
    await reserved.close();
    try {
      await this.serialized((connection) => connection.run('VACUUM INTO ?', [destination]));
      await chmod(destination, 0o600);
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = this.tail.then(() => new Promise<void>((resolveClose, reject) =>
        this.connection.close((error) => error ? reject(error) : resolveClose())));
    }
    return this.closePromise;
  }
}
