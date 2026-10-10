import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import Fastify from 'fastify';
import { openAuthService, AuthError, createAuthHttp, type AuthService } from '../../server/auth/index.js';
import { ScryptPasswords, type PasswordHasher } from '../../server/auth/password.js';
import { authMigrations } from '../../server/auth/migrations/schema.js';

const ID = '123456789012345678';
const SECOND_ID = '223456789012345678';
const ORIGIN = 'https://music.example.test';
const PASSWORD = 'NewPrivatePassword';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cirno-auth-'));
  const dbPath = join(directory, 'auth.sqlite');
  const services: AuthService[] = [];
  return { directory, dbPath, async open(options: Record<string, unknown> = {}) {
    const service = await openAuthService({ dbPath, ...options }); services.push(service); return service;
  }, async cleanup() { await Promise.all(services.map((service) => service.close())); await rm(directory, { recursive: true, force: true }); } };
}
function expectCode(code: string) {
  return (error: unknown) => error instanceof AuthError && error.code === code;
}
async function changeInitial(auth: AuthService, id = ID) {
  const login = await auth.login(id, 'piyan');
  const session = await auth.authenticate(login.token);
  assert.ok(session);
  await auth.changePassword(session, 'piyan', PASSWORD);
  return auth.login(id, PASSWORD);
}
async function query(path: string, sql: string): Promise<Record<string, unknown>[]> {
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const connection = new sqlite3.Database(path, (error) => error ? reject(error) : resolve(connection));
  });
  try { return await new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows as Record<string, unknown>[]))); }
  finally { await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
}

test('initial login has immediate full access; voluntary password change revokes every session and tokens are hashed at rest', async () => {
  const f = await fixture();
  try {
    const auth = await f.open();
    await assert.rejects(auth.createUser('9007199254740991'), expectCode('INVALID_DISCORD_ID'));
    await auth.createUser(ID);
    await assert.rejects(auth.createUser(ID), expectCode('USER_EXISTS'));
    const initial = await auth.login(ID, 'piyan');
    const other = await auth.login(ID, 'piyan');
    assert.equal(initial.scope, 'full');
    assert.equal(initial.user.mustChangePassword, false);
    const session = await auth.authenticate(initial.token);
    assert.ok(session);
    await assert.rejects(auth.changePassword(session, 'piyan', 'abc'), expectCode('WEAK_PASSWORD'));
    await auth.changePassword(session, 'piyan', PASSWORD);
    assert.equal(await auth.authenticate(initial.token), null);
    assert.equal(await auth.authenticate(other.token), null);
    await assert.rejects(auth.login(ID, 'piyan'), expectCode('INVALID_CREDENTIALS'));
    const full = await auth.login(ID, PASSWORD);
    assert.equal(full.scope, 'full');
    assert.equal(full.user.mustChangePassword, false);
    const rows = await query(f.dbPath, 'SELECT token_hash, csrf_token FROM WebSession');
    assert.equal(rows.some((row) => row.token_hash === full.token), false);
    assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(String(row.token_hash))));
    const users = await query(f.dbPath, 'SELECT password_hash, credential_version FROM WebUser');
    assert.match(String(users[0]!.password_hash), /^scrypt\$32768\$8\$1\$/);
    assert.equal(users[0]!.credential_version, 2);
    assert.equal((await stat(f.dbPath)).mode & 0o777, 0o600);
    await auth.logout(full.token);
    assert.equal(await auth.authenticate(full.token), null);
  } finally { await f.cleanup(); }
});

test('passwords accept four ASCII letters or digits, reject short/symbol/Unicode input, and may remain unchanged', async () => {
  const f = await fixture();
  try {
    const auth = await f.open();
    await auth.createUser(ID);
    let currentPassword = 'piyan';
    let login = await auth.login(ID, currentPassword);
    let session = await auth.authenticate(login.token); assert.ok(session);
    for (const invalid of ['abc', '123', 'abcd!', 'ab cd', 'ab_c', 'ab-c', '中文密碼', '１２３４', 'abcd\n', 'a'.repeat(1025)]) {
      await assert.rejects(auth.changePassword(session, currentPassword, invalid), (error: unknown) =>
        error instanceof AuthError && ['WEAK_PASSWORD', 'INVALID_PASSWORD'].includes(error.code));
      assert.ok(await auth.authenticate(login.token));
    }
    await assert.rejects(auth.changePassword(session, 'incorrect', 'Ab12'), expectCode('INVALID_CREDENTIALS'));
    for (const replacement of ['abcd', '1234', 'Ab12', 'Ab12', 'piyan']) {
      const oldToken = login.token;
      await auth.changePassword(session, currentPassword, replacement);
      assert.equal(await auth.authenticate(oldToken), null);
      currentPassword = replacement;
      login = await auth.login(ID, currentPassword);
      assert.equal(login.scope, 'full');
      session = await auth.authenticate(login.token); assert.ok(session);
    }
  } finally { await f.cleanup(); }
});

test('concurrent registrations on independent SQLite connections create only one account without replacing credentials', async () => {
  const f = await fixture();
  try {
    const first = await f.open();
    const second = await f.open();
    const attempts = await Promise.allSettled([first.createUser(ID), second.createUser(ID)]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected' && expectCode('USER_EXISTS')(rejected.reason));
    const initial = await first.login(ID, 'piyan');
    const session = await first.authenticate(initial.token); assert.ok(session);
    await first.changePassword(session, 'piyan', 'Ab12');
    const before = await query(f.dbPath, 'SELECT * FROM WebUser');
    await assert.rejects(second.createUser(ID), expectCode('USER_EXISTS'));
    assert.deepEqual(await query(f.dbPath, 'SELECT * FROM WebUser'), before);
    await assert.rejects(second.login(ID, 'piyan'), expectCode('INVALID_CREDENTIALS'));
    assert.equal((await second.login(ID, 'Ab12')).scope, 'full');
  } finally { await f.cleanup(); }
});

test('initial and normal sessions use absolute and idle expiry; activity renews only idle time', async () => {
  const f = await fixture();
  let now = Date.now();
  try {
    const auth = await f.open({ now: () => now, sessionMaxAgeMs: 200_000, sessionIdleMs: 60_000 });
    await auth.createUser(ID);
    const initial = await auth.login(ID, 'piyan');
    now += 10_001;
    assert.ok(await auth.authenticate(initial.token));
    const full = await changeInitial(auth);
    now += 31_000;
    assert.ok(await auth.authenticate(full.token));
    now += 59_999;
    assert.ok(await auth.authenticate(full.token));
    now += 60_001;
    assert.equal(await auth.authenticate(full.token), null);
    const absolute = await auth.login(ID, PASSWORD);
    for (let i = 0; i < 6; i++) { now += 31_000; assert.ok(await auth.authenticate(absolute.token)); }
    now += 14_001;
    assert.equal(await auth.authenticate(absolute.token), null);
  } finally { await f.cleanup(); }
});

test('independent SQLite connections reset/disable atomically and reject an old password login already hashing', async () => {
  const f = await fixture();
  let release!: () => void;
  let observed!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { observed = resolve; });
  let delay = false;
  const real = new ScryptPasswords();
  const passwords: PasswordHasher = {
    hash: (password) => real.hash(password),
    async verify(password, hash) {
      const valid = await real.verify(password, hash);
      if (delay && password === PASSWORD) { observed(); await held; }
      return valid;
    },
  };
  try {
    const http = await f.open({ passwords });
    await http.createUser(ID);
    const active = await changeInitial(http);
    const cli = await f.open();
    delay = true;
    const underway = http.login(ID, PASSWORD);
    await reached;
    const temporary = await cli.resetPassword(ID);
    assert.notEqual(temporary, 'piyan');
    assert.ok(temporary.length >= 20);
    release();
    await assert.rejects(underway, expectCode('INVALID_CREDENTIALS'));
    assert.equal(await http.authenticate(active.token), null);
    const reset = await http.login(ID, temporary);
    assert.equal(reset.scope, 'full');
    await cli.setDisabled(ID, true);
    assert.equal(await http.authenticate(reset.token), null);
    await assert.rejects(http.login(ID, temporary), expectCode('INVALID_CREDENTIALS'));
    await cli.setDisabled(ID, false);
    assert.equal(await http.authenticate(reset.token), null);
    assert.equal((await http.login(ID, temporary)).scope, 'full');
    await assert.rejects(http.login(SECOND_ID, temporary), expectCode('INVALID_CREDENTIALS'));
  } finally { release(); await f.cleanup(); }
});

test('a revoked session cannot complete an in-flight password change or overwrite a later CLI reset', async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const real = new ScryptPasswords();
  const replacement = 'Replacement1234';
  try {
    const http = await f.open({ passwords: { verify: real.verify.bind(real), async hash(password: string) {
      const hash = await real.hash(password);
      if (password === replacement) { reached(); await gate; }
      return hash;
    } } });
    await http.createUser(ID);
    const active = await changeInitial(http);
    const session = await http.authenticate(active.token); assert.ok(session);
    const changing = http.changePassword(session, PASSWORD, replacement);
    await started;
    const cli = await f.open();
    const reset = await cli.resetPassword(ID);
    release();
    await assert.rejects(changing, expectCode('SESSION_EXPIRED'));
    assert.equal((await cli.login(ID, reset)).scope, 'full');
    await assert.rejects(cli.login(ID, replacement), expectCode('INVALID_CREDENTIALS'));
  } finally { release(); await f.cleanup(); }
});

test('sessions and credentials survive restart and WAL-safe live backup/restore', async () => {
  const f = await fixture();
  try {
    const first = await f.open();
    await first.createUser(ID);
    const active = await changeInitial(first);
    const backup = join(f.directory, 'backup.sqlite');
    await first.backup(backup);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    await first.close();
    const restarted = await f.open();
    assert.ok(await restarted.authenticate(active.token));
    assert.equal((await restarted.login(ID, PASSWORD)).scope, 'full');
    const restoredPath = join(f.directory, 'restored', 'auth.sqlite');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(f.directory, 'restored'));
    await cp(backup, restoredPath);
    const restored = await openAuthService({ dbPath: restoredPath });
    try {
      assert.ok(await restored.authenticate(active.token));
      assert.equal((await restored.login(ID, PASSWORD)).user.discordId, ID);
      await assert.rejects(restarted.backup(backup)); // Never overwrite an existing backup.
    } finally { await restored.close(); }
  } finally { await f.cleanup(); }
});

test('upgrading an older schema retains accounts/sessions and makes a restorable pre-migration backup', async () => {
  const f = await fixture();
  const passwords = new ScryptPasswords();
  const hash = await passwords.hash('piyan');
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const now = Date.now();
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const connection = new sqlite3.Database(f.dbPath, (error) => error ? reject(error) : resolve(connection));
  });
  try {
    const exec = (sql: string) => new Promise<void>((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
    const run = (sql: string, values: unknown[]) => new Promise<void>((resolve, reject) => db.run(sql, values, (error) => error ? reject(error) : resolve()));
    await exec(`PRAGMA journal_mode=WAL; CREATE TABLE WebMigration (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); ${authMigrations[0].sql}`);
    await run('INSERT INTO WebMigration VALUES(1, ?)', [now]);
    await run('INSERT INTO WebUser VALUES(?, ?, 1, ?, ?)', [ID, hash, now, now]);
    await run('INSERT INTO WebSession VALUES(?, ?, ?, ?, ?, ?, ?, NULL)',
      [createHash('sha256').update(token).digest('hex'), ID, csrf, 'password_change', now, now + 600_000, now]);
  } finally { await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
  try {
    const upgraded = await f.open();
    assert.equal((await upgraded.authenticate(token))?.scope, 'full');
    assert.equal((await upgraded.login(ID, 'piyan')).scope, 'full');
    assert.deepEqual((await query(f.dbPath, 'SELECT version FROM WebMigration ORDER BY version')).map((row) => row.version), [1, 2, 3]);
    const backups = (await readdir(f.directory)).filter((name) => name.includes('.migration-') && name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    assert.equal((await query(join(f.directory, backups[0]!), 'SELECT discord_id FROM WebUser'))[0]!.discord_id, ID);
  } finally { await f.cleanup(); }
});

test('v2 migration preserves old passwords, normal sessions and revocation while upgrading forced-change sessions', async () => {
  const f = await fixture();
  const passwords = new ScryptPasswords();
  const legacyPassword = 'old password ✓ with symbols!';
  const [legacyHash, initialHash] = await Promise.all([passwords.hash(legacyPassword), passwords.hash('piyan')]);
  const disabledId = '323456789012345678';
  const now = Date.now();
  const tokens = { normal: randomBytes(32).toString('base64url'), restricted: randomBytes(32).toString('base64url'),
    revoked: randomBytes(32).toString('base64url'), disabled: randomBytes(32).toString('base64url') };
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const connection = new sqlite3.Database(f.dbPath, (error) => error ? reject(error) : resolve(connection));
  });
  try {
    const exec = (sql: string) => new Promise<void>((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
    const run = (sql: string, values: unknown[]) => new Promise<void>((resolve, reject) => db.run(sql, values, (error) => error ? reject(error) : resolve()));
    await exec(`CREATE TABLE WebMigration (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      ${authMigrations[0].sql} ${authMigrations[1].sql}`);
    await run('INSERT INTO WebMigration VALUES(1, ?), (2, ?)', [now, now]);
    for (const [id, hash, forced, disabled] of [[ID, legacyHash, 0, null], [SECOND_ID, initialHash, 1, null],
      [disabledId, initialHash, 1, now]] as const) {
      await run(`INSERT INTO WebUser(discord_id, password_hash, must_change_password, created_at,
        password_updated_at, credential_version, disabled_at) VALUES (?, ?, ?, ?, ?, 7, ?)`, [id, hash, forced, now, now, disabled]);
    }
    for (const [name, token] of Object.entries(tokens)) {
      const owner = name === 'normal' ? ID : name === 'disabled' ? disabledId : SECOND_ID;
      await run(`INSERT INTO WebSession(token_hash, user_id, csrf_token, scope, created_at, expires_at,
        last_seen_at, revoked_at, credential_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 7)`,
      [createHash('sha256').update(token).digest('hex'), owner, randomBytes(32).toString('base64url'),
        name === 'normal' ? 'full' : 'password_change', now, now + 600_000, now, name === 'revoked' ? now : null]);
    }
  } finally { await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
  try {
    const beforeUsers = await query(f.dbPath, 'SELECT * FROM WebUser ORDER BY discord_id');
    const beforeSessions = await query(f.dbPath, 'SELECT * FROM WebSession ORDER BY token_hash');
    const upgraded = await f.open();
    assert.deepEqual(await query(f.dbPath, 'SELECT * FROM WebUser ORDER BY discord_id'),
      beforeUsers.map((row) => ({ ...row, must_change_password: 0 })));
    assert.deepEqual(await query(f.dbPath, 'SELECT * FROM WebSession ORDER BY token_hash'),
      beforeSessions.map((row) => ({ ...row, scope: 'full' })));
    assert.equal((await upgraded.authenticate(tokens.normal))?.scope, 'full');
    assert.equal((await upgraded.authenticate(tokens.restricted))?.scope, 'full');
    assert.equal(await upgraded.authenticate(tokens.revoked), null);
    assert.equal(await upgraded.authenticate(tokens.disabled), null);
    assert.equal((await upgraded.login(ID, legacyPassword)).scope, 'full');
    assert.equal((await upgraded.login(SECOND_ID, 'piyan')).user.mustChangePassword, false);
    await assert.rejects(upgraded.login(disabledId, 'piyan'), expectCode('INVALID_CREDENTIALS'));
    const legacyLogin = await upgraded.login(ID, legacyPassword);
    const legacySession = await upgraded.authenticate(legacyLogin.token); assert.ok(legacySession);
    await upgraded.changePassword(legacySession, legacyPassword, '1234');
    assert.equal((await upgraded.login(ID, '1234')).scope, 'full');
    assert.equal(await upgraded.authenticate(tokens.normal), null);
    const backup = (await readdir(f.directory)).find((name) => name.includes('.migration-') && name.endsWith('.sqlite'));
    assert.ok(backup);
    assert.deepEqual(await query(join(f.directory, backup), 'SELECT * FROM WebUser ORDER BY discord_id'), beforeUsers);
  } finally { await f.cleanup(); }
});

test('asynchronous scrypt bounds waiting work and uses independent salts', async () => {
  const passwords = new ScryptPasswords(1, 1);
  const first = passwords.hash(PASSWORD);
  const second = passwords.hash(PASSWORD);
  await assert.rejects(passwords.hash(PASSWORD), expectCode('AUTH_BUSY'));
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a, b);
  assert.ok(await passwords.verify(PASSWORD, a));
  assert.equal(await passwords.verify('different password', a), false);
});

test('real CLI runs alongside the HTTP service without a Bot login and persists accounts', async () => {
  const f = await fixture();
  try {
    const http = await f.open();
    await http.createUser(ID);
    const active = await changeInitial(http);
    const cli = fileURLToPath(new URL('../../server/auth/cli.ts', import.meta.url));
    const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, WEB_AUTH_DB_PATH: f.dbPath, WEB_PUBLIC_URL: ORIGIN },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (value) => { output += value.toString(); });
      child.stderr.on('data', (value) => { output += value.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, output }));
    });
    const [created, disabled] = await Promise.all([run(['create', SECOND_ID]), run(['disable', ID])]);
    assert.equal(created.code, 0, created.output);
    assert.equal(created.output.includes('piyan'), false);
    assert.equal(disabled.code, 0, disabled.output);
    assert.equal(await http.authenticate(active.token), null);
    assert.equal((await http.login(SECOND_ID, 'piyan')).scope, 'full');
    const reset = await run(['reset', SECOND_ID]);
    assert.equal(reset.code, 0, reset.output);
    const temporary = reset.output.match(/Temporary password for \d+: ([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(temporary);
    assert.equal((await http.login(SECOND_ID, temporary)).scope, 'full');
  } finally { await f.cleanup(); }
});

test('HTTP auth enforces same-origin, CSRF, immediate music access, cookie privacy, expiry and login backoff', async () => {
  const f = await fixture();
  const app = Fastify();
  try {
    const auth = await f.open();
    const http = createAuthHttp(auth, { publicOrigin: ORIGIN, secureCookies: true });
    await http.registerRoutes(app);
    app.get('/web/api/private', async (request) => ({ owner: (await http.requireSession(request)).discordId }));
    const registered = await app.inject({ method: 'POST', url: '/web/api/auth/register', headers: { origin: ORIGIN }, payload: { discordId: ID } });
    assert.equal(registered.statusCode, 201);
    assert.deepEqual(registered.json(), { success: true });
    assert.equal(registered.headers['set-cookie'], undefined);
    assert.equal(registered.headers['cache-control'], 'no-store');
    assert.equal(registered.body.includes('piyan'), false);
    assert.equal((await app.inject('/web/api/auth/me')).statusCode, 401);
    const login = (password = 'piyan', origin = ORIGIN) => app.inject({ method: 'POST', url: '/web/api/auth/login',
      headers: { origin }, payload: { discordId: ID, password } });
    assert.equal((await login('piyan', 'https://attacker.test')).statusCode, 403);
    assert.equal((await app.inject('/web/api/auth/me')).statusCode, 401);
    const initial = await login();
    assert.equal(initial.statusCode, 200);
    assert.match(String(initial.headers['set-cookie']), /HttpOnly/);
    assert.match(String(initial.headers['set-cookie']), /SameSite=Lax/);
    assert.match(String(initial.headers['set-cookie']), /Secure/);
    assert.equal(initial.headers['cache-control'], 'no-store');
    assert.equal(initial.json().token, undefined);
    const cookie = String(initial.headers['set-cookie']).split(';')[0]!;
    assert.equal((await app.inject({ url: '/web/api/private', headers: { cookie } })).statusCode, 200);
    assert.equal(initial.json().scope, 'full');
    assert.equal(initial.json().user.mustChangePassword, false);
    assert.equal(initial.body.includes('piyan'), false);
    assert.equal((await app.inject({ url: '/web/api/auth/me', headers: { cookie: `${cookie}; ${cookie}` } })).statusCode, 401);
    const passwordBody = { currentPassword: 'piyan', newPassword: PASSWORD };
    assert.equal((await app.inject({ method: 'POST', url: '/web/api/auth/password', headers: { cookie, origin: ORIGIN }, payload: passwordBody })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/web/api/auth/password', headers: { cookie, origin: ORIGIN, 'x-csrf-token': '界'.repeat(43) }, payload: passwordBody })).statusCode, 403);
    const changed = await app.inject({ method: 'POST', url: '/web/api/auth/password',
      headers: { cookie, origin: ORIGIN, 'x-csrf-token': initial.json().csrfToken }, payload: passwordBody });
    assert.equal(changed.statusCode, 200);
    assert.match(String(changed.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await app.inject({ url: '/web/api/auth/me', headers: { cookie } })).statusCode, 401);
    const full = await login(PASSWORD);
    const fullCookie = String(full.headers['set-cookie']).split(';')[0]!;
    assert.equal((await app.inject({ url: '/web/api/private', headers: { cookie: fullCookie } })).json().owner, ID);
    const wrong = await login('wrong password');
    assert.equal(wrong.statusCode, 401);
    assert.equal((await login('wrong password')).statusCode, 429);
    assert.equal((await app.inject({ method: 'POST', url: '/web/api/auth/logout',
      headers: { cookie: fullCookie, origin: ORIGIN, 'x-csrf-token': full.json().csrfToken } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/web/api/private', headers: { cookie: fullCookie } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/web/api/auth/signup', payload: { discordId: SECOND_ID } })).statusCode, 404);
  } finally { await app.close(); await f.cleanup(); }
});

test('public registration accepts only a string Discord ID from the configured origin and never resets existing accounts', async () => {
  const f = await fixture();
  const app = Fastify();
  try {
    const auth = await f.open();
    const http = createAuthHttp(auth, { publicOrigin: ORIGIN, secureCookies: true });
    await http.registerRoutes(app);
    const register = (payload: unknown, headers: Record<string, string> = { origin: ORIGIN }) => app.inject({
      method: 'POST', url: '/web/api/auth/register', headers, payload: payload as object });
    for (const headers of [{}, { origin: 'https://attacker.test' }, { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }]) {
      const response = await register({ discordId: ID }, headers);
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.includes('piyan'), false);
    }
    for (const body of [{}, { discordId: 123456789012345678 }, { discordId: ID, password: 'piyan' },
      { discordId: '1234' }, { discordId: `${ID}\n` }, { discordId: '１２３４５６７８９０１２３４５６７８' },
      { discordId: ID, ownerId: SECOND_ID }, [ID]]) {
      const response = await register(body);
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.includes('piyan'), false);
      assert.equal(response.headers['set-cookie'], undefined);
    }
    assert.deepEqual(await query(f.dbPath, 'SELECT * FROM WebUser'), []);
    const registered = await register({ discordId: ID });
    assert.equal(registered.statusCode, 201);
    assert.deepEqual(registered.json(), { success: true });
    assert.equal(registered.headers['set-cookie'], undefined);
    assert.equal((await app.inject('/web/api/auth/me')).statusCode, 401);
    const login = await auth.login(ID, 'piyan');
    const session = await auth.authenticate(login.token); assert.ok(session);
    await auth.changePassword(session, 'piyan', 'Ab12');
    const active = await auth.login(ID, 'Ab12');
    const before = await query(f.dbPath, 'SELECT * FROM WebUser');
    const duplicate = await register({ discordId: ID });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.includes('piyan'), false);
    assert.deepEqual(await query(f.dbPath, 'SELECT * FROM WebUser'), before);
    assert.ok(await auth.authenticate(active.token));
    await assert.rejects(auth.login(ID, 'piyan'), expectCode('INVALID_CREDENTIALS'));
    await auth.setDisabled(ID, true);
    assert.equal((await register({ discordId: ID })).statusCode, 409);
    await assert.rejects(auth.login(ID, 'Ab12'), expectCode('INVALID_CREDENTIALS'));
  } finally { await app.close(); await f.cleanup(); }
});

test('public registration bounds attempts per account, per IP and globally before hashing or creating accounts', async () => {
  const f = await fixture();
  const apps: ReturnType<typeof Fastify>[] = [];
  let hashes = 0;
  try {
    const auth = await f.open({ passwords: { async hash(password: string) { hashes++; return `test:${password}`; },
      async verify(password: string, hash: string) { return hash === `test:${password}`; } } });
    const makeApp = async () => {
      const app = Fastify(); apps.push(app);
      await createAuthHttp(auth, { publicOrigin: ORIGIN, secureCookies: true }).registerRoutes(app);
      return app;
    };
    const app = await makeApp();
    const register = (target: ReturnType<typeof Fastify>, id: string, ip = '127.0.0.1') => target.inject({
      method: 'POST', url: '/web/api/auth/register', remoteAddress: ip, headers: { origin: ORIGIN }, payload: { discordId: id } });
    assert.equal((await register(app, ID)).statusCode, 201);
    assert.equal((await register(app, ID)).statusCode, 409);
    assert.equal((await register(app, ID)).statusCode, 409);
    let before = hashes;
    assert.equal((await register(app, ID)).statusCode, 429);
    assert.equal(hashes, before);
    for (let i = 0; i < 7; i++) {
      assert.equal((await register(app, String(400000000000000000n + BigInt(i)))).statusCode, 201);
    }
    before = hashes;
    assert.equal((await register(app, SECOND_ID)).statusCode, 429);
    assert.equal(hashes, before);
    assert.equal((await query(f.dbPath, 'SELECT discord_id FROM WebUser')).length, 8);
    const globalApp = await makeApp();
    for (let i = 0; i < 60; i++) {
      assert.equal((await register(globalApp, String(500000000000000000n + BigInt(i)), `192.0.2.${i + 1}`)).statusCode, 201);
    }
    before = hashes;
    const capped = await register(globalApp, SECOND_ID, '198.51.100.1');
    assert.equal(capped.statusCode, 429);
    assert.equal(capped.body.includes('piyan'), false);
    assert.equal(hashes, before);
    assert.equal((await query(f.dbPath, 'SELECT discord_id FROM WebUser')).length, 68);
  } finally { await Promise.all(apps.map((app) => app.close())); await f.cleanup(); }
});
