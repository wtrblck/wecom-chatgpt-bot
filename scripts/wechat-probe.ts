import { createLogger } from '../src/utils/logger.js';
import { WeChatBridgeClient } from '../src/wechat/bridge-client.js';

const bridge = new WeChatBridgeClient(process.cwd(), process.env.WECHAT_BRIDGE_PATH, createLogger('warn'));
try {
  await bridge.start();
  const state = await bridge.health();
  console.log(JSON.stringify(state, null, 2));
} finally {
  await bridge.stop();
}
