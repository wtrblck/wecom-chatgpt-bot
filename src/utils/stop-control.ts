import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

interface ControlRecord { pid: number; address: string; token: string }

function controlAddress(databasePath: string, pid: number): string {
  const digest = createHash('sha256').update(path.resolve(databasePath).toLowerCase()).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wechat-bot-${digest}-${pid}`
    : path.join(path.dirname(path.resolve(databasePath)), `.bot-${digest}-${pid}.sock`);
}

/** A local, authenticated control endpoint for this database's locked bot instance. */
export async function startStopControl(databasePath: string, onShutdown: () => void): Promise<{ close(): Promise<void> }> {
  const file = `${databasePath}.control.json`;
  const record: ControlRecord = { pid: process.pid, address: controlAddress(databasePath, process.pid), token: randomBytes(32).toString('hex') };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    let body = '';
    socket.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 2_048) { socket.destroy(); return; }
      if (!body.includes('\n')) return;
      socket.removeAllListeners('data');
      let request: { type?: string; token?: string };
      try { request = JSON.parse(body.slice(0, body.indexOf('\n'))) as typeof request; }
      catch { socket.end('{"accepted":false}\n'); return; }
      const token = Buffer.from(typeof request.token === 'string' ? request.token : '');
      const expected = Buffer.from(record.token);
      if (request.type !== 'shutdown' || token.length !== expected.length || !timingSafeEqual(token, expected)) {
        socket.end('{"accepted":false}\n');
        return;
      }
      // Flush acknowledgement before shutdown closes the server and workers.
      socket.end('{"accepted":true}\n', onShutdown);
    });
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(record.address, () => { server.removeListener('error', reject); resolve(); });
    });
    await fs.writeFile(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  let closing: Promise<void> | null = null;
  return {
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        // Never delete metadata created by a later instance.
        try {
          const current = JSON.parse(await fs.readFile(file, 'utf8')) as ControlRecord;
          if (current.token === record.token) await fs.unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      })();
      return closing;
    },
  };
}

/** Request graceful shutdown without signals, TCP listeners, or killing a process. */
export async function requestStop(databasePath: string): Promise<number> {
  let record: ControlRecord;
  try { record = JSON.parse(await fs.readFile(`${databasePath}.control.json`, 'utf8')) as ControlRecord; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('未找到本项目的运行控制文件；Bot 可能未运行或需要更新后重新启动');
    throw error;
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || record.address !== controlAddress(databasePath, record.pid)
    || typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new Error('Bot 控制文件无效，未发送停止请求');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(record.address);
    let body = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(5_000, () => finish(new Error('Bot 停止请求未得到确认')));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'shutdown', token: record.token })}\n`));
    socket.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 2_048) { finish(new Error('Bot 停止响应无效')); return; }
      if (!body.includes('\n')) return;
      try {
        const response = JSON.parse(body.slice(0, body.indexOf('\n'))) as { accepted?: boolean };
        finish(response.accepted === true ? undefined : new Error('Bot 拒绝停止请求'));
      } catch { finish(new Error('Bot 停止响应无效')); }
    });
    socket.once('end', () => finish(new Error('Bot 在确认停止请求前关闭了连接')));
  });
  return record.pid;
}

export async function waitForStopped(pid: number, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Bot (pid=${pid}) 已收到停止请求但仍在清理；未强制终止，请检查日志`);
}
