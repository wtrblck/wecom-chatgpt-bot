import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const root = path.resolve(process.argv.find(a => a.startsWith('--root='))?.slice(7) || '.');
const node = fs.existsSync(path.join(root, 'runtime/node.exe')) ? path.join(root, 'runtime/node.exe') : process.execPath;
const child = spawn(node, ['dist/scripts/desktop-host.js'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let sequence = 0;
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const message = JSON.parse(line); const request = pending.get(message.id); if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  if (message.ok) request.resolve(message.result); else request.reject(new Error(message.error));
});
child.stderr.on('data', data => process.stderr.write(data));
function call(method) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)); }, 100000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method }) + '\n');
  });
}
try {
  const before = await call('state');
  console.log('Initial phase:', before.phase);
  if (before.phase !== 'stopped') throw new Error('Unexpected automatic startup');
  if (process.argv.includes('--login')) {
    await call('login'); const state = await call('state');
    console.log('Browser state:', state.browser, 'Account evidence:', state.account);
    await call('stop');
    if ((await call('state')).browser !== 'CLOSED') throw new Error('Browser not closed');
  }
  await call('close'); child.stdin.end();
  console.log('Desktop protocol and graceful close passed.');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
  await call('close').catch(() => {}); child.stdin.end();
}
