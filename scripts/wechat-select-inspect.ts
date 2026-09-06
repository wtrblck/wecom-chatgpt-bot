import { createLogger } from '../src/utils/logger.js';
import { WeChatBridgeClient } from '../src/wechat/bridge-client.js';

const displayName = process.argv[2];
if (!displayName) throw new Error('Usage: npm run wechat:select:inspect -- <displayName>');
const bridge = new WeChatBridgeClient(process.cwd(), process.env.WECHAT_BRIDGE_PATH, createLogger('warn'));
try {
  await bridge.start();
  await bridge.select(displayName);
  console.log(JSON.stringify(await bridge.ocrInspect(), null, 2));
} finally {
  await bridge.stop();
}
