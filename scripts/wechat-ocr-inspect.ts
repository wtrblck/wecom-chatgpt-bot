import { createLogger } from '../src/utils/logger.js';
import { WeChatBridgeClient } from '../src/wechat/bridge-client.js';

const bridge = new WeChatBridgeClient(process.cwd(), process.env.WECHAT_BRIDGE_PATH, createLogger('warn'));
try {
  await bridge.start();
  console.log(JSON.stringify(await bridge.ocrInspect(), null, 2));
} finally {
  await bridge.stop();
}
