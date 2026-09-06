import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Explicit operator command; neither setup nor the bot calls it automatically.
const helper = path.resolve('native/WeChatAccessibility/publish/WeChatAccessibility.exe');
function run(args: string[]): Record<string, any> {
  const result = spawnSync(helper, args, { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout.trim()) as Record<string, any>;
  if (result.status !== 0 || report.ok !== true) throw new Error(String(report.error || 'Accessibility validation failed'));
  return report;
}
const check = run(['--check']);
if (!Number.isInteger(check.pid) || typeof check.module?.sha256 !== 'string') throw new Error('无有效的进程及模块验证结果');
const result = run(['--apply', '--pid', String(check.pid), '--expected-sha256', check.module.sha256]);
console.log(JSON.stringify({ ok: result.ok, applied: result.applied, currentValue: result.currentValue,
  version: result.module.version, note: '可访问性标志已启用；仍需 wechat:inspect 验证控件。' }));
