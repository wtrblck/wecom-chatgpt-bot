import fs from 'node:fs';
import path from 'node:path';

/** Shared by the bot and manual delivery tools; prevents two UI senders. */
export function acquireProcessLock(databasePath: string): () => void {
  const file = `${databasePath}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(file, 'wx');
      fs.writeFileSync(descriptor, String(process.pid));
      fs.closeSync(descriptor);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* already removed */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`进程锁损坏，请确认 Bot 已停止后检查 ${file}`);
      let alive = true;
      try { process.kill(pid, 0); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      }
      if (alive) throw new Error(`Bot 或补发工具已经运行 (pid=${pid})，请先停止它再操作`);
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法获取项目进程锁');
}
