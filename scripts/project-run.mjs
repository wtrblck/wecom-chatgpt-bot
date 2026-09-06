import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

// Keep tool downloads, build state and temporary files with the project.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
loadEnv({ path: path.join(root, '.env'), quiet: true });
const temporary = path.join(root, '.cache', 'tmp');
fs.mkdirSync(temporary, { recursive: true });
const env = {
  ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  npm_config_cache: path.join(root, '.cache', 'npm'),
  PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.cache', 'ms-playwright'),
  DOTNET_CLI_HOME: path.join(root, '.dotnet-home'),
  NUGET_PACKAGES: path.join(root, '.nuget', 'packages'),
  DOTNET_CLI_TELEMETRY_OPTOUT: '1', PYTHONPYCACHEPREFIX: path.join(root, '.cache', 'pycache'),
};
const commands = {
  start: [process.execPath, ['dist/src/index.js']],
  dev: [process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'src/index.ts']],
  test: [process.execPath, ['node_modules/vitest/vitest.mjs', 'run']],
  build: [process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']],
  check: [process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit']],
  playwright: [process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium']],
  native: ['dotnet', ['publish', 'native/WeChatBridge/WeChatBridge.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'false', '-o', 'native/WeChatBridge/publish']],
  'accessibility-build': ['dotnet', ['publish', 'native/WeChatAccessibility/WeChatAccessibility.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'false', '-o', 'native/WeChatAccessibility/publish']],
  accessibility: [path.join(root, 'native/WeChatAccessibility/publish/WeChatAccessibility.exe'), []],
  tsx: [process.execPath, ['node_modules/tsx/dist/cli.mjs']],
  'python-script': [process.env.WECHAT_DB_PYTHON_PATH || path.join(root, '.venv-wechatdb', 'Scripts', 'python.exe'), []],
  python: [process.env.WECHAT_DB_PYTHON_PATH || path.join(root, '.venv-wechatdb', 'Scripts', 'python.exe'), ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py']],
};
const selected = commands[process.argv[2]];
if (!selected) throw new Error(`Unknown project command: ${process.argv[2]}`);
const botProcess = process.argv[2] === 'start';
const child = spawn(selected[0], [...selected[1], ...process.argv.slice(3)], {
  cwd: root, env, stdio: botProcess ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', windowsHide: true,
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
let stopping = false;
function stop(signal) {
  if (stopping || child.exitCode !== null || child.signalCode !== null) return;
  stopping = true;
  // Windows ChildProcess.kill terminates rather than delivering a POSIX signal.
  if (botProcess && child.connected) {
    child.send({ type: 'shutdown', signal }, (error) => {
      if (error) {
        console.error(`无法转发停止请求：${error.message}；请在另一个终端运行 npm run stop。`);
        stopping = false;
      }
    });
  } else if (botProcess) {
    console.error('Bot 控制通道已断开；请运行 npm run stop，未强制终止子进程。');
    stopping = false;
  } else child.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
