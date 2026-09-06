import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config/config.js';

const checks: { check: string; ok: boolean; detail: string }[] = [];
try {
  const config = loadConfig();
  checks.push({ check: 'configuration', ok: true, detail: `wechat=${config.wechatEnabled}, wecom=${config.wecomEnabled}, listeners=${config.wechatDbConversations.length}` });
  checks.push({ check: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.versions.node });
  const chromiumReady = fs.existsSync(chromium.executablePath());
  checks.push({ check: 'chromium', ok: chromiumReady, detail: chromiumReady ? 'project-local browser installed' : 'Run npm run playwright:install' });
  if (config.wechatEnabled) {
    const bridge = config.wechatBridgePath || path.resolve('native/WeChatBridge/publish/WeChatBridge.exe');
    checks.push({ check: 'wechat-bridge', ok: fs.existsSync(bridge), detail: fs.existsSync(bridge) ? 'published; use wechat:inspect for live control capability' : 'Run npm run wechat:build' });
    const runtime = spawnSync('dotnet', ['--list-runtimes'], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    checks.push({ check: 'dotnet-desktop-runtime', ok: /Microsoft\.WindowsDesktop\.App 10\./.test(runtime.stdout || ''), detail: 'Requires .NET 10 Desktop Runtime; build also requires .NET 10 SDK.' });
    if (config.wechatReadMode === 'db') {
      const python = spawnSync(config.wechatDbPythonPath, ['-c', 'import cryptography, zstandard; print("ready")'], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
      checks.push({ check: 'python-db-dependencies', ok: python.status === 0, detail: python.status === 0 ? 'ready' : 'Run npm run setup (or install scripts/requirements-wechat-db.txt in .venv-wechatdb)' });
    }
  }
} catch (error) {
  checks.push({ check: 'configuration', ok: false, detail: error instanceof Error ? error.message : String(error) });
}
for (const check of checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.check}: ${check.detail}`);
console.log('This check does not read chats, submit GPT prompts, or send messages. Login and live UI compatibility still need local verification.');
if (checks.some((check) => !check.ok)) process.exitCode = 1;
