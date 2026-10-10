import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadWebConfig } from '../config/index.js';
import { openAuthService } from './service.js';
import { AuthError } from './errors.js';

const usage = 'Usage: npm --prefix web run auth -- create|reset|disable|enable <Discord ID> OR backup <new backup path>';

/** This entry loads website settings only. It never imports or logs into the Bot. */
export async function runAuthCli(args: string[], settings: {
  dbPath?: string;
  output?: (message: string) => void;
} = {}): Promise<void> {
  const [command, value, ...extra] = args;
  if (!['create', 'reset', 'disable', 'enable', 'backup'].includes(command ?? '') || !value || extra.length) {
    throw new AuthError('CLI_USAGE', usage);
  }
  const dbPath = settings.dbPath ?? loadWebConfig({ requireBackend: false }).authDbPath;
  const output = settings.output ?? ((message: string) => process.stdout.write(`${message}\n`));
  const auth = await openAuthService({ dbPath });
  try {
    switch (command) {
      case 'create':
        await auth.createUser(value);
        output(`Created ${value}.`);
        break;
      case 'reset':
        output(`Temporary password for ${value}: ${await auth.resetPassword(value)}\nAll sessions were revoked.`);
        break;
      case 'disable':
      case 'enable':
        await auth.setDisabled(value, command === 'disable');
        output(`${command === 'disable' ? 'Disabled' : 'Enabled'} ${value}. All sessions were revoked.`);
        break;
      case 'backup':
        await auth.backup(value);
        output(`Authentication backup saved to ${resolve(value)}.`);
        break;
    }
  } finally {
    await auth.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runAuthCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Account command failed'}\n`);
    process.exitCode = 1;
  });
}
