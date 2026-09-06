export class BrowserLaunchError extends Error {}
export class ChatGPTLoginRequiredError extends Error {}
export class ChatGPTNavigationError extends Error {}
export class ChatGPTSendError extends Error {}
/** Submission may have reached ChatGPT. Never automatically submit it again. */
export class ChatGPTSendUncertainError extends ChatGPTSendError {}
export class ChatGPTGenerationTimeoutError extends Error {}
export class ChatGPTDOMChangedError extends Error {}
export class ChatGPTGenerationStoppedError extends Error {}
export class WeComSendError extends Error {}
