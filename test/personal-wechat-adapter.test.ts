import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../src/conversation/repository.js';
import { openDatabase } from '../src/db/sqlite.js';
import type { BridgeIncomingMessage } from '../src/wechat/bridge-client.js';
import { WindowsPersonalWeChatAdapter } from '../src/wechat/personal-wechat-adapter.js';
import { splitWechatText } from '../src/wechat/text.js';
import type { IncomingMessage } from '../src/types/index.js';

const { bridge, reader, files } = vi.hoisted(() => ({
  bridge: { start: vi.fn(), stop: vi.fn(), health: vi.fn(), poll: vi.fn(), send: vi.fn(), snapshot: vi.fn() },
  reader: { start: vi.fn(), stop: vi.fn(), health: vi.fn(), poll: vi.fn(), ack: vi.fn() },
  files: { mkdir: vi.fn(), appendFile: vi.fn() },
}));

vi.mock('../src/wechat/bridge-client.js', () => ({
  WeChatBridgeClient: vi.fn(function () { return bridge; }),
}));
vi.mock('../src/wechat/db-reader-client.js', () => ({
  WeChatDbReaderClient: vi.fn(function () { return reader; }),
}));
// Keep failure logs and snapshots offline too. Repository uses a real in-memory DB.
vi.mock('node:fs/promises', () => ({ default: files }));

const room = 'test@chatroom';
const otherRoom = 'other@chatroom';
const message = (overrides: Partial<BridgeIncomingMessage> = {}): BridgeIncomingMessage => ({
  messageId: 'message1', userId: room, displayName: 'Test group', senderId: 'wxid_friend',
  senderDisplayName: 'Friend', text: 'wxid_friend:\n/gpt hello', timestamp: 1_700_000_000_000,
  isSelf: false, ...overrides,
});
const healthy = { processRunning: true, windowFound: true, loggedIn: true };
const verified = { verified: true, strategy: 'uia', submittedAt: 1_700_000_000_000 };

describe('personal WeChat durable adapter integration', () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: Repository;
  let adapter: WindowsPersonalWeChatAdapter;
  let callback: ReturnType<typeof vi.fn<(incoming: IncomingMessage) => Promise<void>>>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    bridge.start.mockResolvedValue(undefined);
    bridge.stop.mockResolvedValue(undefined);
    bridge.health.mockResolvedValue(healthy);
    bridge.poll.mockResolvedValue([]);
    bridge.send.mockResolvedValue(verified);
    bridge.snapshot.mockResolvedValue(undefined);
    reader.start.mockResolvedValue(undefined);
    reader.stop.mockResolvedValue(undefined);
    reader.health.mockResolvedValue({ ready: true, conversationCount: 2 });
    reader.poll.mockResolvedValue({ batchId: null, messages: [] });
    reader.ack.mockResolvedValue(undefined);
    files.mkdir.mockResolvedValue(undefined);
    files.appendFile.mockResolvedValue(undefined);
    db = openDatabase(':memory:');
    repository = new Repository(db);
    repository.saveContact('wechat', room, 'Test group');
    repository.saveContact('wechat', otherRoom, 'Other group');
    callback = vi.fn(async (incoming: IncomingMessage) => { repository.claimIncoming('wechat', incoming.messageId); });
    adapter = new WindowsPersonalWeChatAdapter({
      projectRoot: process.cwd(), pollIntervalMs: 1_000, sendIntervalMs: 1,
      logDirectory: `${process.cwd()}/logs/test`, requirePrefix: true, prefixes: ['/gpt'],
      canonicalNames: [], readMode: 'db', dbPythonPath: 'unused-python',
      dbConversations: [
        { id: room, name: 'Test group', type: 'group', enabled: true },
        { id: otherRoom, name: 'Other group', type: 'group', enabled: true },
        { id: 'disabled@chatroom', name: 'Disabled group', type: 'group', enabled: false },
      ],
    }, repository, { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger);
    adapter.onMessage(callback);
  });

  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    db.close();
  });

  async function start(): Promise<void> {
    await adapter.start();
    await vi.advanceTimersByTimeAsync(0);
  }

  it('does not acknowledge or dispatch when saving the inbox fails, then retries the batch', async () => {
    reader.poll.mockResolvedValue({ batchId: 'batch1', messages: [message()] });
    vi.spyOn(repository, 'saveInbox').mockImplementationOnce(() => { throw new Error('disk full'); });
    await start();
    expect(reader.ack).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(repository.pendingInbox()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reader.ack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reader.ack).toHaveBeenCalledExactlyOnceWith('batch1');
    expect(callback).toHaveBeenCalledOnce();
    expect(repository.pendingInbox()).toEqual([]);
  });

  it('commits the batch before ack and replays a failed callback from the durable inbox', async () => {
    const events: string[] = [];
    reader.poll.mockResolvedValueOnce({ batchId: 'batch1', messages: [message()] });
    reader.ack.mockImplementation(async () => {
      expect(repository.pendingInbox()).toHaveLength(1);
      events.push('ack');
    });
    callback.mockImplementationOnce(async () => {
      events.push('callback failed');
      throw new Error('router unavailable');
    }).mockImplementationOnce(async (incoming) => {
      events.push('callback replayed');
      repository.claimIncoming('wechat', incoming.messageId);
    });
    await start();
    expect(events).toEqual(['ack', 'callback failed']);
    expect(repository.pendingInbox()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(['ack', 'callback failed']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(['ack', 'callback failed', 'callback replayed']);
    expect(reader.ack).toHaveBeenCalledOnce();
    expect(repository.pendingInbox()).toEqual([]);
  });

  it('keeps a saved inbox recoverable when ack fails and suppresses duplicate dispatch', async () => {
    reader.poll.mockResolvedValue({ batchId: 'batch1', messages: [message()] });
    reader.ack.mockRejectedValueOnce(new Error('reader disconnected'));
    await start();
    expect(repository.pendingInbox()).toHaveLength(1);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callback).toHaveBeenCalledOnce();
    expect(reader.ack).toHaveBeenCalledTimes(2);
    expect(repository.pendingInbox()).toEqual([]);
  });

  it('filters self, disabled, unknown and already processed messages while acknowledging the batch', async () => {
    repository.claimIncoming('wechat', 'processed');
    reader.poll.mockResolvedValueOnce({ batchId: 'batch1', messages: [
      message({ messageId: 'self', isSelf: true }),
      message({ messageId: 'disabled', userId: 'disabled@chatroom', displayName: 'Disabled group' }),
      message({ messageId: 'unknown', userId: 'unknown@chatroom', displayName: 'Unknown group' }),
      message({ messageId: 'processed' }),
      message({ messageId: 'accepted', text: 'wxid_envelope:\n/gpt hello', senderId: 'wxid_authoritative' }),
    ] });
    await start();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'accepted', senderId: 'wxid_authoritative', text: '/gpt hello',
    }));
    expect(reader.ack).toHaveBeenCalledExactlyOnceWith('batch1');
  });

  it('acknowledges a non-text batch that has no dispatchable messages', async () => {
    reader.poll.mockResolvedValueOnce({ batchId: 'media-only', messages: [] });
    await start();
    expect(reader.ack).toHaveBeenCalledExactlyOnceWith('media-only');
    expect(callback).not.toHaveBeenCalled();
  });

  it('continues database polling when the desktop window reports unhealthy', async () => {
    bridge.health.mockResolvedValue({ processRunning: true, windowFound: false, loggedIn: false });
    reader.poll.mockResolvedValueOnce({ batchId: 'batch1', messages: [message()] });
    await start();
    expect(reader.poll).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
    expect(reader.ack).toHaveBeenCalledWith('batch1');
  });

  it('does not start overlapping polls while a database batch is still loading', async () => {
    let releasePoll!: (value: { batchId: null; messages: BridgeIncomingMessage[] }) => void;
    reader.poll.mockImplementationOnce(() => new Promise((resolve) => { releasePoll = resolve; }));
    await start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reader.poll).toHaveBeenCalledOnce();
    releasePoll({ batchId: null, messages: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reader.poll).toHaveBeenCalledTimes(2);
  });

  it('marks interrupted sending parts uncertain after process recovery', async () => {
    await start();
    repository.prepareDelivery('recovered-reply', room, ['first', 'second']);
    repository.updateDelivery('recovered-reply', 0, 'sent');
    repository.updateDelivery('recovered-reply', 1, 'sending');
    expect(repository.recoverDeliveries()).toBe(1);
    const resumed = expect(adapter.sendText(room, 'ignored', 'recovered-reply')).rejects.toThrow('发送状态未知');
    await vi.advanceTimersByTimeAsync(10);
    await resumed;
    expect(bridge.send).not.toHaveBeenCalled();
    expect(repository.deliveryParts('recovered-reply').map((part) => part.status)).toEqual(['sent', 'uncertain']);
  });

  it('retries only unsent chunks after a definite rejection and preserves saved content', async () => {
    await start();
    const text = `${'甲'.repeat(1_800)}${'乙'.repeat(1_800)}${'丙'.repeat(80)}`;
    const chunks = splitWechatText(text);
    bridge.send.mockResolvedValueOnce(verified).mockRejectedValueOnce(
      Object.assign(new Error('target selection rejected'), { code: 'WECHAT_SEND_REJECTED' }),
    );
    const first = expect(adapter.sendText(room, text, 'reply1')).rejects.toThrow('rejected');
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(repository.deliveryParts('reply1').map((part) => part.status)).toEqual(['sent', 'failed', 'pending']);
    const retry = adapter.sendText(room, 'a regenerated answer must not replace saved chunks', 'reply1');
    await vi.advanceTimersByTimeAsync(10);
    await retry;
    expect(bridge.send.mock.calls.map((call) => call[1])).toEqual([chunks[0], chunks[1], chunks[1], chunks[2]]);
    expect(repository.deliveryParts('reply1').map((part) => part.status)).toEqual(['sent', 'sent', 'sent']);
    const alreadySent = adapter.sendText(room, 'ignored', 'reply1');
    await vi.advanceTimersByTimeAsync(10);
    await alreadySent;
    expect(bridge.send).toHaveBeenCalledTimes(4);
  });

  it('marks ambiguous delivery uncertain and refuses automatic retransmission', async () => {
    await start();
    const text = `${'甲'.repeat(1_800)}${'乙'.repeat(80)}`;
    bridge.send.mockResolvedValueOnce(verified).mockRejectedValueOnce(new Error('bridge exited during submit'));
    const first = expect(adapter.sendText(room, text, 'reply-uncertain')).rejects.toThrow('bridge exited');
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(repository.deliveryParts('reply-uncertain').map((part) => part.status)).toEqual(['sent', 'uncertain']);
    const retry = expect(adapter.sendText(room, text, 'reply-uncertain')).rejects.toThrow('发送状态未知');
    await vi.advanceTimersByTimeAsync(10);
    await retry;
    expect(bridge.send).toHaveBeenCalledTimes(2);
  });

  it('treats a missing verification receipt as uncertain', async () => {
    await start();
    bridge.send.mockResolvedValueOnce({ verified: false });
    const sending = expect(adapter.sendText(room, 'hello', 'unverified')).rejects.toThrow('回执');
    await vi.advanceTimersByTimeAsync(10);
    await sending;
    expect(repository.deliveryParts('unverified')[0]?.status).toBe('uncertain');
  });

  it('sends a whole multipart answer before another group can use the sending worker', async () => {
    await start();
    const firstText = '甲'.repeat(3_601);
    const secondText = '乙'.repeat(1_801);
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    bridge.send.mockImplementationOnce(async () => { await blocked; return verified; });
    const first = adapter.sendText(room, firstText, 'reply-first');
    const second = adapter.sendText(otherRoom, secondText, 'reply-second');
    expect(bridge.send).toHaveBeenCalledOnce();
    releaseFirst();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([first, second]);
    expect(bridge.send.mock.calls.map((call) => call[0])).toEqual([
      'Test group', 'Test group', 'Test group', 'Other group', 'Other group',
    ]);
    expect(bridge.send.mock.calls.map((call) => call[1])).toEqual([
      ...splitWechatText(firstText), ...splitWechatText(secondText),
    ]);
  });

  it('rejects reuse of a saved delivery key for another conversation', async () => {
    await start();
    repository.prepareDelivery('existing-reply', room, ['saved answer']);
    await expect(adapter.sendText(otherRoom, 'new answer', 'existing-reply')).rejects.toThrow('目标会话');
    expect(bridge.send).not.toHaveBeenCalled();
    expect(repository.deliveryParts('existing-reply')[0]).toMatchObject({ user_id: room, status: 'pending' });
  });
});
