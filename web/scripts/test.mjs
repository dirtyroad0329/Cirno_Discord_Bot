import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'unit';
if (!['unit', 'integration', 'browser'].includes(mode)) throw new Error('Unknown test group.');
const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.test\.(ts|mjs)$/.test(entry.name)) {
      const name = relative(resolve(root, 'tests'), path).replaceAll('\\', '/');
      if (mode === 'unit' ? !/^(integration|browser)\//.test(name) : name.startsWith(`${mode}/`)) files.push(path);
    }
  }
}
await collect(resolve(root, 'tests'));
if (!files.length) throw new Error(`No ${mode} tests found.`);
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files.sort()], {
  cwd: root, env: process.env, stdio: 'inherit',
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
