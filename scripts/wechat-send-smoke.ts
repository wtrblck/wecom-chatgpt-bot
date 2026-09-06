import { loadConfig } from '../src/config/config.js';
import { WeChatBridgeClient } from '../src/wechat/bridge-client.js';
import { createLogger } from '../src/utils/logger.js';
import { acquireProcessLock } from '../src/utils/process-lock.js';

const config = loadConfig();
const name = process.argv[2];
const selected = config.wechatConversations.filter((chat) => chat.enabled && chat.name === name);
if (selected.length !== 1) throw new Error('请指定一个已配置且启用的唯一测试会话名称');
const release = acquireProcessLock(config.databasePath);
process.once('exit', release);
const bridge = new WeChatBridgeClient(process.cwd(), config.wechatBridgePath, createLogger('warn'));
try {
  await bridge.start();
  const startedAt = Date.now();
  const receipt = await bridge.send(name!, '【机器人联调】这是一条通过 Windows 控件发送的测试消息，无需回复。', {
    resumeVerifiedDraft: process.argv.includes('--resume-verified-draft'),
  });
  console.log(JSON.stringify({ ...receipt, durationMs: Date.now() - startedAt }));
} finally { await bridge.stop(); release(); }
