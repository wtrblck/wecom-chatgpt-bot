import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

export interface CreateLoggerOptions {
  /**
   * 调试日志文件路径。设置后所有日志（含 debug 级）都会写入该文件，
   * 且文件在每次启动时被清空，只保留最后一次运行的内容。
   */
  logFile?: string;
}

export function createLogger(level: string, options: CreateLoggerOptions = {}): Logger {
  const base = {
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'secret',
        '*.secret',
        'WECOM_BOT_SECRET',
        'cookie',
        'cookies',
        '*.cookies',
        'authorization',
        '*.authorization',
      ],
      censor: '[REDACTED]',
    },
  };

  if (!options.logFile) {
    return pino({ ...base, level });
  }

  // 只保留最后一次运行：启动即清空日志文件
  const logFile = options.logFile;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '');

  // 主日志级别取最详细一档（debug，用户可配 trace），
  // 各输出目标再按自己的级别过滤：控制台保持原级别，文件写入全部 debug 级日志。
  const verboseLevel = level === 'trace' ? 'trace' : 'debug';
  return pino(
    { ...base, level: verboseLevel },
    pino.transport({
      targets: [
        { target: 'pino/file', level, options: { destination: 1 } },
        { target: 'pino/file', level: verboseLevel, options: { destination: logFile, mkdir: true } },
      ],
    }),
  );
}

export function sdkLogger(logger: Logger) {
  return {
    debug: (message: string, ...args: unknown[]) => logger.debug({ args }, message),
    info: (message: string, ...args: unknown[]) => logger.info({ args }, message),
    warn: (message: string, ...args: unknown[]) => logger.warn({ args }, message),
    error: (message: string, ...args: unknown[]) => logger.error({ args }, message),
  };
}
