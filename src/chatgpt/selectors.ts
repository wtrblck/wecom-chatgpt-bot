import type { Locator, Page } from 'playwright';

// Keep all volatile ChatGPT DOM knowledge in this file.
const PROMPT_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="消息"]',
  '[contenteditable="true"][role="textbox"]',
];

const SEND_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="发送"]',
];

const STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="停止生成"]',
  'button[aria-label="停止回答"]',
];

function union(page: Page, selectors: string[]): Locator {
  return page.locator(selectors.join(', '));
}

export function findPromptEditor(page: Page): Locator {
  return union(page, PROMPT_SELECTORS).first();
}

export function findSendButton(page: Page): Locator {
  return union(page, SEND_SELECTORS).filter({ visible: true }).first();
}

export function findFileInput(page: Page): Locator {
  return page.locator('input[type="file"]').first();
}

export function findAttachButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /attach|add photos|upload|附件|上传|添加照片/i })
    .or(page.locator('button[data-testid*="attach"], button[aria-label*="附件"], button[aria-label*="上传"]'))
    .filter({ visible: true })
    .first();
}

export function findStopButton(page: Page): Locator {
  return union(page, STOP_SELECTORS).filter({ visible: true }).first();
}

export function findAssistantMessages(page: Page): Locator {
  return page.locator('[data-message-author-role="assistant"]');
}

export function findUserMessages(page: Page): Locator {
  return page.locator('[data-message-author-role="user"]');
}

export function findLastAssistantMessage(page: Page): Locator {
  return findAssistantMessages(page).last();
}

export function findConversationUi(page: Page): Locator {
  return page.locator('main, [role="main"], [data-testid*="conversation"]').first();
}

export function findLoginControls(page: Page): Locator {
  return page
    .getByRole('button', { name: /log in|sign up|登录|注册/i })
    .or(page.getByRole('link', { name: /log in|sign up|登录|注册/i }))
    .first();
}

export function findAuthenticatedUi(page: Page): Locator {
  return union(page, [
    '[data-testid="accounts-profile-button"]',
    '[data-testid="profile-button"]',
    'button[aria-label*="profile" i]',
    'button[aria-label*="account" i]',
    'button[aria-label*="个人资料"]',
    'button[aria-label*="账户"]',
    'nav a[href^="/c/"]',
  ]).filter({ visible: true }).first();
}

export function findRegenerateButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /regenerate|retry|重新生成|重试/i })
    .or(page.locator('[data-testid*="regenerate"]'))
    .filter({ visible: true })
    .last();
}
