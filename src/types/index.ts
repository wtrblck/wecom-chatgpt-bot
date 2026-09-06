export enum BrowserState {
  STARTING = 'STARTING',
  LOGIN_REQUIRED = 'LOGIN_REQUIRED',
  READY = 'READY',
  GENERATING = 'GENERATING',
  ERROR = 'ERROR',
  RECOVERING = 'RECOVERING',
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'aborted';

export interface TaskRecord {
  id: number;
  msgid: string;
  userid: string;
  prompt: string;
  status: TaskStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  response: string | null;
  error: string | null;
}

export interface IncomingTextMessage {
  msgid: string;
  userid: string;
  chatid?: string;
  chattype: 'single' | 'group';
  content: string;
  reqId?: string;
}

export interface IncomingMessage {
  platform: 'wecom' | 'wechat';
  messageId: string;
  userId: string;
  displayName?: string;
  senderId?: string;
  senderDisplayName?: string;
  type: 'text';
  text: string;
  timestamp: number;
  triggerPrefixes?: readonly string[];
  attachments?: readonly IncomingAttachment[];
}

export interface IncomingAttachment {
  path: string;
  label: string;
}
