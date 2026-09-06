import type { Repository } from './repository.js';

export class ConversationManager {
  constructor(private readonly repository: Repository) {}

  get(userid: string): string | null {
    return this.repository.getConversation(userid);
  }

  save(userid: string, url: string): void {
    if (/^https:\/\/chatgpt\.com\/c\//.test(url)) this.repository.saveConversation(userid, url);
  }

  reset(userid: string): void {
    this.repository.clearConversation(userid);
  }
}
