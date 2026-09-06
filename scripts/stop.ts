import { loadConfig } from '../src/config/config.js';
import { requestStop, waitForStopped } from '../src/utils/stop-control.js';

try {
  const config = loadConfig();
  const pid = await requestStop(config.databasePath);
  console.log(`Bot (pid=${pid}) 已接受停止请求，等待在途任务和发送收尾…`);
  await waitForStopped(pid);
  console.log('Bot 已退出。');
} catch (error) {
  console.error('停止 Bot 失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
