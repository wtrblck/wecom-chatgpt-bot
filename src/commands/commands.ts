export type Command = '/new' | '/status' | '/stop' | '/retry' | '/help';

export const HELP_TEXT = `可用命令：
/new - 开始新的 ChatGPT 对话
/retry - 优先补发已保存答案，否则重试上一条问题
/stop - 停止当前生成并取消你的排队任务
/status - 查看运行状态
/help - 显示本帮助`;

export function parseCommand(text: string): Command | null {
  const normalized = text.trim().toLowerCase();
  return ['/new', '/status', '/stop', '/retry', '/help'].includes(normalized)
    ? (normalized as Command)
    : null;
}
