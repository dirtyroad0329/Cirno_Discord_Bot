import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AuthError } from './errors.js';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
}

/** Native asynchronous work still shares libuv resources with the Bot. Bound both
 * active work and the waiting queue rather than allocating per-request jobs. */
export class ScryptPasswords implements PasswordHasher {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency = 2, private readonly queueLimit = 16) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 ||
      !Number.isInteger(queueLimit) || queueLimit < 0 || queueLimit > 256) {
      throw new Error('Invalid password work limits');
    }
  }

  private async derive(password: string, salt: Buffer, cost: number): Promise<Buffer> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.queueLimit) {
        throw new AuthError('AUTH_BUSY', '登入服務忙碌，請稍後再試。', 503);
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 32, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
          (error, key) => error ? reject(error) : resolve(key));
      });
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const cost = 32768;
    const key = await this.derive(password, salt, cost);
    return `scrypt$${cost}$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[2] !== '8' || parts[3] !== '1' ||
      !/^[A-Za-z0-9_-]{22}$/.test(parts[4] ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(parts[5] ?? '')) {
      throw new Error('Unsupported stored password format');
    }
    const cost = Number(parts[1]);
    if (![16384, 32768].includes(cost)) throw new Error('Unsupported stored password cost');
    const expected = Buffer.from(parts[5]!, 'base64url');
    return timingSafeEqual(expected, await this.derive(password, Buffer.from(parts[4]!, 'base64url'), cost));
  }
}

export function validatePasswordInput(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024 ||
    Buffer.byteLength(password, 'utf8') > 4096) {
    throw new AuthError('INVALID_PASSWORD', '密碼長度不符合限制。');
  }
}

export function validateNewPassword(password: unknown): asserts password is string {
  validatePasswordInput(password);
  if (password.length < 4 || /[^A-Za-z0-9]/.test(password)) {
    throw new AuthError('WEAK_PASSWORD', '新密碼至少需要 4 個字元，且僅限英文字母與數字。');
  }
}
