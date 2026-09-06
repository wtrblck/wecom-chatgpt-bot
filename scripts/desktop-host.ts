import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config as dotenv } from 'dotenv';
import { acquireProcessLock } from '../src/utils/process-lock.js';

// Set paths before importing Playwright, whose browser registry captures its environment.
const root = process.cwd();
dotenv({ path: path.join(root, '.env'), quiet: true });
const temp = path.join(root, '.cache', 'tmp');
fs.mkdirSync(temp, { recursive: true });
Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp,
  PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.cache', 'ms-playwright'),
  PYTHONPYCACHEPREFIX: path.join(root, '.cache', 'pycache'), PYTHONUTF8: '1',
});
if (fs.existsSync(path.join(root, 'runtime', 'python', 'python.exe'))) {
  process.env.WECHAT_DB_PYTHON_PATH = path.join(root, 'runtime', 'python', 'python.exe');
}
const release = acquireProcessLock(path.join(root, 'data', 'desktop-session'));
process.once('exit', release);
const { DesktopService } = await import('../src/desktop/service.js');
const service = new DesktopService(root);
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  if (line.length > 2_000_000) return;
  let request: { id: number; method: string; params?: unknown };
  try { request = JSON.parse(line) as typeof request; } catch { return; }
  void service.action(request.method, request.params).then(
    result => process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n'),
    error => process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n'),
  );
});
input.on('close', () => {
  // A busy operation can be launching Chromium; wait for it before disposing resources.
  const finish = async () => {
    try { await service.action('close'); release(); process.exit(0); }
    catch { setTimeout(() => void finish(), 1000); }
  };
  void finish();
});
