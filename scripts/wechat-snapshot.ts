import path from 'node:path';
import { createLogger } from '../src/utils/logger.js';
import { WeChatBridgeClient } from '../src/wechat/bridge-client.js';

const bridge = new WeChatBridgeClient(process.cwd(), process.env.WECHAT_BRIDGE_PATH, createLogger('warn'));
try {
  await bridge.start();
  const output = path.resolve('logs/wechat/current-window.png');
  await bridge.snapshot(output);
  console.log(output);
} finally {
  await bridge.stop();
}
